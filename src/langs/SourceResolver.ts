/**
 * Turn "what the user typed" into a directory that holds a `manifest.json`.
 *
 * `LanguageRegistry.install()` only accepts a directory, which is the right
 * constraint — validation, migrations and the `data/` protection all hang off
 * that one shape. Everything else a user might reasonably have (a zip, a
 * tarball, a URL, a git repo) is resolved *here*, down to a plain directory,
 * and then handed to the existing install path unchanged.
 *
 *   directory   -> used in place (never deleted)
 *   .zip        -> inflated to a temp dir
 *   .tar/.tgz   -> untarred (and gunzipped) to a temp dir
 *   git URL     -> shallow clone into a temp dir
 *   http(s) URL -> downloaded, then treated as an archive
 *
 * Two rules are non-negotiable because the payload is plugin code:
 *
 *   1. **No archive entry may escape the destination.** `..`, absolute paths,
 *      drive letters and symlinks are rejected before anything is written —
 *      the usual "zip slip", but for a plugin that will later be executed.
 *   2. **Everything fetched is bounded.** A download has a timeout, a byte cap
 *      and a redirect limit, and only http/https are allowed.
 *
 * Zero dependencies: tar is parsed by hand, zip is read through `zlib`
 * (`inflateRaw`), downloads use `node:http`/`node:https`, and git is a normal
 * subprocess. This file is the only place that knows those details.
 */
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

/** What a source string looks like, decided without touching the network. */
export type SourceKind = 'dir' | 'zip' | 'tar' | 'git' | 'url' | 'unknown';

export interface ResolvedSource {
  /** A directory containing `manifest.json` — ready for `registry.install()`. */
  dir: string;
  /**
   * True when we created `dir` and therefore must delete it. A source that was
   * already a directory on disk is the user's, never ours to remove.
   */
  temp: boolean;
  /** Exactly what the user asked for, so an update can repeat it later. */
  origin: string;
  kind: SourceKind;
}

export interface ResolveOptions {
  /** Refuse archives larger than this (default 200 MB). */
  maxBytes?: number;
  /** Per-request timeout for downloads (default 30 s). */
  timeoutMs?: number;
  /** `git clone` timeout (default 120 s). */
  gitTimeoutMs?: number;
}

/** A source problem, as opposed to a registry problem. */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

/**
 * Classify a source string. Pure: no I/O beyond a `stat`, so it can be tested
 * without a network and without writing anything.
 */
export function classifySource(target: string): SourceKind {
  const t = target.trim();
  if (!t) return 'unknown';

  // git@host:path/repo.git
  if (/^git@[\w.-]+:.+/.test(t)) return 'git';
  if (/^ssh:\/\//i.test(t)) return 'git';
  if (/^git:\/\//i.test(t)) return 'git';
  // https://host/repo.git — but not https://host/repo.git.zip
  if (/^https?:\/\//i.test(t)) {
    return /\.git(?:[#/?]|$)/i.test(t) ? 'git' : 'url';
  }

  if (existsSync(t)) {
    let isDir = false;
    try {
      isDir = statSync(t).isDirectory();
    } catch {
      return 'unknown';
    }
    if (isDir) return 'dir';
    const lower = t.toLowerCase();
    if (lower.endsWith('.zip')) return 'zip';
    if (/\.(?:tar|tgz|tar\.gz|tar\.bz2)$/.test(lower)) return 'tar';
  }
  return 'unknown';
}

/**
 * Resolve `target` into a directory with a manifest.
 *
 * The caller owns the result: when `temp` is true it must call
 * `disposeSource()` (in a `finally`) once the install is done.
 */
export async function resolveSource(target: string, opts: ResolveOptions = {}): Promise<ResolvedSource> {
  const kind = classifySource(target);

  if (kind === 'dir') {
    const dir = resolve(target);
    if (!existsSync(join(dir, 'manifest.json'))) {
      throw new SourceError(`no manifest.json in ${dir}`);
    }
    return { dir, temp: false, origin: target, kind };
  }

  if (kind === 'zip' || kind === 'tar') {
    const dir = await unpackArchive(target, kind);
    return finish(dir, target, kind);
  }

  if (kind === 'git') {
    const dir = await gitClone(target, opts.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
    return finish(dir, target, kind);
  }

  if (kind === 'url') {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { file, name } = await download(target, { maxBytes, timeoutMs });
    // The name in the URL decides how to unpack; a bare URL with no extension
    // is refused rather than guessed at, because guessing means executing.
    const lower = name.toLowerCase();
    if (lower.endsWith('.zip')) {
      const dir = await unpackArchive(file, 'zip');
      await safeRm(file);
      return finish(dir, target, kind);
    }
    if (/\.(?:tar|tgz|tar\.gz|tar\.bz2)$/.test(lower)) {
      const dir = await unpackArchive(file, 'tar');
      await safeRm(file);
      return finish(dir, target, kind);
    }
    await safeRm(file);
    throw new SourceError(
      `cannot tell what ${name} is — point the URL at a .zip/.tar.gz archive, or at a git repository (…/repo.git)`,
    );
  }

  throw new SourceError(
    `cannot install from "${target}" — expected a directory, a .zip/.tar.gz, a git URL, or an http(s) archive URL`,
  );
}

/** Delete a resolved source, but only the ones we created. */
export async function disposeSource(source: ResolvedSource): Promise<void> {
  if (source.temp) await safeRm(source.dir);
}

async function safeRm(path: string): Promise<void> {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // A temp directory we cannot remove is not worth failing an install over.
  }
}

/**
 * Archives usually wrap everything in one folder. Accept a manifest at the root
 * or in a single top-level folder; anything else is reported, not guessed.
 */
async function finish(dir: string, origin: string, kind: SourceKind): Promise<ResolvedSource> {
  const root = join(dir, 'manifest.json');
  if (existsSync(root)) return { dir, temp: true, origin, kind };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const folders = entries.filter((e) => e.isDirectory());
  for (const folder of folders) {
    const nested = join(dir, folder.name);
    if (existsSync(join(nested, 'manifest.json'))) return { dir: nested, temp: true, origin, kind };
  }
  await safeRm(dir);
  throw new SourceError('the source has no manifest.json — not at its root, and not in any top-level folder');
}

// ---------------------------------------------------------------- archives

async function unpackArchive(file: string, kind: 'zip' | 'tar'): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), 'nlg-lang-'));
  try {
    // Read through the cap first: an archive is untrusted input.
    const maxBytes = DEFAULT_MAX_BYTES;
    const size = statSync(file).size;
    if (size > maxBytes) {
      throw new SourceError(`archive is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
    }
    const raw = readFileSync(file);
    const entries = kind === 'zip' ? parseZip(raw) : parseTar(untarMaybeGunzip(raw, file));
    writeEntries(entries, dest);
    return dest;
  } catch (err) {
    await safeRm(dest);
    throw err instanceof SourceError ? err : new SourceError(`could not unpack ${basename(file)}: ${(err as Error).message}`);
  }
}

function untarMaybeGunzip(buf: Buffer, file: string): Buffer {
  const lower = file.toLowerCase();
  if (lower.endsWith('.gz') || lower.endsWith('.tgz')) return gunzipSync(buf);
  if (lower.endsWith('.bz2')) {
    throw new SourceError('.tar.bz2 is not supported — use .tar.gz or .zip');
  }
  return buf;
}

interface ArchiveEntry {
  name: string;
  kind: 'file' | 'dir';
  data: Buffer;
}

/**
 * Resolve an archive entry name inside `root`, or null when it would land
 * outside. A plugin archive is code we will run, so this is the one place a
 * hostile entry name is allowed to fail loudly.
 */
export function safeJoin(root: string, name: string): string | null {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized) return null;
  if (normalized.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter((p) => p.length > 0 && p !== '.');
  for (const part of parts) {
    if (part === '..') return null;
  }
  if (!parts.length) return null;
  const rootAbs = resolve(root);
  const out = resolve(join(rootAbs, ...parts));
  if (out !== rootAbs && !out.startsWith(rootAbs + sep)) return null;
  return out;
}

function writeEntries(entries: ArchiveEntry[], dest: string): void {
  for (const entry of entries) {
    const target = safeJoin(dest, entry.name);
    if (!target) {
      throw new SourceError(`archive entry "${entry.name}" would escape the destination — rejected`);
    }
    if (entry.kind === 'dir') {
      mkdirSyncRecursive(target);
      continue;
    }
    mkdirSyncRecursive(dirname(target));
    writeFileSync(target, entry.data);
  }
}

function mkdirSyncRecursive(dir: string): void {
  // `mkdir -p` without pulling in a helper module.
  const parts: string[] = [];
  let current = resolve(dir);
  while (!existsSync(current)) {
    parts.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const part of parts) {
    try {
      mkdirSync(part);
    } catch {
      // Another entry created it first — that is fine.
    }
  }
}

/** Minimal tar reader: ustar, plus GNU long names and pax `path=`. */
function parseTar(buf: Buffer): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    let zero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        zero = false;
        break;
      }
    }
    if (zero) break; // two zero blocks end the archive

    const field = (start: number, len: number): string => {
      const raw = header.subarray(start, start + len);
      const end = raw.indexOf(0);
      return raw.subarray(0, end < 0 ? len : end).toString('utf8');
    };

    let name = field(0, 100);
    const sizeField = field(124, 12).replace(/[^0-7]/g, '');
    const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = field(345, 155);
    if (prefix) name = `${prefix}/${name}`;

    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    const next = dataStart + Math.ceil(size / 512) * 512;

    // 'L' (GNU long name) and 'x'/'g' (pax) describe the *next* entry.
    if (typeflag === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      offset = next;
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (match) paxPath = match[1] ?? null;
      offset = next;
      continue;
    }
    if (typeflag === '1' || typeflag === '2') {
      throw new SourceError(`archive contains a link entry ("${name}") — refused`);
    }

    const finalName = longName ?? paxPath ?? name;
    longName = null;
    paxPath = null;

    if (typeflag === '5') {
      out.push({ name: finalName, kind: 'dir', data: Buffer.alloc(0) });
    } else if (typeflag === '0' || typeflag === '\u0000' || typeflag === '7') {
      out.push({ name: finalName, kind: 'file', data: Buffer.from(data) });
    }
    offset = next;
  }
  return out;
}

/** Minimal zip reader: central directory + stored(0)/deflate(8) entries. */
function parseZip(buf: Buffer): ArchiveEntry[] {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;

  let eocd = -1;
  const floor = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SourceError('not a zip archive (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out: ArchiveEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CENTRAL) {
      throw new SourceError('malformed zip archive (bad central directory)');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compressed = buf.readUInt32LE(ptr + 20);
    const uncompressed = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new SourceError(`zip64 entry "${name}" is not supported`);
    }
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL) {
      throw new SourceError(`malformed zip archive (bad local header for "${name}")`);
    }
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressed);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch (err) {
        throw new SourceError(`could not inflate "${name}": ${(err as Error).message}`);
      }
    } else {
      throw new SourceError(`unsupported compression method ${method} for "${name}"`);
    }

    out.push({ name, kind: name.endsWith('/') ? 'dir' : 'file', data });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------- network

interface DownloadResult {
  file: string;
  name: string;
}

async function download(url: string, opts: { maxBytes: number; timeoutMs: number }): Promise<DownloadResult> {
  const dest = join(mkdtempSync(join(tmpdir(), 'nlg-dl-')), 'payload');
  let current = url;
  let name = '';
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await attempt(current, dest, opts);
    if (result.ok) {
      name = result.name || name;
      return { file: dest, name };
    }
    current = result.location ?? '';
  }
  await safeRm(dirname(dest));
  throw new SourceError(`too many redirects (more than ${MAX_REDIRECTS})`);
}

interface AttemptResult {
  ok: boolean;
  location?: string;
  name?: string;
}

function attempt(url: string, dest: string, opts: { maxBytes: number; timeoutMs: number }): Promise<AttemptResult> {
  return new Promise((res, rej) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      rej(new SourceError(`not a valid URL: ${url}`));
      return;
    }
    // Only http/https: a plugin must not be fetched over file:// or ftp:.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      rej(new SourceError(`refusing to download from ${parsed.protocol}`));
      return;
    }
    const lib = parsed.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = lib(parsed, {
      timeout: opts.timeoutMs,
      headers: { 'user-agent': 'nolanguage/lang-install', accept: '*/*' },
    }, (response) => {
      const code = response.statusCode ?? 0;
      const location = response.headers.location;
      if (code >= 300 && code < 400 && location) {
        response.resume();
        try {
          res({ ok: false, location: new URL(location, parsed).toString() });
        } catch {
          rej(new SourceError(`bad redirect target: ${location}`));
        }
        return;
      }
      if (code < 200 || code >= 300) {
        response.resume();
        rej(new SourceError(`download failed: HTTP ${code}`));
        return;
      }
      const ws = createWriteStream(dest);
      let seen = 0;
      response.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > opts.maxBytes) {
          response.destroy();
          ws.destroy();
          void safeRm(dest);
          rej(new SourceError(`download exceeds the ${Math.round(opts.maxBytes / 1024 / 1024)} MB limit`));
        }
      });
      response.on('error', rej);
      ws.on('error', rej);
      ws.on('finish', () => {
        ws.close(() => res({ ok: true, name: basename(parsed.pathname) || `payload${extname(parsed.pathname)}` }));
      });
      response.pipe(ws);
    });
    req.on('timeout', () => req.destroy(new SourceError('download timed out')));
    req.on('error', rej);
    req.end();
  });
}

function gitClone(url: string, timeoutMs: number): Promise<string> {
  // A leading dash would be parsed as a git option rather than a URL.
  if (url.startsWith('-')) {
    throw new SourceError(`refusing a git URL that starts with "-": ${url}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'nlg-git-'));
  return new Promise((res, rej) => {
    const child = spawn('git', ['clone', '--depth', '1', '--', url, dir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let err = '';
    child.stderr?.on('data', (c: Buffer) => {
      if (err.length < 4096) err += c.toString('utf8');
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      void safeRm(dir);
      rej(new SourceError('git clone timed out'));
    }, timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void safeRm(dir);
      rej(new SourceError(e.code === 'ENOENT' ? 'git is not installed or not on PATH' : `git failed to start: ${e.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        res(dir);
        return;
      }
      void safeRm(dir);
      rej(new SourceError(`git clone failed (exit ${code})${err.trim() ? `: ${err.trim()}` : ''}`));
    });
  });
}
