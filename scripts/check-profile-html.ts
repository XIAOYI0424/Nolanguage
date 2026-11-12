/**
 * /profile page smoke test — the same self-containment, theming and
 * "every message the page sends is handled by the server" rules as the plugins
 * page, specialised for the flamegraph UI.
 *
 * The page inlines the vendored Vue runtime, `nl-core` and `profile-app.js` as
 * separate <script> blocks, so unlike the plugins check we compile the App
 * block (the one that defines `window.ProfileApp`) rather than asserting a
 * single block. `new Function` would have caught a backtick-in-comment that
 * breaks the IIFE.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/check-profile-html.ts
 */
import { renderProfileHtml } from '../src/ui/profile-ui.js';

const html = renderProfileHtml(7310);
const checks: Array<[string, boolean, string]> = [];

const shell = html.replace(/<script>[\s\S]*?<\/script>/g, '<script></script>');
const blocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1] as string);
const appBlock = blocks.find((b) => /global\.ProfileApp\s*=|window\.ProfileApp\s*=/.test(b)) ?? '';
const mountBlock = blocks.find((b) => /Vue\.createApp\(window\.ProfileApp\)/.test(b)) ?? '';

// ---- self-containment ----
const externalPatterns: Array<[string, RegExp]> = [
  ['<script src=...>', /<script[^>]+\bsrc=/i],
  ['<link href=...>', /<link[^>]+\bhref=/i],
  ['absolute http(s) URL', /https?:\/\/(?!127\.0\.0\.1|localhost)/i],
  ['@import', /@import/i],
  ['CDN host', /\bcdn\./i],
];
for (const [name, re] of externalPatterns) {
  checks.push([`no external reference: ${name}`, !re.test(shell), '']);
}

// ---- the app script must parse ----
let parseError = '';
try {
  // eslint-disable-next-line no-new-func
  new Function(appBlock);
  if (mountBlock) new Function(mountBlock);
} catch (e) {
  parseError = (e as Error).message;
}
checks.push(['the page app script parses', !parseError, parseError]);

// ---- theme ----
checks.push(['uses a light-theme background', /--bg-primary:\s*#FFFFFF/i.test(shell), '']);
checks.push(['the palette is expressed in CSS variables', (shell.match(/var\(--[a-z-]+\)/g) ?? []).length >= 15, `${(shell.match(/var\(--[a-z-]+\)/g) ?? []).length} uses`]);
checks.push(['declares a variable palette', (shell.match(/--[a-z-]+:/g) ?? []).length >= 6, `${(shell.match(/--[a-z-]+:/g) ?? []).length} declared`]);
checks.push(['has no emoji / pictographs', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(shell), '']);
checks.push(['declares utf-8 charset', /charset="utf-8"/i.test(shell), '']);

// ---- protocol: every message the page sends must be one the server answers ----
const kinds = Array.from(appBlock.matchAll(/kind:\s*'([a-z]+)'/g)).map((m) => m[1] as string);
const serverHandles = ['profile', 'profileCaps', 'profileLast'];
for (const kind of new Set(kinds)) {
  checks.push([`the server handles "${kind}"`, serverHandles.includes(kind), kind]);
}
checks.push(['the page opens the shared WebSocket endpoint', /location\.host \+ '\/'/.test(appBlock), '']);
checks.push(['the page renders a flamegraph', /flameSvg/.test(appBlock) && /v-html="flameSvg"/.test(shell), '']);
checks.push(['the page renders a hotspot table', /result\.hotspots/.test(shell) && /class="hot"/.test(shell), '']);
checks.push(['the page can zoom the flamegraph', /zoom = r\.frame/.test(appBlock) && /resetZoom/.test(appBlock), '']);
checks.push(['the page lists profilable languages', /profileCaps/.test(appBlock) && /caps/.test(appBlock), '']);
checks.push(['HTML is escaped, not interpolated', /NL\.esc/.test(appBlock), '']);

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(`\nshell size: ${shell.length} bytes · app script: ${appBlock.length} bytes · total ${html.length} bytes`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
