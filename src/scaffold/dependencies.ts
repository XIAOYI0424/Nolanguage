/**
 * Adding a dependency, per ecosystem.
 *
 * The panel runs a command and shows its output; it does not parse lock files or
 * pretend to resolve versions. The value here is knowing *which* command and
 * *where* — that is the part users get wrong (running `npm install` in the wrong
 * directory, or `pip install` when the project uses uv).
 *
 * Gradle/Maven declaration edits are explicit and validated. Fetching is a
 * separate user action (`planSync`), because a build can take minutes and touch
 * the network. A failed process-based add leaves the project manifest untouched.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyDeclaredAdd, planDeclaredAdd, type DeclaredAddPlan } from './declaredDependencies.js';
import { planSpawn } from '../util/spawnPlan.js';

export type Ecosystem = 'npm' | 'pnpm' | 'yarn' | 'cargo' | 'uv' | 'go' | 'gradle' | 'maven';

export interface AddPlan {
  ecosystem: Ecosystem;
  /** Executable, already resolved for this platform (npm is a .cmd on Windows). Empty for a declaration edit. */
  command: string;
  args: string[];
  cwd: string;
  /** What to show the user before they press the button. */
  label: string;
  /**
   * Set when the ecosystem has no "add" command and the declaration must be
   * written into the project file instead (Gradle / Maven).
   */
  declared?: DeclaredAddPlan;
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

  const has = (file: string): boolean => existsSync(join(dir, file));

  // Gradle/Maven own declarations in a build file, so validate their richer
  // coordinate grammar before applying the command-spec whitelist for CLI ecosystems.
  const declared = planDeclaredAdd(dir, raw, opts.probe === true);
  if (declared) {
    return { ecosystem: declared.ecosystem, command: '', args: [], cwd: dir, label: declared.label, declared };
  }

  if (raw && !SPEC.test(raw)) throw new DependencyError('依赖名里有不支持的字符', 'spec');

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
  throw new DependencyError('这个目录里没有识别到项目（Cargo.toml / go.mod / pyproject.toml / package.json / build.gradle / pom.xml）', 'dir');
}

/** Apply a declaration edit. Process-based plans must go through `runAdd`. */
export function applyAdd(plan: AddPlan): AddResult {
  if (!plan.declared) {
    return { ok: false, plan, code: null, output: '这个依赖不需要编辑项目文件' };
  }
  try {
    const output = applyDeclaredAdd(plan.declared);
    return { ok: true, plan, code: 0, output };
  } catch (err) {
    return { ok: false, plan, code: null, output: (err as Error).message };
  }
}

/**
 * Fetch what the project already declares.
 *
 * This is deliberately a separate, explicit action: a Gradle build can run for
 * minutes and hit the network, so it must never be a side effect of writing a
 * template. The command comes from the marker in the directory, not from a
 * language id.
 */
export function planSync(dir: string): AddPlan {
  const has = (file: string): boolean => existsSync(join(dir, file));
  if (has('build.gradle.kts') || has('build.gradle') || has('settings.gradle') || has('settings.gradle.kts')) {
    const wrapper = process.platform === 'win32'
      ? (has('gradlew.bat') ? join(dir, 'gradlew.bat') : 'gradle')
      : (has('gradlew') ? join(dir, 'gradlew') : 'gradle');
    return {
      ecosystem: 'gradle',
      command: wrapper,
      args: ['--no-daemon', 'classes'],
      cwd: dir,
      label: `${wrapper === 'gradle' ? 'gradle' : wrapper} --no-daemon classes（拉取依赖）`,
    };
  }
  if (has('pom.xml')) {
    const wrapper = process.platform === 'win32'
      ? (has('mvnw.cmd') ? join(dir, 'mvnw.cmd') : 'mvn')
      : (has('mvnw') ? join(dir, 'mvnw') : 'mvn');
    return {
      ecosystem: 'maven',
      command: wrapper,
      args: ['-B', '-q', 'dependency:resolve'],
      cwd: dir,
      label: `${wrapper === 'mvn' ? 'mvn' : wrapper} dependency:resolve（拉取依赖）`,
    };
  }
  if (has('pyproject.toml')) {
    return { ecosystem: 'uv', command: bin('uv'), args: ['sync'], cwd: dir, label: 'uv sync（拉取依赖）' };
  }
  if (has('requirements.txt')) {
    return { ecosystem: 'uv', command: bin('uv'), args: ['pip', 'install', '-r', 'requirements.txt'], cwd: dir, label: 'uv pip install -r requirements.txt（拉取依赖）' };
  }
  if (has('Cargo.toml')) {
    return { ecosystem: 'cargo', command: bin('cargo'), args: ['fetch'], cwd: dir, label: 'cargo fetch（拉取依赖）' };
  }
  if (has('go.mod')) {
    return { ecosystem: 'go', command: bin('go'), args: ['mod', 'download'], cwd: dir, label: 'go mod download（拉取依赖）' };
  }
  if (has('package.json')) {
    if (has('pnpm-lock.yaml')) {
      return { ecosystem: 'pnpm', command: bin('pnpm'), args: ['install', '--frozen-lockfile'], cwd: dir, label: 'pnpm install --frozen-lockfile（拉取依赖）' };
    }
    if (has('yarn.lock')) {
      return { ecosystem: 'yarn', command: bin('yarn'), args: ['install', '--frozen-lockfile'], cwd: dir, label: 'yarn install --frozen-lockfile（拉取依赖）' };
    }
    const ci = has('package-lock.json');
    return {
      ecosystem: 'npm',
      command: bin('npm'),
      args: ci ? ['ci'] : ['install'],
      cwd: dir,
      label: `npm ${ci ? 'ci' : 'install'}（拉取依赖）`,
    };
  }
  throw new DependencyError('这个目录里没有识别到可同步的项目（build.gradle / pom.xml / Cargo.toml / go.mod / pyproject.toml / package.json）', 'dir');
}

/** Run a plan, capturing both streams. Never throws for a non-zero exit. */
export function runAdd(plan: AddPlan, timeoutMs = 120_000): Promise<AddResult> {
  if (plan.declared) return Promise.resolve(applyAdd(plan));
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
      const launch = planSpawn(plan.command, plan.args);
      child = spawn(launch.command, launch.args, { cwd: plan.cwd, windowsHide: true, shell: launch.shell });
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
