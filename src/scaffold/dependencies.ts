/**
 * Adding a dependency, per ecosystem.
 *
 * The panel runs a command and shows its output; it does not parse lock files or
 * pretend to resolve versions. The value here is knowing *which* command and
 * *where* — that is the part users get wrong (running `npm install` in the wrong
 * directory, or `pip install` when the project uses uv).
 *
 * Nothing in this file writes to disk: the toolchain does, which is why a failed
 * add leaves the project exactly as it was.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type Ecosystem = 'npm' | 'cargo' | 'uv' | 'go';

export interface AddPlan {
  ecosystem: Ecosystem;
  /** Executable, already resolved for this platform (npm is a .cmd on Windows). */
  command: string;
  args: string[];
  cwd: string;
  /** What to show the user before they press the button. */
  label: string;
}

export interface AddResult {
  ok: boolean;
  plan: AddPlan;
  code: number | null;
  output: string;
  /** Set when the process had to be killed. */
  timedOut?: boolean;
}

/**
 * Package specs, checked before anything is spawned.
 *
 * Covers `lodash`, `@scope/pkg@1.2.3`, `serde@1`, `github.com/x/y@v1.2.0`. It
 * deliberately rejects whitespace and shell metacharacters: the command is run
 * without a shell, but a spec is still user input and should not be able to look
 * like a second argument.
 */
const SPEC = /^[A-Za-z0-9@/._:^~<>=*+[\]-]+$/;

export class DependencyError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'DependencyError';
  }
}

const bin = (name: string): string => (process.platform === 'win32' && name === 'npm' ? 'npm.cmd' : name);

/**
 * Which ecosystem owns `dir`, and what "add" means there.
 *
 * Order matters: a Rust project with a `package.json` in a subdirectory is still
 * Rust, but at this level the first marker in the list is the one that describes
 * the directory itself.
 */
export function planAdd(dir: string, spec: string, opts: { probe?: boolean } = {}): AddPlan {
  const raw = spec.trim();
  // `probe` is the dialog asking "which ecosystem is this?" before the user has
  // typed anything; it wants the command without the argument.
  if (!raw && !opts.probe) throw new DependencyError('请填写要添加的依赖', 'spec');
  if (raw && !SPEC.test(raw)) throw new DependencyError('依赖名里有不支持的字符', 'spec');

  const has = (file: string): boolean => existsSync(join(dir, file));

  if (has('Cargo.toml')) {
    return { ecosystem: 'cargo', command: bin('cargo'), args: raw ? ['add', raw] : [], cwd: dir, label: 'cargo add' };
  }
  if (has('go.mod')) {
    return { ecosystem: 'go', command: bin('go'), args: raw ? ['get', raw] : [], cwd: dir, label: 'go get' };
  }
  if (has('pyproject.toml')) {
    // uv manages pyproject.toml; pip would install into the environment and leave
    // the project's declaration untouched, which is the opposite of what the user
    // is asking for here.
    return { ecosystem: 'uv', command: bin('uv'), args: raw ? ['add', raw] : [], cwd: dir, label: 'uv add' };
  }
  if (has('package.json')) {
    return { ecosystem: 'npm', command: bin('npm'), args: raw ? ['install', raw] : [], cwd: dir, label: 'npm install' };
  }
  throw new DependencyError('这个目录里没有识别到项目（Cargo.toml / go.mod / pyproject.toml / package.json）', 'dir');
}

/** Run a plan, capturing both streams. Never throws for a non-zero exit. */
export function runAdd(plan: AddPlan, timeoutMs = 120_000): Promise<AddResult> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (code: number | null, timedOut = false): void => {
      if (done) return;
      done = true;
      resolve({ ok: code === 0 && !timedOut, plan, code, output: out.trim().slice(-8000), ...(timedOut ? { timedOut } : {}) });
    };
    let child;
    try {
      child = spawn(plan.command, plan.args, { cwd: plan.cwd, windowsHide: true, shell: false });
    } catch (err) {
      out = (err as Error).message;
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null, true);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      out += b.toString();
    });
    child.on('error', (err) => {
      out += (err as Error).message;
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}
