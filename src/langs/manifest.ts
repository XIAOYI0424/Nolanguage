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
  /** Server command; `{resolved}` is replaced by the discovery result. */
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
   * stop anywhere. The command is a shell string with the same placeholders,
   * plus `{toolchain}` when the run block's discovery found a compiler.
   */
  preLaunch?: { cmd?: string; timeoutMs?: number };
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
  }

  const lsp = m.lsp as Record<string, unknown> | undefined;
  if (lsp) {
    validateDiscovery(lsp.discovery, 'lsp.discovery', add);
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
