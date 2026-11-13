/**
 * Make `makensis` available, or explain why it cannot be.
 *
 * `npm run build:setup` needs NSIS, and a fresh Windows CI runner has none —
 * the first `integration` job to reach "Build installer" died with
 * "makensis not found". The Tauri CLI happens to download a copy, but that step
 * runs *after* the installer on purpose (it compiles Rust and is allowed to
 * fail), so it cannot be the bootstrap.
 *
 * So: if makensis is already somewhere we know, do nothing (this is the normal
 * case on a developer machine, and the script stays a no-op). Otherwise install
 * NSIS with Chocolatey, which every `windows-latest` image ships. Then re-check
 * with the same resolver `build-setup.mjs` uses, so "it worked" here means it
 * will work there.
 *
 * Run: npm run ci:nsis
 */
import { spawnSync } from 'node:child_process';
import { findMakensis, makensisCandidates } from './lib/nsis.mjs';

const log = (...a) => console.log('[ensure-nsis]', ...a);

const before = findMakensis();
if (before) {
  log(`makensis ready: ${before}`);
  process.exit(0);
}

if (process.platform !== 'win32') {
  log('not Windows — install NSIS with your package manager and set NSIS_MAKENSIS');
  process.exit(1);
}

log('makensis not found; trying Chocolatey (present on windows-latest)');
const choco = spawnSync(
  'choco',
  ['install', 'nsis', '-y', '--no-progress', '--limit-output'],
  { stdio: 'inherit', windowsHide: true },
);

if (choco.error) {
  log(`choco is unavailable: ${choco.error.message}`);
  log(`looked in: ${makensisCandidates().join(' · ')}`);
  process.exit(1);
}
if (choco.status !== 0) {
  log(`choco install nsis exited ${choco.status}`);
  process.exit(1);
}

const after = findMakensis();
if (!after) {
  log('NSIS reported success but makensis is still not on the known paths');
  log(`looked in: ${makensisCandidates().join(' · ')}`);
  process.exit(1);
}
log(`makensis ready: ${after}`);
