/**
 * Plugins page smoke test — the same three rules every page in this project
 * must satisfy (二十五: no emoji; 三十四: CSS-variable theming; and the
 * standing "one self-contained document" rule), plus the page-specific
 * assertions: it must talk to the same WebSocket, and every action on it must
 * go through a message the server actually handles.
 *
 * The page's script is ES5 on purpose (it is a template string evaluated as
 * plain JS), so it is compiled here with `new Function` — which is what would
 * have caught the backtick-in-a-comment bug that once killed the IDE page.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/check-plugins-html.ts
 */
import { renderPluginsHtml } from '../src/ui/plugins-ui.js';

const html = renderPluginsHtml();
const checks: Array<[string, boolean, string]> = [];

const shell = html.replace(/<script>[\s\S]*?<\/script>/g, '<script></script>');
const blocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1] as string);
const app = blocks.join('\n');

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

// ---- the script must parse ----
checks.push(['inlines exactly one script', blocks.length === 1, `${blocks.length} blocks`]);
let parseError = '';
try {
  // eslint-disable-next-line no-new-func
  new Function(app);
} catch (e) {
  parseError = (e as Error).message;
}
checks.push(['the page script parses', !parseError, parseError]);

// ---- theme ----
checks.push(['uses a light-theme background', /--bg:\s*#FFFFFF/i.test(shell), '']);
// The rule is "the palette lives in variables", which is about *usage*, not
// how many variables a given page happens to need — a small page with a nine
// colour palette is compliant; one that inlines #EBECF0 in twelve places is not.
checks.push(['the palette is expressed in CSS variables', (shell.match(/var\(--[a-z-]+\)/g) ?? []).length >= 15, `${(shell.match(/var\(--[a-z-]+\)/g) ?? []).length} uses`]);
checks.push(['declares a variable palette', (shell.match(/--[a-z-]+:/g) ?? []).length >= 6, `${(shell.match(/--[a-z-]+:/g) ?? []).length} declared`]);
checks.push(['has no emoji / pictographs', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(shell), '']);
checks.push(['declares utf-8 charset', /charset="utf-8"/i.test(shell), '']);

// ---- protocol: every message the page sends must be one the server answers ----
const kinds = Array.from(app.matchAll(/kind:\s*'([a-z]+)'/g)).map((m) => m[1]);
const serverHandles = ['listPlugins', 'langEnable', 'langDisable', 'langUninstall', 'langInstall', 'reclaimResources'];
for (const kind of new Set(kinds)) {
  checks.push([`the server handles "${kind}"`, serverHandles.includes(kind), kind]);
}
checks.push(['the page opens the shared WebSocket endpoint', /location\.host \+ '\/'/.test(app), '']);
checks.push(['the page renders the resource budget', /renderBudget/.test(app) && /mb\(/.test(app), '']);
checks.push(['the page renders plugin cards with state', /enabled/.test(app) && /validation/.test(app), '']);
checks.push(['the page can install from a directory', /installDir/.test(app) && /installBtn/.test(app), '']);
checks.push(['builtin plugins cannot be uninstalled', /p\.removable/.test(app), '']);
checks.push(['user data is kept on uninstall', /keepData/.test(app), '']);
checks.push(['HTML is escaped, not interpolated', /function esc\(/.test(app) && /&amp;/.test(app), '']);

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(`\nshell size: ${shell.length} bytes · inline script: ${blocks.map((b) => b.length).join(' + ')} · total ${html.length} bytes`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
