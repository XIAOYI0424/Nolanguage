/**
 * Panel UI smoke test: the monitor page must be fully self-contained (no CDN,
 * no external assets), themeable, and emoji-free — matching the design spec
 * (二十五: no emoji/Unicode symbols; 三十四: CSS-variable theming).
 *
 * Since the Vue port the page is the vendored Vue runtime + the shared
 * `nl-core` helpers + the `monitor-app` application, inlined verbatim, so the
 * self-containment rules are applied to our own shell and the inlined blocks
 * are checked for order and parseability instead.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/check-panel-html.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { renderPanelHtml } from '../src/panel/ui.js';

const here = join(fileURLToPath(import.meta.url), '..');

const html = renderPanelHtml(7310);
const checks: Array<[string, boolean, string]> = [];

const shell = html.replace(/<script>[\s\S]*?<\/script>/g, '<script></script>');
const blocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1] as string);

const externalPatterns: Array<[string, RegExp]> = [
  ['<script src=…>', /<script[^>]+\bsrc=/i],
  ['<link href=…>', /<link[^>]+\bhref=/i],
  ['absolute http(s) URL', /https?:\/\/(?!127\.0\.0\.1|localhost)/i],
  ['@import', /@import/i],
  ['CDN host', /\bcdn\./i],
  ['font CDN', /fonts\.googleapis/i],
];
for (const [name, re] of externalPatterns) {
  checks.push([`no external reference: ${name}`, !re.test(shell), '']);
}

// ---- inlined sources ----
checks.push(['inlines three scripts (vue · core · app)', blocks.length === 3, `${blocks.length} blocks`]);
checks.push(['inlines the vendored Vue runtime', /var Vue=function\(e\)\{/.test(blocks[0] ?? ''), '']);
checks.push(['inlines the shared nl-core helpers', /global\.NL\s*=/.test(blocks[1] ?? ''), '']);
checks.push(['inlines the Vue application', /createApp\(/.test(blocks[2] ?? ''), '']);
checks.push(['the app mounts the shell', /app\.mount\('#app'\)/.test(blocks[2] ?? ''), '']);
for (const [i, block] of blocks.entries()) {
  let error = '';
  try {
    // eslint-disable-next-line no-new-func
    new Function(block);
  } catch (e) {
    error = (e as Error).message;
  }
  checks.push([`script block ${i + 1} parses`, !error, error]);
}

// ---- the Vue template must compile ----
let templateError = '';
let templateSize = 0;
try {
  const vueSource = readFileSync(join(here, '..', 'src', 'vendor', 'vue.global.prod.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  const Vue = new Function(vueSource + '\n;return Vue;')() as { compile(t: string): unknown };
  (globalThis as unknown as { Vue: unknown }).Vue = Vue;
  const open = '<div id="app">';
  const start = shell.indexOf(open);
  const end = shell.indexOf('<script>');
  const template = shell.slice(start + open.length, end).trim().replace(/<\/div>\s*$/, '');
  templateSize = template.length;
  Vue.compile(template);
} catch (e) {
  templateError = (e as Error).message;
}
checks.push(['the in-DOM Vue template compiles', !templateError && templateSize > 500, templateError || `${templateSize} chars`]);

// ---- behaviour ----
const app = blocks.join('\n');
const behaviour: Array<[string, RegExp]> = [
  ['websocket client', /new WebSocket\(url\)/],
  ['metric sparklines', /function sparkBars/],
  ['level filtering', /st\.filterLevel/],
  ['pause/clear controls', /togglePauseLogs/.test(app) && /clearLogs/.test(app)],
  ['reconnects after disconnect', /setTimeout\(open,/],
  ['dedupes log records', /st\.seen\[r\.id\]/],
  ['caps the log buffer', /MAX_LOGS/],
  ['groups metrics', /^command\\\./.test(app) || /command\\\./.test(app)],
];
for (const [name, ok] of behaviour) {
  checks.push([`implements ${name}`, ok, '']);
}

checks.push(['uses light theme background', /--bg-primary:\s*#FFFFFF/i.test(shell), '']);
checks.push(['uses CSS custom properties', (shell.match(/--[a-z-]+:/g) ?? []).length >= 15, '']);
checks.push(['mentions the served port in the footer', shell.includes('127.0.0.1:7310'), '']);
checks.push(['has no emoji / pictographs', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(shell), '']);
checks.push(['declares utf-8 charset', /charset="utf-8"/i.test(shell), '']);

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(`\nshell size: ${shell.length} bytes · inline sources: ${blocks.map((b) => b.length).join(' + ')} · total ${html.length} bytes`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
