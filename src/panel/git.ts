/**
 * Minimal git plumbing for the IDE's VCS surfaces (commit pane, git widget).
 *
 * The engine's `GitProbe` only *reports* a repository; the Commit panel needs
 * to act on one. Rather than growing a second git implementation, this shells
 * out to the user's own `git` — the same binary they would type into the
 * terminal — and returns its exit status verbatim.
 *
 * The commit is deliberately narrow: `git add -u` stages **tracked** changes
 * only, so pressing Commit can never sweep unrelated untracked files into the
 * repository. A message is required; an empty one is rejected before spawning.
 */
import { spawn } from 'node:child_process';

export interface GitChange {
  /** Two-column porcelain status (`M `, ` M`, `A `, `??` …). */
  status: string;
  path: string;
}

export interface GitStatus {
  ok: boolean;
  branch: string;
  changes: GitChange[];
  error?: string;
}

export interface GitCommitResult {
  ok: boolean;
  branch: string;
  committed: number;
  output: string;
  error?: string;
}

interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runGit(cwd: string, args: string[], timeoutMs = 20_000): Promise<GitRun> {
  return new Promise((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.join(''), stderr: err.join(''), timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      err.push((e as Error).message);
      finish(-1);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => err.push(d.toString('utf8')));
    child.on('error', (e) => {
      err.push(e.message);
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

/** `git status --porcelain -b`, parsed into a branch name and a change list. */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  const r = await runGit(cwd, ['status', '--porcelain=v1', '-b']);
  if (r.code !== 0) {
    const why = r.timedOut ? 'git status timed out' : r.stderr.trim() || `git exited with ${r.code}`;
    return { ok: false, branch: '', changes: [], error: why };
  }
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  let branch = '';
  const changes: GitChange[] = [];
  for (const line of lines) {
    if (line.startsWith('##')) {
      // `## main...origin/main [ahead 1]` → `main`
      branch = line.slice(2).trim().split('...')[0].split(' ')[0] || '';
      continue;
    }
    if (line.length < 4) continue;
    changes.push({ status: line.slice(0, 2), path: line.slice(3) });
  }
  return { ok: true, branch, changes };
}

/** Stage tracked changes and commit them with `message`. */
export async function gitCommit(cwd: string, message: string): Promise<GitCommitResult> {
  const msg = message.trim();
  if (!msg) {
    return { ok: false, branch: '', committed: 0, output: '', error: 'a commit message is required' };
  }
  const status = await gitStatus(cwd);
  if (!status.ok) return { ok: false, branch: '', committed: 0, output: '', error: status.error };
  const tracked = status.changes.filter((c) => !c.status.includes('??'));
  if (!tracked.length) {
    return {
      ok: false,
      branch: status.branch,
      committed: 0,
      output: '',
      error: status.changes.length
        ? 'only untracked files changed — stage them in the terminal first'
        : 'nothing to commit, working tree clean',
    };
  }

  const staged = await runGit(cwd, ['add', '-u']);
  if (staged.code !== 0) {
    return {
      ok: false,
      branch: status.branch,
      committed: 0,
      output: staged.stdout,
      error: staged.timedOut ? 'git add timed out' : staged.stderr.trim() || 'git add failed',
    };
  }

  const commit = await runGit(cwd, ['commit', '-m', msg]);
  const output = (commit.stdout + commit.stderr).trim();
  if (commit.code !== 0) {
    return {
      ok: false,
      branch: status.branch,
      committed: 0,
      output,
      error: commit.timedOut ? 'git commit timed out' : output || `git commit exited with ${commit.code}`,
    };
  }
  return { ok: true, branch: status.branch, committed: tracked.length, output };
}
