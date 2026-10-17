/**
 * The runtime registry — a tiny catalogue of execution capabilities with
 * version constraints.
 *
 * A plugin declares `manifest.run.requires: ["repl-session@^1.0.0"]`. The
 * factory asks this registry whether the installed runtime satisfies that, so
 * a plugin built for a future runtime fails with a clear message instead of
 * throwing somewhere deep in a spawn call.
 *
 * Version syntax is deliberately minimal (no `||`, no pre-release tags):
 * `*`, `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`, `>1.2.3`, `<=1.2.3`, `<1.2.3`.
 * That covers every constraint a manifest realistically needs, in ~40 lines,
 * with no dependency.
 */
import type { RuntimeExtension } from './types.js';

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmp(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Does `version` satisfy `range`? Returns false for unparseable input. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const r = String(range).trim();
  if (r === '' || r === '*' || r === 'latest') return true;

  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (!m) return false;
  const target: Version = { major: Number(m[2]), minor: Number(m[3]), patch: Number(m[4]) };
  const op = m[1] ?? '=';

  switch (op) {
    case '=':
      return cmp(v, target) === 0;
    case '>=':
      return cmp(v, target) >= 0;
    case '>':
      return cmp(v, target) > 0;
    case '<=':
      return cmp(v, target) <= 0;
    case '<':
      return cmp(v, target) < 0;
    case '~':
      // ~1.2.3 := >=1.2.3 <1.3.0
      return cmp(v, target) >= 0 && v.major === target.major && v.minor === target.minor;
    case '^':
      // ^1.2.3 := >=1.2.3 <2.0.0 — but ^0.x is treated as ~x for safety.
      if (target.major === 0) return cmp(v, target) >= 0 && v.major === 0 && v.minor === target.minor;
      return cmp(v, target) >= 0 && v.major === target.major;
    default:
      return false;
  }
}

/** `"repl-session@^1.0.0"` → `{ id: 'repl-session', range: '^1.0.0' }`. */
export function parseRequirement(text: string): { id: string; range: string } {
  const at = String(text).indexOf('@');
  if (at < 0) return { id: String(text).trim(), range: '*' };
  return { id: text.slice(0, at).trim(), range: text.slice(at + 1).trim() || '*' };
}

export class RuntimeRegistry {
  private runtimes = new Map<string, RuntimeExtension>();

  register(runtime: RuntimeExtension): void {
    this.runtimes.set(runtime.id, runtime);
  }

  get(id: string): RuntimeExtension | undefined {
    return this.runtimes.get(id);
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  list(): Array<{ id: string; version: string }> {
    return [...this.runtimes.values()].map((r) => ({ id: r.id, version: r.version }));
  }

  /** True when the installed runtime `id` satisfies `range`. */
  satisfies(id: string, range: string): boolean {
    const rt = this.runtimes.get(id);
    if (!rt) return false;
    return satisfies(rt.version, range);
  }

  /** True when every `requires` entry is met. */
  satisfiesAll(requires: string[] | undefined): { ok: boolean; unmet: string[] } {
    const unmet: string[] = [];
    for (const req of requires ?? []) {
      const { id, range } = parseRequirement(req);
      if (!this.satisfies(id, range)) unmet.push(req);
    }
    return { ok: unmet.length === 0, unmet };
  }
}
