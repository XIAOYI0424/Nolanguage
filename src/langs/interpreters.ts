/**
 * Interpreter discovery — the first migration threshold.
 *
 * A PyCharm user does not think "which python binary"; they think "the project
 * interpreter". The project usually says so already: a `.venv` next to the
 * sources, a `pyvenv.cfg` inside it, a `project-jdk-name` in `.idea/misc.xml`,
 * or a conda env list in the home directory.
 *
 * This module finds those candidates and picks one, so switching editors does
 * not silently run the wrong interpreter (which shows up as "module not found"
 * on a project that worked a minute ago).
 *
 * The per-language knowledge is **data** (`INTERPRETER_SPECS`), not branches:
 * the discovery loop is identical for every language, which is what keeps the
 * plugin boundary intact.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { probeVersion } from './discover.js';
import type { EnvironmentCreateSpec, InterpretersSpec } from '../runtimes/types.js';

export type InterpreterKind = 'venv' | 'conda' | 'version-manager' | 'path' | 'sdk';

export interface InterpreterSpec {
  /** Directory names that hold a self-contained environment. */
  envDirs: string[];
  /** Executable locations inside an environment directory. */
  envBins: string[];
  /** File whose presence proves the directory really is an environment. */
  marker: string;
  /** Executable names to look for on PATH. */
  exeNames: string[];
  /** Version-manager roots, relative to the user's home. */
  versionDirs: string[];
  /** Executable locations inside a version-manager install. */
  versionBins: string[];
  /** File listing environments (conda), relative to the user's home. */
  envListFile?: string;
  /** Arguments that print a version. */
  versionArgs: string[];
  /** How an IDE prefixes this SDK's name (`Python 3.11.9`, `Go 1.21`). */
  sdkPrefix?: string;
}

/**
 * The engine's fallback table, for plugins that do not declare
 * `run.interpreters`.
 *
 * New languages should declare the block in their manifest — that is what lets
 * a third-party plugin offer the SDK picker at all. These three rows exist so
 * the built-ins keep working if a manifest is missing the block, and so a
 * hand-written plugin written before the field existed does not silently lose
 * discovery.
 */
export const INTERPRETER_SPECS: Record<string, InterpreterSpec> = {
  python: {
    envDirs: ['.venv', 'venv', 'env', '.env'],
    envBins: ['Scripts/python.exe', 'bin/python3', 'bin/python'],
    marker: 'pyvenv.cfg',
    exeNames: ['python.exe', 'python3.exe', 'python', 'python3'],
    versionDirs: ['.pyenv/pyenv-win/versions', '.pyenv/versions'],
    versionBins: ['python.exe', 'bin/python3', 'bin/python'],
    envListFile: '.conda/environments.txt',
    versionArgs: ['--version'],
  },
  javascript: {
    envDirs: [],
    envBins: [],
    marker: 'package.json',
    exeNames: ['node.exe', 'node'],
    versionDirs: ['.nvm/versions/node', '.volta/tools/image/node'],
    versionBins: ['node.exe', 'bin/node'],
    versionArgs: ['--version'],
  },
  go: {
    envDirs: [],
    envBins: [],
    marker: 'go.mod',
    exeNames: ['go.exe', 'go'],
    versionDirs: ['go/bin', 'scoop/apps/go/current/bin'],
    versionBins: ['go.exe', 'go'],
    versionArgs: ['version'],
  },
};

/**
 * Fill in the defaults for a declared `run.interpreters` block.
 *
 * Every field is optional in the manifest so a plugin can declare only what it
 * needs; the loop below always sees a complete spec.
 */
export function normalizeInterpreterSpec(partial: InterpretersSpec | undefined): InterpreterSpec | undefined {
  if (!partial) return undefined;
  return {
    envDirs: partial.envDirs ?? [],
    envBins: partial.envBins ?? [],
    marker: partial.marker ?? '',
    exeNames: partial.exeNames ?? [],
    versionDirs: partial.versionDirs ?? [],
    versionBins: partial.versionBins ?? [],
    envListFile: partial.envListFile,
    versionArgs: partial.versionArgs ?? ['--version'],
    sdkPrefix: partial.sdkPrefix,
  };
}

export interface InterpreterCandidate {
  /** Absolute executable path — the identity used for pinning. */
  path: string;
  /** Human label, e.g. `Python 3.13.14 (.venv)`. */
  label: string;
  kind: InterpreterKind;
  /** Where it was found: `.venv`, `PATH`, `conda`, `.idea`, … */
  source: string;
  version?: string;
  /** Matches the project SDK name recorded by PyCharm. */
  sdkMatch?: boolean;
}

export interface DiscoverInterpretersOptions {
  /** Home directory override (tests). Defaults to `os.homedir()`. */
  home?: string;
  /** PATH override (tests). Defaults to `process.env.PATH`. */
  pathEnv?: string;
  /** `project-jdk-name` from `.idea/misc.xml`, when the project has one. */
  sdkName?: string;
  /** Version probe; `null` disables spawning entirely. */
  probe?: ((bin: string, args: string[]) => Promise<string | null>) | null;
  /** How many candidates to probe (each one is a process). */
  maxProbe?: number;
  /** Whether a path is a file. Injected so tests need no real binaries. */
  isFile?: (p: string) => boolean;
  /** How many parent folders may supply an environment (default: 4). */
  envSearchUp?: number;
  /** How deep below the opened folder environments are searched (default: 4). */
  envSearchDown?: number;
  /**
   * The plugin's declared `run.interpreters`. Wins over the engine's fallback
   * table; absent means "use the table" (built-ins written before the field).
   */
  spec?: InterpretersSpec;
}

const KIND_ORDER: Record<InterpreterKind, number> = {
  venv: 0,
  sdk: 1,
  conda: 2,
  'version-manager': 3,
  path: 4,
};

/**
 * A workspace is not always a single project: a monorepo can keep the shared
 * environment at its root while the folder you actually open is a subproject,
 * and a subproject can equally carry its own `.venv`. Discovery therefore walks
 * both ways — up to the nearest parents and down into shallow children — using
 * only the plugin's declared environment names and marker.
 *
 * The bounds are policy, not language knowledge: nobody wants a picker that
 * crawls an entire disk or a `node_modules` tree to answer one question.
 */
const ENV_SEARCH_UP = 4;
const ENV_SEARCH_DOWN = 4;
const ENV_SCAN_LIMIT = 1500;
const ENV_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'site-packages',
  'dist', 'build', 'out', 'target', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.tmp', 'coverage',
]);

interface EnvDirHit {
  dir: string;
  source: string;
  /** 0 = opened folder, 1 = parent, 2 = child; then distance. */
  rank: number;
}

function pathKey(p: string): string {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function relSource(root: string, dir: string): string {
  const rel = relative(root, dir) || basename(dir);
  return rel.split(sep).join('/');
}

/**
 * Environment directories around `rootDir`, nearest first.
 *
 * Environment directories themselves are never descended into: a venv can be
 * hundreds of megabytes, and its `site-packages` is not a place to look for
 * another venv.
 */
function collectEnvDirs(
  rootDir: string,
  spec: InterpreterSpec,
  upLimit = ENV_SEARCH_UP,
  downLimit = ENV_SEARCH_DOWN,
): EnvDirHit[] {
  const root = resolve(rootDir);
  const hits: EnvDirHit[] = [];
  const seen = new Set<string>();
  const add = (dir: string, source: string, rank: number): void => {
    const key = pathKey(dir);
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ dir, source, rank });
  };

  let current = root;
  for (let up = 0; up <= upLimit; up++) {
    for (const name of spec.envDirs) {
      const dir = join(current, name);
      add(dir, relSource(root, dir), up === 0 ? 0 : 100 + up);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (queue.length && scanned < ENV_SCAN_LIMIT) {
    const item = queue.shift()!;
    scanned++;
    if (item.depth >= downLimit) continue;
    let entries;
    try {
      entries = readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (spec.envDirs.indexOf(entry.name) !== -1) {
        const dir = join(item.dir, entry.name);
        add(dir, relSource(root, dir), 200 + item.depth + 1);
        continue;
      }
      if (ENV_SKIP_DIRS.has(entry.name)) continue;
      queue.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 });
    }
  }

  hits.sort((a, b) => a.rank - b.rank || a.source.localeCompare(b.source));
  return hits;
}

function kindLabel(kind: InterpreterKind): string {
  switch (kind) {
    case 'venv':
      return 'venv';
    case 'conda':
      return 'conda';
    case 'version-manager':
      return 'managed';
    case 'sdk':
      return 'SDK';
    default:
      return 'PATH';
  }
}

/** Short version for a label: `3.13.14` from `Python 3.13.14`. */
export function shortVersion(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(raw);
  return m ? m[1] : raw.trim().split(/\s+/).pop();
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Find interpreter candidates for one language.
 *
 * Order is stable and meaningful: project environments first (that is what the
 * user means by "the project interpreter"), then conda, then version managers,
 * then whatever PATH happens to point at.
 */
export async function discoverInterpreters(
  rootDir: string,
  languageId: string,
  opts: DiscoverInterpretersOptions = {},
): Promise<InterpreterCandidate[]> {
  // Declared beats fallback: a plugin that ships its own rules is authoritative.
  const spec = normalizeInterpreterSpec(opts.spec) ?? INTERPRETER_SPECS[languageId];
  if (!spec) return [];
  const home = opts.home ?? homedir();
  const isFile = opts.isFile ?? ((p: string) => existsSync(p) && fileSize(p) > 0);
  const found: InterpreterCandidate[] = [];
  const seen = new Set<string>();
  const envRank = new Map<string, number>();

  const add = (path: string, kind: InterpreterKind, source: string): void => {
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path, label: '', kind, source });
  };

  // 1. Project environments — the opened folder, its parents and its shallow
  // children. Without a marker there is no way to tell an environment from an
  // ordinary directory, so the whole step is skipped rather than guessing.
  if (spec.marker) {
    for (const hit of collectEnvDirs(
      rootDir,
      spec,
      opts.envSearchUp ?? ENV_SEARCH_UP,
      opts.envSearchDown ?? ENV_SEARCH_DOWN,
    )) {
      if (!existsSync(join(hit.dir, spec.marker))) continue;
      for (const bin of spec.envBins) {
        const p = join(hit.dir, bin);
        if (isFile(p)) {
          add(p, 'venv', hit.source);
          envRank.set(pathKey(p), hit.rank);
          break;
        }
      }
    }
  }

  // 2. Conda environments, listed one absolute path per line.
  if (spec.envListFile) {
    try {
      const list = readFileSync(join(home, spec.envListFile), 'utf8');
      for (const line of list.split(/\r?\n/)) {
        const envDir = line.trim();
        if (!envDir) continue;
        for (const bin of spec.envBins) {
          const p = join(envDir, bin);
          if (isFile(p)) {
            add(p, 'conda', basename(envDir));
            break;
          }
        }
      }
    } catch {
      /* no conda */
    }
  }

  // 3. Version-manager installs (pyenv / nvm / volta / …).
  for (const rel of spec.versionDirs) {
    const base = join(home, rel);
    let versions: string[] = [];
    try {
      versions = readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse()
        .slice(0, 3);
    } catch {
      versions = [];
    }
    for (const v of versions) {
      for (const bin of spec.versionBins) {
        const p = join(base, v, bin);
        if (isFile(p)) {
          add(p, 'version-manager', `${basename(base)}/${v}`);
          break;
        }
      }
    }
  }

  // 4. PATH.
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const exe of spec.exeNames) {
      const p = join(dir, exe);
      if (isFile(p)) add(p, 'path', 'PATH');
    }
  }

  // 5. Versions: only the first few, and only when a prober is supplied.
  const probe = opts.probe === null ? null : opts.probe ?? probeVersion;
  const maxProbe = opts.maxProbe ?? 6;
  if (probe) {
    const head = found.slice(0, maxProbe);
    const versions = await Promise.all(head.map((c) => probe(c.path, spec.versionArgs).catch(() => null)));
    head.forEach((c, i) => {
      const v = shortVersion(versions[i]);
      if (v) c.version = v;
    });
  }

  // 6. Labels + SDK match + ordering.
  const sdk = (opts.sdkName ?? '').trim().toLowerCase();
  for (const c of found) {
    const dirName = basename(join(c.path, '..', '..'));
    if (sdk) {
      // The prefix comes from the spec: PyCharm records "Python 3.11.9",
      // "Go 1.21", "Node.js 20" — the engine has no business knowing which.
      // `sdk` is lower-cased above; the prefix must be too, or "Kotlin 1.9.0"
      // never matches "kotlin 1.9.0". The old literal was `python`, which
      // happened to already be lower case.
      const named =
        spec.sdkPrefix && c.version ? `${spec.sdkPrefix} ${c.version}`.toLowerCase() : undefined;
      c.sdkMatch =
        sdk.includes(dirName.toLowerCase()) ||
        (named ? sdk.includes(named) : false) ||
        sdk.includes(basename(c.path).replace(/\.exe$/i, '').toLowerCase());
    }
    // The list is already scoped to one language, so the label carries only the
    // version — prefixing it with a language name is how a generic list starts
    // knowing which languages exist.
    const head = c.version ? c.version : kindLabel(c.kind);
    c.label = `${head} (${c.source})`;
  }

  found.sort((a, b) => {
    if (a.sdkMatch !== b.sdkMatch) return a.sdkMatch ? -1 : 1;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (a.kind === 'venv' && b.kind === 'venv') {
      const ra = envRank.get(pathKey(a.path)) ?? Number.MAX_SAFE_INTEGER;
      const rb = envRank.get(pathKey(b.path)) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
    }
    return a.path.localeCompare(b.path);
  });
  return found;
}

/**
 * Turn a declared `create` block into one concrete command.
 *
 * Pure and separate from the spawn: the panel owns processes, this owns the
 * mapping from "user picked venv, path .venv, version 3.12" to argv. Keeping it
 * here means the rules (placeholders, containment, which provider exists) are
 * unit-testable without a child process, and the handler stays a spawn call.
 */
export interface EnvironmentPlan {
  provider: string;
  /** Absolute target directory. */
  dir: string;
  command: string[];
  /** Human form for the terminal echo (`python -m venv /path`). */
  display: string;
}

export interface PlanEnvironmentOptions {
  create: Record<string, EnvironmentCreateSpec> | undefined;
  provider?: string;
  root: string;
  /** Project-relative directory from the dialog; absolute is accepted only inside the root. */
  dir: string;
  version?: string;
  /** The interpreter that builds the environment, when the command needs one. */
  toolchain?: string;
}

export function planEnvironment(o: PlanEnvironmentOptions): EnvironmentPlan {
  const create = o.create ?? {};
  const providers = Object.keys(create);
  if (!providers.length) throw new Error('this language declares no environment providers');
  const provider = o.provider || providers[0];
  const spec = create[provider];
  if (!spec) throw new Error(`unknown provider "${provider}"; this plugin offers ${providers.join(', ')}`);

  const root = resolve(o.root);
  const raw = (o.dir || spec.defaultPath || '').trim();
  if (!raw) throw new Error('a target directory is required');
  const dir = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const rel = relative(root, dir);
  // The environment is part of the project, so a path that resolves outside it is
  // a mistake, not an advanced option: the runner and the language server both
  // assume the project root contains their environment.
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`the environment must live inside the project (${root})`);
  }

  const version = (o.version ?? '').trim();
  if (spec.wantsVersion && !version) throw new Error(`provider "${provider}" needs a version (for example 3.12)`);
  const needsToolchain = spec.command.includes('{toolchain}');
  if (needsToolchain && !o.toolchain) {
    throw new Error('this provider builds the environment from an existing interpreter; pick one first');
  }

  const command = spec.command.map((part) =>
    part
      .split('{path}').join(dir)
      .split('{toolchain}').join(o.toolchain ?? '')
      .split('{version}').join(version),
  );
  return { provider, dir, command, display: command.join(' ') };
}

/** Where the new environment's interpreter should be, once it exists. */
export function environmentExecutable(
  dir: string,
  envBins: string[] | undefined,
  isFile: (p: string) => boolean = (p) => existsSync(p) && fileSize(p) > 0,
): string | undefined {
  for (const bin of envBins ?? []) {
    const p = join(dir, bin);
    if (isFile(p)) return p;
  }
  return undefined;
}

/**
 * Which candidate should be the project interpreter.
 *
 * A pin always wins (that is what pinning means). Otherwise the first project
 * environment, otherwise the SDK-named one, otherwise nothing: guessing "the
 * first thing on PATH" when a project venv exists is how the wrong interpreter
 * gets used without anyone noticing.
 */
export function pickInterpreter(
  candidates: InterpreterCandidate[],
  opts: { pinned?: string } = {},
): InterpreterCandidate | undefined {
  if (opts.pinned) {
    const hit = candidates.find((c) => c.path.toLowerCase() === opts.pinned!.toLowerCase());
    if (hit) return hit;
  }
  const venv = candidates.find((c) => c.kind === 'venv');
  if (venv) return venv;
  const sdk = candidates.find((c) => c.sdkMatch);
  if (sdk) return sdk;
  return candidates[0];
}
