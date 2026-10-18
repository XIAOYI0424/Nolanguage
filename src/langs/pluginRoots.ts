/**
 * Where language plugins are looked for.
 *
 * A `LanguageRegistry` owns two roots of its own (`<home>/builtin` and
 * `<home>/languages`); everything else is supplied by the host through
 * `extraRoots`. This module is that one place, shared by the panel server, the
 * CLI (`Nolanguage.exe lang …`) and `--dump-plugins`, so the three can never
 * disagree about which directory a plugin came from.
 *
 * Order matters: `LanguageRegistry.scan()` keeps the *highest version* per id
 * and, on a version tie, the root that was scanned first. Built-in roots
 * therefore precede user roots, which precede `LANG_DIR` — an official plugin
 * cannot be shadowed by a stale copy of itself with the same version.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeAssets } from '../desktop/embeddedAssets.js';
import type { RegistryRoot } from './Registry.js';

/**
 * Directory of this module. `import.meta.url` is not a `file://` URL inside the
 * SEA bundle (esbuild emits CommonJS there), so fall back to the cwd instead of
 * throwing at load time — the packaged build finds its plugins through
 * `materializeAssets()` anyway.
 */
function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/** Split `LANG_DIR`-style lists (`:`/`;` separated) into non-empty entries. */
export function splitEnvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[:;]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Extra roots for the official plugins: `LANG_DIR`, the repo's `builtin/`
 * (source runs), and the assets embedded in a packaged executable.
 *
 * These are read-only (`removable: false`): an official plugin is disabled,
 * never uninstalled — otherwise the next upgrade would silently bring it back.
 */
export function officialRoots(): RegistryRoot[] {
  const fromEnv = splitEnvList(process.env.LANG_DIR).map((p) => ({
    dir: resolve(p),
    kind: 'builtin' as const,
    removable: false,
  }));
  // Two levels up from this module is the repo root in a source run; in a
  // packaged build the cwd candidate and the embedded assets cover it.
  const repo = [join(moduleDir(), '..', '..', 'builtin'), join(process.cwd(), 'builtin')]
    .filter((d) => existsSync(d))
    .map((d) => ({ dir: resolve(d), kind: 'builtin' as const, removable: false }));
  const unpacked = materializeAssets('builtin');
  const embedded: RegistryRoot[] = unpacked
    ? [{ dir: unpacked, kind: 'builtin', removable: false }]
    : [];

  const seen = new Set<string>();
  return [...fromEnv, ...repo, ...embedded].filter((r) => {
    const key = r.dir.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


