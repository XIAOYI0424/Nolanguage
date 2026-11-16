/**
 * FsService — the file-system backend behind the IDE's project explorer.
 *
 * The workspace already had *buffers* (one file per language, written by
 * `WorkspaceService`), but no way to look at the project or open anything
 * else. This service adds the explorer's read/write surface:
 *
 *   list(rel)            one directory level (the tree loads lazily)
 *   read(rel)            text content + a language hint
 *   write(rel, content)  save
 *   create(rel, kind)    new file / folder
 *   rename(from, to)
 *   remove(rel)
 *
 * ## Two rules that matter more than the features
 *
 * 1. **Everything is confined to the workspace root.** `rel` arrives from the
 *    browser, so it is untrusted: `resolveSafe()` rejects absolute paths, `..`
 *    escapes and symlink-free prefixes by comparing the *resolved* path against
 *    the resolved root. A path that escapes is an error, never a silent no-op.
 *
 * 2. **Nothing here is allowed to be slow or fatal.** A directory with a
 *    hundred thousand entries, a 2 GB log file, a locked file — the explorer
 *    must still render. Listing is bounded, reads are size-capped, and every
 *    syscall failure is reported as a per-entry status rather than thrown.
 */
import { readFile, writeFile, readdir, stat, mkdir, rename, rm, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { languageForName } from '../langs/extensionIndex.js';

/** One row in the explorer tree. */
export interface FsEntry {
  /** Name as shown in the tree. */
  name: string;
  /** Path relative to the workspace root, always `/`-separated. */
  path: string;
  kind: 'file' | 'dir';
  size: number;
  /** Last modification time, epoch ms. */
  mtime: number;
  /** True when the entry looks like something the editor can open as text. */
  editable: boolean;
}

export interface FsListing {
  /** The directory that was listed, relative to the root. */
  path: string;
  entries: FsEntry[];
  /** Set when the listing was cut short, so the UI can say so honestly. */
  truncated?: boolean;
}

export interface FsFile {
  path: string;
  name: string;
  content: string;
  size: number;
  mtime: number;
  /** Language id inferred from the extension, for the highlighter + LSP. */
  languageId?: string;
  /** True when the file was too large / binary and `content` is a placeholder. */
  truncated: boolean;
  /** Why the content is not the real thing (shown to the user). */
  note?: string;
}

export class FsError extends Error {
  constructor(
    message: string,
    readonly code: 'outside' | 'not-found' | 'is-dir' | 'exists' | 'too-large' | 'binary' | 'io',
  ) {
    super(message);
    this.name = 'FsError';
  }
}

/** Hard cap on a single directory listing. */
const MAX_ENTRIES = 5000;
/** Files above this are not read into the editor. */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** Only this much is sniffed when deciding whether a file is binary. */
const SNIFF_BYTES = 4096;

/**
 * Directories that are never worth showing and are expensive to walk: version
 * control internals and dependency caches. Kept in sync with the frontend's
 * `SKIP_DIRS` so the tree and the search agree.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.idea',
  '.vscode',
  '.nolanguage',
]);

/**
 * File name to language id.
 *
 * The mapping lives in `langs/extensionIndex.ts`, fed by the registry. This
 * used to be its own table — one of five copies that disagreed about `.ts`.
 */
export const languageOf = languageForName;

export class FsService {
  private rootDir: string;
  /** Resolved (symlink-free) root, the anchor for every containment check. */
  private realRoot: string;

  constructor(root: string) {
    this.rootDir = resolve(root);
    this.realRoot = this.rootDir;
  }

  get root(): string {
    return this.rootDir;
  }

  /** Point the explorer at a different folder. */
  async setRoot(dir: string): Promise<void> {
    const abs = resolve(dir);
    const info = await stat(abs).catch(() => undefined);
    if (!info) throw new FsError(`folder not found: ${abs}`, 'not-found');
    if (!info.isDirectory()) throw new FsError(`not a folder: ${abs}`, 'is-dir');
    this.rootDir = abs;
    // `realpath` collapses 8.3 short names and symlinks, so the containment
    // check compares like with like even on a path like C:\PROGRA~1.
    this.realRoot = await realpath(abs).catch(() => abs);
  }

  // ---------------- path safety ----------------

  /**
   * Resolve a client-supplied relative path against the root.
   *
   * Rejects anything that escapes: absolute paths and `..` traversal. The
   * comparison is done on the *resolved* strings so `a/../../b` cannot slip
   * through as a prefix match. Existence is deliberately *not* checked here —
   * every caller reports its own `not-found` with a message that names the
   * operation, which is more useful than a generic failure from this layer.
   */
  private resolveSafe(rel: string): string {
    const clean = String(rel ?? '').replace(/\\/g, '/').trim();
    if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) {
      throw new FsError(`absolute paths are not allowed: ${rel}`, 'outside');
    }
    // `..` segments are rejected outright rather than resolved: a legitimate
    // explorer never needs them, and allowing them makes the containment
    // argument much harder to keep true.
    const parts = clean.split('/').filter((p) => p && p !== '.');
    if (parts.some((p) => p === '..')) {
      throw new FsError(`path escapes the workspace: ${rel}`, 'outside');
    }

    const abs = resolve(this.rootDir, ...parts);
    const relToRoot = relative(this.rootDir, abs);
    if (relToRoot.startsWith('..') || (relToRoot && resolve(this.rootDir, relToRoot) !== abs)) {
      throw new FsError(`path escapes the workspace: ${rel}`, 'outside');
    }
    this.assertInsideRealRoot(abs, rel);
    return abs;
  }

  /**
   * A path that is inside the root *lexically* can still be outside it in fact.
   *
   * A symlink or an NTFS junction inside the tree resolves to wherever it
   * points, and `readFile` follows it — so `link/secret.txt` passed every check
   * above and read a file the workspace never contained. That is the whole
   * reason `realRoot` exists (`setRoot` calls `realpath` to keep it
   * symlink-free), and it went unused until a probe walked out of a scratch
   * workspace with one junction.
   *
   * `realpath` is applied to the deepest ancestor that exists rather than to the
   * path itself, because the leaf frequently does not exist yet (`create`,
   * `write` of a new file) and `realpath` on a missing path throws. Walking up
   * is sound: the missing tail cannot contain a link.
   *
   * Windows compares case-insensitively — `GetFinalPathNameByHandle` may return
   * a different case than the root was created with, and a false "outside" here
   * would make a legitimate folder unopenable.
   */
  private assertInsideRealRoot(abs: string, rel: string): void {
    const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
    const root = fold(this.realRoot);
    const prefix = root.endsWith(sep) ? root : root + sep;
    let probe = abs;
    for (;;) {
      let real: string;
      try {
        real = fold(realpathSync(probe));
      } catch {
        const parent = dirname(probe);
        if (parent === probe) {
          // Nothing on this path resolves — the drive itself is gone.
          throw new FsError(`cannot resolve the path for: ${rel}`, 'io');
        }
        probe = parent;
        continue;
      }
      if (real === root || real.startsWith(prefix)) return;
      throw new FsError(`path escapes the workspace through a link: ${rel}`, 'outside');
    }
  }

  /** `rel` in the wire format (`/`-separated, no leading slash). */
  private toRel(abs: string): string {
    const r = relative(this.rootDir, abs);
    return r.split(sep).join('/');
  }

  // ---------------- operations ----------------

  /** List one directory level. The tree expands lazily, so this is per-folder. */
  async list(rel = ''): Promise<FsListing> {
    const abs = this.resolveSafe(rel);
    const info = await stat(abs).catch(() => undefined);
    if (!info) throw new FsError(`no such folder: ${rel || '.'}`, 'not-found');
    if (!info.isDirectory()) throw new FsError(`not a folder: ${rel}`, 'is-dir');

    let names: string[];
    try {
      names = await readdir(abs);
    } catch (err) {
      throw new FsError(`cannot read folder: ${(err as Error).message}`, 'io');
    }

    const entries: FsEntry[] = [];
    let truncated = false;
    for (const name of names) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const childAbs = join(abs, name);
      // A single unreadable entry (a broken symlink, a permission wall) must
      // not abort the whole listing.
      const st = await stat(childAbs).catch(() => undefined);
      if (!st) continue;
      const isDir = st.isDirectory();
      if (isDir && SKIP_DIRS.has(name)) continue;
      entries.push({
        name,
        path: this.toRel(childAbs),
        kind: isDir ? 'dir' : 'file',
        size: isDir ? 0 : st.size,
        mtime: st.mtimeMs,
        editable: isDir ? false : this.looksTextual(name, st.size),
      });
    }

    // Directories first, then case-insensitive name — the ordering every IDE uses.
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return { path: this.toRel(abs), entries, truncated };
  }

  /**
   * Cheap pre-filter for the tree: an entry the editor will never open (a
   * multi-megabyte file) is marked non-editable so the row does not invite a
   * click that can only fail. The real decision is still the content sniff in
   * `read()` — this only avoids the obviously-hopeless case.
   */
  private looksTextual(_name: string, size: number): boolean {
    return size <= MAX_READ_BYTES;
  }

  /** Read a file as text, with a language hint for the editor. */
  async read(rel: string): Promise<FsFile> {
    const abs = this.resolveSafe(rel);
    const st = await stat(abs).catch(() => undefined);
    if (!st) throw new FsError(`no such file: ${rel}`, 'not-found');
    if (st.isDirectory()) throw new FsError(`not a file: ${rel}`, 'is-dir');

    const name = basename(abs);
    const base: Omit<FsFile, 'content' | 'truncated'> = {
      path: this.toRel(abs),
      name,
      size: st.size,
      mtime: st.mtimeMs,
      languageId: languageOf(name),
    };

    if (st.size > MAX_READ_BYTES) {
      return {
        ...base,
        content: '',
        truncated: true,
        note: `file is ${(st.size / 1048576).toFixed(1)} MB — too large to open (limit ${MAX_READ_BYTES / 1048576} MB)`,
      };
    }

    const buf = await readFile(abs).catch((err) => {
      throw new FsError(`cannot read file: ${(err as Error).message}`, 'io');
    });
    if (isBinary(buf)) {
      return {
        ...base,
        content: '',
        truncated: true,
        note: `binary file (${st.size} bytes) — not shown in the editor`,
      };
    }

    return { ...base, content: buf.toString('utf8'), truncated: false };
  }

  /** Save text to a file, creating it when absent. */
  async write(rel: string, content: string): Promise<FsFile> {
    const abs = this.resolveSafe(rel);
    const st = await stat(abs).catch(() => undefined);
    if (st?.isDirectory()) throw new FsError(`not a file: ${rel}`, 'is-dir');
    // Saving into a folder that was never created is a normal thing to do
    // (mkdir + write), so the parent is created rather than rejected.
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content ?? '', 'utf8').catch((err) => {
      throw new FsError(`cannot save file: ${(err as Error).message}`, 'io');
    });
    const after = await stat(abs).catch(() => undefined);
    return {
      path: this.toRel(abs),
      name: basename(abs),
      content: content ?? '',
      size: after?.size ?? Buffer.byteLength(content ?? '', 'utf8'),
      mtime: after?.mtimeMs ?? Date.now(),
      languageId: languageOf(basename(abs)),
      truncated: false,
    };
  }

  /** Create an empty file, or a folder. Fails if the target already exists. */
  async create(rel: string, kind: 'file' | 'dir'): Promise<FsEntry> {
    const abs = this.resolveSafe(rel);
    if (await exists(abs)) throw new FsError(`already exists: ${rel}`, 'exists');
    await mkdir(dirname(abs), { recursive: true });
    if (kind === 'dir') {
      await mkdir(abs, { recursive: true });
    } else {
      await writeFile(abs, '', 'utf8');
    }
    const st = await stat(abs).catch(() => undefined);
    return {
      name: basename(abs),
      path: this.toRel(abs),
      kind,
      size: 0,
      mtime: st?.mtimeMs ?? Date.now(),
      editable: kind === 'file',
    };
  }

  /** Rename / move within the workspace. */
  async rename(from: string, to: string): Promise<FsEntry> {
    const absFrom = this.resolveSafe(from);
    const absTo = this.resolveSafe(to);
    if (absFrom === absTo) {
      const st = await stat(absFrom);
      return {
        name: basename(absFrom),
        path: this.toRel(absFrom),
        kind: st.isDirectory() ? 'dir' : 'file',
        size: st.size,
        mtime: st.mtimeMs,
        editable: !st.isDirectory(),
      };
    }
    if (await exists(absTo)) throw new FsError(`already exists: ${to}`, 'exists');
    // Moving a folder into its own descendant would detach the subtree.
    if (absTo.startsWith(absFrom + sep)) {
      throw new FsError('cannot move a folder into itself', 'io');
    }
    await mkdir(dirname(absTo), { recursive: true });
    await rename(absFrom, absTo).catch((err) => {
      throw new FsError(`cannot rename: ${(err as Error).message}`, 'io');
    });
    const st = await stat(absTo).catch(() => undefined);
    return {
      name: basename(absTo),
      path: this.toRel(absTo),
      kind: st?.isDirectory() ? 'dir' : 'file',
      size: st?.size ?? 0,
      mtime: st?.mtimeMs ?? Date.now(),
      editable: !st?.isDirectory(),
    };
  }

  /** Delete a file or a folder (recursively). */
  async remove(rel: string): Promise<{ path: string }> {
    const abs = this.resolveSafe(rel);
    if (abs === this.rootDir) throw new FsError('refusing to delete the workspace root', 'outside');
    // Probe first: without this, `rm` turns "it was already gone" into a generic
    // ENOENT that gets reported as an I/O failure, and the two mean very
    // different things to the user.
    if (!(await exists(abs))) throw new FsError(`no such file or folder: ${rel}`, 'not-found');
    await rm(abs, { recursive: true, force: false }).catch((err) => {
      throw new FsError(`cannot delete: ${(err as Error).message}`, 'io');
    });
    return { path: this.toRel(abs) };
  }

  /**
   * The folder the explorer should open first: the workspace root. Exposed so
   * the UI can render a "project" root row without a round-trip.
   */
  describe(): { root: string; name: string } {
    return { root: this.rootDir, name: basename(this.rootDir) || this.rootDir };
  }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/**
 * Heuristic binary sniff: a NUL byte in the first few KB. Text files never
 * contain one, and this is what `git` itself uses.
 */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
