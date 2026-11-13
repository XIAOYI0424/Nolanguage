import { spawn } from 'node:child_process';

/**
 * Git probe (Stage 6 · 基线系统).
 *
 * The correlation skeleton (spec 二十二) needs `gitCommit` on every perf + log
 * record, and the auto-baseline mechanism (spec 十: "每次 Git commit 创建基线")
 * needs to know *which* commit the current metrics belong to.
 *
 * Everything here is **async `spawn`**, never `execSync` / `spawnSync`: this
 * runtime returns `EBUSY` for every synchronous child process, which would
 * silently degrade `gitCommit` to `'unknown'` forever.
 */

export interface GitInfo {
  /** The `git` binary answered at all. */
  available: boolean;
  /** cwd is inside a git work tree. */
  repo: boolean;
  /** Full 40-char SHA, or `'unknown'` on an unborn branch (no commits yet). */
  commit: string;
  /** Abbreviated SHA, or `'unknown'`. */
  shortCommit: string;
  /** Branch name; `HEAD` when detached. */
  branch: string;
  /** Working tree has staged / unstaged / untracked changes. */
  dirty: boolean;
  /** Number of changed paths reported by `git status`. */
  changedFiles: number;
  /** First line of the commit message; empty on an unborn branch. */
  subject: string;
  /** Commit time in epoch ms; 0 on an unborn branch. */
  commitTime: number;
  /** Absolute path to the work tree root; '' when not a repo. */
  root: string;
  /** True when the branch has no commits yet (`# branch.oid (initial)`). */
  unborn: boolean;
  /** Populated when the probe failed for a reason worth surfacing. */
  error?: string;
}

export const UNKNOWN_GIT: GitInfo = {
  available: false,
  repo: false,
  commit: 'unknown',
  shortCommit: 'unknown',
  branch: 'unknown',
  dirty: false,
  changedFiles: 0,
  subject: '',
  commitTime: 0,
  root: '',
  unborn: false,
};

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one git command asynchronously and capture its output. */
export function runGit(args: string[], cwd?: string, bin = 'git'): Promise<GitRun> {
  return new Promise((resolve) => {
    let child;
    try {
      // `git.exe` is a console application. Spawned from the GUI exe without
      // this flag, every probe opens a console window titled "Git/git.exe" —
      // three of them at startup (rev-parse, status, log) and again on every
      // 15 s watch tick.
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** `git --version` → e.g. `git version 2.55.0.windows.1`; '' when unavailable. */
export async function gitVersion(bin = 'git'): Promise<string> {
  const r = await runGit(['--version'], undefined, bin);
  if (r.code !== 0) return '';
  return r.stdout.trim().replace(/^git version\s+/, '');
}

/**
 * Parse `git status --porcelain=v2 --branch` header lines.
 * Returns the branch oid / head / dirty flag without shelling out again.
 */
function parseStatusV2(out: string): { oid: string; branch: string; changedFiles: number; unborn: boolean } {
  let oid = 'unknown';
  let branch = 'unknown';
  let unborn = false;
  let changedFiles = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      const v = line.slice('# branch.oid '.length).trim();
      if (v === '(initial)') { unborn = true; oid = 'unknown'; } else { oid = v; }
    } else if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim() || 'unknown';
    } else if (line.startsWith('#') || line.startsWith('#')) {
      continue;
    } else {
      changedFiles++;
    }
  }
  return { oid, branch, changedFiles, unborn };
}

/**
 * Probe the git state of `cwd` (defaults to the process cwd).
 *
 * Never throws — a missing binary / non-repo directory yields a well-formed
 * `GitInfo` with `available` / `repo` flags set accordingly, so callers can
 * degrade instead of crashing.
 */
export async function probeGit(cwd?: string, bin = process.env.GIT_BIN ?? 'git'): Promise<GitInfo> {
  const rootRes = await runGit(['rev-parse', '--show-toplevel'], cwd, bin);
  if (rootRes.code !== 0) {
    const notRepo = /not a git repository/i.test(rootRes.stderr);
    return {
      ...UNKNOWN_GIT,
      available: !notRepo,
      repo: false,
      error: notRepo ? undefined : rootRes.stderr.trim() || rootRes.stdout.trim() || undefined,
    };
  }
  const root = rootRes.stdout.trim();

  const status = await runGit(
    ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
    cwd,
    bin,
  );
  const { oid, branch, changedFiles, unborn } = parseStatusV2(status.stdout);

  let shortCommit = oid === 'unknown' ? 'unknown' : oid.slice(0, 7);
  let subject = '';
  let commitTime = 0;

  if (!unborn && oid !== 'unknown') {
    // %x00 separator: commit subjects may contain any other character.
    const log = await runGit(['log', '-1', '--format=%h%x00%s%x00%ct'], cwd, bin);
    if (log.code === 0) {
      const [h, s, t] = log.stdout.trim().split('\u0000');
      if (h) shortCommit = h.trim();
      if (s) subject = s.trim();
      if (t) commitTime = Number(t.trim()) * 1000 || 0;
    }
  }

  return {
    available: true,
    repo: true,
    commit: oid,
    shortCommit,
    branch,
    dirty: changedFiles > 0,
    changedFiles,
    subject,
    commitTime,
    root,
    unborn,
  };
}

export interface GitProbeOptions {
  cwd?: string;
  bin?: string;
  /** Poll interval for `watch()` in ms (default 15 s). */
  intervalMs?: number;
}

/**
 * Cached git probe. `refresh()` re-reads the repository; `watch()` polls for
 * commit changes and invokes the callback only when the resolved commit moves.
 */
export class GitProbe {
  private cached?: GitInfo;
  private inflight?: Promise<GitInfo>;
  private timer?: ReturnType<typeof setInterval>;
  private lastSeenCommit?: string;

  readonly cwd?: string;
  readonly bin: string;
  private readonly intervalMs: number;

  constructor(opts: GitProbeOptions = {}) {
    this.cwd = opts.cwd;
    this.bin = opts.bin ?? process.env.GIT_BIN ?? 'git';
    this.intervalMs = opts.intervalMs ?? 15_000;
  }

  /** Last probe result, or `undefined` before the first probe. */
  current(): GitInfo | undefined {
    return this.cached;
  }

  /** Probe (or return the cached value when `force` is false). */
  async probe(force = false): Promise<GitInfo> {
    if (!force && this.cached) return this.cached;
    // Concurrent forced polls/refreshes represent one point-in-time read; do
    // not launch another three-process probe while the first one is running.
    if (this.inflight) return this.inflight;
    const p = probeGit(this.cwd, this.bin).then((info) => {
      this.cached = info;
      this.inflight = undefined;
      return info;
    });
    this.inflight = p;
    return p;
  }

  /** Force a re-read of the repository. */
  async refresh(): Promise<GitInfo> {
    return this.probe(true);
  }

  /** Convenience: resolved commit or `'unknown'`. */
  async commit(): Promise<string> {
    return (await this.probe()).commit;
  }

  /**
   * Poll for commit changes. The callback fires immediately with the first
   * observation, then only when the commit id changes.
   */
  watch(onChange: (info: GitInfo, previous: string | undefined) => void): () => void {
    this.generation++;
    const generation = this.generation;
    const tick = async () => {
      const info = await this.probe(true);
      if (generation !== this.generation) return; // stopped mid-probe
      if (info.commit !== this.lastSeenCommit) {
        const prev = this.lastSeenCommit;
        this.lastSeenCommit = info.commit;
        try {
          onChange(info, prev);
        } catch {
          // A watcher failure must never kill the poll loop.
        }
      }
    };
    void tick();
    this.timer = setInterval(() => { void tick(); }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Bump the generation so an in-flight probe cannot fire a callback after
    // the caller has already stopped watching.
    this.generation++;
  }

  /** Monotonic counter used to discard callbacks from cancelled watch cycles. */
  private generation = 0;
}
