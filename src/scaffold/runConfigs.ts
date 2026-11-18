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

export interface RunConfig {
  id: string;
  name: string;
  language: string;
  /** Program arguments, as typed: `--port 8080 --verbose`. */
  args: string;
  /** Working directory; empty means the plugin's own. */
  cwd?: string;
  /** Environment lines, `KEY=VALUE` per line. */
  env?: string;
}

const MAX_NAME = 80;
const MAX_ARGS = 2000;
const MAX_ENV = 4000;

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

    const items = this.list();
    const id = input.id && input.id.trim() ? input.id.trim() : `rc-${Date.now().toString(36)}`;
    const next: RunConfig = { id, name, language, args, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) };
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
