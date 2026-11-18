/**
 * The architecture contract.
 *
 * This file is the paradigm made mechanical. A document describing layers is a
 * suggestion; a check that fails the build is a constraint. Everything here is
 * derived from the actual import graph, so it cannot drift from the code.
 *
 * Six rules:
 *
 *   R1  **Layers.** A slice may import only from a strictly lower layer, or from
 *       its own. The layer of every slice is declared in `architecture.json`,
 *       because that declaration is the *intent* — when the graph and the intent
 *       disagree, someone has to decide which one is wrong.
 *   R2  **No cycles.** Neither the slice graph nor the file graph may contain a
 *       strongly connected component bigger than one, except for the groups
 *       listed in the ledger.
 *   R3  **Vocabulary.** A file named `types.ts` with **no imports at all** is
 *       shared vocabulary and may be imported from any layer. This is what lets
 *       a shape be used by `util` and by `panel` without inventing an edge
 *       between them. The rule is checked, not assumed: a `types.ts` that grows
 *       an import stops being vocabulary and its importers become violations.
 *   R4  **Product boundary.** `debugtool` is a separate product. It may import
 *       only the slices listed for it — never the app shell, never the kernel.
 *   R5  **Budgets.** A file over `maxFileLines` or a slice over `maxSliceFiles`
 *       must be listed with a reason. Budgets are how "it grew" becomes visible
 *       before it becomes a problem. An exception that no longer describes
 *       anything over budget fails too, for the same reason a retired cycle
 *       entry does.
 *   R7  **Wiring.** Every field of `RunRequest` — the interface that crosses the
 *       runtime boundary — must be read by at least one runtime. `args` was
 *       declared, typed, forwarded by the panel and dropped by every runtime for
 *       a whole release: a declared field that nothing reads compiles cleanly and
 *       fails silently, so the only way to catch the next one is to look.
 *   R8  **Declared capability.** `RuntimeExtension.supportsArgs` must agree with
 *       the code: a runtime that claims `true` has to read `opts.args`, and one
 *       that claims `false` must not. A flag nobody checks is a comment.
 *   R6  **Purity.** The debugger's wire format and analysis modules are listed
 *       in the ledger and may import no `node:` builtin. That is what makes the
 *       protocol implementable by another collector, and the arithmetic testable
 *       without a debuggee. `recorder.ts` is deliberately not listed: it writes
 *       files, which is its job.
 *
 * The ledger (`architecture.json`) may only shrink. A new violation fails; a
 * listed one that got worse fails; a listed one that disappeared fails until the
 * entry is deleted, so the ledger cannot rot into a list of things that are no
 * longer true.
 *
 * Self-test first. The cycle detector in this file is the thing that decides
 * whether the project is coupled, and an earlier version of it silently returned
 * "0 cycles" because it compared absolute paths against relative ones. A checker
 * that can be wrong in silence is worse than no checker, so the detector is
 * exercised against synthetic graphs before it is trusted with the real one.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-architecture.ts
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const SRC = join(ROOT, 'src');

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ------------------------------------------------------------------ the graph

type Graph = Map<string, Set<string>>;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Vendored code is not ours to refactor and has no internal structure worth
      // modelling; skipping it keeps the graph about decisions we make.
      if (entry.name !== 'vendor') walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

/** Every module a file imports, resolved to an absolute path on disk. */
function importsOf(file: string, text: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    // `?raw` is a bundler query, not part of the path.
    const target = resolve(dirname(file), spec.split('?')[0].replace(/\.js$/, '.ts'));
    try {
      if (statSync(target).isFile()) out.push(target);
    } catch {
      /* a specifier that does not resolve is tsc's problem, not ours */
    }
  }
  return out;
}

const files = walk(SRC);
const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const edges: Graph = new Map(files.map((f) => [f, new Set(importsOf(f, texts.get(f) ?? ''))]));

/** A slice is the first path segment under `src/`; root files are their own. */
function sliceOf(file: string): string {
  const rel = relative(SRC, file).split('\\').join('/');
  const parts = rel.split('/');
  return parts.length > 1 ? parts[0] : '(root)';
}

/** `types.ts` with zero imports: shared vocabulary, usable from any layer. */
function isVocabulary(file: string): boolean {
  // Normalise separators first: on Windows these paths are `src\\langs\\types.ts`,
  // and a `/`-only pattern silently matched nothing — which switched the whole
  // vocabulary exemption off and made every shared shape look like an upward edge.
  const normalised = file.split('\\').join('/');
  if ((edges.get(file)?.size ?? 1) !== 0) return false;
  // A `types.ts` anywhere, or a root-level file with no imports (`version.ts`):
  // both are shapes/constants with no behaviour, so any layer may read them.
  const rel = relative(SRC, file).split('\\').join('/');
  return /(^|\/)types\.ts$/.test(normalised) || !rel.includes('/');
}

// ------------------------------------------------------------ the detector

/**
 * Tarjan's SCC. Returns every component with more than one member.
 *
 * Pure over a `Graph`, so the self-test below can call it with synthetic input.
 * That separation is the whole point: the bug that made an earlier version
 * useless was in here, and it was invisible from the outside.
 */
export function findCycles(graph: Graph): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];

  const strong = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop() as string;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1) out.push(comp);
    }
  };

  for (const v of graph.keys()) if (!index.has(v)) strong(v);
  return out;
}

/** Collapse a file graph into a slice graph, dropping vocabulary targets. */
function sliceGraph(): Graph {
  const g: Graph = new Map();
  for (const [from, outs] of edges) {
    const a = sliceOf(from);
    if (!g.has(a)) g.set(a, new Set());
    for (const to of outs) {
      if (isVocabulary(to)) continue;
      const b = sliceOf(to);
      if (a !== b) (g.get(a) as Set<string>).add(b);
    }
  }
  return g;
}

// ------------------------------------------------------------- self-test

{
  const g: Graph = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
  ]);
  const found = findCycles(g);
  check('self-test: a two-node cycle is detected', found.length === 1 && found[0].length === 2, JSON.stringify(found));

  const g3: Graph = new Map([
    ['x', new Set(['y'])],
    ['y', new Set(['z'])],
    ['z', new Set(['x'])],
  ]);
  check('self-test: a three-node cycle is detected', findCycles(g3).length === 1);

  const dag: Graph = new Map([
    ['p', new Set(['q', 'r'])],
    ['q', new Set(['r'])],
    ['r', new Set()],
  ]);
  check('self-test: a DAG reports nothing', findCycles(dag).length === 0);

  // The exact shape of the bug this self-test exists for: a graph whose nodes
  // are absolute paths while an adjacency lookup uses relative ones looked
  // acyclic. Keys and values must be the same vocabulary.
  const mixed: Graph = new Map([
    ['/abs/a.ts', new Set(['/abs/b.ts'])],
    ['/abs/b.ts', new Set(['/abs/a.ts'])],
  ]);
  check('self-test: absolute-path graphs are handled', findCycles(mixed).length === 1);
}

// ------------------------------------------------------------ the contract

interface Ledger {
  layers: Record<string, number>;
  products: Record<string, string[]>;
  allowedCycles: Array<{ members: string[]; why: string }>;
  budgets: { maxFileLines: number; maxSliceFiles: number };
  budgetExceptions: Record<string, string>;
  /** Files (relative to `src/`) that must stay free of `node:` builtins, with the reason. */
  purity: Record<string, string>;
}

const ledger = JSON.parse(readFileSync(join(ROOT, 'scripts', 'architecture.json'), 'utf8')) as Ledger;

// ---- R1: layers ----
{
  const violations: Array<{ from: string; to: string; file: string; detail: string }> = [];
  const unknown = new Set<string>();
  for (const [from, outs] of sliceGraph()) {
    for (const to of outs) {
      if (from === to) continue;
      const lf = ledger.layers[from];
      const lt = ledger.layers[to];
      if (lf === undefined || lt === undefined) {
        unknown.add(lf === undefined ? from : to);
        continue;
      }
      // A listed cycle is exempt from the ordering rule: its direction is decided
      // by the ledger, not by a layer number that would be a fiction.
      const inAllowedCycle = ledger.allowedCycles.some(
        (c) => c.members.includes(from) && c.members.includes(to),
      );
      if (lf <= lt && !inAllowedCycle) violations.push({ from, to, file: '', detail: `${from}(${lf}) -> ${to}(${lt})` });
    }
  }
  check(
    'R1 layers: every slice imports only downwards',
    violations.length === 0,
    violations.length ? violations.map((v) => v.detail).slice(0, 6).join(' · ') : `${Object.keys(ledger.layers).length} slices declared`,
  );
  check('R1 layers: every slice in the graph has a declared layer', unknown.size === 0, [...unknown].join(', '));
}

// ---- R2: cycles ----
{
  const allowed = ledger.allowedCycles.map((c) => [...c.members].sort().join('+'));
  const sliceCycles = findCycles(sliceGraph()).map((c) => c.sort().join('+'));
  const unexpected = sliceCycles.filter((c) => !allowed.includes(c));
  check('R2 cycles: no undeclared slice cycle', unexpected.length === 0, unexpected.join(' · ') || `${sliceCycles.length} declared`);

  const fileCycles = findCycles(edges);
  check(
    'R2 cycles: no file-level cycle',
    fileCycles.length === 0,
    fileCycles.map((c) => c.map((f) => relative(SRC, f)).join(' ⇄ ')).slice(0, 3).join(' | ') || 'none',
  );

  // A ledger entry that no longer describes reality is stale, and a stale ledger
  // is how a list of exceptions becomes a list of lies.
  const stale = allowed.filter((c) => !sliceCycles.includes(c));
  check('R2 cycles: the ledger lists no cycle that no longer exists', stale.length === 0, stale.join(' · ') || 'none');
}

// ---- R3: vocabulary ----
{
  const vocabFiles = files.filter(isVocabulary);
  check('R3 vocabulary: shared shapes are import-free', vocabFiles.length > 0, `${vocabFiles.length} files: ${vocabFiles.map((f) => relative(SRC, f)).join(', ')}`);

  // A `types.ts` that grew an import silently stops being vocabulary, which
  // quietly turns every importer into an upward edge. Name the offenders.
  const fake = files.filter((f) => /(^|\/)types\.ts$/.test(f) && !isVocabulary(f));
  check('R3 vocabulary: every types.ts is either vocabulary or documented', fake.length === 0, fake.map((f) => relative(SRC, f)).join(', '));
}

// ---- R4: product boundary ----
{
  const product = 'debugtool';
  const allowedSlices = new Set(ledger.products[product] ?? []);
  const offenders: string[] = [];
  for (const [from, outs] of edges) {
    if (sliceOf(from) !== product) continue;
    for (const to of outs) {
      const slice = sliceOf(to);
      if (slice === product || slice === '(root)' || isVocabulary(to)) continue;
      if (!allowedSlices.has(slice)) offenders.push(`${relative(SRC, from)} -> ${slice}`);
    }
  }
  check(
    `R4 boundary: ${product} imports only ${[...allowedSlices].join(', ')}`,
    offenders.length === 0,
    offenders.slice(0, 5).join(' · ') || 'clean',
  );
}

// ---- R5: budgets ----
{
  const over: string[] = [];
  for (const f of files) {
    const rel = relative(SRC, f).split('\\').join('/');
    const lines = (texts.get(f) ?? '').split('\n').length;
    if (lines > ledger.budgets.maxFileLines && !(rel in ledger.budgetExceptions)) over.push(`${rel} (${lines})`);
  }
  check(`R5 budgets: no file over ${ledger.budgets.maxFileLines} lines without an exception`, over.length === 0, over.slice(0, 4).join(' · ') || 'ok');

  const perSlice = new Map<string, number>();
  for (const f of files) perSlice.set(sliceOf(f), (perSlice.get(sliceOf(f)) ?? 0) + 1);
  const big = [...perSlice.entries()].filter(([s, n]) => n > ledger.budgets.maxSliceFiles && !(s in ledger.budgetExceptions));
  check(`R5 budgets: no slice over ${ledger.budgets.maxSliceFiles} files`, big.length === 0, big.map(([s, n]) => `${s}(${n})`).join(' ') || 'ok');

  // An exception that no longer describes anything is worse than no exception:
  // it reads as "this is still too big" long after it stopped being true, and
  // the next person inherits a reason that has expired. Same rule as R2's cycle
  // ledger — a bookkeeping entry has to keep describing the code.
  const overFiles = new Set(
    files
      .map((f) => ({ rel: relative(SRC, f).split('\\').join('/'), lines: (texts.get(f) ?? '').split('\n').length }))
      .filter((x) => x.lines > ledger.budgets.maxFileLines)
      .map((x) => x.rel),
  );
  const overSlices = new Set([...perSlice.entries()].filter(([, n]) => n > ledger.budgets.maxSliceFiles).map(([s]) => s));
  const stale = Object.keys(ledger.budgetExceptions).filter((k) => !overFiles.has(k) && !overSlices.has(k));
  check(
    'R5 budgets: every exception still describes something over budget',
    stale.length === 0,
    stale.length ? `${stale.join(', ')} — remove from scripts/architecture.json` : 'ok',
  );
}

// ---- R6: purity ----

/** Every `node:` builtin a file imports, static or dynamic. */
function nodeBuiltinsOf(text: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text))) {
    if (m[1].startsWith('node:')) out.push(m[1]);
  }
  return out;
}

// The detector decides whether a module is transport-free, so it gets the same
// treatment as the cycle detector: prove it sees both import forms before
// trusting a green result. A regex that matches nothing reports "pure" forever.
{
  const probe = [
    "import { createServer } from 'node:net';",
    "import { join } from 'node:path';",
    "const lazy = await import('node:fs/promises');",
    "import local from './local.js';",
  ].join('\n');
  const found = nodeBuiltinsOf(probe);
  check(
    'self-test: node: builtins are detected (static and dynamic)',
    found.length === 3 && found.includes('node:net') && found.includes('node:fs/promises'),
    found.join(', '),
  );
}

{
  const missing = Object.keys(ledger.purity).filter((rel) => !texts.has(join(SRC, rel)));
  check('R6 purity: every listed module exists', missing.length === 0, missing.join(', ') || `${Object.keys(ledger.purity).length} modules`);

  const impure: string[] = [];
  for (const rel of Object.keys(ledger.purity)) {
    const text = texts.get(join(SRC, rel));
    if (text === undefined) continue;
    const builtins = nodeBuiltinsOf(text);
    if (builtins.length) impure.push(`${rel} → ${builtins.join(', ')}`);
  }
  check(
    "R6 purity: the debugger's wire and analysis modules import no node: builtin",
    impure.length === 0,
    impure.join(' · ') || 'ok',
  );
}

// ------------------------------------------------- R7/R8 the runtime boundary
//
// `RunRequest.args` was declared, typed, documented — and read by nobody. The run
// configuration collected the arguments, the panel forwarded them, and every
// runtime dropped them: it took a manual run to notice, because a declared field
// that nothing reads compiles cleanly and fails silently.
//
// The check is deliberately narrow. Not "no field is unused" — that needs a type
// checker and would flag legitimate write-only fields. It is "every field of the
// interface that crosses the runtime boundary is read by at least one runtime",
// which is the shape of the bug and is decidable with a regex.

/** Strip comments, so a field named in prose is not mistaken for a read. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Field names declared in `interface <name> { … }`. */
function interfaceFields(source: string, name: string): string[] {
  const m = new RegExp(`interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(stripComments(source));
  if (!m) return [];
  const out: string[] = [];
  for (const line of m[1].split('\n')) {
    const f = /^\s*(?:readonly\s+)?([a-zA-Z_]\w*)\??\s*:/.exec(line);
    if (f) out.push(f[1]);
  }
  return out;
}

/** Fields read as `opts.<field>` — the name every runner gives its request. */
function fieldsRead(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripComments(source).matchAll(/\bopts\.([a-zA-Z_]\w*)/g)) out.add(m[1]);
  return out;
}

{
  // Self-test first: a scanner that quietly matches nothing would report "all
  // fields are read" forever, which is the failure mode this rule exists for.
  const sample = ['interface RunRequest {', '  alpha?: string;', '  // beta?: number;', '  gamma?: number;', '}'].join('\n');
  const fields = interfaceFields(sample, 'RunRequest');
  check('self-test: interface fields come from the declaration', fields.join(',') === 'alpha,gamma', fields.join(',') || 'none');
  const body = 'const x = opts.alpha; // opts.gamma is not a read';
  const read = fieldsRead(body);
  check('self-test: a field named in a comment is not a read', read.has('alpha') && !read.has('gamma'), [...read].join(','));
}

{
  const RUNTIMES = join(SRC, 'runtimes');
  const runtimeFiles = [...texts.keys()].filter((f) => f.startsWith(RUNTIMES) && f !== join(RUNTIMES, 'types.ts'));

  const declared = interfaceFields(texts.get(join(RUNTIMES, 'types.ts')) ?? '', 'RunRequest');
  const read = new Set<string>();
  for (const f of runtimeFiles) for (const name of fieldsRead(texts.get(f) ?? '')) read.add(name);
  const unread = declared.filter((name) => !read.has(name));
  check(
    'R7 wiring: every RunRequest field is read by a runtime',
    declared.length >= 8 && unread.length === 0,
    unread.length ? `never read: ${unread.join(', ')}` : `${declared.length} fields`,
  );

  const mismatched: string[] = [];
  let extensions = 0;
  for (const f of runtimeFiles) {
    const text = texts.get(f) ?? '';
    // Only the extensions themselves: `steps.ts` and `proc.ts` are helpers that
    // take a request, not runtimes that declare a capability.
    if (!/implements\s+RuntimeExtension/.test(text)) continue;
    extensions++;
    const decl = /readonly\s+supportsArgs\s*=\s*(true|false)/.exec(stripComments(text));
    if (!decl) {
      mismatched.push(`${relative(SRC, f)}: no supportsArgs declaration`);
      continue;
    }
    const claims = decl[1] === 'true';
    const reads = fieldsRead(text).has('args');
    if (reads !== claims) {
      mismatched.push(`${relative(SRC, f)}: declares ${claims} but ${reads ? 'reads' : 'never reads'} opts.args`);
    }
  }
  check('R8 args: the supportsArgs flag matches the code', mismatched.length === 0, mismatched.join(' · ') || `${extensions} runtimes`);
}

// ------------------------------------------------------------------ verdict

const passed = results.filter((r) => r.ok).length;
const importCount = [...edges.values()].reduce((a, s) => a + s.size, 0);
console.log(`\n${passed}/${results.length} checks passed · ${files.length} files · ${importCount} imports`);

// A machine-readable copy, for the doc gate (`verify-docs`). Documents quote
// these three numbers; without a single source they drift the moment anything
// moves, and a stale number in a doc is indistinguishable from a fresh one.
// Written even on failure — the gate that reads it reports the failure itself.
try {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  writeFileSync(
    join(ROOT, '.tmp', 'arch-summary.json'),
    JSON.stringify({ files: files.length, imports: importCount, checks: passed, total: results.length }, null, 2) + '\n',
    'utf8',
  );
} catch {
  /* a doc gate that cannot read this will say so; the contract itself still ran */
}

if (passed !== results.length) {
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = 1;
}
