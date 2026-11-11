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
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

declare global {
  // eslint-disable-next-line no-var
  var __NOLANGUAGE_EMBEDDED__: Record<string, string> | undefined;
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
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  if (!existsSync(target)) writeFileSync(target, source, 'utf8');
  cache.set(name, target);
  return target;
}

/** True when this process is running from a packaged executable. */
export function isPackaged(): boolean {
  return embeddedStore() !== undefined;
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
export function materializeAssets(prefix: string): string | undefined {
  const store = embeddedStore();
  if (!store) return undefined;
  const keys = Object.keys(store).filter((k) => k.startsWith(prefix));
  if (!keys.length) return undefined;
  const root = join(tmpdir(), 'nolanguage-embedded');
  for (const key of keys) {
    const target = join(root, key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, store[key], 'utf8');
  }
  return join(root, ...prefix.split('/').filter(Boolean));
}
