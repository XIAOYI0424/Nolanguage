/**
 * Generate a language plugin's files from a short description.
 *
 * `docs/添加新语言指南.md` is 400 lines of contract, and every new language used to
 * mean re-deriving its manifest by hand — including the sticky-regex rules, the
 * `{toolchain}` quoting, and the `requires` line that must match a host runtime.
 * This module is the guide as code: it emits a manifest that `validateManifest`
 * accepts, so the scaffolding gate fails on the generator rather than on a
 * contributor's first install.
 *
 * Pure: it returns paths and contents. Writing, overwrite policy and the CLI live
 * in `scripts/scaffold-lang.ts`.
 */
import type { GrammarRule, LanguageManifest } from './manifest.js';

/** The host runtimes a plugin may require. Not installable — part of the build. */
export const RUN_MODES = ['none', 'template', 'repl-session', 'directory-session', 'inline-vm', 'script-host'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export interface NewLanguageSpec {
  /** Plugin id; also the folder name. Lowercase letters, digits, dash. */
  id: string;
  /** Menu name; defaults to the id with its first letter upper-cased. */
  displayName?: string;
  /** File extensions without the dot, e.g. `['rs', 'rlib']`. */
  extensions: string[];
  version?: string;
  apiVersion?: string;
  /** Which run block to emit. `none` = render/edit only, Run stays disabled. */
  run?: RunMode;
  /** Language server command for `discovery.commands`, e.g. `rust-analyzer`. */
  lspCommand?: string;
  /** Line-comment prefix used for the grammar rule and the sample file. */
  commentPrefix?: string;
  /** Words highlighted as keywords. Falls back to an empty list (no `k` rule). */
  keywords?: string[];
  /** `image` (extension `png`), `text`, or `markdown` — the CM mode to try first. */
  cmMode?: string;
}

export interface ScaffoldFile {
  /** Path relative to the plugin directory, always `/`-separated. */
  path: string;
  content: string;
}

export interface ScaffoldResult {
  manifest: LanguageManifest;
  files: ScaffoldFile[];
  /** Things the generator could not fill in and a human must decide. */
  todos: string[];
}

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const EXT_RE = /^[A-Za-z0-9_+-]{1,16}$/;

/** Escape a literal for a sticky (`y`) regex: only regex metacharacters matter. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `rust` → `Rust`; leaves names that already carry capitals alone. */
function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function displayNameFor(spec: NewLanguageSpec): string {
  const named = spec.displayName?.trim();
  return named && named.length > 0 ? named : titleCase(spec.id);
}

/**
 * The `run` block for a mode, matching the shapes the runtimes validate.
 *
 * Every path in a step is quoted: the guide's most common first bug is an
 * unquoted `{toolchain}` on a machine whose compiler lives in a folder with a
 * space in its name.
 */
function runBlock(spec: NewLanguageSpec): LanguageManifest['run'] | undefined {
  const mode = spec.run ?? 'none';
  if (mode === 'none') return undefined;
  const ext = spec.extensions[0];
  const sourceExt = `.${ext}`;
  const discovery = { commands: [spec.lspCommand ?? spec.id], envVars: [] as string[] };
  switch (mode) {
    case 'template':
      return {
        mode: 'template',
        requires: ['template@^1.0.0'],
        sourceExt,
        discovery,
        timeoutMs: 20000,
        steps: [
          { role: 'build', cmd: '"{toolchain}" {file} -o "{workdir}/a{exe}"' },
          { role: 'run', cmd: '"{workdir}/a{exe}"' },
        ],
      };
    case 'repl-session':
      return {
        mode: 'repl-session',
        requires: ['repl-session@^1.0.0'],
        sourceExt,
        command: ['{toolchain}'],
        bootstrap: 'bootstrap.py',
        discovery,
        timeoutMs: 15000,
      };
    case 'directory-session':
      return {
        mode: 'directory-session',
        requires: ['directory-session@^1.0.0'],
        sourceExt,
        command: ['{toolchain}'],
        discovery,
        steps: [
          { role: 'build', cmd: '"{toolchain}" build "{workdir}"' },
          { role: 'run', cmd: '"{workdir}/main{exe}"' },
        ],
      };
    case 'inline-vm':
      return {
        mode: 'inline-vm',
        requires: ['inline-vm@^1.0.0'],
        sourceExt,
        vmTimeoutMs: 5000,
      };
    case 'script-host':
      return {
        mode: 'script-host',
        requires: ['script-host@^1.0.0'],
        sourceExt,
        script: 'runtime.js',
        discovery,
        timeoutMs: 15000,
      };
  }
}

/**
 * Build a plugin from a spec. Throws (not returns issues) for input that cannot be
 * made valid — id and extensions — because there is nothing to review in a manifest
 * for a plugin the registry will refuse.
 */
export function buildLanguagePlugin(raw: NewLanguageSpec): ScaffoldResult {
  const id = String(raw.id ?? '').trim();
  if (!ID_RE.test(id)) {
    throw new Error(`invalid language id "${id}": use lowercase letters, digits and dashes, starting with a letter`);
  }
  // Split first, strip the leading dot after: `'.dm,.dmo'` is two extensions, and
  // stripping before the split leaves the second one with its dot.
  const extensions = (raw.extensions ?? [])
    .flatMap((e) => String(e ?? '').split(','))
    .map((e) => e.trim().replace(/^\.+/, ''))
    .filter((e) => e.length > 0);
  if (extensions.length === 0) throw new Error('at least one file extension is required');
  for (const ext of extensions) {
    if (!EXT_RE.test(ext)) throw new Error(`invalid file extension "${ext}": letters, digits, underscore, plus and dash only`);
  }

  const commentPrefix = raw.commentPrefix ?? '//';
  const keywords = (raw.keywords ?? []).map((k) => String(k).trim()).filter((k) => k.length > 0);
  // Order matters: comments and strings first, so a keyword inside a string is not
  // highlighted as a keyword. The regexes are sticky at validation time.
  const rules: GrammarRule[] = [
    { re: `${escapeRe(commentPrefix)}[^\\n]*`, cls: 'c' },
    { re: '"([^"\\\\]|\\\\.)*"', cls: 's' },
  ];
  if (keywords.length > 0) rules.push({ re: `\\b(?:${keywords.map(escapeRe).join('|')})\\b`, cls: 'k' });
  rules.push({ re: '[0-9][0-9_]*(?:\\.[0-9]+)?', cls: 'n' });
  rules.push({ re: '[A-Za-z_][A-Za-z0-9_]*(?=\\()', cls: 'f' });

  const mode = raw.run ?? 'none';
  const manifest: LanguageManifest = {
    id,
    displayName: displayNameFor(raw),
    version: raw.version ?? '1.0.0',
    apiVersion: raw.apiVersion ?? '^1.0.0',
    file: { extensions, defaultExt: extensions[0] },
    grammar: { rules },
  };
  if (hasLspSpec(raw)) {
    const server = String(raw.lspCommand).trim();
    manifest.lsp = {
      discovery: { commands: [server] },
      command: ['{resolved}'],
      args: ['--stdio'],
      languageId: id,
      serverName: server,
      diagnosticsTimeoutMs: 8000,
      coldDiagnosticsTimeoutMs: 30000,
      // Every builtin plugin declares this, and the status bar has nothing better
      // to say when discovery fails: "degraded" must be explainable in words.
      degradedNote: `${server} was not found - Check and hover are unavailable, Run still works`,
    };
  }
  const run = runBlock(raw);
  if (run) manifest.run = run;
  if (mode === 'directory-session') {
    manifest.scaffold = {
      required: true,
      onFirstRun: [{ file: `${id}.proj`, template: `# ${displayNameFor(raw)} project\n` }],
      projectFiles: [`${id}.proj`],
    };
  }
  if (mode === 'repl-session') {
    // The session runtime only promises a directory and these environment
    // variables; persisting state is the bootstrap's job (see the Python plugin).
    manifest.scaffold = {
      required: false,
      onFirstRun: [{ file: 'bootstrap.py', template: 'import os\n\n# NL_SESSION_DIR / NL_SOURCE_FILE / NL_GLOBALS_FILE are provided.\n' }],
    };
  }

  const files: ScaffoldFile[] = [{ path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` }];
  if (mode === 'script-host') files.push({ path: 'runtime.js', content: scriptHostStub() });
  if (mode === 'repl-session') files.push({ path: 'bootstrap.py', content: bootstrapStub() });

  const todos: string[] = [];
  if (!hasLspSpec(raw)) todos.push('no `lsp` block: Check and hover stay unavailable until you add one (Run still works)');
  if (mode === 'none') todos.push('no `run` block: Run is disabled for this language (documents render)');
  if (keywords.length === 0) todos.push('no keywords: only comments, strings, numbers and calls are highlighted');
  if (mode === 'directory-session') todos.push(`scaffold writes "${id}.proj" — replace it with your toolchain's real project file`);

  return { manifest, files, todos };
}

function hasLspSpec(spec: NewLanguageSpec): boolean {
  const cmd = spec.lspCommand?.trim();
  return !!cmd && cmd.length > 0;
}

function scriptHostStub(): string {
  return `// script-host runtime: line-delimited JSON on stdin, answers on stdout.
// See docs/添加新语言指南.md §4.5 — non-JSON lines are treated as user output.
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let nl;
  while ((nl = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim().length > 0) handle(line);
  }
});

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.op === 'run') {
    process.stdout.write(JSON.stringify({ t: 'out', s: 'stdout', text: msg.code }) + '\\n');
    process.stdout.write(JSON.stringify({ t: 'exit', code: 0 }) + '\\n');
  }
}
`;
}

function bootstrapStub(): string {
  return `"""repl-session bootstrap: runs NL_SOURCE_FILE with NL_GLOBALS_FILE persisted.

The engine guarantees the environment variables below; everything else is yours.
See builtin/python@1.0.0/bootstrap.py for a persistent implementation.
"""
import os
import runpy

source = os.environ.get("NL_SOURCE_FILE")
if not source:
    raise SystemExit("NL_SOURCE_FILE is not set")
runpy.run_path(source, run_name="__main__")
`;
}
