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
import { basename, delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { probeVersion } from './discover.js';

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
}

/**
 * Per-language discovery data.
 *
 * Adding a language means adding a row here, not editing the loop below.
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
}

const KIND_ORDER: Record<InterpreterKind, number> = {
  venv: 0,
  sdk: 1,
  conda: 2,
  'version-manager': 3,
  path: 4,
};

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
  const spec = INTERPRETER_SPECS[languageId];
  if (!spec) return [];
  const home = opts.home ?? homedir();
  const isFile = opts.isFile ?? ((p: string) => existsSync(p) && fileSize(p) > 0);
  const found: InterpreterCandidate[] = [];
  const seen = new Set<string>();

  const add = (path: string, kind: InterpreterKind, source: string): void => {
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path, label: '', kind, source });
  };

  // 1. Project-local environments (`.venv`, `venv`, …).
  for (const dir of spec.envDirs) {
    const envDir = join(rootDir, dir);
    if (!existsSync(join(envDir, spec.marker))) continue;
    for (const bin of spec.envBins) {
      const p = join(envDir, bin);
      if (isFile(p)) {
        add(p, 'venv', dir);
        break;
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
      c.sdkMatch =
        sdk.includes(dirName.toLowerCase()) ||
        sdk.includes(c.version ? `python ${c.version}` : '\u0000') ||
        sdk.includes(basename(c.path).replace(/\.exe$/i, '').toLowerCase());
    }
    const head = c.version ? `${languageId === 'python' ? 'Python ' : ''}${c.version}` : kindLabel(c.kind);
    c.label = `${head} (${c.source})`;
  }

  found.sort((a, b) => {
    if (a.sdkMatch !== b.sdkMatch) return a.sdkMatch ? -1 : 1;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.path.localeCompare(b.path);
  });
  return found;
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
