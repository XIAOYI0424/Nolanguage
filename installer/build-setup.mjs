/**
 * Build the Nolanguage installer — `installer/Nolanguage-Setup.exe`.
 *
 *   node installer/build-setup.mjs
 *
 * The installer is built with NSIS from `installer/Nolanguage.nsi`, which is a
 * normal Windows wizard: 欢迎页 → 选择安装目录 → 实时进度 → 完成页.
 *
 * # What it ships
 *
 * The Tauri desktop build — a native-window shell plus its engine sidecar:
 *
 *   src-tauri/target/release/nolanguage.exe       -> installed as Nolanguage.exe
 *   src-tauri/target/release/NolanguageEngine.exe -> the engine the shell spawns
 *
 * The shell is the app the user opens (a native WebView2 window, no console).
 * The sidecar is a full copy of the Node SEA engine, so the `nlg` CLI shim
 * keeps working on a machine with no Node and no checkout.
 *
 * # Why not a bare `cargo build`
 *
 * Without the `custom-protocol` feature the shell has no bundled page: its
 * window points at the dev URL and refuses to connect. Either build with
 * `cargo build --release --features tauri/custom-protocol` or run
 * `npm run tauri:build` (the CLI adds the feature for you).
 *
 * # Toolchain
 *
 * `makensis` is taken from (in order):
 *   1. `%NSIS_MAKENSIS%`
 *   2. the copy the Tauri CLI downloads (`%LOCALAPPDATA%\tauri\NSIS`)
 *   3. `makensis` on `PATH`
 *   4. `C:\Program Files (x86)\NSIS`
 *
 * The Tauri build is produced only when missing — run
 * `npm run tauri:build` yourself when `src/` changed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Overridable for packaging another build (e.g. the old Node SEA image).
const APP_EXE = process.env.NOLANGUAGE_APP_EXE
  ? resolve(process.env.NOLANGUAGE_APP_EXE)
  : join(ROOT, 'src-tauri', 'target', 'release', 'nolanguage.exe');
const ENGINE_EXE = process.env.NOLANGUAGE_ENGINE_EXE
  ? resolve(process.env.NOLANGUAGE_ENGINE_EXE)
  : join(ROOT, 'src-tauri', 'target', 'release', 'NolanguageEngine.exe');
const SCRIPT = join(ROOT, 'installer', 'Nolanguage.nsi');
const SETUP = join(ROOT, 'installer', 'Nolanguage-Setup.exe');

const log = (...a) => console.log('[build-setup]', ...a);
const fail = (m) => {
  console.error(`[build-setup] ${m}`);
  process.exit(1);
};
const mib = (p) => `${(statSync(p).size / 1024 / 1024).toFixed(1)} MiB`;

/** First existing `makensis.exe` among the known locations, or undefined. */
function findMakensis() {
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    process.env.NSIS_MAKENSIS,
    local && join(local, 'tauri', 'NSIS', 'makensis.exe'),
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const which = spawnSync('where', ['makensis'], { encoding: 'utf8', windowsHide: true });
  const found = (which.stdout ?? '').split(/\r?\n/).find((line) => line.trim().length > 0);
  return found ? found.trim() : undefined;
}

for (const f of [APP_EXE, ENGINE_EXE]) {
  if (!existsSync(f)) {
    fail(`missing payload: ${f} — build the Tauri app first (npm run tauri:build, or cargo build --release --features tauri/custom-protocol)`);
  }
}

/**
 * Refuse to ship a stale payload.
 *
 * The shell embeds `frontend/dist` at **compile** time and the engine is a copy
 * of `dist/Nolanguage.exe`, so "the installer built successfully" says nothing
 * about what is inside it. That gap already shipped one installer with the old
 * page (no new menus) and an engine two builds behind — the "更新完了怎么没有
 * 新功能" report. Both inputs are compared by mtime, which is exactly the
 * relationship `tauri build` maintains when it runs.
 */
const newer = (candidate, reference, what) => {
  if (!existsSync(candidate)) return null;
  return statSync(candidate).mtimeMs > statSync(reference).mtimeMs + 1000
    ? `${what}: ${candidate} is newer than ${reference}`
    : null;
};
const stale = [
  newer(join(ROOT, 'frontend', 'dist', 'index.html'), APP_EXE, 'frontend page'),
  newer(join(ROOT, 'dist', process.env.NOLANGUAGE_EXE_NAME ?? 'Nolanguage.exe'), ENGINE_EXE, 'engine image'),
].filter(Boolean);
if (stale.length) {
  fail(
    'stale payload — the installer would not contain the current UI/engine:\n  ' +
      stale.join('\n  ') +
      '\n  rebuild: npm run build:exe && npm run tauri:build (its beforeBuildCommand refreshes the page and the sidecar)',
  );
}

const makensis = findMakensis();
if (!makensis) {
  fail(
    'makensis not found. Install NSIS (https://nsis.sourceforge.io) or run ' +
      '`npx tauri build` once (the Tauri CLI downloads it), or set NSIS_MAKENSIS.',
  );
}

log(`makensis  : ${makensis}`);
log(`shell     : ${APP_EXE} (${mib(APP_EXE)})`);
log(`engine    : ${ENGINE_EXE} (${mib(ENGINE_EXE)})`);

// `-INPUTCHARSET UTF8`: the script is UTF-8 (Chinese UI strings). NSIS would
// otherwise read it as the ANSI code page and garble every label.
const args = [
  '-INPUTCHARSET',
  'UTF8',
  `/DAPP_EXE=${APP_EXE}`,
  `/DENGINE_EXE=${ENGINE_EXE}`,
  `/DOUTFILE=${SETUP}`,
  SCRIPT,
];
log('running makensis…');
const r = spawnSync(makensis, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (r.status !== 0) fail(`makensis failed (exit ${r.status})`);
if (!existsSync(SETUP)) fail(`no output at ${SETUP}`);

log(`done -> ${SETUP} (${(statSync(SETUP).size / 1024 / 1024).toFixed(1)} MiB)`);
log('double-click to install: 选择目录 → 实时进度 → 完成页默认勾选“运行”，装完即开桌面端。');
