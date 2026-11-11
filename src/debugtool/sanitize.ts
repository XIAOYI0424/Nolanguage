/**
 * Turn a recording into something safe to attach to a bug report.
 *
 * A `.ndlog` is faithful on purpose: it carries the handshake token, and the
 * values it recorded were redacted by *the rules in force at the time*. Both are
 * wrong for a file that leaves the machine.
 *
 * Three passes, each addressing a way the file can leak:
 *
 *   1. **The token goes.** It is in the header and in the recorded `hello`. It
 *      guards a socket that no longer exists, but it is still a credential, and
 *      a reader has no way to know it is dead.
 *   2. **Values are re-redacted with today's rules.** A recording made before a
 *      name was added to the list still contains that value; exporting it with
 *      the current config is the only way to be sure the file matches the policy
 *      the user believes is in effect.
 *   3. **Free text is scrubbed on request.** A secret can appear inside an
 *      exception message or a string value, where field-name matching cannot see
 *      it. That needs a pattern, so it is opt-in: `--scrub <regex>`.
 *
 * What this module does *not* do is guess. It will not look for "things that
 * look like keys" — a heuristic that silently misses is worse than one the user
 * configured, because it creates false confidence. The report says exactly what
 * was changed and how much.
 */
import type { Recording, RecordingHeader } from './recorder.js';
import type { SNode } from './protocol.js';
import { isSensitiveName, type RedactConfig } from './redact.js';

export interface SanitizeOptions {
  redact: RedactConfig;
  /** Patterns whose matches are replaced in every string value. */
  scrub?: RegExp[];
  /** Replacement for scrubbed text (default `[scrubbed]`). */
  placeholder?: string;
  /** Paths listed in the report (default 10). */
  maxSamples?: number;
}

export interface SanitizeReport {
  /** Event lines written (header not counted). */
  lines: number;
  /** True when the header carried a token and it was removed. */
  tokenRemoved: boolean;
  /** Recorded `hello` events that carried a token. */
  helloTokensRemoved: number;
  /** Value-tree fields hidden by the current redaction rules. */
  fieldsRedacted: number;
  /** String values (or messages) replaced by a scrub pattern. */
  valuesScrubbed: number;
  /** Lines that could not be parsed and were dropped. */
  dropped: number;
  /** A few of the paths that were changed, for the human reading the report. */
  samples: string[];
}

export interface SanitizeResult {
  header: RecordingHeader;
  lines: string[];
  report: SanitizeReport;
}

const DEFAULT_PLACEHOLDER = '[scrubbed]';

/** Apply every scrub pattern to one string. */
function scrubText(text: string, patterns: RegExp[], placeholder: string, onHit: () => void): string {
  let out = text;
  for (const re of patterns) {
    // A global regex keeps `lastIndex` between calls; reset it so the same
    // pattern behaves the same on every string.
    re.lastIndex = 0;
    if (re.test(out)) {
      re.lastIndex = 0;
      out = out.replace(re, placeholder);
      onHit();
    }
  }
  return out;
}

/**
 * Rewrite a value tree in place-free fashion.
 *
 * Returns a new tree; the original is left alone so a caller can compare them
 * (and so a bug in this function cannot corrupt the source recording).
 */
function sanitizeNode(
  node: SNode,
  config: RedactConfig,
  patterns: RegExp[],
  placeholder: string,
  state: { fields: number; values: number; samples: string[]; maxSamples: number },
  path: string,
  keyName?: string,
): SNode {
  const note = (p: string): void => {
    if (state.samples.length < state.maxSamples) state.samples.push(p);
  };

  // Already redacted: nothing to do, and counting it again would make the report
  // claim work that was done by the original session.
  if (node.k === 'trunc') return node;

  // The name check comes **before** the primitive branch. Putting it after meant
  // a string or number under `api_token` was scrubbed-but-not-redacted — the
  // single most common secret shape, and the one this whole module exists for.
  if (keyName !== undefined && isSensitiveName(keyName, config)) {
    state.fields += 1;
    note(path);
    return { k: 'trunc', why: 'redacted', t: node.k === 'prim' ? node.t : node.k === 'obj' ? node.t : node.k };
  }

  if (node.k === 'prim') {
    if (node.t !== 'str' || !patterns.length) return node;
    const next = scrubText(node.v, patterns, placeholder, () => {
      state.values += 1;
      note(path);
    });
    return next === node.v ? node : { ...node, v: next };
  }

  if (node.k === 'obj') {
    return {
      ...node,
      fields: node.fields.map(([name, child]): [string, SNode] => [
        name,
        sanitizeNode(child, config, patterns, placeholder, state, `${path}.${name}`, name),
      ]),
    };
  }
  if (node.k === 'map') {
    return {
      ...node,
      entries: node.entries.map(([key, child], i) => {
        // A dict keyed by name (`locals`) is the common case: the key *is* the
        // field name, so the value must be judged by it.
        const keyText = key.k === 'prim' ? key.v : '';
        return [
          sanitizeNode(key, config, patterns, placeholder, state, `${path}.key${i}`),
          sanitizeNode(child, config, patterns, placeholder, state, `${path}[${keyText || i}]`, keyText || undefined),
        ] as [SNode, SNode];
      }),
    };
  }
  if (node.k === 'seq') {
    return {
      ...node,
      items: node.items.map((child, i) => sanitizeNode(child, config, patterns, placeholder, state, `${path}[${i}]`)),
    };
  }
  return node;
}

/**
 * Sanitize a recording.
 *
 * The returned header keeps everything that makes the file useful (target, lang,
 * hz, when it started) and drops the one field that is a credential, plus a
 * `sanitized` block recording what was done — so a reader can tell a scrubbed
 * recording from a raw one.
 */
export function sanitizeRecording(rec: Recording, opts: SanitizeOptions): SanitizeResult {
  const placeholder = opts.placeholder ?? DEFAULT_PLACEHOLDER;
  const patterns = opts.scrub ?? [];
  const state = {
    fields: 0,
    values: 0,
    samples: [] as string[],
    maxSamples: opts.maxSamples ?? 10,
  };
  const report: SanitizeReport = {
    lines: 0,
    tokenRemoved: false,
    helloTokensRemoved: 0,
    fieldsRedacted: 0,
    valuesScrubbed: 0,
    dropped: 0,
    samples: [],
  };

  const header: RecordingHeader = { ...rec.header };
  if (header.token !== undefined) {
    delete header.token;
    report.tokenRemoved = true;
  }

  const lines: string[] = [];
  for (const line of rec.lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      report.dropped += 1;
      continue;
    }

    // The handshake carries the token too; a file with a token in `hello` is no
    // safer than one with it in the header.
    if (ev.t === 'hello' && typeof ev.token === 'string') {
      delete ev.token;
      report.helloTokensRemoved += 1;
    }

    if ((ev.t === 'snapshot' || ev.t === 'watch') && ev.value) {
      ev.value = sanitizeNode(
        ev.value as SNode,
        opts.redact,
        patterns,
        placeholder,
        state,
        String(ev.path ?? ev.id ?? '$'),
      );
    }

    if (ev.t === 'exception') {
      if (typeof ev.message === 'string' && patterns.length) {
        ev.message = scrubText(ev.message, patterns, placeholder, () => {
          state.values += 1;
          state.samples.length < state.maxSamples && state.samples.push('exception.message');
        });
      }
      if (typeof ev.type === 'string' && patterns.length) {
        ev.type = scrubText(ev.type, patterns, placeholder, () => {
          state.values += 1;
        });
      }
    }

    if (typeof ev.target === 'string' && patterns.length) {
      ev.target = scrubText(ev.target, patterns, placeholder, () => {
        state.values += 1;
      });
    }

    lines.push(JSON.stringify(ev));
  }

  report.lines = lines.length;
  report.fieldsRedacted = state.fields;
  report.valuesScrubbed = state.values;
  report.samples = state.samples;

  return {
    header: {
      ...header,
      sanitized: {
        at: Date.now(),
        fieldsRedacted: report.fieldsRedacted,
        valuesScrubbed: report.valuesScrubbed,
        tokenRemoved: report.tokenRemoved || report.helloTokensRemoved > 0,
      },
    },
    lines,
    report,
  };
}

/** The file body: one header line, then the sanitized events. */
export function renderSanitized(result: SanitizeResult): string {
  return [JSON.stringify(result.header), ...result.lines].join('\n') + '\n';
}

/** One line for the CLI. */
export function describeReport(report: SanitizeReport): string {
  const parts = [`${report.lines} events`];
  if (report.tokenRemoved) parts.push('token removed from header');
  if (report.helloTokensRemoved) parts.push(`token removed from ${report.helloTokensRemoved} hello`);
  if (report.fieldsRedacted) parts.push(`${report.fieldsRedacted} fields re-redacted`);
  if (report.valuesScrubbed) parts.push(`${report.valuesScrubbed} values scrubbed`);
  if (report.dropped) parts.push(`${report.dropped} unreadable lines dropped`);
  if (parts.length === 1) parts.push('nothing sensitive found');
  return parts.join(' · ');
}
