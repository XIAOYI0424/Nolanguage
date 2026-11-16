/**
 * Two ways to answer "what changed since the last index?".
 *
 * `GitDiffStrategy` is the good one: git already knows, exactly, and costs one
 * process. `ContentHashStrategy` is the honest fallback for a directory that is
 * not a checkout — mtime plus size is not a hash, but it is cheap and it catches
 * every edit a human makes.
 *
 * Both return a *report* rather than throwing: "I could not tell" is a valid
 * answer, and the manager has to distinguish it from "nothing changed" before it
 * decides whether to reuse an index.
 */
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { DirtyReport, IncrementalStrategy, IndexMetadata } from './types.js';

/** Directories that are never worth walking for source changes. */
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'target',
  'build',
  'dist',
  'out',
  'bin',
  'obj',
  '.gradle',
  '.idea',
  '.tmp',
  '.venv',
  '__pycache__',
]);

const MAX_FILES = 20_000;
const MAX_DEPTH = 8;

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

/** Run git without a shell, bounded, and never throw. */
function git(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, out: '', err: (err as Error).message });
      return;
    }
    let out = '';
    let err = '';
    const done = (ok: boolean): void => resolve({ ok, out, err });
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    child.on('error', (e) => {
      err += e.message;
      done(false);
    });
    child.on('close', (code) => done(code === 0));
  });
}

const toPosix = (p: string): string => p.split(sep).join('/');

export class GitDiffStrategy implements IncrementalStrategy {
  readonly kind = 'git-diff' as const;

  /**
   * Files that differ between the indexed commit and the working tree.
   *
   * `git diff <commit>` (not `<commit>..HEAD`) is deliberate: the two-dot form
   * compares two commits and would miss the edit the user just made, which is
   * the only change that matters while the editor is open.
   */
  async dirtyFiles(root: string, last: IndexMetadata | undefined): Promise<DirtyReport> {
    const commit = last?.indexedCommit;
    if (!commit) {
      return { files: [], source: 'none', reason: 'no indexed commit yet' };
    }
    const r = await git(root, ['diff', '--name-only', '--relative', commit, '--']);
    if (!r.ok) {
      const first = r.err.trim().split('\n')[0] ?? 'git failed';
      return { files: [], source: 'none', reason: first.slice(0, 160) };
    }
    const files = r.out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map(toPosix);
    return { files: [...new Set(files)], source: 'git' };
  }

  isLargeChange(dirty: DirtyReport, threshold: number): boolean {
    return dirty.files.length > threshold;
  }
}

export class ContentHashStrategy implements IncrementalStrategy {
  readonly kind = 'content-hash' as const;

  /** `relPath → "mtimeMs:size"` for every source-looking file under `root`. */
  async stampsFor(root: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let count = 0;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || count >= MAX_FILES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (count >= MAX_FILES) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const st = await stat(full);
          out[toPosix(relative(root, full))] = `${Math.round(st.mtimeMs)}:${st.size}`;
          count++;
        } catch {
          /* vanished between readdir and stat: not our problem */
        }
      }
    };

    await walk(root, 0);
    return out;
  }

  async dirtyFiles(root: string, last: IndexMetadata | undefined): Promise<DirtyReport> {
    if (!last?.stamps) {
      return { files: [], source: 'none', reason: 'no content stamps recorded yet' };
    }
    const now = await this.stampsFor(root);
    const files: string[] = [];
    for (const [rel, stamp] of Object.entries(now)) {
      if (last.stamps[rel] !== stamp) files.push(rel);
    }
    return { files, source: 'content-hash' };
  }

  isLargeChange(dirty: DirtyReport, threshold: number): boolean {
    return dirty.files.length > threshold;
  }
}

/**
 * Git first, stamps second.
 *
 * A checkout that loses its `.git` (an export, a tarball) must not silently stop
 * noticing changes, so the two are chained rather than chosen.
 */
export async function resolveDirty(
  strategies: { git: GitDiffStrategy; hash: ContentHashStrategy },
  root: string,
  last: IndexMetadata | undefined,
): Promise<DirtyReport> {
  const viaGit = await strategies.git.dirtyFiles(root, last);
  if (viaGit.source === 'git') return viaGit;
  const viaHash = await strategies.hash.dirtyFiles(root, last);
  if (viaHash.source !== 'none') return viaHash;
  return { files: [], source: 'none', reason: viaGit.reason ?? viaHash.reason };
}

/** Current HEAD, or null outside a checkout. */
export async function headCommit(root: string): Promise<string | null> {
  const r = await git(root, ['rev-parse', 'HEAD']);
  if (!r.ok) return null;
  const sha = r.out.trim().split('\n')[0];
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}
