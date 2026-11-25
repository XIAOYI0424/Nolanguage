/**
 * The workflow is a claim too.
 *
 * `ci.yml` was in the repo for six versions and had never been executed. Nothing
 * in it was obviously wrong, which is exactly the problem: a workflow that
 * references a renamed script, installs with `npm install` instead of `npm ci`,
 * or has a job with no steps at all fails on the *first real run* — and until
 * then every green local build looks like evidence that it works.
 *
 * The checks below are the ones that can be made mechanical without a YAML
 * parser and without pretending to validate GitHub's semantics:
 *
 *   C1  every `npm run <x>` in the workflow is a script that exists
 *   C2  every `node scripts/<file>` in the workflow is a file that exists
 *   C3  installs use `npm ci`, never `npm install` — the lockfile is committed,
 *       and `npm install` would quietly resolve something newer
 *   C4  every job has at least one `run:` step (a job with no steps is green by
 *       doing nothing)
 *   C5  every `continue-on-error` step is named "(optional)", so a gate that can
 *       fail without failing the build says so out loud
 *   C6  every `ci:*` script in package.json is actually used by the workflow —
 *       otherwise "this is what CI runs" is false, and the local command proves
 *       nothing about CI
 *
 * Not checked, deliberately: YAML validity, action versions, runner images.
 * Those belong to GitHub, and a home-made approximation would be worse than
 * nothing — it would report "valid" for a file GitHub rejects.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-ci.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const WORKFLOW_DIR = join(ROOT, '.github', 'workflows');

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const scripts = new Set(Object.keys(pkg.scripts));

const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
if (files.length === 0) {
  check('ci: at least one workflow exists', false, `${WORKFLOW_DIR} is empty`);
}

interface Workflow {
  file: string;
  text: string;
}

const workflows: Workflow[] = files.map((f) => ({ file: f, text: readFileSync(join(WORKFLOW_DIR, f), 'utf8') }));

/** Every `run:` value, joined so block scalars are not truncated. */
function runBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-?\s*run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const first = m[1].trim();
    if (first !== '|' && first !== '>' && first !== '') {
      out.push(first);
      continue;
    }
    // Block scalar: take the following lines until indentation drops back.
    const indent = lines[i].search(/\S/);
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const ind = line.search(/\S/);
      if (ind <= indent) break;
      body.push(line.trim());
    }
    out.push(body.join(' '));
  }
  return out;
}

/**
 * The values a workflow's matrix declares, keyed by variable name.
 *
 * Only inline lists (`lang: [go, javascript, markdown]`) are read: that is the
 * shape this repository uses, and guessing at `include:`/`exclude:` would let the
 * gate report a green light for a matrix GitHub may expand differently.
 */
function matrixValues(text: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s+matrix:\s*$/.test(l));
  if (at < 0) return values;
  const indent = lines[at].search(/\S/);
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    // Left the matrix block: a line at or above its indentation that is not a
    // nested `include:`/`exclude:` key.
    if (line.search(/\S/) <= indent && !/^\s*(include|exclude):/.test(line)) break;
    const m = /^\s+([A-Za-z0-9_-]+):\s*\[([^\]]*)\]\s*$/.exec(line);
    if (!m) continue;
    values.set(
      m[1],
      m[2]
        .split(',')
        .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
        .filter((v) => v.length > 0),
    );
  }
  return values;
}

interface ExpandedRun {
  file: string;
  cmd: string;
  /** The templated form, so a report can name the line the author wrote. */
  source: string;
  /** `${{ … }}` expressions the workflow used that this matrix cannot expand. */
  unknown: string[];
}

const MATRIX_EXPR = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g;

/**
 * Expand `${{ matrix.x }}` in a `run:` value into one command per value.
 *
 * Without this, `npm run verify:${{ matrix.lang }}` is checked as the script
 * `verify:` — a false failure that invites the author to inline three explicit
 * steps and lose the matrix. Expressions that are not matrix lookups (a
 * `github.ref` inside a shell line) are left alone and reported as unknown, so a
 * templated command can never pass by being silently not checked.
 */
function expandRun(file: string, cmd: string, values: Map<string, string[]>): ExpandedRun[] {
  const source = cmd;
  const unknown: string[] = [];
  for (const m of cmd.matchAll(/\$\{\{\s*([^}]*)\s*\}\}/g)) {
    const inner = m[1].trim();
    const asMatrix = /^matrix\.([A-Za-z0-9_-]+)$/.exec(inner);
    if (asMatrix && values.has(asMatrix[1])) continue; // expanded below
    unknown.push(inner);
  }
  if (!MATRIX_EXPR.test(cmd)) return [{ file, cmd, source, unknown }];
  MATRIX_EXPR.lastIndex = 0;

  // split() with one capture group alternates literal / whole match, so the
  // variable name comes from applying MATRIX_EXPR to each whole match.
  const pieces = cmd.split(/(\$\{\{\s*matrix\.[A-Za-z0-9_-]+\s*\}\})/);
  const segments: Array<{ text: string } | { key: string }> = [];
  for (let i = 0; i < pieces.length; i++) {
    if (i % 2 === 0) segments.push({ text: pieces[i] });
    else {
      const m = /matrix\.([A-Za-z0-9_-]+)/.exec(pieces[i]);
      segments.push({ key: m ? m[1] : '' });
    }
  }
  const build = (index: number, acc: string): string[] => {
    if (index >= segments.length) return [acc];
    const seg = segments[index];
    if ('text' in seg) return build(index + 1, acc + seg.text);
    const list = values.get(seg.key) ?? [];
    return list.flatMap((value) => build(index + 1, acc + value));
  };
  const expanded = build(0, '');
  return (expanded.length ? expanded : [cmd]).map((cmd) => ({ file, cmd, source, unknown }));
}

const allRuns = workflows.flatMap((w) => {
  const values = matrixValues(w.text);
  return runBlocks(w.text).flatMap((cmd) => expandRun(w.file, cmd, values));
});

/**
 * The npm scripts a command line invokes.
 *
 * Both `npm run build:exe` and `npm test` count: `npm test` is the `test`
 * script, and a checker that only understands the long form would report a
 * mismatch where there is none. `npm ci` / `npm install` are package-manager
 * verbs, not scripts, so they fall out naturally — `ci` is not in `scripts`.
 */
function npmScriptsIn(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/npm (?:run\s+)?([a-z][\w:-]*)/g)) {
    if (scripts.has(m[1])) out.push(m[1]);
  }
  return out;
}

// --------------------------------------------------------- C1 / C2 references

{
  const missing: string[] = [];
  for (const { file, cmd } of allRuns) {
    for (const m of cmd.matchAll(/npm (?:run\s+)?([a-z][\w:-]*)/g)) {
      // `ci`, `install`, `i` are verbs; anything else has to be a script.
      if (['ci', 'install', 'i', 'publish', 'version'].includes(m[1])) continue;
      if (!scripts.has(m[1])) missing.push(`${file}: npm ${m[0].slice(4)}`);
    }
  }
  check('ci: every npm command in a workflow is a real script', missing.length === 0, missing.join(' · ') || `${allRuns.length} commands`);

  const matrixRuns = allRuns.filter((r) => r.source !== r.cmd);
  const unknownExpr = [...new Set(allRuns.flatMap((r) => r.unknown))];
  check(
    'ci: matrix expressions expand to commands that are checked',
    unknownExpr.length === 0,
    unknownExpr.length
      ? `unexpanded: ${unknownExpr.join(', ')}`
      : `${matrixRuns.length} expanded variant(s) from ${new Set(matrixRuns.map((r) => r.source)).size} templated command(s)`,
  );
}

{
  const missing: string[] = [];
  for (const { file, cmd } of allRuns) {
    for (const m of cmd.matchAll(/(?:^|\s)node\s+(\S*scripts\/[\w./-]+\.m?js)/g)) {
      if (!existsSync(join(ROOT, m[1]))) missing.push(`${file}: ${m[1]}`);
    }
  }
  check('ci: every script path a workflow runs exists', missing.length === 0, missing.join(' · ') || 'ok');
}

// -------------------------------------------------------------- C3 lockfile

{
  const bad: string[] = [];
  for (const { file, cmd } of allRuns) {
    if (/(?:^|\s)npm\s+install(?:\s|$)/.test(cmd)) bad.push(`${file}: ${cmd.slice(0, 60)}`);
  }
  check('ci: installs use `npm ci`, not `npm install`', bad.length === 0, bad.join(' · ') || 'lockfile is authoritative');
}

// ------------------------------------------------------------- C4 / C5 jobs

{
  // Job names are the keys one level under `jobs:`.
  const empty: string[] = [];
  for (const w of workflows) {
    const lines = w.text.split(/\r?\n/);
    const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    if (jobsAt < 0) continue;
    let current: string | null = null;
    let hasRun = false;
    const flush = (): void => {
      if (current && !hasRun) empty.push(`${w.file}: ${current}`);
    };
    for (let i = jobsAt + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\S/.test(line) && line.trim() !== '') break; // left the jobs block
      const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (job) {
        flush();
        current = job[1];
        hasRun = false;
        continue;
      }
      if (/^\s*-?\s*run:/.test(line)) hasRun = true;
    }
    flush();
  }
  check('ci: every job has at least one step that runs something', empty.length === 0, empty.join(' · ') || 'ok');
}

{
  const unnamed: string[] = [];
  for (const w of workflows) {
    const lines = w.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/continue-on-error:\s*true/.test(lines[i])) continue;
      // Look back for the `- name:` of the same step.
      let name = '';
      for (let j = i; j >= 0 && j > i - 8; j--) {
        const m = /-\s*name:\s*(.+)$/.exec(lines[j]);
        if (m) { name = m[1].trim(); break; }
      }
      if (!/optional/i.test(name)) unnamed.push(`${w.file}: ${name || '(unnamed step)'}`);
    }
  }
  check(
    'ci: a step that may fail without failing the build is named "(optional)"',
    unnamed.length === 0,
    unnamed.join(' · ') || 'ok',
  );
}

// ------------------------------------------------------------ C6 the reverse

/**
 * A `ci:*` script promises "this is what CI runs". Two ways to keep that
 * promise: the workflow invokes it, or it is an aggregation whose every command
 * the workflow also runs. A script that drifts from the workflow is worse than
 * no script — it is a local green light that proves nothing.
 *
 * Only `run:` values count. An earlier version of this check scanned the whole
 * file, and a comment mentioning `npm run ci:pure` was enough to satisfy it —
 * which is how a check ends up certifying a promise nobody keeps.
 */
{
  const invoked = new Set<string>();
  for (const { cmd } of allRuns) for (const name of npmScriptsIn(cmd)) invoked.add(name);

  const drifted: string[] = [];
  const ciScripts = [...scripts].filter((s) => s.startsWith('ci:'));
  for (const name of ciScripts) {
    if (invoked.has(name)) continue;
    // An aggregation: `a && b && npm run c`. Every element must be run by CI.
    const parts = pkg.scripts[name].split('&&').map((x) => x.trim()).filter(Boolean);
    const elements = parts.flatMap((part) => {
      const named = npmScriptsIn(part);
      return named.length ? named : [part];
    });
    const missing = elements.filter((e) => (scripts.has(e) ? !invoked.has(e) : true));
    if (missing.length) drifted.push(`${name} → ${missing.join(', ')}`);
  }
  check(
    'ci: every `ci:*` script is invoked by a workflow or made only of steps it runs',
    drifted.length === 0,
    drifted.length ? `${drifted.join(' · ')}` : `${ciScripts.length} scripts`,
  );
}

// ------------------------------------------------------------------- verdict

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed · ${workflows.length} workflow(s) · ${allRuns.length} commands`);
if (passed !== results.length) {
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = 1;
}
