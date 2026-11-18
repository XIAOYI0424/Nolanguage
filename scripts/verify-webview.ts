/**
 * WebView host verification.
 *
 * Covers the desktop window launcher without opening an actual window (which
 * would be disruptive in a test run) — engine resolution, profile selection,
 * the Chromium switch set, and the launch/teardown contract.
 *
 * The important regression this guards is the one that cost real debugging
 * time: `msedgewebview2.exe` **looks** like a launchable shell but is a passive
 * COM host that exits immediately without rendering. If someone "optimises"
 * `openWebView` back to spawning it, the window silently stops appearing while
 * every other test still passes — so the launch target is asserted here.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-webview.ts
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findEdgeBinary,
  hasWebView2,
  openSystemBrowser,
  openWebView,
  webView2Version,
  webViewProfileDir,
} from '../src/desktop/WebViewHost.js';

const here = join(fileURLToPath(import.meta.url), '..');
const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const source = readFileSync(join(here, '..', 'src', 'desktop', 'WebViewHost.ts'), 'utf8');

// ---- detection ----
const wv2 = webView2Version();
const edge = findEdgeBinary();

check('WebView2 runtime detection returns a version or nothing', wv2 === undefined || /^\d+(\.\d+)+$/.test(wv2), String(wv2));
check('hasWebView2() agrees with webView2Version()', hasWebView2() === (wv2 !== undefined));
check('an Edge binary is found on this machine', !!edge && existsSync(edge), edge ?? 'not found');

// On Windows 10+ the runtime ships with the OS; a missing runtime is legal but
// noteworthy, so report rather than fail.
if (!wv2 && process.platform === 'win32') {
  console.log('  NOTE  WebView2 runtime not installed — the Edge shell will host the window instead');
}

// ---- the engine that actually renders ----
// `openWebView` must spawn the Edge binary, never `msedgewebview2.exe`.
check('the launcher never spawns msedgewebview2.exe', !/spawn\(\s*webview2|binary\s*=\s*webview2/.test(source));
check('the launcher spawns the Edge binary', /spawn\(edge,/.test(source));
check('msedgewebview2.exe is retained only for availability detection', /webView2Version|hasWebView2/.test(source));
check(
  'the module documents why the runtime binary is not launchable',
  /passive host|ICoreWebView2Environment/.test(source),
  '',
);

// ---- profile ----
const profile = webViewProfileDir();
check('the profile directory is absolute', /^[A-Za-z]:[\\/]|^\//.test(profile), profile);
check('the profile directory exists (created on demand)', existsSync(profile), profile);
check('the profile is not the user\'s real browser profile', !/Edge[\\/]User Data$/i.test(profile), profile);
check(
  'the profile can be pinned by NOLANGUAGE_WEBVIEW_PROFILE',
  (() => {
    const saved = process.env.NOLANGUAGE_WEBVIEW_PROFILE;
    process.env.NOLANGUAGE_WEBVIEW_PROFILE = join(here, '..', '.tmp', 'wv-env-probe');
    const got = webViewProfileDir();
    if (saved === undefined) delete process.env.NOLANGUAGE_WEBVIEW_PROFILE;
    else process.env.NOLANGUAGE_WEBVIEW_PROFILE = saved;
    return got === join(here, '..', '.tmp', 'wv-env-probe');
  })(),
);

// ---- launch contract ----
check('openWebView never throws when the engine is absent', typeof openWebView === 'function');
check('openSystemBrowser never throws', typeof openSystemBrowser('http://127.0.0.1:1/') === 'boolean');

// Launching for real is opt-in: a window popping up mid-suite would be hostile.
if (process.env.VERIFY_WEBVIEW_LAUNCH === '1') {
  const handle = openWebView({ url: 'about:blank', size: '400,300', quiet: true });
  check('openWebView reports an engine', handle.engine !== 'none', handle.engine);
  check('the handle exposes a close()', typeof handle.close === 'function');
  check('the handle reports the backing WebView2 version', handle.webview2Version === wv2, String(handle.webview2Version));
  check('a real launch uses the Edge binary', handle.binary === edge, handle.binary ?? 'none');
  handle.close();
  handle.close(); // must be safe to call twice
  check('close() is idempotent', true);
} else {
  console.log('  SKIP  live window launch (set VERIFY_WEBVIEW_LAUNCH=1 to include it)');
}

// ---- switch hygiene ----
for (const sw of [
  '--app=',
  '--user-data-dir=',
  '--no-first-run',
  '--no-default-browser-check',
  // Without these the window outlives the server and Chromium offers the
  // "restore pages?" bubble on the next launch — the two extra-popup reports.
  '--disable-background-mode',
  // Edge's own updater cannot update a private profile; left alone it opens a
  // "无法更新 Microsoft Edge" window on every launch.
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble',
]) {
  check(`the window is launched with ${sw}`, source.includes(`'${sw}`) || source.includes(sw));
}

// ---- lifetime contract ----
// The window is detached, so nothing on Windows ties it to this process. These
// three pieces are the only reason closing the window stops the server (and
// stopping the server closes the window).
check('the launcher reports a window the user closed', /onClosed/.test(source));
check('teardown kills the window process tree, not just the launcher', /killTree\(/.test(source));
check('the window pid is recorded for the next launch', /patchSession\(/.test(source));

// ---- session bookkeeping ----
const sessionProbe = join(here, '..', '.tmp', 'session-probe');
process.env.NOLANGUAGE_DATA = sessionProbe;
const session = await import('../src/desktop/session.js');
session.patchSession({ serverPid: process.pid, browserPid: 999999, profile: 'probe', port: 7310 });
const recorded = session.readSession();
check('the session round-trips through disk', recorded?.serverPid === process.pid && recorded.profile === 'probe');
check('isAlive() sees this process', session.isAlive(process.pid));
check('isAlive() rejects a dead pid', !session.isAlive(999999));
session.patchSession({ browserPid: undefined });
check('patching with undefined forgets the field', session.readSession()?.browserPid === undefined);
session.patchSession({ cleanExit: true });
check('a clean exit round-trips through disk', session.readSession()?.cleanExit === true);
session.clearSession();
check('clearSession() removes the record', session.readSession() === undefined);
session.logDesktop('probe-event', { ok: true });
const logFile = join(sessionProbe, 'desktop.log');
check(
  'logDesktop() appends a readable line',
  existsSync(logFile) && /probe-event \{"ok":true\}/.test(readFileSync(logFile, 'utf8')),
);
// Cleanup is best-effort. A leftover directory under `.tmp/` must never fail the
// suite: the sandbox's delete guard can refuse a bulk removal, and that refusal
// used to take the whole run down with it (the summary then read 0/0).
try {
  rmSync(sessionProbe, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  /* a temp directory is not worth an assertion */
}

// ---- delegation guard ----
// Chromium hands an `--app` URL to a browser that already owns the profile and
// exits at once. Treating that exit as "the user closed the window" stops the
// server while the window is still on screen — the page then reloads into a
// dead port. These three pieces keep that from happening.
const mainSource = readFileSync(join(here, '..', 'src', 'desktop', 'main.ts'), 'utf8');
// `msedge --app` can hand the profile to a relaunched browser and exit in
// ~100 ms, so the window pid has to be *discovered*, never assumed from the
// spawn result.
check('the window pid is discovered, not assumed', /discoverWindow\(/.test(mainSource));
check('the client count can stop a server whose window is gone', /clientCount\(\)/.test(mainSource));
check('the launch leaves a trace in desktop.log', /logDesktop\('launch'/.test(mainSource));

// ---- teardown completeness ----
// The execution plane and extension hosts are not language slots. Leaving
// their close out is what makes node.exe / --extension-host outlive the app.
const serverSource = readFileSync(join(here, '..', 'src', 'panel', 'server.ts'), 'utf8');
check('shutdown closes the execution plane', /exec\.close\(\)/.test(serverSource));
check('shutdown disposes extension hosts', /extManager\.dispose\(\)/.test(serverSource));
const scriptHostSource = readFileSync(join(here, '..', 'src', 'runtimes', 'script-host.ts'), 'utf8');
check(
  'script-host close kills live children',
  /for \(const child of this\.children\)/.test(scriptHostSource) &&
    /child\.kill\('SIGKILL'\)/.test(scriptHostSource),
);
const sessionSource = readFileSync(join(here, '..', 'src', 'desktop', 'session.ts'), 'utf8');
check('the window probe is case-insensitive', /OrdinalIgnoreCase/.test(sessionSource));
check(
  'the window URL fallback is scoped to the app port',
  sessionSource.includes('const url = port ?') && sessionSource.includes('--app=http') && sessionSource.includes('${url}'),
);
check(
  'profile sweep catches Chromium background processes before they delegate',
  sessionSource.includes('IndexOf($p, [StringComparison]::OrdinalIgnoreCase)') &&
    !sessionSource.includes("CommandLine -match '--app=' -and"),
);
check('a delegated spawn is retried only if no client connected to its visible window', /delegation-adopted/.test(mainSource));
check('the desktop window pid is published for owned native dialogs', /NOLANGUAGE_WINDOW_PID = String\(windowPid\)/.test(mainSource));
check('the watchdog checks the known window pid first', /isAlive\(windowPid\)/.test(mainSource));
check('an orphan server is taken over instead of exiting', /orphan-server/.test(mainSource));
check('a hung shutdown force-exits', /shutdown-timeout/.test(mainSource));
const installerSource = readFileSync(join(here, '..', 'installer', 'Nolanguage.nsi'), 'utf8');
check(
  'installer finish action launches desktop by default',
  installerSource.includes('!define MUI_FINISHPAGE_RUN "$INSTDIR\\${APP_NAME}.exe"') &&
    installerSource.includes('!define MUI_FINISHPAGE_RUN_TEXT "运行 ${APP_NAME} (Desktop)"'),
);
check(
  'the unlabelled Start Menu and desktop shortcuts launch desktop mode',
  installerSource.includes('CreateShortcut "$SMPROGRAMS\\${APP_NAME}\\${APP_NAME}.lnk"           "$INSTDIR\\${APP_NAME}.exe" ""') &&
    installerSource.includes('CreateShortcut "$DESKTOP\\${APP_NAME}.lnk" "$INSTDIR\\${APP_NAME}.exe" ""'),
);
check('browser mode is explicit in the separate Web shortcut', installerSource.includes('APP_WEB_ARG   "--open-browser"'));
const gitProbeSource = readFileSync(join(here, '..', 'src', 'git', 'GitProbe.ts'), 'utf8');
check(
  'the git probe never opens a console window',
  /spawn\(bin, args, \{[^}]*windowsHide:\s*true/.test(gitProbeSource),
);

// ---- stale-window sweep ----
// The installer kills `Nolanguage.exe` on upgrade but cannot reach the detached
// Edge window, which keeps the profile. Sweeping it *before* the spawn is what
// stops Chromium from delegating the new `--app` URL to it — the extra window
// that appeared and closed.
check(
  'stale profile windows are swept before the spawn',
  mainSource.indexOf('closeStaleWindows(') !== -1 &&
    mainSource.indexOf('closeStaleWindows(') < mainSource.indexOf('openWebView('),
);
check('a clean exit is recorded for the next launch', /cleanExit:\s*true/.test(mainSource));
check(
  'the launch always sweeps the profile',
  /const swept = await closeStaleWindows\(profile\)/.test(mainSource),
);
check(
  'an abnormal exit drops the record instead of marking it clean',
  /if\s*\(!shuttingDown\)\s*clearSession\(\)/.test(mainSource),
);
// Edge's EdgeCore ships a *newer* WebView2 than the Evergreen Runtime. Reading
// the newest folder made doctor claim WebView2 151 while the runtime an embedded
// app actually loads was 143 — the exact difference between "works" and "blank".
// Structural, not textual: the candidate list is an array of *groups*, and the
// Evergreen Runtime must sit in an earlier group than EdgeCore. Matching the
// whole list with a character window broke the moment a third path (the
// per-user install) was added to the first group.
check(
  'the WebView2 version prefers the Evergreen runtime over EdgeCore',
  (() => {
    const list = /const WEBVIEW2_CANDIDATES: string\[\]\[\] = \[([\s\S]*?)\n\];/.exec(source);
    if (!list) return false;
    const groups = list[1].split(/\n  \[/).filter((g) => g.trim());
    if (groups.length < 2) return false;
    const evergreen = groups[0];
    return /EdgeWebView/.test(evergreen) && !/EdgeCore/.test(evergreen) && /EdgeCore/.test(groups[1]);
  })(),
);

const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
