/**
 * User override layer: `<home>/overrides/<id>.json`.
 *
 * A plugin body is copied wholesale by `install()`, so editing
 * `languages/<id>@<ver>/manifest.json` is editing something the next upgrade
 * will replace. Overrides are a separate, per-plugin file that is merged onto
 * the manifest *after* it is read, before anything looks at it:
 *
 *   - the body stays byte-identical to what shipped (reinstall/upgrade safe);
 *   - the diff is one small file per plugin, reviewable and diffable;
 *   - `--dump-plugins` and `lang info` can say exactly which fields changed.
 *
 * Merge semantics are intentionally simple, because "why is this field 30s?"
 * must have a one-line answer:
 *
 *   - objects merge recursively;
 *   - arrays replace as a whole (no surprise index merging);
 *   - `null` deletes the key, so a field can be handed back to the manifest.
 *
 * An override that produces an invalid manifest is reported and ignored — a
 * typo must not take a language out of service.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateManifest, type LanguageManifest } from './manifest.js';

export interface OverrideFile {
  /** Absolute path, for `lang info` and the dump. */
  file: string;
  patch: Record<string, unknown>;
}

export interface OverrideMerge {
  manifest: LanguageManifest;
  /** Leaf paths the override changed (`lsp.command`, `run.timeoutMs`, …). */
  changed: string[];
  /** Leaf paths the override names but the manifest no longer has. */
  stale: string[];
  /** Set when the merged manifest failed validation; `manifest` is then the base. */
  problem?: string;
}

/** `<home>/overrides/<id>.json` — the only file users are meant to hand-edit. */
export function overridePath(home: string, id: string): string {
  return join(home, 'overrides', `${id}.json`);
}

/**
 * Read one override file. A missing file is `undefined`; a malformed one is
 * reported through `problem` so the caller can surface it instead of throwing.
 */
export async function readOverride(
  home: string,
  id: string,
): Promise<{ file: string; patch?: Record<string, unknown>; problem?: string }> {
  const file = overridePath(home, id);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { file };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { file, problem: 'override must be a JSON object' };
    }
    return { file, patch: parsed as Record<string, unknown> };
  } catch (err) {
    return { file, problem: `invalid JSON: ${(err as Error).message}` };
  }
}

/** Deep-merge `patch` onto `base` in place-free fashion (arrays replace). */
function merge(base: unknown, patch: unknown, path: string, changed: string[], stale: string[]): unknown {
  if (patch === null) {
    // `null` means "drop this key" — the manifest default applies again.
    if (isRecord(base)) changed.push(path);
    return undefined;
  }
  if (isRecord(patch)) {
    if (!isRecord(base)) {
      // A whole subtree appears that the manifest never had: valid for some
      // fields (`run.modes`), reported as stale only when the key is unknown.
      stale.push(path);
      return clone(patch);
    }
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      const child = path ? `${path}.${key}` : key;
      if (!(key in base)) {
        stale.push(child);
        out[key] = clone(value);
        continue;
      }
      const merged = merge(base[key], value, child, changed, stale);
      if (merged === undefined) delete out[key];
      else out[key] = merged;
    }
    return out;
  }
  if (!deepEqual(base, patch)) changed.push(path);
  return clone(patch);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge one plugin's override onto its manifest and say what changed. */
export function applyOverride(
  manifest: LanguageManifest,
  patch: Record<string, unknown>,
): OverrideMerge {
  const changed: string[] = [];
  const stale: string[] = [];
  const merged = merge(manifest as unknown, patch, '', changed, stale) as LanguageManifest;
  // `id` and `version` identify the plugin directory; letting an override
  // rename either would orphan `data/<id>/`, so they are not overridable.
  merged.id = manifest.id;
  merged.version = manifest.version;
  const validation = validateManifest(merged);
  if (!validation.ok) {
    const detail = validation.issues.map((i) => `${i.field}: ${i.message}`).join('; ');
    return { manifest, changed: [], stale, problem: `override rejected: ${detail}` };
  }
  return { manifest: merged, changed, stale };
}
