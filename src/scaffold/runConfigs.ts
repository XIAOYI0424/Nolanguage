/**
 * Saved run configurations: a name, arguments, a working directory, an environment.
 *
 * Deliberately small. A run configuration in a full IDE can grow into a build
 * system; the four fields here are the ones that change what actually runs, and
 * everything else (timeouts, interpreters) already comes from the language
 * manifest. The store is JSON on disk so a user can read, edit, or commit it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type RunConfigMode = 'run' | 'test' | 'project';

export interface RunConfig {
  id: string;
  name: string;
  language: string;
  /** How to run: the plugin's default, its test mode, or its project mode. */
  mode?: RunConfigMode;
  /** Program arguments, as typed: `--port 8080 --verbose`. */
  args: string;
  /** Working directory; empty means the plugin's own. */
  cwd?: string;
  /** Environment lines, `KEY=VALUE` per line. */
  env?: string;
  /**
   * Classpath for a project-mode run (Java: `out;D:\libs\*`), as typed.
   * Passed to `{classpath}` in the manifest's project step.
   */
  classpath?: string;
  /** Entry class for a project-mode run, passed to `{mainClass}`. */
  mainClass?: string;
}

const RUN_CONFIG_MODES = new Set<RunConfigMode>(['run', 'test', 'project']);
const MAX_NAME = 80;
const MAX_ARGS = 2000;
const MAX_ENV = 4000;
const MAX_CLASSPATH = 4000;
const MAX_MAIN_CLASS = 200;

/**
 * A classpath is a path list, not shell text. It is substituted *inside* the
 * manifest's quoted argv slot, so a quote would break out of that slot, and
 * braces would be expanded by a second substitution pass in older engines.
 * Separators and wildcards are fine; shell metacharacters are not.
 */
export function classpathProblem(value: string): string | undefined {
  const v = String(value ?? '').trim();
  if (!v) return 'classpath is required in project mode';
  if (v.length > MAX_CLASSPATH) return `classpath is too long (${MAX_CLASSPATH} max)`;
  if (/["'`{}\r\n\u0000-\u001f]/.test(v)) return 'classpath contains a forbidden character';
  return undefined;
}

/** A dotted class name, the shape every JVM entry point has. */
export function mainClassProblem(value: string): string | undefined {
  const v = String(value ?? '').trim();
  if (!v) return 'main class is required in project mode';
  if (v.length > MAX_MAIN_CLASS) return `main class is too long (${MAX_MAIN_CLASS} max)`;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(v)) {
    return 'main class must be a dotted Java identifier';
  }
  return undefined;
}

/**
 * Split an argument string the way a shell would, for quotes only.
 *
 * Not a shell: no globbing, no `$VAR`, no operators. A run configuration that
 * quietly expanded `$(rm -rf ~)` would be a security bug, not a feature.
 */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** `KEY=VALUE` lines to an object; blank lines and `#` comments are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = line.slice(at + 1).trim();
  }
  return out;
}

export class RunConfigError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'RunConfigError';
  }
}

export class RunConfigStore {
  private readonly file: string;

  constructor(home: string) {
    this.file = join(home, 'run-configs.json');
  }

  get path(): string {
    return this.file;
  }

  list(): RunConfig[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { items?: RunConfig[] };
      return Array.isArray(raw.items) ? raw.items.filter((c) => c && typeof c.id === 'string') : [];
    } catch {
      // A corrupt file must not take the editor down; the next save rewrites it.
      return [];
    }
  }

  save(input: Partial<RunConfig>): RunConfig {
    const name = String(input.name ?? '').trim();
    const language = String(input.language ?? '').trim();
    if (!name) throw new RunConfigError('配置需要一个名字', 'name');
    if (name.length > MAX_NAME) throw new RunConfigError('名字太长', 'name');
    if (!language) throw new RunConfigError('配置需要绑定一个语言', 'language');
    const args = String(input.args ?? '').slice(0, MAX_ARGS);
    const env = String(input.env ?? '').slice(0, MAX_ENV);
    const cwd = String(input.cwd ?? '').trim().slice(0, 400);
    const mode = input.mode && RUN_CONFIG_MODES.has(input.mode) ? input.mode : 'run';
    const classpath = String(input.classpath ?? '').trim().slice(0, MAX_CLASSPATH);
    const mainClass = String(input.mainClass ?? '').trim().slice(0, MAX_MAIN_CLASS);
    if (mode === 'project') {
      const cpProblem = classpathProblem(classpath);
      if (cpProblem) throw new RunConfigError(cpProblem, 'classpath');
      const mainProblem = mainClassProblem(mainClass);
      if (mainProblem) throw new RunConfigError(mainProblem, 'mainClass');
    }

    const items = this.list();
    const id = input.id && input.id.trim() ? input.id.trim() : `rc-${Date.now().toString(36)}`;
    const next: RunConfig = {
      id, name, language, args, mode,
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      ...(classpath ? { classpath } : {}),
      ...(mainClass ? { mainClass } : {}),
    };
    const at = items.findIndex((c) => c.id === id);
    if (at >= 0) items[at] = next;
    else items.push(next);
    this.write(items);
    return next;
  }

  remove(id: string): boolean {
    const items = this.list();
    const next = items.filter((c) => c.id !== id);
    if (next.length === items.length) return false;
    this.write(next);
    return true;
  }

  private write(items: RunConfig[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, 'utf8');
  }
}
