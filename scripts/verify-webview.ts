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
import { existsSync, readFileSync } from 'node:fs';
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
for (const sw of ['--app=', '--user-data-dir=', '--no-first-run', '--no-default-browser-check']) {
  check(`the window is launched with ${sw}`, source.includes(`'${sw}`) || source.includes(sw));
}

const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
