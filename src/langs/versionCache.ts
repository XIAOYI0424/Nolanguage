/**
 * Toolchain versions, cached by signature.
 *
 * `status()` is synchronous and the UI polls it, so a language's version has to
 * be known before the first render — which today means a `--version` spawn per
 * language during `init()`. Measured here: 58–149 ms each, 607 ms across nine
 * manifests run one after another. That is the single largest avoidable cost in
 * a warm launch.
 *
 * A version string can only change when the binary does, so the cache is keyed
 * by the binary's *signature* — path, size, mtime, and the arguments used. No
 * TTL: a toolchain that has not changed does not need re-probing, and one that
 * has changed is caught by the signature rather than by a timer that would be
 * either too eager (re-probe a stable install) or too lazy (miss an upgrade).
 *
 * Failure is not cached. A binary that cannot answer `--version` today might
 * answer after the user fixes their PATH, and remembering "broken" would hide
 * exactly the fix they just made.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { probeVersion } from './discover.js';

/** Bump when the file's shape changes; old files are then simply ignored. */
export const VERSION_CACHE_SCHEMA = 1;

export interface ToolchainVersionEntry {
  /** What the probe printed, e.g. `Python 3.13.14`. */
  version: string;
  /** `toolchainSignature()` at the time it was probed. */
  signature: string;
}

interface CacheFile {
  schema: number;
  entries: Record<string, ToolchainVersionEntry>;
}

/** `<home>/cache/toolchain-versions.json` — one file for every language. */
export function versionCachePath(home: string): string {
  return join(home, 'cache', 'toolchain-versions.json');
}

/**
 * Identity of a toolchain binary: path, size, mtime, and the arguments used.
 *
 * `missing` is a real value, not an error path: a binary that disappeared must
 * not match the entry written when it was still there.
 */
export function toolchainSignature(bin: string, args: string[] = []): string {
  try {
    const st = statSync(bin);
    return createHash('sha256')
      .update(`${bin}\n${st.size}\n${Math.round(st.mtimeMs)}\n${args.join('\0')}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
  } catch {
    return 'missing';
  }
}

/**
 * Parsed files, per path.
 *
 * One entry per home in practice, and the map keeps a launch from re-reading the
 * file for every language. A stale in-memory copy is harmless: the signature is
 * checked against the binary as it is *now*, so a file written by another
 * process only costs one extra probe.
 */
const files = new Map<string, CacheFile>();

function load(path: string): CacheFile {
  const cached = files.get(path);
  if (cached) return cached;
  let file: CacheFile = { schema: VERSION_CACHE_SCHEMA, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheFile>;
    if (parsed.schema === VERSION_CACHE_SCHEMA && parsed.entries && typeof parsed.entries === 'object') {
      file = { schema: VERSION_CACHE_SCHEMA, entries: parsed.entries };
    }
  } catch {
    // Missing, unreadable or corrupt: a cache is an optimisation, never a
    // source of truth, so the answer is "probe it".
  }
  files.set(path, file);
  return file;
}

function save(path: string, file: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Write then rename: a half-written JSON file would be read as corrupt on
    // the next launch and cost a full re-probe of every language.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  } catch {
    // A read-only profile must not fail a launch because of a cache write.
  }
}

export interface CachedVersionOptions {
  /** `LanguageRegistry.home`; the cache lives under it. */
  home: string;
  /** Language id — the key. One toolchain per language. */
  id: string;
  bin: string;
  args: string[];
  /** Injected by tests; defaults to the real probe. */
  probe?: (bin: string, args: string[]) => Promise<string | null>;
}

/**
 * The version, from the cache when the binary has not changed.
 *
 * Returns `null` when the probe fails, and does not cache that.
 */
export async function cachedVersion(opts: CachedVersionOptions): Promise<string | null> {
  if (!opts.bin) return null;
  const path = versionCachePath(opts.home);
  const file = load(path);
  const signature = toolchainSignature(opts.bin, opts.args);
  const hit = file.entries[opts.id];
  if (hit && hit.signature === signature) return hit.version;
  const probe = opts.probe ?? probeVersion;
  const version = await probe(opts.bin, opts.args);
  if (version) {
    file.entries[opts.id] = { version, signature };
    save(path, file);
  }
  return version;
}
