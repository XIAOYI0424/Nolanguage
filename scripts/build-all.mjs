/**
 * `npm run build:all` — every shippable artifact, in one command.
 *
 * Why this exists: on 2026-11-10 the repo was found with three versions of work
 * sitting in the index and tags pointing at trees that did not contain it. Part
 * of the cause was that building was a set of separate commands (`build:exe`,
 * `build:ndebug`, `build:setup`) that nobody ran together, so "the binary" and
 * "the source" drifted by days without anyone noticing.
 *
 * This script makes the three builds one step, prints what it produced (size and
 * timestamp), and finishes with the release check — so a release is a single
 * command whose output can be read at a glance.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STEPS = [
  { script: 'build:exe', label: 'engine exe', artifacts: ['dist/Nolanguage.exe'] },
  { script: 'build:ndebug', label: 'debug observatory', artifacts: ['dist/NDebug.exe'] },
  { script: 'build:setup', label: 'installer', artifacts: ['installer/Nolanguage-Setup.exe'] },
];

const log = (...a) => console.log('[build:all]', ...a);

function run(script) {
  const started = Date.now();
  // `npm run` on Windows is npm.cmd; `shell: true` keeps one code path.
  execFileSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit', shell: true });
  return Date.now() - started;
}

const startedAll = Date.now();
const rows = [];

for (const step of STEPS) {
  log(`── ${step.script} (${step.label})`);
  const ms = run(step.script);
  for (const rel of step.artifacts) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      console.error(`[build:all] ${step.script} finished but ${rel} is missing`);
      process.exit(1);
    }
    const st = statSync(abs);
    rows.push({ rel, mb: st.size / 1024 / 1024, at: st.mtime.toISOString().replace('T', ' ').slice(0, 19), ms });
  }
}

const width = Math.max(...rows.map((r) => r.rel.length));
log('');
log('artifacts:');
for (const r of rows) {
  log(`  ${r.rel.padEnd(width)}  ${r.mb.toFixed(1).padStart(6)} MiB  ${r.at}`);
}
log(`  total ${((Date.now() - startedAll) / 1000).toFixed(1)}s`);

// The release check is advisory here: building during development is normal, and
// a dirty tree must not block a local build. It becomes a hard gate before a tag
// (`npm run verify:release`) and before a push (the pre-push hook).
log('');
try {
  execFileSync('node', [join(ROOT, 'scripts', 'check-release.mjs')], { cwd: ROOT, stdio: 'inherit' });
} catch {
  log('release check reported problems (see above) — fix them before tagging');
}
