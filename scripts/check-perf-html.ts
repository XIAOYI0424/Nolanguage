/**
 * Perf page smoke test.
 *
 * Same contract as `check-panel-html.ts`: the kernel performance analysis page
 * must be fully self-contained (no CDN, no external assets), light-themed and
 * emoji-free, and its in-DOM Vue template must really compile with the vendored
 * runtime. On top of that it asserts the analytical capabilities the page
 * exists for — full percentile summaries, trend history, subsystem
 * attribution, slow-path correlation and the record mix.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/check-perf-html.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { renderPerfHtml } from '../src/panel/perf-ui.js';

const here = join(fileURLToPath(import.meta.url), '..');

const html = renderPerfHtml(7310);
const checks: Array<[string, boolean, string]> = [];

const shell = html.replace(/<script>[\s\S]*?<\/script>/g, '<script></script>');
const blocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1] as string);

// ---- self-containment ----
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
  const vueSource = readFileSync(join(here, '..', 'src', 'panel', 'vendor', 'vue.global.prod.js'), 'utf8');
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
checks.push(['the in-DOM Vue template compiles', !templateError && templateSize > 2000, templateError || `${templateSize} chars`]);

// ---- capability assertions ----
const app = blocks.join('\n');
const capabilities: Array<[string, RegExp]> = [
  ['consumes the metrics digest', /msg\.kind === 'metrics'/],
  ['consumes the slow-path stream', /msg\.kind === 'slow'/],
  ['reads the perf record mix', /perfSummary[\s\S]{0,40}byType|msg\.perfSummary/],
  ['plots the full percentile set', /p50[\s\S]{0,400}p95[\s\S]{0,400}p99/],
  ['renders count/min/avg/max columns', /min:[\s\S]{0,80}max:[\s\S]{0,80}avg:/],
  ['attributes metrics to a subsystem', /function scopeOf/],
  ['groups by command/rpc/lsp/execution', /command\\\./.test(app) && /execution\\\./.test(app)],
  ['classifies metric units (bytes/rate/count/ms)', /function unitOf/],
  ['treats host uptime as a gauge, not a latency', /\\.uptime\$/.test(app)],
  ['formats values according to their unit', /function fmtUnit/],
  ['bands only durations, never gauges', /function bandOf\(p95, unit\)/],
  ['excludes gauges from the worst-latency KPI', /unit === 'ms'[\s\S]{0,220}worst = all\[i\]\.p95/],
  ['keeps gauges out of the duration sort group', /a\.unit !== b\.unit/],
  ['accumulates trend history', /st\.history\[name\]/],
  ['caps trend history length', /TREND_LEN/],
  ['renders a trend chart component', /app\.component\('trend-chart'/],
  ['renders per-row sparklines', /app\.component\('spark-line'/],
  ['correlates a slow span to its trace id', /shortId\(s\.traceId\)/],
  ['time-stamps each slow span', /clockOf\(s\.at\)/],
  ['bucketises slow paths into a histogram', /slowHistogram/],
  ['sorts metrics by any column', /function sortBy/],
  ['highlights the selected metric', /selectedRow/],
  ['exposes pause control', /togglePause/],
  ['exposes slow-path clear', /clearSlow/],
  ['exposes a slow-path filter', /st\.slowFilter/],
  ['reconnects after disconnect', /setTimeout\(open,/],
];
for (const [name, ok] of capabilities) {
  checks.push([`implements ${name}`, ok, '']);
}

// ---- theme & hygiene ----
checks.push(['uses light theme background', /--bg-primary:\s*#FFFFFF/i.test(shell), '']);
checks.push(['uses CSS custom properties', (shell.match(/--[a-z-]+:/g) ?? []).length >= 15, '']);
checks.push(['mentions the served port in the footer', shell.includes('127.0.0.1:7310'), '']);
checks.push(['has no emoji / pictographs', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(shell), '']);
checks.push(['declares utf-8 charset', /charset="utf-8"/i.test(shell), '']);
checks.push(['links to the other pages', /href="\/monitor"/.test(shell) && /href="\/"/.test(shell), '']);

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(`\nshell size: ${shell.length} bytes · inline sources: ${blocks.map((b) => b.length).join(' + ')} · total ${html.length} bytes`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
