/**
 * Which field names are secrets — as configuration, not as a constant.
 *
 * The first version of this was a hard-coded list of substrings in two agents.
 * That failed in both directions and neither failure was visible:
 *
 *   - **False negatives.** A company that calls its field `sessionid` or
 *     `x-api-key` leaked it, because nobody could add a name without editing the
 *     tool.
 *   - **False positives.** `token_count` and `secretary` were redacted, so the
 *     one value someone actually needed was the one hidden from them. When a
 *     debugger hides data for no reason, people stop trusting the redaction and
 *     start working around it — which is worse than no redaction at all.
 *
 * So the config has two lists, and the allowlist wins:
 *
 *   - `names`: substrings that mark a field as sensitive (case-insensitive);
 *   - `allow`: substrings that exempt a field even when it matches `names`.
 *
 * Both are substring matches, because that is what catches `db_password_hash`
 * without enumerating every suffix. `allow` exists precisely because substring
 * matching is blunt: `token_count` matches `token`, and the allowlist is how you
 * say "not that one".
 *
 * This module is pure. Reading a config file lives in `loadRedactConfig` at the
 * bottom, which is the only part that touches the disk.
 */
import { readFileSync } from 'node:fs';

export interface RedactConfig {
  /** Substrings that mark a field name as sensitive. */
  names: string[];
  /** Substrings that exempt a field even when it matches `names`. */
  allow: string[];
}

/**
 * The defaults. Chosen to be boring: credential-shaped words that almost never
 * appear in a name the user wants to see the value of.
 */
export const DEFAULT_REDACT: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
];

export const EMPTY_CONFIG: RedactConfig = { names: [], allow: [] };

/** Normalise: lower-case, trim, drop empties, de-duplicate, keep order. */
export function normaliseList(list: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const v = String(raw).trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The config the agents start with: defaults, no allowlist. */
export function defaultConfig(): RedactConfig {
  return { names: normaliseList(DEFAULT_REDACT), allow: [] };
}

/**
 * Merge layers left to right.
 *
 * `names` accumulates (a config file can only *add* secrets — removing a default
 * would silently un-redact `password`, which is the one thing a config file must
 * not be able to do by accident); `allow` also accumulates, and always wins at
 * match time.
 */
export function mergeConfig(...layers: Array<Partial<RedactConfig> | undefined>): RedactConfig {
  const names: string[] = [];
  const allow: string[] = [];
  for (const layer of layers) {
    if (!layer) continue;
    for (const n of normaliseList(layer.names)) if (!names.includes(n)) names.push(n);
    for (const a of normaliseList(layer.allow)) if (!allow.includes(a)) allow.push(a);
  }
  return { names, allow };
}

/**
 * Is this field name sensitive?
 *
 * The allowlist is checked first and unconditionally: an exemption that only
 * applied when nothing else matched would be useless, since the whole point is
 * to override a match.
 */
export function isSensitiveName(name: string, config: RedactConfig): boolean {
  const lower = name.toLowerCase();
  if (config.allow.some((a) => a && lower.includes(a))) return false;
  return config.names.some((n) => n && lower.includes(n));
}

export type ConfigResult = { ok: true; config: RedactConfig } | { ok: false; error: string };

/**
 * Validate a parsed JSON config object.
 *
 * Both shapes are accepted, because a one-line config should be one line:
 *
 *   { "redact": ["sessionid"] }
 *   { "redact": { "names": ["sessionid"], "allow": ["token_count"] } }
 *
 * Anything else is an error with the field path, not a silent no-op — a typo in
 * a redaction config that is quietly ignored is how a secret ends up in a log.
 */
export function parseConfig(raw: unknown): ConfigResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'config must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const redact = obj.redact;

  if (redact === undefined) {
    // An empty object is a valid config: it means "defaults only".
    return { ok: true, config: EMPTY_CONFIG };
  }
  if (Array.isArray(redact)) {
    const bad = redact.find((x) => typeof x !== 'string');
    if (bad !== undefined) return { ok: false, error: 'redact[] must contain only strings' };
    return { ok: true, config: { names: normaliseList(redact as string[]), allow: [] } };
  }
  if (typeof redact !== 'object' || redact === null) {
    return { ok: false, error: 'redact must be an array of names or an object with names/allow' };
  }

  const spec = redact as Record<string, unknown>;
  const readList = (key: string): string[] | string => {
    const value = spec[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) return `redact.${key} must be an array of strings`;
    const bad = value.find((x) => typeof x !== 'string');
    if (bad !== undefined) return `redact.${key}[] must contain only strings`;
    return normaliseList(value as string[]);
  };

  const names = readList('names');
  if (typeof names === 'string') return { ok: false, error: names };
  const allow = readList('allow');
  if (typeof allow === 'string') return { ok: false, error: allow };

  const unknown = Object.keys(spec).filter((k) => k !== 'names' && k !== 'allow');
  if (unknown.length) return { ok: false, error: `unknown key(s) in redact: ${unknown.join(', ')}` };

  return { ok: true, config: { names, allow } };
}

/**
 * Read a config file.
 *
 * A missing file is an error rather than "use defaults": the user named a path,
 * and silently ignoring a typo would leave them believing a rule was in effect.
 */
export function loadRedactConfig(path: string): ConfigResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read ${path}: ${(err as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `${path} is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = parseConfig(raw);
  if (!parsed.ok) return { ok: false, error: `${path}: ${parsed.error}` };
  return parsed;
}

/** One line for the banner: what is in effect. */
export function describeConfig(config: RedactConfig): string {
  const names = config.names.length;
  const allow = config.allow.length;
  return `${names} redacted name${names === 1 ? '' : 's'}` + (allow ? `, ${allow} exempt` : '');
}
