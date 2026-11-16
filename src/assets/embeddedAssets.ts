/**
 * Embedded assets (packaged build).
 *
 * `Nolanguage.exe` carries its JavaScript as a single SEA blob, so files that
 * the runtime would otherwise read off disk (the built-in Python language
 * server, `src/python/pyrightServer.py`) have to travel with it. The build
 * script inlines them into a prelude that defines
 * `globalThis.__NOLANGUAGE_EMBEDDED__`; at runtime they are materialised into a
 * per-user temp directory on first use.
 *
 * When the sources are run directly from `src/` nothing is embedded, so the
 * loader falls back to the real file on disk.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

declare global {
  // eslint-disable-next-line no-var
  var __NOLANGUAGE_EMBEDDED__: Record<string, string> | undefined;
}

/**
 * A materialisation failure, carrying which asset it was.
 *
 * `assets` sits at the bottom of the layer order and may not import the logger,
 * so the diagnosis travels on the error instead: the caller (which is allowed to
 * log) reads `asset` and records it. Without this the message said only
 * "EPERM ... extension.json" with no way to tell which of several hundred
 * bundled files it meant.
 */
export interface EmbeddedAssetError extends Error {
  asset?: string;
  assetRoot?: string;
}

let cache: Map<string, string> | undefined;

function embeddedStore(): Record<string, string> | undefined {
  return typeof globalThis.__NOLANGUAGE_EMBEDDED__ === 'object'
    ? globalThis.__NOLANGUAGE_EMBEDDED__
    : undefined;
}

/**
 * Local filesystem path for a bundled asset, or `undefined` when this is not a
 * packaged build. The file is written once and reused for the process lifetime.
 */
export function embeddedAssetPath(name: string): string | undefined {
  const store = embeddedStore();
  if (!store) return undefined;
  const source = store[name];
  if (typeof source !== 'string') return undefined;

  cache ??= new Map();
  const hit = cache.get(name);
  if (hit && existsSync(hit)) return hit;

  const dir = join(tmpdir(), 'nolanguage-embedded');
  const target = join(dir, name);
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(target)) writeFileSync(target, source, 'utf8');
  } catch (err) {
    // Annotate and rethrow: behaviour is unchanged, but the caller can now say
    // *which* asset was refused.
    const e = err as EmbeddedAssetError;
    e.asset = name;
    e.assetRoot = dir;
    throw e;
  }
  cache.set(name, target);
  return target;
}

/**
 * True when `target` already holds `text`.
 *
 * Embedded assets are build constants, so a second launch has nothing to write.
 * Skipping the write is not just an optimisation: on Windows an existing file
 * can be locked (a running extension host, a scanner) and `writeFileSync` then
 * fails with EPERM — which used to abort the whole launch even though the cache
 * was perfectly good.
 */
function alreadyThere(target: string, text: string): boolean {
  try {
    return readFileSync(target, 'utf8') === text;
  } catch {
    return false;
  }
}

/** True when this process is running from a packaged executable. */
export function isPackaged(): boolean {
  return embeddedStore() !== undefined;
}

export interface MaterializeOptions {
  /** Primary root. Defaults to `<tmp>/nolanguage-embedded`; tests override it. */
  root?: string;
  /**
   * Where to write when the primary refuses. Supplied by the caller because the
   * app-data root lives in `util`, and `assets` sits at the same layer as it —
   * an import would be an upward edge the architecture gate rejects.
   */
  fallbackRoot?: string;
}

/**
 * Materialise every embedded asset whose key starts with `prefix` and return
 * the directory they landed in (or `undefined` outside a packaged build).
 *
 * Keys carry their relative path (`extensions/examples/hello/extension.json`),
 * so the whole tree is recreated under one temp root. Used to ship the built-in
 * demo extensions inside the executable: the extension host child process
 * imports them by path, and a path is the only thing `import()` accepts.
 */
export function materializeAssets(prefix: string, opts: MaterializeOptions = {}): string | undefined {
  const store = embeddedStore();
  if (!store) return undefined;
  const keys = Object.keys(store).filter((k) => k.startsWith(prefix));
  if (!keys.length) return undefined;

  // `%TEMP%` is the natural home, but it is not always writable: a scanner can
  // hold a file, a roaming profile can arrive read-only, and the directory may
  // belong to a different account after an update. Falling back to the app data
  // root keeps the app starting; failing outright does not.
  const roots = [opts.root ?? join(tmpdir(), 'nolanguage-embedded'), opts.fallbackRoot].filter((r): r is string => !!r);
  let last: unknown;
  for (const root of roots) {
    try {
      for (const key of keys) {
        const target = join(root, key);
        mkdirSync(dirname(target), { recursive: true });
        if (!alreadyThere(target, store[key])) writeFileSync(target, store[key], 'utf8');
      }
      return join(root, ...prefix.split('/').filter(Boolean));
    } catch (err) {
      last = err;
    }
  }
  const e = last as EmbeddedAssetError;
  e.assetRoot = roots[roots.length - 1];
  throw e;
}
