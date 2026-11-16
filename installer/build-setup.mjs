/**
 * Build the Nolanguage installer — `installer/Nolanguage-Setup.exe`.
 *
 *   node installer/build-setup.mjs
 *
 * The installer is built with NSIS from `installer/Nolanguage.nsi`, which is a
 * normal Windows wizard: 欢迎页 → 选择安装目录 → 实时进度 → 完成页.
 *
 * # Why not the old Node SEA installer
 *
 * It used to be a Node Single Executable Application that unpacked the app on
 * launch. An SEA inherits Node's *console* subsystem, so double-clicking it
 * always flashed a black console window, and it had no way to draw a UI — no
 * directory picker, no progress. NSIS is a GUI-subsystem executable: no console
 * window, real pages, and a progress bar that advances as files are written.
 *
 * # Toolchain
 *
 * `makensis` is taken from (in order):
 *   1. `%NSIS_MAKENSIS%`
 *   2. the copy the Tauri CLI downloads (`%LOCALAPPDATA%\tauri\NSIS`)
 *   3. `makensis` on `PATH`
 *   4. `C:\Program Files (x86)\NSIS`
 *
 * The app image (`dist/Nolanguage.exe`) is rebuilt only when it is missing —
 * run `npm run build:exe` yourself when `src/` changed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { findMakensis } from '../scripts/lib/nsis.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// `NOLANGUAGE_APP_EXE` lets `installer\build-nsis.bat <exe>` package another build.
const APP_EXE = process.env.NOLANGUAGE_APP_EXE
  ? resolve(process.env.NOLANGUAGE_APP_EXE)
  : join(ROOT, 'dist', 'Nolanguage.exe');
const SCRIPT = join(ROOT, 'installer', 'Nolanguage.nsi');
const SETUP = join(ROOT, 'installer', 'Nolanguage-Setup.exe');

const log = (...a) => console.log('[build-setup]', ...a);
const fail = (m) => {
  console.error(`[build-setup] ${m}`);
  process.exit(1);
};

if (!existsSync(APP_EXE)) {
  log('dist/Nolanguage.exe missing — building it first');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-exe.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}
if (!existsSync(APP_EXE)) fail(`still missing: ${APP_EXE}`);

const makensis = findMakensis();
if (!makensis) {
  fail(
    'makensis not found. Run `npm run ci:nsis` to install it, or install NSIS ' +
      '(https://nsis.sourceforge.io), or run `npx tauri build` once (the Tauri ' +
      'CLI downloads it), or set NSIS_MAKENSIS.',
  );
}

log(`makensis  : ${makensis}`);
log(`app image : ${APP_EXE} (${(statSync(APP_EXE).size / 1024 / 1024).toFixed(1)} MiB)`);

// `-INPUTCHARSET UTF8`: the script is UTF-8 (Chinese UI strings). NSIS would
// otherwise read it as the ANSI code page and garble every label.
// The version is read from package.json, not repeated in the .nsi: the
// Add/Remove entry, the file version and `/health` must all name the same
// build, and a hand-edited copy of the number is exactly how they drift.
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const args = [
  '-INPUTCHARSET',
  'UTF8',
  `/DAPP_EXE=${APP_EXE}`,
  `/DOUTFILE=${SETUP}`,
  `/DAPP_VERSION=${version}`,
  SCRIPT,
];
log('running makensis…');
const r = spawnSync(makensis, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (r.status !== 0) fail(`makensis failed (exit ${r.status})`);
if (!existsSync(SETUP)) fail(`no output at ${SETUP}`);

log(`done -> ${SETUP} (${(statSync(SETUP).size / 1024 / 1024).toFixed(1)} MiB)`);
log('double-click to install: 选择目录 → 实时进度 → 完成。');
