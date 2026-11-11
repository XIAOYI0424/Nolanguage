/**
 * Type-check the verification scripts — as a ratchet, not an all-or-nothing gate.
 *
 * `tsconfig.json` includes only `src`, so the 43 suites under `scripts/` were
 * never seen by `tsc`. When they were finally included, 108 type errors fell out
 * — every one of them invisible until then, and none of them caught by the
 * suites themselves, because TypeScript is erased at run time.
 *
 * Fixing 108 errors across other people's suites in one pass is how a refactor
 * breaks things quietly. So this is a budget instead: each file may carry the
 * number of errors listed in `types-budget.json`, may not grow, and no new file
 * may appear. Fixing errors means lowering the number.
 *
 *   npm run verify:types     # enforce
 *   npm run types:budget     # rewrite the budget from the current state
 *
 * The rewrite is deliberately manual: a budget that updates itself is not a
 * constraint, it is a log.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-types.ts
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const BUDGET_PATH = join(here, 'types-budget.json');
const UPDATE = process.argv.includes('--update');

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ------------------------------------------------------------------ run tsc

const tsc = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.scripts.json', '--pretty', 'false'], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 600_000,
});

const output = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`;

/** `scripts/x.ts(12,3): error TS1234: message` -> counts per file. */
function countsFrom(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const re = /^([^\s(]+\.ts)\(\d+,\d+\): error TS\d+/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const file = m[1].split('\\').join('/');
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

const current = countsFrom(output);
const total = [...current.values()].reduce((a, b) => a + b, 0);

// A build failure with no parseable errors means tsc itself broke (bad config,
// missing types) — that must not be read as "0 errors, all good".
if (tsc.status !== 0 && total === 0) {
  console.log(output.slice(0, 800));
  check('types: tsc produced parseable errors', false, `exit ${tsc.status} with no error lines`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exitCode = 1;
  process.exit(1);
}

// ---------------------------------------------------------------- the budget

interface BudgetFile {
  budget: Record<string, number>;
  why: string;
}

const file = JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) as BudgetFile;

if (UPDATE) {
  const budget: Record<string, number> = {};
  for (const key of [...current.keys()].sort()) budget[key] = current.get(key) ?? 0;
  writeFileSync(BUDGET_PATH, JSON.stringify({ ...file, budget }, null, 2) + '\n', 'utf8');
  console.log(`types: budget rewritten — ${total} errors in ${current.size} files`);
  process.exit(0);
}

// ---- 1. no file may grow ----
{
  const grown: string[] = [];
  for (const [file_, n] of current) {
    const allowed = file.budget[file_];
    if (allowed === undefined) continue;
    if (n > allowed) grown.push(`${file_} ${allowed}→${n}`);
  }
  check('types: no file exceeds its error budget', grown.length === 0, grown.join(' · ') || 'ok');
}

// ---- 2. no new file may carry errors ----
{
  const added = [...current.keys()].filter((f) => file.budget[f] === undefined);
  check('types: no new file carries type errors', added.length === 0, added.join(' · ') || 'ok');
}

// ---- 3. the budget must not list files that are now clean ----
{
  const stale = Object.keys(file.budget).filter((f) => !current.has(f));
  check(
    'types: the budget lists no file that is now clean',
    stale.length === 0,
    stale.length ? `${stale.join(', ')} — run npm run types:budget` : 'ok',
  );
}

// ---- 4. shrinking is good, but the number has to follow ----
{
  const shrunk = Object.entries(file.budget)
    .filter(([f, n]) => current.has(f) && (current.get(f) ?? 0) < n)
    .map(([f, n]) => `${f} ${n}→${current.get(f)}`);
  // Not a failure: fixing errors must never be blocked by bookkeeping. But say it
  // loudly, because a budget that is never lowered stops describing anything.
  if (shrunk.length) console.log(`NOTE  types: ${shrunk.length} file(s) improved — run npm run types:budget to record it (${shrunk.join(', ')})`);
  check('types: the budget still describes the code', true, `${total} errors in ${current.size} files`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed · ${relative(ROOT, BUDGET_PATH).split('\\').join('/')} covers ${Object.keys(file.budget).length} files`);
if (passed !== results.length) {
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = 1;
}
