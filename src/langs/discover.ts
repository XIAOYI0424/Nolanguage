/**
 * Generic toolchain discovery.
 *
 * Every language used to own a discover.ts with its own precedence rules
 * (PYTHON_BIN → PATH → known dirs; GO_BIN → PATH → install dirs; …). The
 * rules were never language-specific — they were policy, and policy belongs
 * in the manifest:
 *
 *   env var  →  known absolute paths  →  PATH lookup
 *
 * The env var comes first because that is the documented escape hatch when a
 * machine has several toolchains installed. knownPaths come next because a
 * Windows install frequently does not touch PATH at all (this machine's Go is
 * D:\Go lang, never added to PATH). PATH is last because it is the least
 * specific answer.
 *
 * A project may also declare the version it wants (.python-version, .nvmrc,
 * package.json engines, go.mod). That declaration is a hint: it orders the
 * knownPaths candidates, it never fails a lookup.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { commandExists } from '../lsp/LspClient.js';
import type { BinaryDiscoverySpec, VersionFileSpec } from '../runtimes/types.js';

export interface DiscoverOptions {
  /** Project root used to resolve versionFiles; defaults to process.cwd(). */
  root?: string;
}

export interface BinaryResolution {
  /** Resolved path, or the bare command name when only PATH matched. */
  bin: string;
  /** Which rule matched: env:GO_BIN / known / path / missing. */
  source: string;
  /** Version the project declared, when a version file was read. */
  wantedVersion?: string;
  /** Which version file declared it (project-relative). */
  versionFile?: string;
}

/** Expand ~ and make relative known-paths absolute against cwd. */
export function expandPath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

/**
 * Expand a single-segment star glob (e.g. ~/.pyenv/versions/STAR/bin/python3).
 *
 * No recursive walk: every real toolchain manager uses exactly one version
 * segment, and a deeper walk would cost more than the feature is worth. A
 * pattern without a star is returned unchanged, so literal paths keep their
 * old behaviour.
 */
export function expandGlob(pattern: string): string[] {
  const p = expandPath(pattern);
  if (!p.includes('*')) return [p];
  const segs = p.split(/[\\/]+/);
  const head = segs[0] === '' ? sep : segs[0];
  let out: string[] = [head];
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg) continue;
    if (!seg.includes('*')) {
      out = out.map((b) => join(b, seg));
      continue;
    }
    // Escape the literal parts, then join them with `.*`: escaping first and
    // then replacing `*` would turn the escaped `\*` into `\.*`.
    const re = new RegExp('^' + seg.split('*').map(escapeRegExp).join('.*') + '$');
    const next: string[] = [];
    for (const b of out) {
      try {
        for (const name of readdirSync(b)) if (re.test(name)) next.push(join(b, name));
      } catch {
        /* directory does not exist — no candidates from it */
      }
    }
    out = next;
  }
  return out;
}

/** Characters that need a backslash inside a RegExp. */
const REGEXP_SPECIAL = new Set([
  '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', String.fromCharCode(92),
]);
const BACKSLASH = String.fromCharCode(92);

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  let out = '';
  for (const ch of s) {
    if (REGEXP_SPECIAL.has(ch)) out += BACKSLASH;
    out += ch;
  }
  return out;
}

/** Read a dot-path (engines.node) out of a parsed JSON document. */
function readKey(value: unknown, key?: string): string | undefined {
  if (!key) return undefined;
  let cur: unknown = value;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** The version a single declaration file carries, or undefined. */
function readVersionFrom(text: string, vf: VersionFileSpec): string | undefined {
  if (vf.format === 'plain') {
    return text.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  }
  if (vf.format === 'json') {
    try {
      return readKey(JSON.parse(text), vf.key);
    } catch {
      return undefined;
    }
  }
  if (vf.format === 'toml') {
    // Deliberately minimal: requires-python = ">=3.11" (or the last segment
    // of key). A full TOML parser is a dependency this project will not take.
    const key = (vf.key ?? 'requires-python').split('.').pop() ?? 'requires-python';
    const esc = escapeRegExp(key);
    const m = new RegExp('^\\s*' + esc + '\\s*=\\s*["\']([^"\']+)["\']', 'm').exec(text);
    return m?.[1];
  }
  if (vf.format === 'regex') {
    if (!vf.pattern) return undefined;
    try {
      return new RegExp(vf.pattern, 'm').exec(text)?.[1];
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** First version file that exists and yields a version wins. */
function readVersionHint(
  spec: BinaryDiscoverySpec,
  root: string,
): { version?: string; file?: string } {
  for (const vf of spec.versionFiles ?? []) {
    const p = isAbsolute(vf.path) ? vf.path : join(root, vf.path);
    if (!existsSync(p)) continue;
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const version = readVersionFrom(text, vf);
    if (version) return { version: version.trim(), file: vf.path };
  }
  return {};
}

/**
 * True when a candidate looks like the version the project asked for.
 *
 * Only the binary name and its two parent directories are inspected — the
 * version lives in one of them (.../versions/3.11.4/bin/python3,
 * .../v20.1.0/bin/node, .../go1.22/bin/go). Matching the whole path would
 * let an unrelated directory (a temp root called 2026-...) satisfy every
 * candidate.
 */
function versionMatches(path: string, version: string): boolean {
  const v = version.replace(/^[^\d]*/, ''); // v3.11 / >=3.11 / ^20
  if (!v) return false;
  const majorMinor = v.split('.').slice(0, 2).join('.');
  const segments = [basename(path), basename(dirname(path)), basename(dirname(dirname(path)))];
  return segments.some(
    (s) => s.includes(v) || (majorMinor !== '' && majorMinor !== v && s.includes(majorMinor)),
  );
}

/**
 * Resolve a toolchain from a manifest discovery block. Synchronous and cheap.
 *
 * Order: version file (a hint, not a hard constraint) → explicit env var →
 * known paths (glob-expanded, version-matching entries first) → PATH. The
 * version file never fails a lookup; it only orders the candidates, because
 * a project may pin a version that is not installed and the best answer is
 * still the closest installed one.
 */
export function discoverBinary(
  spec: BinaryDiscoverySpec | undefined,
  opts: DiscoverOptions = {},
): BinaryResolution {
  if (!spec) return { bin: '', source: 'missing' };
  const hint = readVersionHint(spec, opts.root ?? process.cwd());
  const hintFields = hint.version
    ? { wantedVersion: hint.version, versionFile: hint.file }
    : {};

  for (const name of spec.envVars ?? []) {
    const value = process.env[name];
    if (value && value.trim()) {
      const p = expandPath(value.trim());
      if (existsSync(p)) return { bin: p, source: 'env:' + name, ...hintFields };
    }
  }

  const candidates: string[] = [];
  for (const known of spec.knownPaths ?? []) candidates.push(...expandGlob(known));
  if (hint.version) {
    candidates.sort((a, b) => {
      const ma = versionMatches(a, hint.version as string) ? 0 : 1;
      const mb = versionMatches(b, hint.version as string) ? 0 : 1;
      return ma - mb;
    });
  }
  for (const p of candidates) {
    if (existsSync(p)) return { bin: p, source: 'known', ...hintFields };
  }

  for (const cmd of spec.commands ?? []) {
    if (commandExists(cmd)) return { bin: cmd, source: 'path', ...hintFields };
  }

  return { bin: spec.commands?.[0] ?? '', source: 'missing', ...hintFields };
}

/**
 * Probe a binary's version with a short, non-blocking run.
 *
 * Async spawn on purpose: spawnSync is blocked in this environment and
 * would freeze the panel while a toolchain boots.
 */
export function probeVersion(bin: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolvePromise) => {
    if (!bin) {
      resolvePromise(null);
      return;
    }
    let settled = false;
    const done = (v: string | null): void => {
      if (!settled) {
        settled = true;
        resolvePromise(v);
      }
    };
    // Imported lazily so this module stays usable from a browser-ish context.
    void import('node:child_process').then(({ spawn }) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, args, { windowsHide: true });
      } catch {
        done(null);
        return;
      }
      let out = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(null);
      }, timeoutMs);
      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.stderr?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        done(out.trim().split('\n')[0] ?? null);
      });
    });
  });
}
