/**
 * The doc gate: documents must not describe a project that no longer exists.
 *
 * Twice now the evaluation docs lagged the code by several versions, and twice a
 * status line in this repo was wrong in a way nobody could see: `README.md`
 * claimed "29 suites / 1360 assertions" while the harness ran 44 suites, and
 * `项目现状报告.md` still opened with `0.7.7` when the code was at `0.7.14`.
 * A stale number is indistinguishable from a fresh one, so the number has to be
 * checked or it has to go.
 *
 * Two kinds of document, and the difference is the whole point:
 *
 *   **live**   claims to describe the code *today*. Its paths must exist, its
 *              commands must resolve, its version must be the current one, and
 *              the counts it quotes must match the tools that produce them.
 *   **dated**  a snapshot with an explicit date (`CHANGELOG.md`, the evaluation
 *              reports, the status report). It is *allowed* to be old — that is
 *              what a snapshot is — but it must say when it was taken, so a
 *              reader knows which project it is describing.
 *
 * Every markdown file has to be classified. A new doc that is in neither list
 * fails the check, because "nobody told the gate about it" is exactly how the
 * status report drifted seven versions without anyone noticing.
 *
 * What is deliberately **not** checked: assertion totals. Nothing in the repo
 * can produce that number without running every suite, so a live doc must not
 * quote one — `npm run verify` prints it. Quoting an unverifiable number is how
 * `README.md` came to claim 1360.
 *
 * The architecture numbers come from `.tmp/arch-summary.json`, written by
 * `verify-architecture.ts`. If it is missing this fails loudly rather than
 * passing on nothing — a gate that silently skips is worse than no gate.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-docs.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ------------------------------------------------------------- classification

/** Describes the code as it is now. Checked hard. */
const LIVE = [
  'README.md',
  '方案.md',
  '语言插件化设计.md',
  'docs/README.md',
  'docs/ARCHITECTURE.md',
  'docs/添加新语言指南.md',
];

/** A snapshot with a date. Allowed to be old, not allowed to be undated. */
const DATED = [
  'CHANGELOG.md',
  '项目现状报告.md',
  'docs/Tauri搁置说明.md',
  'docs/环境与包管理方案评审.md',
  'docs/新增语言与C-CMake评估.md',
  'docs/系统评估_20261027.md',
  'docs/评估_20261102.md',
  'docs/评估_20261107.md',
  'docs/评估_20261110.md',
];

const live = new Set(LIVE);
const dated = new Set(DATED);

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const textOf = new Map([...live, ...dated].filter((f) => existsSync(join(ROOT, f))).map((f) => [f, read(f)]));

// --------------------------------------------------------------- D1 coverage

{
  const rootMd = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name);
  const docsMd = readdirSync(join(ROOT, 'docs'))
    .filter((n) => n.endsWith('.md'))
    .map((n) => `docs/${n}`);
  const unclassified = [...rootMd, ...docsMd].filter((f) => !live.has(f) && !dated.has(f));
  check(
    'docs: every markdown file is classified as live or dated',
    unclassified.length === 0,
    unclassified.length ? `${unclassified.join(', ')} — add it to LIVE or DATED in scripts/verify-docs.ts` : `${live.size} live · ${dated.size} dated`,
  );
}

// ------------------------------------------------------- D2 / D3 live claims

/** Repo paths a live doc points at. Bare prose is ignored: only backticks. */
const PATH_RE = /`((?:src|scripts|docs|installer|builtin|examples|debugtool)\/[A-Za-z0-9_./@-]+\.(?:ts|mjs|cjs|js|json|md|ps1|nsi|py|go))`/g;

{
  const dead: string[] = [];
  for (const [file, text] of textOf) {
    if (!live.has(file)) continue;
    for (const m of text.matchAll(PATH_RE)) {
      if (!existsSync(join(ROOT, m[1]))) dead.push(`${file} → ${m[1]}`);
    }
  }
  check('docs: every path a live doc names exists', dead.length === 0, dead.slice(0, 6).join(' · ') || 'ok');
}

{
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const unknown: string[] = [];
  for (const [file, text] of textOf) {
    if (!live.has(file)) continue;
    for (const m of text.matchAll(/npm run ([a-z][\w:-]*)/g)) {
      if (!(m[1] in pkg.scripts)) unknown.push(`${file} → npm run ${m[1]}`);
    }
  }
  check('docs: every `npm run …` a live doc names is a real script', unknown.length === 0, unknown.join(' · ') || 'ok');
}

// ---------------------------------------------------------- D4 / D5 versions

const pkgVersion = (JSON.parse(read('package.json')) as { version: string }).version;
const appVersion = /APP_VERSION\s*=\s*'([\d.]+)-workspace'/.exec(read('src/version.ts'))?.[1];

{
  // Only the provenance line (`> 版本 0.7.14`), not every version in the prose:
  // live docs legitimately discuss history ("0.7.12 之前，文件级循环是 0").
  const wrong: string[] = [];
  for (const [file, text] of textOf) {
    if (!live.has(file)) continue;
    for (const m of text.matchAll(/^>\s*版本\s+`?(\d+\.\d+\.\d+)`?/gm)) {
      if (m[1] !== pkgVersion) wrong.push(`${file} says ${m[1]}, code is ${pkgVersion}`);
    }
  }
  check('docs: the version a live doc declares is the current one', wrong.length === 0, wrong.join(' · ') || `${pkgVersion} · ${appVersion}`);
}

{
  const suites = (read('scripts/verify-all.mjs').match(/^  \{ name: '/gm) ?? []).length;
  const wrong: string[] = [];
  for (const [file, text] of textOf) {
    if (!live.has(file)) continue;
    for (const m of text.matchAll(/(\d+)\s*套件/g)) {
      if (Number(m[1]) !== suites) wrong.push(`${file} says ${m[1]}, harness runs ${suites}`);
    }
  }
  check('docs: the suite count a live doc quotes is the real one', wrong.length === 0, wrong.join(' · ') || `${suites} suites`);
}

// ------------------------------------------------------------------- D6 totals

{
  // `npm run verify` prints this number and it changes with every assertion.
  // A live doc that pins it will be wrong within a week.
  const quoted: string[] = [];
  for (const [file, text] of textOf) {
    if (!live.has(file)) continue;
    for (const m of text.matchAll(/(\d+)\s*条断言|(\d{3,})\s*\/\s*\d{3,}\s*通过/g)) {
      quoted.push(`${file} → ${m[0]}`);
    }
  }
  check(
    'docs: no live doc pins an assertion total (nothing can keep it true)',
    quoted.length === 0,
    quoted.join(' · ') || 'ok',
  );
}

// ------------------------------------------------- D7 the contract's numbers

{
  const summaryPath = join(ROOT, '.tmp', 'arch-summary.json');
  if (!existsSync(summaryPath)) {
    check('docs: the architecture numbers are checkable', false, 'run npm run verify:arch first (.tmp/arch-summary.json missing)');
  } else {
    const s = JSON.parse(readFileSync(summaryPath, 'utf8')) as { files: number; imports: number; checks: number; total: number };
    const arch = textOf.get('docs/ARCHITECTURE.md') ?? '';
    const m = /`(\d+) files · (\d+) imports · (\d+)\/(\d+)`/.exec(arch);
    if (!m) {
      check('docs: ARCHITECTURE.md states the contract numbers', false, 'no `N files · N imports · N/N` line found');
    } else {
      const said = `${m[1]} files · ${m[2]} imports · ${m[3]}/${m[4]}`;
      const real = `${s.files} files · ${s.imports} imports · ${s.checks}/${s.total}`;
      check('docs: the contract numbers in ARCHITECTURE.md are the real ones', said === real, said === real ? real : `says "${said}", contract says "${real}"`);
    }
  }
}

// --------------------------------------------------------- D8 dated documents

{
  const undated: string[] = [];
  for (const [file, text] of textOf) {
    if (!dated.has(file)) continue;
    if (!/\b20\d\d-\d\d-\d\d\b/.test(text)) undated.push(file);
  }
  check('docs: every dated document states its date', undated.length === 0, undated.join(', ') || `${dated.size} snapshots`);
}

// -------------------------------------------------------------- D9 changelog

{
  const changelog = textOf.get('CHANGELOG.md') ?? '';
  const newest = /^## (\d+\.\d+\.\d+)/m.exec(changelog)?.[1];
  check(
    'docs: the changelog has an entry for the current version',
    newest === pkgVersion,
    newest === pkgVersion ? `## ${newest}` : `newest entry is ${newest ?? '(none)'}, package is ${pkgVersion}`,
  );
}

// ------------------------------------------------------------------- verdict

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed · ${live.size} live · ${dated.size} dated · ${relative(ROOT, join(ROOT, 'docs')).split('\\').join('/')}/`);
if (passed !== results.length) {
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = 1;
}
