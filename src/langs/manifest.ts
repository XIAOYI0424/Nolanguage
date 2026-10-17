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
   * `"stub"` = the bundled minimal Python server in `src/python/pyrightServer.py`.
   * Named capability, not a language check.
   */
  bundledFallback?: 'stub';
}

export interface DapSpec {
  adapter: string;
  type?: string;
}

export interface ProfilerSpec {
  adapter: string;
  memoryHint?: string;
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
  profiler?: ProfilerSpec;
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
  }

  const lsp = m.lsp as Record<string, unknown> | undefined;
  if (lsp && lsp.discovery !== undefined) {
    const d = lsp.discovery as Record<string, unknown>;
    for (const key of ['commands', 'envVars', 'knownPaths']) {
      if (d[key] !== undefined && (!Array.isArray(d[key]) || (d[key] as unknown[]).some((x) => typeof x !== 'string'))) {
        add(`lsp.discovery.${key}`, 'must be an array of strings');
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

/** `trust.sandbox` defaults to `subprocess`: the safe choice for a plugin. */
export function sandboxOf(m: LanguageManifest): TrustSandbox {
  return m.trust?.sandbox ?? 'subprocess';
}
