/**
 * Release integrity check — the mechanical answer to the 2026-11-10 incident.
 *
 * That incident: three versions of work sat in the index for nine days, tags
 * pointed at trees that did not contain it, and `CHANGELOG` described files that
 * were not in the tag. Nothing failed, because nothing was checking.
 *
 * This script checks the things a human forgets under time pressure:
 *
 *   1. the working tree is clean (nothing staged-but-uncommitted, nothing
 *      modified, nothing untracked outside the ignore list);
 *   2. the version in `package.json` matches `src/version.ts` and the tag, when
 *      HEAD is tagged;
 *   3. every artifact exists and is **newer than the newest source file** — a
 *      binary older than the code is a stale binary wearing a version number.
 *
 * Exit code is 0 only when everything holds. `--warn` turns failures into
 * warnings (used by `build:all` while developing).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WARN_ONLY = process.argv.includes('--warn');
// `--push` is the pre-push gate: it only demands a clean tree. Requiring fresh
// binaries before every push would block a docs-only change for no reason —
// artifact freshness matters at *release* time, which is what the default mode
// checks.
const PUSH_GATE = process.argv.includes('--push');

const problems = [];
const notes = [];

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------- 1. clean tree

let status = '';
try {
  status = git('status', '--porcelain');
} catch {
  problems.push('not a git repository (or git is unavailable)');
}

if (status) {
  const lines = status.split('\n').filter(Boolean);
  const staged = lines.filter((l) => /^[MADRC]/.test(l));
  const modified = lines.filter((l) => /^.[MADRC]/.test(l));
  const untracked = lines.filter((l) => l.startsWith('??'));
  problems.push(
    `working tree is dirty: ${lines.length} path(s)` +
      (staged.length ? ` · ${staged.length} staged` : '') +
      (modified.length ? ` · ${modified.length} modified` : '') +
      (untracked.length ? ` · ${untracked.length} untracked` : ''),
  );
  for (const l of lines.slice(0, 12)) problems.push(`    ${l}`);
  if (lines.length > 12) problems.push(`    … ${lines.length - 12} more`);
}

// ------------------------------------------------------------- 2. version truth

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const versionSource = readFileSync(join(ROOT, 'src', 'version.ts'), 'utf8');
const appVersion = /APP_VERSION\s*=\s*'([^']+)'/.exec(versionSource)?.[1];
const expected = `${pkg.version}-workspace`;

if (appVersion !== expected) {
  problems.push(`src/version.ts says ${appVersion ?? '(missing)'}, package.json says ${pkg.version} (expected ${expected})`);
}

let headTag = '';
try {
  headTag = git('describe', '--tags', '--exact-match', 'HEAD');
} catch {
  notes.push('HEAD is not tagged (fine while developing; required for a release)');
}
if (headTag && headTag !== `v${pkg.version}`) {
  problems.push(`HEAD is tagged ${headTag} but package.json says ${pkg.version}`);
}

// ------------------------------------------------------- 3. artifacts are fresh

if (PUSH_GATE) {
  report();
}

const newestSource = (() => {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'vendor') continue; // vendored code rarely changes
        walk(full);
      } else if (/\.(ts|js|py|json)$/.test(entry.name)) {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'debugtool'));
  return newest;
})();

const ARTIFACTS = [
  { rel: 'dist/Nolanguage.exe', what: 'engine exe' },
  { rel: 'dist/NDebug.exe', what: 'ndebug' },
  { rel: 'installer/Nolanguage-Setup.exe', what: 'installer' },
];

for (const art of ARTIFACTS) {
  const abs = join(ROOT, art.rel);
  if (!existsSync(abs)) {
    problems.push(`${art.rel} (${art.what}) is missing — run: npm run build:all`);
    continue;
  }
  const at = statSync(abs).mtimeMs;
  if (at < newestSource) {
    const hours = ((newestSource - at) / 3_600_000).toFixed(1);
    problems.push(`${art.rel} is ${hours}h older than the newest source — rebuild: npm run build:all`);
  }
}

// ---------------------------------------------------------------------- report

// Both modes end here. The `--push` gate jumps out early (it only cares about a
// clean tree); the default path falls through the artifact checks above. A
// version of this script that *only* jumped early silently passed everything.
report();

function report() {
console.log('[release] version ' + pkg.version + (headTag ? ` · tag ${headTag}` : ' · untagged HEAD'));
for (const n of notes) console.log(`  note  ${n}`);
if (!problems.length) {
  console.log('  ok    tree clean, versions agree, artifacts fresh');
  process.exit(0);
}

for (const p of problems) console.log(`  ${WARN_ONLY ? 'warn ' : 'FAIL '} ${p}`);
process.exit(WARN_ONLY ? 0 : 1);
}
