/**
 * Language parity: every plugin is the same shape, and no core layer knows a
 * language by name.
 *
 * # Why this exists
 *
 * The platform's contract is that a language is data — a manifest — and the
 * engine is language-blind. That holds in `RunnerFactory` and the runtimes, and
 * it drifted everywhere else: `src/panel` and `src/lsp` carry language names as
 * literals (an extension map, a coverage default of `'python'`, a Python-only
 * fallback server resolved from generic code), and the four builtin manifests
 * disagree about which `lsp` sub-fields they declare.
 *
 * None of that breaks a test today, which is exactly why it needs a gate: each
 * individual literal looks harmless, and the sum is a codebase where adding a
 * language means editing the panel.
 *
 * # What it checks
 *
 *   1. Every plugin declares the same core fields.
 *   2. When a plugin declares `lsp` / `run` / `debug` / `profiler`, the block
 *      has the same required sub-fields as every other plugin that declares it.
 *   3. No core layer compares a language by name (`language === 'python'`,
 *      `case 'go':`), which is the shape that actually costs you.
 *   4. The count of bare language literals per core file does not grow. A
 *      ratchet, not a cliff: the existing ones are listed with a budget so a
 *      refactor can lower it and a new one fails immediately.
 *
 * Capability coverage (which language has debug, profiler, ...) is reported but
 * not enforced — parity there is a product decision, not a shape violation.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BUILTIN = join(ROOT, 'builtin');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

/** Present on every plugin, whatever it does. */
const CORE_FIELDS = ['id', 'displayName', 'version', 'apiVersion', 'publisher', 'description', 'order', 'trust'] as const;

/** Sub-fields required *when* the block exists. */
const BLOCK_FIELDS: Record<string, readonly string[]> = {
  lsp: ['discovery', 'command', 'languageId', 'serverName', 'degradedNote'],
  run: ['mode'],
  debug: ['adapter'],
  profiler: ['adapter'],
  file: ['extensions'],
};

/**
 * Language literals allowed per core file, as a ratchet.
 *
 * Each entry is a known offender with a reason; the gate fails only when the
 * number goes **up**. Lowering a number here is the goal of every cleanup.
 *
 * The numbers are the measured baseline when this gate was written (49 in
 * total, now 48). Five sites were fixed on the way in — coverage no longer
 * checks `language !== 'python'` (it reads `run.coverage`), the interpreter list
 * no longer prefixes labels with a language name, the bundled LSP fallback
 * moved from a Python-only helper into the manifest, and Python's server
 * discovery moved out of the generic client into `src/python/`.
 *
 * `src/langs` joined the scan with the interpreter work: the fallback table and
 * a third copy of the extension map were living there uncounted. That copy and
 * FsService's are both gone now — `langs/extensionIndex.ts` is the only
 * extension table left, and the check above keeps its defaults aligned.
 */
const LITERAL_BUDGET: Record<string, number> = {
  // Demo workspace content: one starter file per language. Data, not logic —
  // but it still belongs in the plugins eventually.
  'src/panel/samples.ts': 19,
  // One left, and it is not a language: `contentFormat: ['markdown',
  // 'plaintext']` is an LSP MIME type. `discoverPythonServer` and friends moved
  // to `src/python/serverDiscovery.ts`, where the language is allowed to live.
  'src/lsp/LspClient.ts': 1,
  // Per-language defaults and notes in the language/migration handlers.
  'src/panel/handlers/languages.ts': 6,
  'src/panel/handlers/migration.ts': 4,
  'src/panel/pythonTraffic.ts': 1,
  'src/panel/coverage.ts': 1,
  // The fallback table itself: three keys, kept so plugins written before
  // `run.interpreters` still get discovery. Built-ins no longer use it.
  'src/langs/interpreters.ts': 3,
  // The `go` **tool name** in `['go', 'install', spec]` — a toolchain, not a
  // language. The provider kind is spelled `go-install` for exactly this reason:
  // nothing in `serverInstall.ts` recognises the *language* `go` by name, and the
  // GOBIN branch keys on the kind, not on the command string.
  'src/langs/serverInstall.ts': 1,
  // The single extension -> language table now. It holds the no-plugin
  // languages plus the defaults a registry-less process (NDebug.exe) needs;
  // the panel replaces the plugin entries with the manifests at startup, and the
  // check above keeps the defaults honest.
  'src/langs/extensionIndex.ts': 13,
  // WorkspaceService dropped off this list: the Python fallback moved into the
  // manifest, taking `stubInterpreter()` (`process.env.PYTHON_BIN ?? 'python'`)
  // with it.
};

interface Plugin {
  id: string;
  dir: string;
  manifest: Record<string, unknown>;
}

function loadPlugins(): Plugin[] {
  const plugins: Plugin[] = [];
  for (const name of readdirSync(BUILTIN)) {
    const dir = join(BUILTIN, name);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const file = join(dir, 'manifest.json');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    plugins.push({ id: String(manifest.id ?? name), dir: name, manifest });
  }
  return plugins;
}

/** Every `.ts` under the given directories. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const LANGUAGE_NAMES = ['python', 'go', 'javascript', 'markdown', 'typescript'] as const;

async function main(): Promise<void> {
  const plugins = loadPlugins();
  check('every builtin plugin loads a manifest', plugins.length >= 4, `${plugins.length} plugin(s): ${plugins.map((p) => p.id).join(', ')}`);

  // ---- 1. core fields on every plugin ------------------------------------
  const missingCore: string[] = [];
  for (const p of plugins) {
    for (const f of CORE_FIELDS) if (!(f in p.manifest)) missingCore.push(`${p.id}.${f}`);
  }
  check('every plugin declares the same core fields', missingCore.length === 0, missingCore.join(', ') || `${CORE_FIELDS.length} fields × ${plugins.length} plugins`);

  // ---- 2. block shape consistency ---------------------------------------
  const shapeProblems: string[] = [];
  const coverage: Record<string, string[]> = {};
  for (const [block, required] of Object.entries(BLOCK_FIELDS)) {
    const owners = plugins.filter((p) => p.manifest[block] !== undefined);
    coverage[block] = owners.map((p) => p.id);
    for (const p of owners) {
      const value = p.manifest[block] as Record<string, unknown> | undefined;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        shapeProblems.push(`${p.id}.${block} is not an object`);
        continue;
      }
      for (const f of required) if (value[f] === undefined) shapeProblems.push(`${p.id}.${block}.${f}`);
    }
  }
  check('a declared block always has its required sub-fields', shapeProblems.length === 0, shapeProblems.join(', ') || Object.keys(BLOCK_FIELDS).join(', '));

  // ---- 3. no language compared by name in core layers --------------------
  // `language === 'python'` / `case 'go':` is the shape that makes a new
  // language require a panel edit. A bare string in a data table is a smell
  // (counted in step 4); a comparison is a bug.
  const coreDirs = ['src/panel', 'src/lsp', 'src/langs', 'src/runtimes', 'src/kernel'];
  const comparisons: string[] = [];
  for (const dir of coreDirs) {
    let files: string[] = [];
    try {
      files = walk(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      // CRLF: splitting on '\n' leaves a trailing '\r', and `$` cannot match
      // before it — the comment strip then silently fails and doc comments get
      // reported as code.
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        // Skip comments: this file's own docs quote the pattern.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const lang of LANGUAGE_NAMES) {
          const compare = new RegExp(`(===|!==|==|!=)\\s*['"]${lang}['"]|['"]${lang}['"]\\s*(===|!==|==|!=)`);
          const caseArm = new RegExp(`^\\s*case\\s+['"]${lang}['"]\\s*:`);
          if (compare.test(code) || caseArm.test(code)) comparisons.push(`${rel}:${i + 1}`);
        }
      });
    }
  }
  check('no core layer compares a language by name', comparisons.length === 0, comparisons.slice(0, 5).join(', ') || `${coreDirs.length} directories scanned`);

  // ---- 3b. interpreter rules are declared, not inherited ------------------
  // The engine keeps a fallback table for plugins written before
  // `run.interpreters` existed. A built-in plugin has no such excuse: if it
  // runs, it must say where its SDKs live, otherwise adding a language still
  // means editing `src/langs/interpreters.ts`.
  const runnable = plugins.filter((p) => p.manifest.run !== undefined);
  const undeclared = runnable
    .filter((p) => (p.manifest.run as Record<string, unknown>).interpreters === undefined)
    .map((p) => p.id);
  check(
    'every runnable plugin declares run.interpreters',
    undeclared.length === 0,
    undeclared.length ? `relying on the engine table: ${undeclared.join(', ')}` : `${runnable.length} plugin(s)`,
  );

  // ---- 3c. the built-in defaults match the manifests they stand in for ----
  // `extensionIndex` ships defaults so a process with no registry (the
  // standalone debugger) can still answer "what language is this file". Those
  // defaults are a copy of the manifests by necessity, so they get checked
  // rather than trusted.
  const { BUILTIN_EXTENSION_DEFAULTS } = await import('../src/langs/extensionIndex.js');
  const drift: string[] = [];
  for (const p of plugins) {
    const exts = (p.manifest.file as { extensions?: string[] } | undefined)?.extensions ?? [];
    for (const ext of exts) {
      const claimed = BUILTIN_EXTENSION_DEFAULTS[ext];
      if (claimed && claimed !== p.id) drift.push(`${ext}: default ${claimed}, ${p.id} claims it`);
    }
  }
  check(
    'built-in extension defaults agree with the manifests',
    drift.length === 0,
    drift.join('; ') || `${Object.keys(BUILTIN_EXTENSION_DEFAULTS).length} default(s)`,
  );

  // ---- 4. literal ratchet ------------------------------------------------
  const counts = new Map<string, number>();
  for (const dir of ['src/panel', 'src/lsp', 'src/langs']) {
    let files: string[] = [];
    try {
      files = walk(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      // Strip comments before counting: a doc comment that mentions a language
      // ("e.g. \"python\" for src/python/...") couples nothing. Counting it
      // makes the ratchet punish documentation, which is backwards.
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      let n = 0;
      for (const lang of LANGUAGE_NAMES) {
        // A bare literal (data or comparison) — the ratchet counts both.
        const m = text.match(new RegExp(`['"]${lang}['"]`, 'g'));
        if (m) n += m.length;
      }
      if (n > 0) counts.set(rel, n);
    }
  }
  const overBudget: string[] = [];
  for (const [file, n] of counts) {
    const budget = LITERAL_BUDGET[file];
    if (budget === undefined) overBudget.push(`${file}: ${n} (new, budget 0)`);
    else if (n > budget) overBudget.push(`${file}: ${n} > ${budget}`);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const budgetTotal = Object.values(LITERAL_BUDGET).reduce((a, b) => a + b, 0);
  check('language literals stay within their budget', overBudget.length === 0, overBudget.join('; ') || `${total} across ${counts.size} file(s), budget ${budgetTotal}`);

  // ---- report (informational) -------------------------------------------
  console.log('\n  capability coverage (not enforced — a product decision):');
  for (const [block, ids] of Object.entries(coverage)) {
    const absent = plugins.filter((p) => !ids.includes(p.id)).map((p) => p.id);
    console.log(`    ${block.padEnd(10)} ${ids.join(', ') || '(none)'}${absent.length ? `   — absent: ${absent.join(', ')}` : ''}`);
  }
  console.log('\n  language literals per file:');
  for (const [file, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const budget = LITERAL_BUDGET[file];
    console.log(`    ${String(n).padStart(3)}  ${file}${budget === undefined ? '' : `  (budget ${budget})`}`);
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exitCode = 1;
  }
}

void main();
