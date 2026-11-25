/**
 * Language plugin manifest — the declarative description of a language.
 *
 * The substrate understands this file and nothing else. There is no
 * `LanguageId` union, no `switch (desc.id)`, no per-language branch anywhere in
 * the engine: Python and a user-installed Rust plugin are read by the same
 * code path.
 *
 * Two design rules worth stating explicitly, because they are what make the
 * plugin boundary honest:
 *
 *  - **`builtin/` and `languages/` use the identical format.** The only
 *    differences are where the directory lives and whether it can be
 *    uninstalled. A special "official" shape would leak into every consumer.
 *  - **No logic in the manifest.** Anything conditional belongs in
 *    `runtime.js` (the `script-host` runtime) or in a bootstrap script, never
 *    in `if/else` fields here.
 */
import type { RunConfig, ScaffoldSpec } from '../runtimes/types.js';
import type { BundledFallbackSpec } from '../lsp/bundledFallback.js';
import type { DependencySpec } from './dependencies.js';

export type { BundledFallbackSpec };

export type TrustSandbox = 'none' | 'subprocess' | 'wasm';

/** One highlighting rule. Compiled to a sticky regex by the UI tokeniser. */
export interface GrammarRule {
  /** Regular expression source (no delimiters). */
  re: string;
  /** Token class: c=comment s=string d=number k=keyword n=name b=builtin f=function cl=class. */
  cls: string;
  /** Extra regex flags (`m` for line-anchored rules). `y` is always added. */
  flags?: string;
}

export interface FileSpec {
  /** Extensions without the dot (`["rs"]`); a leading dot is tolerated. */
  extensions: string[];
  /** Default extension for a new file (`rs`). */
  defaultExt?: string;
  /** Plugin-relative icon path. */
  icon?: string;
  /** Buffer file name inside the workspace (`main.py`). */
  fileName?: string;
}

export interface LspSpec {
  /** How to find the server binary. All fields optional; first hit wins. */
  discovery?: {
    commands?: string[];
    envVars?: string[];
    knownPaths?: string[];
  };
  /**
   * Launch template. Placeholders: `{resolved}` (the discovered binary),
   * `{dist}` (the distribution root, for launchers that live in `bin/`),
   * `{root}`, `{dataDir}`, `{java}`, and `{glob:<pattern>}`.
   *
   * Needed because not every server is launched by its discovered binary:
   * jdtls ships a `.bat` that shells out to Python and ends with `pause`, so the
   * real command is `java -jar …/equinox.launcher_*.jar`.
   */
  command?: string[];
  args?: string[];
  /** LSP `languageId` sent in `textDocument/didOpen`. Defaults to the plugin id. */
  languageId?: string;
  /** Human name for the status bar (`pyright`, `gopls`). */
  serverName?: string;
  /** Rough resident-set hint, for the resource budget. */
  memoryHint?: string;
  /** Without this file in the workspace the server is "degraded", not broken. */
  requiresProjectFile?: string;
  /** What to tell the user when discovery fails. */
  degradedNote?: string;
  /** True when the language deliberately has no language server. */
  disabled?: boolean;
  /**
   * First-answer timeout. Type-checking servers need longer than tokenisers, so
   * this used to be a per-language branch in the engine.
   */
  diagnosticsTimeoutMs?: number;
  /** Second wait after a nudge, for a cold server that is still loading. */
  coldDiagnosticsTimeoutMs?: number;
  /**
   * Start this server during `init()` instead of on first use. Set for the
   * language whose editor experience must be ready immediately (Python).
   */
  eager?: boolean;
  /**
   * A server the *platform* ships for this language when discovery fails.
   *
   * The plugin declares the command, so the engine never has to know which
   * language a fallback belongs to. Placeholders: `{toolchain}` (the resolved
   * interpreter/compiler) and `{embedded:<key>}` (a file inside the executable,
   * or `src/<sourceDir>/<key>` in a source run).
   *
   * It used to be the literal `"stub"`, resolved by a Python-only function in
   * the engine — a named capability that was a language check underneath.
   */
  bundledFallback?: BundledFallbackSpec;
  /**
   * Where this server comes from, when it is not installed.
   *
   * Declared so `nlg lang server` can answer "what is missing, how big is it,
   * what exactly do I type" without a per-language table in the CLI. The
   * provider is *not* used at runtime: discovery still decides what runs, and a
   * managed install is only consulted when discovery finds nothing.
   */
  provider?: ServerProviderSpec;

  // ---------------- pooled manager (opt-in) ----------------
  //
  // Everything below is data, not code: the manager pools, routes, schedules and
  // degrades; the plugin only says *what* its project is and *what to say* when
  // no server is around. A language that leaves `manager` unset keeps the
  // one-client-per-language path, which is what makes this migration reversible
  // one manifest at a time.
  /** Route this language through `LspManager` (pooling, fallback, scheduling). */
  manager?: boolean;
  /** Project-root markers, walked up from the file (`pom.xml`, `Cargo.toml`). */
  projectMarkers?: string[];
  /** Passed to `initialize.initializationOptions` verbatim. */
  initializationOptions?: Record<string, unknown>;
  /**
   * Wipe this plugin's per-root data directory before each launch.
   *
   * For servers that keep their own workspace state and cannot reopen one
   * reliably (jdtls 23.1 in this environment: the second start handshakes and
   * then never imports anything). The directory count stays bounded because it
   * is per root, and a start always begins from a known state.
   */
  freshDataDir?: boolean;
  /** Idle milliseconds before the pooled server is stopped. */
  idleTtlMs?: number;
  /** How long one request may wait for a cold server before the fallback answers. */
  firstRequestBudgetMs?: number;
  /** Budget for an explicit action (definition, formatting, signature help). */
  navBudgetMs?: number;
  /** Budget for the initialize handshake. */
  startTimeoutMs?: number;
  /** Which incremental strategy to use; `git` chains to content stamps. */
  incremental?: 'git' | 'content-hash' | 'none';
  /** Declarative fallback: keywords and a declaration pattern, not code. */
  fallback?: LexicalFallbackSpec;
  /** Optional `--version` args; absent means "identify the binary by its stamp". */
  versionArgs?: string[];
  /** Pinned server version, when the launcher file does not change on upgrade. */
  serverVersion?: string;
}

export interface LexicalFallbackSpec {
  kind?: 'lexical';
  keywords?: string[];
  types?: string[];
  /** Regex source with one capture group naming a declaration. */
  declarationPattern?: string;
  note?: string;
}

export interface ServerProviderSpec {
  /** `npm` and `go` are run for the user; `github` prints instructions instead. */
  kind: 'npm' | 'go-install' | 'github';
  /** npm package, Go module path, or `owner/repo`. */
  package: string;
  /** Pinned version. Absent only for `github`, where a user picks the asset. */
  version?: string;
  /** npm: the executable inside `node_modules/.bin/`. */
  bin?: string;
  /**
   * Extra packages the install must pull in, each already versioned
   * (`typescript@5.6.3`). A server whose peer dependency is not installed
   * starts and then fails on the first request — typescript-language-server
   * needs `typescript` for exactly that reason.
   */
  also?: string[];
  /** github: the release asset to look for. */
  asset?: string;
}

export interface DapSpec {
  adapter: string;
  type?: string;
}

export interface ProfilerSpec {
  adapter: string;
  memoryHint?: string;
}

/** One data-migration step shipped by a plugin, run on upgrade. */
export interface MigrationSpec {
  /** Version the step upgrades *from*. */
  from: string;
  /** Version the step upgrades *to*. */
  to: string;
  /** Plugin-relative script, run with the data directory as its argument. */
  file: string;
}

/** A debug adapter a language server can drive. */
export interface DebugSpec {
  /** Adapter id (`debugpy`, `delve`); resolved against `manifest.debug.discovery`. */
  adapter: string;
  /** DAP `type` sent in `initialize`. Defaults to the adapter id. */
  type?: string;
  /** How to find the adapter binary. */
  discovery?: {
    commands?: string[];
    envVars?: string[];
    knownPaths?: string[];
  };
  /** Launch command; `{resolved}` is replaced by the discovery result. */
  command?: string[];
  /** Extra arguments (`--listen` style adapters only). */
  args?: string[];
  /** Human name for the status bar (`debugpy`, `delve`). */
  serverName?: string;
  /** Rough resident-set hint, for the resource budget. */
  memoryHint?: string;
  /** What to tell the user when discovery fails. */
  degradedNote?: string;
  /** Concrete install command shown when the adapter is missing. */
  install?: string;
  /**
   * The DAP `launch` (and `attach`) payload, as a template.
   *
   * The engine used to hardcode a Python/Go-shaped payload; anything else
   * (Java's `mainClass`, cppdbg's `MIMode`, Node's `runtimeExecutable`) could
   * not be expressed. Values are strings with placeholders, or literals to
   * pass through untouched. Omit it and today's default shape is used, so
   * existing Python/Go manifests keep working.
   *
   * Placeholders: `{program}` `{file}` `{workdir}` `{cwd}` `{args}` `{env}`
   * `{stopOnEntry}` `{resolved}`.
   */
  launch?: Record<string, unknown>;
  /**
   * Build the target before debugging. Compiled languages have no source-level
   * debug target: without this, the debugger is handed a `.cpp` and cannot
   * stop anywhere.
   *
   * `argv` is the safe shape: one array element per process argument, with the
   * same placeholders plus `{toolchain}` when discovery found a compiler. The
   * engine never invokes a shell for it. `cmd` is accepted for older plugins,
   * but it is tokenised locally and run without a shell too.
   */
  preLaunch?: { argv?: string[]; cmd?: string; timeoutMs?: number };
  /** Whether this adapter can attach to an already-running target. */
  supportsAttach?: boolean;
}

export interface LanguageManifest {
  id: string;
  displayName: string;
  version: string;
  /** Plugin API compatibility, e.g. `^1.0.0`. */
  apiVersion: string;
  publisher?: string;
  description?: string;
  /**
   * Presentation order in menus and the language picker. Lower comes first;
   * unset sorts after every explicit value. Declarative on purpose — the engine
   * must not know that Python "should" be first.
   */
  order?: number;
  trust?: { sandbox?: TrustSandbox; signature?: string };
  file: FileSpec;
  grammar?: { rules: GrammarRule[] };
  scaffold?: ScaffoldSpec;
  lsp?: LspSpec;
  run?: RunConfig;
  /**
   * Where this language declares its third-party packages, and how to install
   * one. The *format* is data, so the reader never branches on the language.
   */
  dependencies?: DependencySpec;
  dap?: DapSpec;
  debug?: DebugSpec;
  profiler?: ProfilerSpec;
  /**
   * Feature switches a plugin may turn **off**. Everything here is on by
   * default: a language that says nothing gets the built-in lexical completion,
   * so adding a language never means writing (or declaring) a completion
   * engine. Only a plugin whose text would make word-shaped candidates noise —
   * Markdown, where every English word looks like an identifier — declines it.
   */
  contributes?: {
    completion?: {
      lexical?: { enabled?: boolean };
    };
  };
  /**
   * Data migrations, run in order when the plugin is upgraded. The plugin body
   * is replaced wholesale; this is the hook that keeps `data/<id>/` (sessions,
   * run configs, breakpoints) readable across versions.
   */
  migrations?: MigrationSpec[];
}

/** Where a manifest came from. Same format either way. */
export interface PluginSource {
  kind: 'builtin' | 'user';
  /** Directory holding `manifest.json`. */
  dir: string;
  /** True when the user can uninstall it. */
  removable: boolean;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ManifestValidation {
  ok: boolean;
  issues: ValidationIssue[];
}

const ID_RE = /^[a-z][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const API_RANGE_RE = /^(\^|~|>=|<=|>|<|=)?\s*\d+\.\d+\.\d+$/;

const KNOWN_CLASSES = new Set(['c', 's', 'd', 'k', 'n', 'b', 'f', 'cl']);

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Shared validation for every `discovery` block (`run` / `lsp` / `debug`). */
function validateDiscovery(
  raw: unknown,
  field: string,
  add: (field: string, message: string) => void,
): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    add(field, 'must be an object');
    return;
  }
  const d = raw as Record<string, unknown>;
  for (const key of ['commands', 'envVars', 'knownPaths']) {
    if (d[key] !== undefined && (!Array.isArray(d[key]) || (d[key] as unknown[]).some((x) => typeof x !== 'string'))) {
      add(`${field}.${key}`, 'must be an array of strings');
    }
  }
  if (d.versionFiles === undefined) return;
  if (!Array.isArray(d.versionFiles)) {
    add(`${field}.versionFiles`, 'must be an array of { path, format }');
    return;
  }
  for (const [i, rawVf] of d.versionFiles.entries()) {
    const vf = rawVf as Record<string, unknown>;
    const at = `${field}.versionFiles[${i}]`;
    if (!asString(vf.path)) add(`${at}.path`, 'is required');
    const format = asString(vf.format);
    if (!['plain', 'json', 'toml', 'regex'].includes(format)) {
      add(`${at}.format`, 'must be one of plain | json | toml | regex');
    }
    if (format === 'json' && !asString(vf.key)) {
      add(`${at}.key`, 'is required for format "json"');
    }
    if (format === 'regex') {
      if (!asString(vf.pattern)) add(`${at}.pattern`, 'is required for format "regex"');
      else {
        try {
          new RegExp(String(vf.pattern));
        } catch (err) {
          add(`${at}.pattern`, `does not compile: ${(err as Error).message}`);
        }
      }
    }
  }
}

/**
 * Validate a parsed `manifest.json`.
 *
 * Deliberately hand-written rather than schema-library driven: the project has
 * no third-party runtime dependencies, and the rule set is small enough that a
 * precise, human-readable message per field is cheaper than a generic one.
 */
/** `run.interpreters`: every field optional, but the type has to be right. */
function validateInterpreters(value: unknown, field: string, add: (f: string, m: string) => void): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    add(field, 'must be an object');
    return;
  }
  const spec = value as Record<string, unknown>;
  for (const key of ['envDirs', 'envBins', 'exeNames', 'versionDirs', 'versionBins', 'versionArgs']) {
    const v = spec[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x))) {
      add(`${field}.${key}`, 'must be an array of non-empty strings');
    }
  }
  for (const key of ['marker', 'envListFile', 'sdkPrefix']) {
    const v = spec[key];
    if (v !== undefined && (typeof v !== 'string' || !v)) {
      add(`${field}.${key}`, 'must be a non-empty string when present');
    }
  }
  if (spec.create !== undefined) validateCreates(spec.create, `${field}.create`, add);
}

/**
 * `run.interpreters.create`: the commands that build an environment.
 *
 * Three things are checked here rather than at spawn time: the command is a
 * string array (a single string would be handed to spawn as argv[0]), every
 * placeholder is one the engine actually fills, and `defaultPath` stays inside
 * the project. A literal `{foo}` reaching `spawn` fails at the user's screen with
 * `ENOENT {foo}`, which is unreadable and unactionable.
 */
const CREATE_PLACEHOLDERS = ['{toolchain}', '{path}', '{version}'];

function validateCreates(value: unknown, field: string, add: (f: string, m: string) => void): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    add(field, 'must be an object keyed by provider (venv, conda, …)');
    return;
  }
  for (const [provider, raw] of Object.entries(value as Record<string, unknown>)) {
    const at = `${field}.${provider}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      add(at, 'must be an object');
      continue;
    }
    const spec = raw as Record<string, unknown>;
    if (!Array.isArray(spec.command) || spec.command.length === 0 || spec.command.some((c) => typeof c !== 'string' || !c)) {
      add(`${at}.command`, 'must be a non-empty array of non-empty strings');
    } else {
      const bad = spec.command
        .flatMap((c) => String(c).match(/\{[a-zA-Z0-9_]+\}/g) ?? [])
        .filter((p) => !CREATE_PLACEHOLDERS.includes(p));
      if (bad.length) add(`${at}.command`, `unknown placeholder(s) ${[...new Set(bad)].join(', ')}; known: ${CREATE_PLACEHOLDERS.join(', ')}`);
    }
    if (spec.defaultPath !== undefined) {
      const p = spec.defaultPath;
      if (typeof p !== 'string' || !p) add(`${at}.defaultPath`, 'must be a non-empty string when present');
      else if (/^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) add(`${at}.defaultPath`, 'must be project-relative');
      else if (p.replace(/\\/g, '/').split('/').some((seg) => seg === '..')) add(`${at}.defaultPath`, 'must not escape the project');
    }
    for (const key of ['label']) {
      const v = spec[key];
      if (v !== undefined && (typeof v !== 'string' || !v)) add(`${at}.${key}`, 'must be a non-empty string when present');
    }
    if (spec.wantsVersion !== undefined && typeof spec.wantsVersion !== 'boolean') {
      add(`${at}.wantsVersion`, 'must be a boolean');
    }
  }
}

/**
 * Template declarations, checked where the manifest is loaded.
 *
 * A `{{placeholder}}` that no parameter declares used to fail at generation time,
 * on the user's screen; here it fails at install, on the person who wrote it.
 */
function validateTemplates(list: unknown, add: (field: string, message: string) => void): void {
  if (!Array.isArray(list)) {
    add('scaffold.templates', 'must be an array');
    return;
  }
  const ids = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const where = `scaffold.templates[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      add(where, 'must be an object');
      continue;
    }
    const t = raw as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id : '';
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) add(`${where}.id`, 'must be a lowercase id (a-z, 0-9, -)');
    else if (ids.has(id)) add(`${where}.id`, `duplicate template id "${id}"`);
    else ids.add(id);
    if (typeof t.name !== 'string' || !t.name) add(`${where}.name`, 'must be a non-empty string');
    if (t.kind !== undefined && t.kind !== 'project' && t.kind !== 'file') add(`${where}.kind`, 'must be "project" or "file"');

    const declared = new Set<string>();
    const params = Array.isArray(t.params) ? t.params : [];
    for (const [j, p] of params.entries()) {
      const at = `${where}.params[${j}]`;
      if (!p || typeof p !== 'object') {
        add(at, 'must be an object');
        continue;
      }
      const param = p as Record<string, unknown>;
      const key = typeof param.key === 'string' ? param.key : '';
      if (!key || !/^[a-z][a-zA-Z0-9]*$/.test(key)) add(`${at}.key`, 'must be a camelCase identifier');
      else if (declared.has(key)) add(`${at}.key`, `duplicate param "${key}"`);
      else declared.add(key);
      if (typeof param.label !== 'string' || !param.label) add(`${at}.label`, 'must be a non-empty string');
      const kind = param.kind;
      if (kind !== 'text' && kind !== 'select' && kind !== 'boolean' && kind !== 'multiselect') {
        add(`${at}.kind`, 'must be text | select | boolean | multiselect');
      }
      if ((kind === 'select' || kind === 'multiselect') && !Array.isArray(param.options)) {
        add(`${at}.options`, 'is required for select and multiselect');
      }
      if (param.pattern !== undefined) {
        try {
          new RegExp(String(param.pattern));
        } catch {
          add(`${at}.pattern`, 'must be a valid regular expression');
        }
      }
    }

    const files = Array.isArray(t.files) ? t.files : [];
    if (!files.length) add(`${where}.files`, 'must contain at least one file');
    for (const [j, f] of files.entries()) {
      const at = `${where}.files[${j}]`;
      if (!f || typeof f !== 'object') {
        add(at, 'must be an object');
        continue;
      }
      const file = f as Record<string, unknown>;
      if (typeof file.path !== 'string' || !file.path) add(`${at}.path`, 'must be a non-empty string');
      if (typeof file.template !== 'string') add(`${at}.template`, 'must be a string');
      if (file.when !== undefined) {
        const param = params.find((p) => (p as Record<string, unknown> | undefined)?.key === file.when) as
          | Record<string, unknown>
          | undefined;
        if (!param || param.kind !== 'boolean') add(`${at}.when`, 'must name a declared boolean param');
      }
      for (const text of [file.path, file.template]) {
        if (typeof text !== 'string') continue;
        for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) {
          if (!declared.has(m[1])) add(at, `uses {{${m[1]}}} but no such param is declared`);
        }
      }
    }
  }
}

/**
 * Validate a plugin's `run.modes` block.
 *
 * A mode is a named alternative to the default step list (`test` is the only
 * one the engine itself understands, but a plugin may add more and the IDE
 * will offer them). Until now the block was copied into `RunConfig` unread:
 * a typo in `role` degraded a failing build into an ordinary non-zero exit,
 * and an empty step list made "Run tests" answer with a mystery timeout. Both
 * are manifest bugs and should fail at install time, not at run time.
 */
const RUN_ROLES = new Set(['build', 'run', 'test']);
function validateModes(value: unknown, field: string, add: (f: string, m: string) => void): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    add(field, 'must be an object keyed by mode name (run, test, …)');
    return;
  }
  for (const [mode, raw] of Object.entries(value as Record<string, unknown>)) {
    const at = `${field}.${mode}`;
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(mode)) {
      add(at, 'mode name must be lower-case letters, digits, "-" or "_"');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      add(at, 'must be an object');
      continue;
    }
    const cfg = raw as Record<string, unknown>;
    if (cfg.timeoutMs !== undefined && (typeof cfg.timeoutMs !== 'number' || !(cfg.timeoutMs > 0))) {
      add(`${at}.timeoutMs`, 'must be a positive number');
    }
    if (cfg.command !== undefined && (!Array.isArray(cfg.command) || cfg.command.some((c) => typeof c !== 'string' || !c))) {
      add(`${at}.command`, 'must be an array of non-empty strings');
    }
    if (cfg.steps === undefined) continue;
    if (!Array.isArray(cfg.steps) || !cfg.steps.length) {
      add(`${at}.steps`, 'must be a non-empty array when present');
      continue;
    }
    cfg.steps.forEach((step, i) => {
      const st = `${at}.steps[${i}]`;
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        add(st, 'must be an object');
        return;
      }
      const o = step as Record<string, unknown>;
      if (typeof o.role !== 'string' || !RUN_ROLES.has(o.role)) {
        add(`${st}.role`, 'must be one of build | run | test');
      }
      if (typeof o.cmd !== 'string' || !o.cmd.trim()) {
        add(`${st}.cmd`, 'must be a non-empty command template');
        return;
      }
      if (o.timeoutMs !== undefined && (typeof o.timeoutMs !== 'number' || !(o.timeoutMs > 0))) {
        add(`${st}.timeoutMs`, 'must be a positive number');
      }
      // `{filter}` is only substituted for the step that runs the tests; in a
      // build step it would silently expand to an empty string and look like a
      // mystery flag.
      if (o.cmd.includes('{filter}') && o.role !== 'test') {
        add(`${st}.cmd`, '`{filter}` is only substituted in a `test` step');
      }
    });
  }
}

export function validateManifest(raw: unknown): ManifestValidation {
  const issues: ValidationIssue[] = [];
  const add = (field: string, message: string): void => {
    issues.push({ field, message });
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: '', message: 'manifest must be a JSON object' }] };
  }
  const m = raw as Record<string, unknown>;

  // A localization plugin contributes a translation bundle, not a language: it has
  // no `file`/`grammar`/`run` and is discovered by the i18n loader, never by the
  // language registry. Validation is therefore not applicable.
  if (asString(m.type) === 'localization') return { ok: true, issues: [] };

  if (!ID_RE.test(asString(m.id))) add('id', 'must be lowercase letters, digits or hyphens, starting with a letter');
  if (!asString(m.displayName)) add('displayName', 'is required');
  if (!VERSION_RE.test(asString(m.version))) add('version', 'must be semver (1.0.0)');
  if (!API_RANGE_RE.test(asString(m.apiVersion))) add('apiVersion', 'must be a version range (^1.0.0)');

  const trust = m.trust as Record<string, unknown> | undefined;
  if (trust && trust.sandbox !== undefined) {
    if (!['none', 'subprocess', 'wasm'].includes(asString(trust.sandbox))) {
      add('trust.sandbox', 'must be one of none | subprocess | wasm');
    }
  }

  const file = m.file as Record<string, unknown> | undefined;
  if (!file || typeof file !== 'object') {
    add('file', 'is required');
  } else {
    const exts = file.extensions;
    if (!Array.isArray(exts) || !exts.length) add('file.extensions', 'must list at least one extension');
    else {
      for (const e of exts) {
        if (typeof e !== 'string' || !/^\.?[A-Za-z0-9_+-]+$/.test(e)) {
          add('file.extensions', `"${String(e)}" is not a valid extension`);
        }
      }
    }
    if (file.defaultExt !== undefined && typeof file.defaultExt !== 'string') {
      add('file.defaultExt', 'must be a string');
    }
  }

  const grammar = m.grammar as Record<string, unknown> | undefined;
  if (grammar) {
    const rules = grammar.rules;
    if (!Array.isArray(rules)) add('grammar.rules', 'must be an array');
    else {
      for (const [i, r] of rules.entries()) {
        const rule = r as Record<string, unknown>;
        if (typeof rule.re !== 'string' || !rule.re) add(`grammar.rules[${i}].re`, 'must be a regex source string');
        else {
          try {
            // A rule that does not compile would break highlighting for the
            // whole language, so it is rejected at install time.
            new RegExp(rule.re);
          } catch (err) {
            add(`grammar.rules[${i}].re`, `does not compile: ${(err as Error).message}`);
          }
        }
        if (!KNOWN_CLASSES.has(asString(rule.cls))) {
          add(`grammar.rules[${i}].cls`, `must be one of ${[...KNOWN_CLASSES].join(', ')}`);
        }
      }
    }
  }

  const run = m.run as Record<string, unknown> | undefined;
  if (run) {
    if (!asString(run.mode)) add('run.mode', 'is required when `run` is present');
    if (run.requires !== undefined) {
      if (!Array.isArray(run.requires) || run.requires.some((r) => typeof r !== 'string')) {
        add('run.requires', 'must be an array of strings like "template@^1.0.0"');
      }
    }
    if (run.timeoutMs !== undefined && (typeof run.timeoutMs !== 'number' || run.timeoutMs <= 0)) {
      add('run.timeoutMs', 'must be a positive number');
    }
    validateDiscovery(run.discovery, 'run.discovery', add);
    validateInterpreters(run.interpreters, 'run.interpreters', add);
    if (run.modes !== undefined) validateModes(run.modes, 'run.modes', add);
    // The id is matched against the engine's parser table, so it is a name, not
    // a path: lowercase, no separators. An unknown id is not an error here — the
    // language still runs tests, it just gets plain output.
    if (run.testFormat !== undefined) {
      if (typeof run.testFormat !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(run.testFormat)) {
        add('run.testFormat', 'must be a lowercase format id (letters, digits, dash; max 32)');
      }
    }
  }

  const deps = m.dependencies as Record<string, unknown> | undefined;
  if (deps !== undefined) {
    const formats = ['requirements', 'gomod', 'npm', 'pyproject', 'cargo', 'gradle', 'maven'];
    if (typeof deps.format !== 'string' || !formats.includes(deps.format)) {
      add('dependencies.format', `must be one of ${formats.join(' | ')}`);
    }
    // An entry is a file name, or `{ file, format }` when the candidates answer
    // the same question in different languages (requirements.txt vs
    // pyproject.toml). A string is the common case and stays a string.
    const okFile = (f: unknown): boolean => {
      if (typeof f === 'string') return f.length > 0;
      if (!f || typeof f !== 'object') return false;
      const o = f as Record<string, unknown>;
      if (typeof o.file !== 'string' || !o.file) return false;
      if (o.format !== undefined && (typeof o.format !== 'string' || !formats.includes(o.format))) return false;
      return true;
    };
    if (!Array.isArray(deps.files) || !deps.files.length || deps.files.some((f) => !okFile(f))) {
      add('dependencies.files', 'must be a non-empty array of file names or { file, format } objects');
    }
    if (deps.install !== undefined && (!Array.isArray(deps.install) || deps.install.some((c) => typeof c !== 'string' || !c))) {
      add('dependencies.install', 'must be an array of strings when present');
    }
    // `local` names the "install from disk" flavours. A provider with no install
    // command could never run, so both halves are required together.
    if (deps.local !== undefined) {
      if (!deps.install) add('dependencies.local', 'requires dependencies.install to be present');
      if (!deps.local || typeof deps.local !== 'object' || Array.isArray(deps.local)) {
        add('dependencies.local', 'must be an object keyed by kind (editable, file, …)');
      } else {
        for (const [kind, raw] of Object.entries(deps.local as Record<string, unknown>)) {
          const at = `dependencies.local.${kind}`;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            add(at, 'must be an object');
            continue;
          }
          const spec = raw as Record<string, unknown>;
          if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== 'string'))) {
            add(`${at}.args`, 'must be an array of strings');
          }
          if (spec.label !== undefined && (typeof spec.label !== 'string' || !spec.label)) {
            add(`${at}.label`, 'must be a non-empty string when present');
          }
        }
      }
    }
  }

  // Template declarations are validated for every plugin, not only for the
  // ones that also ship an LSP: a language server is optional, a bad template
  // is always a bad template. This used to live inside the `if (lsp)` block,
  // so a plugin without a server could ship an unresolvable {{placeholder}}.
  const scaffold = m.scaffold as Record<string, unknown> | undefined;
  if (scaffold && scaffold.templates !== undefined) validateTemplates(scaffold.templates, add);

  const lsp = m.lsp as Record<string, unknown> | undefined;
  if (lsp) {
    validateDiscovery(lsp.discovery, 'lsp.discovery', add);
    const prov = lsp.provider;
    if (prov !== undefined) {
      const p = prov as Record<string, unknown>;
      const kinds = ['npm', 'go-install', 'github'];
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        add('lsp.provider', 'must be an object with a `kind` and a `package`');
      } else {
        if (typeof p.kind !== 'string' || !kinds.includes(p.kind)) {
          add('lsp.provider.kind', `must be one of ${kinds.join(' | ')}`);
        }
        if (typeof p.package !== 'string' || !p.package) {
          add('lsp.provider.package', 'must name the npm package, Go module or owner/repo');
        }
        // A pinned version is what makes the install reproducible. `github` is
        // exempt because it is manual by design: the user picks the asset.
        if (p.kind !== 'github' && (typeof p.version !== 'string' || !p.version)) {
          add('lsp.provider.version', 'is required for npm/go — an unpinned install is not reproducible');
        }
        for (const opt of ['bin', 'asset']) {
          if (p[opt] !== undefined && (typeof p[opt] !== 'string' || !p[opt])) {
            add(`lsp.provider.${opt}`, 'must be a non-empty string when present');
          }
        }
        if (p.also !== undefined && (!Array.isArray(p.also) || p.also.some((x) => typeof x !== 'string' || !x))) {
          add('lsp.provider.also', 'must be an array of versioned package specs');
        }
      }
    }

    // ---- pooled manager fields ----
    if (lsp.manager !== undefined && typeof lsp.manager !== 'boolean') {
      add('lsp.manager', 'must be a boolean');
    }
    if (lsp.freshDataDir !== undefined && typeof lsp.freshDataDir !== 'boolean') {
      add('lsp.freshDataDir', 'must be a boolean');
    }
    if (lsp.projectMarkers !== undefined) {
      const m2 = lsp.projectMarkers;
      if (!Array.isArray(m2) || !m2.length || m2.some((x) => typeof x !== 'string' || !x || x.includes('/') || x.includes('\\'))) {
        add('lsp.projectMarkers', 'must be a non-empty array of file names (no path separators)');
      }
    }
    if (lsp.initializationOptions !== undefined && (!lsp.initializationOptions || typeof lsp.initializationOptions !== 'object' || Array.isArray(lsp.initializationOptions))) {
      add('lsp.initializationOptions', 'must be an object');
    }
    for (const key of ['idleTtlMs', 'firstRequestBudgetMs', 'navBudgetMs', 'startTimeoutMs']) {
      const v = lsp[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        add(`lsp.${key}`, 'must be a non-negative number of milliseconds');
      }
    }
    if (lsp.incremental !== undefined && !['git', 'content-hash', 'none'].includes(String(lsp.incremental))) {
      add('lsp.incremental', 'must be one of git | content-hash | none');
    }
    if (lsp.versionArgs !== undefined && (!Array.isArray(lsp.versionArgs) || lsp.versionArgs.some((x) => typeof x !== 'string'))) {
      add('lsp.versionArgs', 'must be an array of strings');
    }
    if (lsp.serverVersion !== undefined && (typeof lsp.serverVersion !== 'string' || !lsp.serverVersion)) {
      add('lsp.serverVersion', 'must be a non-empty string when present');
    }
    const lfb = lsp.fallback as Record<string, unknown> | undefined;
    if (lfb !== undefined) {
      if (!lfb || typeof lfb !== 'object' || Array.isArray(lfb)) {
        add('lsp.fallback', 'must be an object');
      } else {
        if (lfb.kind !== undefined && lfb.kind !== 'lexical') {
          add('lsp.fallback.kind', 'must be "lexical" (tree-sitter is a provider, not a manifest value)');
        }
        for (const key of ['keywords', 'types']) {
          const v = lfb[key];
          if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x))) {
            add(`lsp.fallback.${key}`, 'must be an array of non-empty strings');
          }
        }
        if (lfb.declarationPattern !== undefined) {
          if (typeof lfb.declarationPattern !== 'string' || !lfb.declarationPattern) {
            add('lsp.fallback.declarationPattern', 'must be a non-empty string');
          } else {
            try {
              // A pattern that does not compile would throw on the first
              // keystroke, in the one code path that must never fail.
              new RegExp(lfb.declarationPattern, 'g');
            } catch (err) {
              add('lsp.fallback.declarationPattern', `does not compile: ${(err as Error).message}`);
            }
          }
        }
      }
    }

    const fb = lsp.bundledFallback;
    if (fb !== undefined) {
      if (!fb || typeof fb !== 'object' || Array.isArray(fb)) {
        add('lsp.bundledFallback', 'must be an object with a `command` array (the old "stub" string is gone)');
      } else {
        const cmd = (fb as Record<string, unknown>).command;
        if (!Array.isArray(cmd) || !cmd.length || cmd.some((x) => typeof x !== 'string' || !x)) {
          add('lsp.bundledFallback.command', 'must be a non-empty array of strings');
        }
        const dir = (fb as Record<string, unknown>).sourceDir;
        if (dir !== undefined && (typeof dir !== 'string' || !dir)) {
          add('lsp.bundledFallback.sourceDir', 'must be a non-empty string when present');
        }
      }
    }
  }

  const debug = m.debug as Record<string, unknown> | undefined;
  if (debug !== undefined) {
    if (!asString(debug.adapter)) add('debug.adapter', 'is required when `debug` is present');
    validateDiscovery(debug.discovery, 'debug.discovery', add);
    if (debug.command !== undefined && (!Array.isArray(debug.command) || (debug.command as unknown[]).some((x) => typeof x !== 'string'))) {
      add('debug.command', 'must be an array of strings');
    }
  }

  const dap = m.dap as Record<string, unknown> | undefined;
  if (dap !== undefined && asString(dap.adapter) && asString(debug?.adapter) && asString(dap.adapter) !== asString(debug?.adapter)) {
    // Two spellings of the same field is how manifests rot; catch it at install.
    add('dap', `adapter "${String(dap.adapter)}" contradicts debug.adapter "${String(debug?.adapter)}" — keep one of them`);
  }

  const migrations = m.migrations;
  if (migrations !== undefined) {
    if (!Array.isArray(migrations)) add('migrations', 'must be an array of {from, to, file}');
    else {
      for (const [i, s] of migrations.entries()) {
        const step = s as Record<string, unknown>;
        if (!VERSION_RE.test(asString(step.from))) add(`migrations[${i}].from`, 'must be semver (1.0.0)');
        if (!VERSION_RE.test(asString(step.to))) add(`migrations[${i}].to`, 'must be semver (1.0.0)');
        if (!asString(step.file)) add(`migrations[${i}].file`, 'is required');
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Extensions normalised without a leading dot, lowercased. */
export function normaliseExtensions(file: FileSpec): string[] {
  return (file.extensions ?? []).map((e) => e.replace(/^\./, '').toLowerCase());
}

/** True when the manifest declares an executable language. */
export function supportsRun(m: LanguageManifest): boolean {
  return !!m.run;
}

/** True when a separate "Test" action is meaningful (a `test` mode exists). */
export function supportsTest(m: LanguageManifest): boolean {
  return !!m.run?.modes?.test;
}

/** The buffer file name a plugin wants in the workspace. */
export function bufferName(m: LanguageManifest): string {
  if (m.file.fileName) return m.file.fileName;
  const ext = m.file.defaultExt ?? normaliseExtensions(m.file)[0] ?? 'txt';
  return `main.${ext.replace(/^\./, '')}`;
}

/** Primary extension with a leading dot (`".py"`), for display. */
export function primaryExtension(m: LanguageManifest): string {
  const ext = m.file.defaultExt ?? normaliseExtensions(m.file)[0] ?? '';
  return ext ? `.${ext.replace(/^\./, '')}` : '';
}
