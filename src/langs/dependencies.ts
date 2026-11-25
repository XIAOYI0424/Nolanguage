/**
 * What the project depends on: read the file the ecosystem already uses, and
 * install one more package through the installer the plugin names.
 *
 * # Why this is not a per-language branch
 *
 * The *format* differs (a requirements file is a line list, go.mod has a
 * `require` block, package.json is JSON), but the question is the same for every
 * language, and the answer comes from the plugin's manifest. A parser is chosen
 * by `format`, which is data — no `if (language === 'python')` anywhere, which
 * is what `verify:langparity` enforces.
 *
 * # What this deliberately is not
 *
 * No version resolution, no lock file, no virtualenv or module-path management.
 * It reports what a file says and runs the ecosystem's own installer; the
 * installer owns the truth about what ended up on disk. A resolver here would be
 * a worse pip, and a wrong dependency list is more damaging than a short one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { decodeOutput } from '../util/encoding.js';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * How a dependency file is shaped. Named formats, not named languages.
 *
 * `pyproject` is separate from `requirements` on purpose: a TOML file read as a
 * line list yields `name = "demo"` / `version = "1.0.0"` as "packages" and
 * misses the two real ones. One manifest can therefore name a different format
 * per file (see `DependencyFile`).
 */
export type DependencyFormat = 'requirements' | 'gomod' | 'npm' | 'pyproject' | 'cargo' | 'gradle' | 'maven';

/** One candidate file, optionally with a format of its own. */
export interface DependencyFile {
  file: string;
  /** Overrides the spec's `format` for this file. */
  format?: DependencyFormat;
}

export interface DependencySpec {
  /** Default format, used by every plain-string entry in `files`. */
  format: DependencyFormat;
  /**
   * Files to look for, in order. First one that exists wins.
   *
   * An entry may be `{ file, format }` when the candidates disagree — a Python
   * project's `requirements.txt` and `pyproject.toml` are the same question
   * answered in two languages.
   */
  files: Array<string | DependencyFile>;
  /**
   * Command that installs one package, as a prefix. `{toolchain}` is the
   * resolved interpreter/compiler; the package name is appended.
   */
  install?: string[];
  /**
   * Installing something from disk (`pip install -e ./pkg`) is a different
   * command shape from installing a name: the flag goes *before* the path, and
   * there is no version to resolve. Declared per kind so the difference lives in
   * the manifest instead of a `if (pm === 'uv')` in the engine.
   */
  local?: Record<string, LocalInstallSpec>;
}

/** One "install from disk" flavour: `editable` (pip -e), `file` (wheel/sdist). */
export interface LocalInstallSpec {
  /** Args inserted before the path, e.g. `["-e"]`. */
  args?: string[];
  /** Shown in the Packages dialog. */
  label?: string;
}

/** What to install: a registry name, or a path inside the project. */
export type InstallTarget = string | { kind: string; value: string };

export interface Dependency {
  name: string;
  version?: string;
}

/** What the Packages view renders. One report per language, on demand. */
export interface DependencyReport {
  language: string;
  /** The project root the files were looked up in. */
  root: string;
  /** False when the manifest declares no dependency block at all. */
  supported: boolean;
  format?: DependencyFormat;
  /** The file that was read, relative to `root`. Absent when none exists. */
  file?: string;
  /** The candidates from the manifest, in priority order, for the empty state. */
  searched: string[];
  packages: Dependency[];
  /** Imports in the buffer that no declared package covers. */
  undeclared: string[];
  /** True when the manifest names an install command. */
  installable: boolean;
  /** The installer prefix, so the UI can show the command before running it. */
  installTemplate?: string[];
  /** "Install from disk" flavours this language declares (`editable`, `file`, …). */
  installLocal?: Array<{ kind: string; label: string }>;
  /** Why the list is empty, when it is. */
  note?: string;
}

export interface InstallResult {
  ok: boolean;
  code: number | null;
  signal?: string;
  ms: number;
  /** The exact argv that ran, joined for display and for the log line. */
  command: string;
  output: string;
  truncated: boolean;
  error?: string;
}

export interface InstallHooks {
  onData: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Handed the child so the caller can cancel (Stop button, socket close). */
  onSpawn?: (child: ChildProcess) => void;
}

/** Output cap: a runaway installer must not wedge the panel or the socket. */
const OUTPUT_CAP = 2 * 1024 * 1024;

/**
 * Parse a requirements-style line: `name==1.2.3`, `name>=1`, `name[extra]`.
 *
 * Returns `undefined` for anything that is not a package line — a TOML
 * assignment, a URL, an option. The caller decides whether that is silence or a
 * reason to stop.
 */
function parseRequirementLine(line: string): Dependency | undefined {
  const m = /^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/.exec(line);
  if (!m) return undefined;
  const spec = m[3]?.trim();
  return spec ? { name: m[1], version: spec } : { name: m[1] };
}

/**
 * Parse a requirements-style file: `name==1.2.3`, `name>=1`, `name[extra]`,
 * comments and blank lines ignored, `-r other.txt` skipped (following includes
 * would need a resolver, and a wrong list is worse than a short one).
 */
function parseRequirements(text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const dep = parseRequirementLine(line);
    if (dep) out.push(dep);
  }
  return out;
}

/**
 * Read the `[project]` table's `dependencies = [ … ]` out of a pyproject.toml.
 *
 * Deliberately not a TOML parser: a real one is a dependency, and the only key
 * this product needs is one array of PEP 508 strings. Everything outside
 * `[project]` is ignored, which is what keeps `[build-system] requires` — build
 * tooling, not a runtime dependency — out of the list.
 *
 * Line-oriented and small enough to read in one screen, because the failure
 * mode of a hand-written grammar is a silent misread. When the shape is not
 * recognised the answer is an empty list, never a guess.
 */
function parsePyproject(text: string): Dependency[] {
  const out: Dependency[] = [];
  const push = (chunk: string): void => {
    // Each entry is a quoted string; `name = "demo"` never reaches here because
    // only the body of a `dependencies = [ … ]` array is scanned.
    for (const m of chunk.matchAll(/["']([^"']+)["']/g)) {
      const dep = parseRequirementLine(m[1].trim());
      if (dep) out.push(dep);
    }
  };
  let section = '';
  let inDeps = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (!inDeps) {
      const header = /^\[([^\]]+)\]$/.exec(line);
      if (header) {
        section = header[1].trim();
        continue;
      }
      if (section !== 'project') continue;
      const start = /^dependencies\s*=\s*\[(.*)$/.exec(line);
      if (!start) continue;
      inDeps = true;
      push(start[1]);
      if (start[1].includes(']')) inDeps = false;
      continue;
    }
    if (line.startsWith(']')) {
      inDeps = false;
      continue;
    }
    push(line);
    if (line.includes(']')) inDeps = false;
  }
  return out;
}

/** Parse the `require` block of a go.mod (both single-line and block forms). */
function parseGoMod(text: string): Dependency[] {
  const out: Dependency[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const single = /^require\s+(\S+)\s+(\S+)$/.exec(line);
    if (single) {
      out.push({ name: single[1], version: single[2] });
      continue;
    }
    if (inBlock) {
      const m = /^(\S+)\s+(\S+)/.exec(line);
      if (m) out.push({ name: m[1], version: m[2] });
    }
  }
  return out;
}

/** Parse package.json dependencies + devDependencies. */
function parseNpm(text: string): Dependency[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: Dependency[] = [];
  for (const key of ['dependencies', 'devDependencies']) {
    const block = pkg[key];
    if (!block || typeof block !== 'object') continue;
    for (const [name, version] of Object.entries(block as Record<string, unknown>)) {
      out.push({ name, version: typeof version === 'string' ? version : undefined });
    }
  }
  return out;
}

/** Parse `[dependencies]`, `[dev-dependencies]` and target-scoped Cargo.toml tables. */
function parseCargo(text: string): Dependency[] {
  const out: Dependency[] = [];
  const byName = new Map<string, Dependency>();
  let active = false;
  let current: Dependency | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const section = header[1].trim();
      const table = /^(?:dev-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(section);
      active = /(^|\.)(dev-)?dependencies$/.test(section) || !!table;
      if (section === 'workspace.dependencies') active = false;
      current = undefined;
      if (active && table) {
        const name = table[1];
        current = byName.get(name) ?? { name };
        if (!byName.has(name)) { byName.set(name, current); out.push(current); }
      }
      continue;
    }
    if (!active) continue;
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;
    const [, key, value] = assignment;
    if (current) {
      if (key === 'version') current.version = /^['"]([^'"]+)['"]/.exec(value)?.[1];
      if (key === 'package') current.name = /^['"]([^'"]+)['"]/.exec(value)?.[1] ?? current.name;
      continue;
    }
    const inlineVersion = /\bversion\s*=\s*['"]([^'"]+)['"]/.exec(value)?.[1];
    const simpleVersion = /^['"]([^'"]+)['"]$/.exec(value)?.[1];
    const packageName = /\bpackage\s*=\s*['"]([^'"]+)['"]/.exec(value)?.[1] ?? key;
    const dep = { name: packageName, ...(inlineVersion ?? simpleVersion ? { version: inlineVersion ?? simpleVersion } : {}) };
    byName.set(key, dep);
    out.push(dep);
  }
  return out;
}

/** Parse Gradle/Maven project declaration files using their declared format. */
function parseGradle(text: string): Dependency[] {
  const out: Dependency[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/['"]([A-Za-z][A-Za-z0-9_.-]*):([A-Za-z][A-Za-z0-9_.-]*)(?::([^'"\s]+))?['"]/g)) {
    const name = `${m[1]}:${m[2]}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, ...(m[3] ? { version: m[3] } : {}) });
  }
  return out;
}

/** The `<dependency>` blocks of a pom.xml, without pretending to be an XML resolver. */
function parseMaven(text: string): Dependency[] {
  const out: Dependency[] = [];
  const rootOpen = /<(?:[A-Za-z_][\w.-]*:)?project\b[^>]*>/g.exec(text);
  if (!rootOpen) return out;
  const rootTag = rootOpen[0].match(/^<((?:[A-Za-z_][\w.-]*:)?)project/)?.[1] ?? '';
  const closingProject = new RegExp(`<\\/${rootTag}project\\s*>`, 'g');
  const rootClose = closingProject.exec(text);
  if (!rootClose) return out;
  const project = text.slice(rootOpen.index + rootOpen[0].length, rootClose.index);
  // `<dependencyManagement>` also contains a `<dependencies>` block, and it is
  // usually the first one. Those entries are BOM-managed versions, not the
  // project's own dependencies, so drop the section before looking for the
  // real block.
  const managedTag = new RegExp(
    `<${rootTag}dependencyManagement\\b[^>]*>[\\s\\S]*?<\\/${rootTag}dependencyManagement\\s*>`,
    'g',
  );
  const own = project.replace(managedTag, '');
  const dependenciesTag = new RegExp(`<${rootTag}dependencies\\b[^>]*>([\\s\\S]*?)<\\/${rootTag}dependencies\\s*>`, 'g');
  const depBlock = dependenciesTag.exec(own);
  if (!depBlock) return out;
  const dependencyTag = new RegExp(`<${rootTag}dependency\\b[^>]*>([\\s\\S]*?)<\\/${rootTag}dependency\\s*>`, 'g');
  for (const block of depBlock[1].matchAll(dependencyTag)) {
    const group = new RegExp(`<${rootTag}groupId\\b[^>]*>([^<]+)<\\/${rootTag}groupId>`).exec(block[1])?.[1]?.trim();
    const artifact = new RegExp(`<${rootTag}artifactId\\b[^>]*>([^<]+)<\\/${rootTag}artifactId>`).exec(block[1])?.[1]?.trim();
    const version = new RegExp(`<${rootTag}version\\b[^>]*>([^<]+)<\\/${rootTag}version>`).exec(block[1])?.[1]?.trim();
    if (group && artifact) out.push({ name: `${group}:${artifact}`, ...(version ? { version } : {}) });
  }
  return out;
}

/** Dispatch on the declared format. Unknown input yields an empty list. */
export function parseDependencies(format: DependencyFormat, text: string): Dependency[] {
  switch (format) {
    case 'requirements':
      return parseRequirements(text);
    case 'gomod':
      return parseGoMod(text);
    case 'npm':
      return parseNpm(text);
    case 'pyproject':
      return parsePyproject(text);
    case 'cargo':
      return parseCargo(text);
    case 'gradle':
      return parseGradle(text);
    case 'maven':
      return parseMaven(text);
    default:
      return [];
  }
}

/**
 * Names a file imports that the dependency list does not mention.
 *
 * Deliberately textual: this is a hint in the UI ("not declared"), not a
 * resolver. Anything cleverer needs the language server's import graph, and a
 * standard-library import will show up here as "not declared" — which is why the
 * UI labels it a hint and never an error.
 */
export function undeclaredImports(code: string, declared: readonly Dependency[]): string[] {
  const known = new Set(declared.map((d) => d.name.toLowerCase().replace(/-/g, '_')));
  const seen = new Set<string>();
  const out: string[] = [];
  // import x / from x import y / import x.y / require('x') / #include "x"
  const patterns = [
    /^\s*import\s+([A-Za-z_][\w.]*)/gm,
    /^\s*from\s+([A-Za-z_][\w.]*)\s+import/gm,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      const root = m[1].split('.')[0].toLowerCase();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      if (known.has(root)) continue;
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * A package name has to survive being handed to an installer as one argv entry.
 *
 * No shell is involved (`spawn`, never `exec`), so this is not about quoting — it
 * is about an installer misreading the argument as a flag or a path. A leading
 * `-` is the one shape that reliably does damage: `pip install -r x` installs a
 * file instead of the named package.
 */
export function packageNameProblem(name: string): string | undefined {
  if (!name) return 'a package name is required';
  if (name.length > 200) return 'the package name is too long';
  if (name.startsWith('-')) return 'a package name cannot start with "-"';
  if (/[\s"'`;&|$\\(){}]/.test(name)) return `"${name}" contains characters an installer would misread`;
  return undefined;
}

/** True when `abs` is `root` or lives under it. */
function inside(root: string, abs: string): boolean {
  if (abs === root) return true;
  return abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Cap on a dependency file. These are line lists; anything bigger is not one. */
const MAX_DEPENDENCY_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Read the first candidate that exists.
 *
 * A manifest is data, and data can be wrong: a `files` entry that escapes the
 * project root would read a file the user never opened. Such an entry is skipped
 * rather than resolved, and the report then says nothing was found.
 *
 * The read is capped: a `requirements.txt` is a line list, so a 200 MB one is
 * not a dependency file, and reading it whole to find that out is how a probe
 * turns into an out-of-memory.
 */
async function firstReadable(
  root: string,
  entries: ReadonlyArray<{ name: string; format: DependencyFormat }>,
): Promise<{ rel: string; format: DependencyFormat; text: string } | undefined> {
  const resolvedRoot = resolve(root);
  for (const entry of entries) {
    const abs = resolve(resolvedRoot, entry.name);
    if (!inside(resolvedRoot, abs)) continue;
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_DEPENDENCY_FILE_BYTES) continue;
      return { rel: entry.name, format: entry.format, text: await readFile(abs, 'utf8') };
    } catch {
      /* not there — try the next candidate */
    }
  }
  return undefined;
}

/** Normalise `files` (strings or `{ file, format }`) into one shape. */
function candidates(spec: DependencySpec): Array<{ name: string; format: DependencyFormat }> {
  return spec.files.map((entry) =>
    typeof entry === 'string'
      ? { name: entry, format: spec.format }
      : { name: entry.file, format: entry.format ?? spec.format },
  );
}

/**
 * What this language's project declares, and what the buffer uses but does not.
 *
 * The spec is passed instead of the manifest so this module never imports
 * `manifest.ts`: `manifest.ts` already imports the types here, and a cycle back
 * would be rejected by the architecture contract (R2).
 */
export async function readDependencies(
  id: string,
  spec: DependencySpec | undefined,
  root: string,
  code: string,
): Promise<DependencyReport> {
  if (!spec) {
    return {
      language: id,
      root,
      supported: false,
      searched: [],
      packages: [],
      undeclared: [],
      installable: false,
      note: `"${id}" does not declare a dependency file (manifest.dependencies)`,
    };
  }

  const entries = candidates(spec);
  const found = await firstReadable(root, entries);
  const base: DependencyReport = {
    language: id,
    root,
    supported: true,
    format: spec.format,
    searched: entries.map((e) => e.name),
    packages: [],
    undeclared: [],
    installable: Array.isArray(spec.install) && spec.install.length > 0,
    ...(spec.install ? { installTemplate: spec.install } : {}),
    ...(spec.local
      ? { installLocal: Object.entries(spec.local).map(([kind, s]) => ({ kind, label: s.label ?? kind })) }
      : {}),
  };
  if (!found) {
    // Not an error: a new project has no dependency file yet, and the first
    // install creates one, so the empty state has to be usable.
    return { ...base, note: `none of ${base.searched.join(', ')} exists in ${root}` };
  }
  const packages = parseDependencies(found.format, found.text);
  // `format` in the report is the one that was actually used, not the spec's
  // default: a project with only a pyproject.toml must not be described as
  // "requirements".
  return {
    ...base,
    format: found.format,
    file: found.rel,
    packages,
    undeclared: undeclaredImports(code, packages),
  };
}

/**
 * Run the manifest's installer for one package.
 *
 * Resolves with the outcome instead of throwing: "the installer exited 1" is a
 * normal answer the panel must render with the tool's own message, not a
 * rejected promise that loses the output.
 */
export function installPackage(
  spec: DependencySpec | undefined,
  target: InstallTarget,
  toolchain: string | undefined,
  cwd: string,
  hooks: InstallHooks,
): Promise<InstallResult> {
  const started = Date.now();
  const fail = (error: string): InstallResult => ({
    ok: false,
    code: null,
    ms: 0,
    command: '',
    output: '',
    truncated: false,
    error,
  });

  if (!spec?.install?.length) {
    return Promise.resolve(fail('this language does not declare an install command'));
  }
  const want = typeof target === 'string' ? { kind: 'registry', value: target } : target;
  let tail: string[];
  if (want.kind === 'registry') {
    const problem = packageNameProblem(want.value);
    if (problem) return Promise.resolve(fail(problem));
    tail = [want.value];
  } else {
    const local = spec.local?.[want.kind];
    if (!local) return Promise.resolve(fail(`this language does not declare a "${want.kind}" install`));
    const path = String(want.value ?? '').trim();
    if (!path) return Promise.resolve(fail('a path is required'));
    const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    // Same boundary as every other file operation: a path outside the project is
    // refused, because installing it would make the project depend on something
    // the next checkout does not have.
    if (!inside(resolve(cwd), abs)) return Promise.resolve(fail('the package must live inside the project'));
    if (!existsSync(abs)) return Promise.resolve(fail(`no such path: ${path}`));
    tail = [...(local.args ?? []), abs];
  }

  // `{toolchain}` is the interpreter/compiler the run block discovered. Without
  // it the installer would have to be on PATH under a fixed name, which is the
  // assumption the manifest exists to remove.
  const subst = (s: string): string => s.replace(/\{toolchain\}/g, toolchain ?? '');
  const [head, ...rest] = spec.install;
  const command = subst(head);
  const args = [...rest.map(subst), ...tail];
  const shown = [command, ...args].join(' ');
  if (!command) return Promise.resolve(fail('the toolchain for this language could not be resolved'));

  return new Promise<InstallResult>((done) => {
    let bytes = 0;
    let truncated = false;
    const chunks: string[] = [];
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      // No stdin: an installer that asks a question must fail fast rather than
      // wait forever on a pipe nobody is writing to.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    hooks.onSpawn?.(child);

    const take = (stream: 'stdout' | 'stderr') => (d: Buffer): void => {
      const text = decodeOutput(d);
      if (bytes < OUTPUT_CAP) {
        chunks.push(text);
        hooks.onData(stream, text);
      } else if (!truncated) {
        truncated = true;
        hooks.onData('stderr', '\n[output limit reached; later lines were dropped]\n');
      }
      bytes += d.length;
    };
    child.stdout?.on('data', take('stdout'));
    child.stderr?.on('data', take('stderr'));

    child.on('error', (err) => {
      done({ ...fail(String(err)), command: shown, ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      done({
        ok: code === 0,
        code: code ?? null,
        ...(signal ? { signal } : {}),
        ms: Date.now() - started,
        command: shown,
        output: chunks.join(''),
        truncated,
      });
    });
  });
}
