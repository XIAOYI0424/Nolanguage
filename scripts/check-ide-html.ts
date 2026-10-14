/**
 * IDE UI smoke test: the workspace page must be fully self-contained, its
 * inline scripts must be syntactically valid, its Vue template must compile,
 * and it must expose the editor surface the user interacts with (gutter,
 * highlight overlay, completion popup, tabs).
 *
 * Since the Vue port the page is assembled from three inlined sources — the
 * vendored Vue runtime, the shared `nl-core` helpers and the `ide-app` Vue
 * application — plus a small HTML shell. The self-containment rules therefore
 * apply to the *shell* (our own markup), while the inlined blocks are checked
 * for what they are: parseable, in the right order, and actually used.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/check-ide-html.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { renderIdeHtml, PY_PATTERN, GO_PATTERN, HIGHLIGHT_CLASSES } from '../src/panel/ide.js';
import { SAMPLES, LANGUAGES } from '../src/panel/samples.js';

const here = join(fileURLToPath(import.meta.url), '..');

const html = renderIdeHtml(7310, SAMPLES, LANGUAGES);
const checks: Array<[string, boolean, string]> = [];

// The shell is everything outside the inline <script> bodies: our own markup
// plus the boot-data script, which carries no third-party text.
const shell = html.replace(/<script>[\s\S]*?<\/script>/g, '<script></script>');
/** Every inline script body, in document order. */
const blocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1] as string);

// ---- self-containment (design spec 二十五 / 三十四) ----
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

// ---- the inlined blocks: right order, right content, all parse ----
checks.push(['inlines four scripts (vue · core · boot · app)', blocks.length === 4, `${blocks.length} blocks`]);
checks.push(['inlines the vendored Vue runtime', /var Vue=function\(e\)\{/.test(blocks[0] ?? ''), '']);
checks.push(['inlines the shared nl-core helpers', /global\.NL\s*=/.test(blocks[1] ?? ''), '']);
checks.push(['injects the boot data', /__NOLANGUAGE_IDE__/.test(blocks[2] ?? ''), '']);
checks.push(['inlines the Vue application', /createApp\(/.test(blocks[3] ?? ''), '']);
checks.push(['the app mounts the shell', /app\.mount\('#app'\)/.test(blocks[3] ?? ''), '']);
for (const [i, block] of blocks.entries()) {
  let error = '';
  try {
    // Parse only — `new Function` compiles without executing.
    // eslint-disable-next-line no-new-func
    new Function(block);
  } catch (e) {
    error = (e as Error).message;
  }
  checks.push([`script block ${i + 1} parses`, !error, error]);
}

// ---- the Vue template must compile ----
// The vendored runtime is a plain script that assigns `var Vue`, so it can be
// evaluated in Node and its own compiler used on the in-DOM template — a real
// syntax check, not a regex guess.
let templateError = '';
let templateSize = 0;
try {
  const vueSource = readFileSync(join(here, '..', 'src', 'panel', 'vendor', 'vue.global.prod.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  const Vue = new Function(vueSource + '\n;return Vue;')() as { compile(t: string): unknown };
  // The compiled render function closes over the global `Vue`, so it has to
  // exist for the compiler call to succeed.
  (globalThis as unknown as { Vue: unknown }).Vue = Vue;
  const open = '<div id="app">';
  const start = shell.indexOf(open);
  const end = shell.indexOf('<script>');
  let template = shell.slice(start + open.length, end).trim().replace(/<\/div>\s*$/, '');
  templateSize = template.length;
  Vue.compile(template);
} catch (e) {
  templateError = (e as Error).message;
}
checks.push(['the in-DOM Vue template compiles', !templateError && templateSize > 1000, templateError || `${templateSize} chars`]);

// ---- editor surface ----
const surface: Array<[string, RegExp]> = [
  ['language selector', /<select[^>]*:value="st\.language"/],
  ['line-number gutter', /id="gutter"[\s\S]*?ref="gutterEl"/],
  ['highlight overlay', /id="highlight"[^>]*ref="hlEl"/],
  ['code textarea', /<textarea[^>]*id="code"[^>]*ref="ta"/],
  ['active-line marker', /id="activeLine"[^>]*ref="activeEl"/],
  ['completion popup', /id="completion"[^>]*ref="cmpEl"/],
  ['output panel', /id="panel-out"/],
  ['problems panel', /id="panel-prob"/],
  ['performance panel', /id="panel-perf"/],
  ['logs panel', /id="panel-logs"/],
  ['status bar', /id="fCursor"/],
  ['test action', /v-show="langDesc\(st\.language\)\.supportsTest"/],
  ['sparkline component', /<spark-line :values="row\.series"/],
];
for (const [name, re] of surface) checks.push([`has ${name}`, re.test(shell), '']);

// ---- behaviour (checked against the inlined application source) ----
const app = blocks.join('\n');
const behaviour: Array<[string, RegExp]> = [
  ['multi-language highlighter', /function highlight\(src, lang\)/],
  ['per-language token tables', /HIGHLIGHT_CLASSES\[lang\]/],
  ['language switching', /function setLanguage\(lang, opts\)/],
  ['language-scoped samples', /function samplesForLang\(lang\)/],
  ['toolchain badge', /toolBadge/],
  ['Ctrl+Enter runs', /ctrlKey \|\| e\.metaKey\) && e\.key === 'Enter'/],
  ['F5 runs', /e\.key === 'F5'/],
  ['Ctrl+Space completes', /e\.code === 'Space'/],
  ['completion request sent', /kind: 'complete'/],
  ['completion response handled', /case 'completion':/],
  ['stale responses dropped', /msg\.requestId !== cmp\.reqId/],
  ['language-scoped responses', /msg\.language !== st\.language/],
  ['keyboard navigation', /function moveSel/],
  ['completion insertion', /function acceptCompletion/],
  ['popup dismissal', /function closeCompletion/],
  ['smart indent', /indent \+ extra/],
  ['websocket reconnect', /setTimeout\(open,/],
  ['diagnostic gutter markers', /out\[st\.problems\[i\]\.line\] = 1/],
  ['build phase reported', /r\.buildMs/],
  ['compile error surfaced', /COMPILE ERROR/],
  ['metrics grouping', /execution\\\./],
  ['log dedupe', /st\.seen\[r\.id\]/],
  ['log cap', /MAX_LOGS/],
];
for (const [name, re] of behaviour) checks.push([`implements ${name}`, re.test(app), '']);

// ---- the token patterns must actually tokenise both languages ----
// Groups: 1 comment · 2 string · 3 decorator|keyword · 4 keyword|type ·
//         5 number|builtin · 6 builtin|number · 7 call · 8 class-ish|exported
function groupOf(pattern: RegExp, src: string, token: string): number {
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(src)) !== null) {
    if (m[0] === token) {
      for (let g = 1; g <= 8; g++) if (m[g] !== undefined) return g;
    }
    if (m[0].length === 0) pattern.lastIndex++;
  }
  return -1;
}

const PY_TOK = new RegExp(PY_PATTERN, 'g');
const tokenCases: Array<[string, RegExp, string, number, string]> = [
  ['line comment', PY_TOK, 'x = 1  # hi', 1, '# hi'],
  ['double-quoted string', PY_TOK, 's = "abc"', 2, '"abc"'],
  ['single-quoted string', PY_TOK, "s = 'abc'", 2, "'abc'"],
  ['triple-quoted docstring', PY_TOK, '"""doc"""', 2, '"""doc"""'],
  ['multi-line docstring', PY_TOK, '"""a\nb"""', 2, '"""a\nb"""'],
  ['triple single quotes', PY_TOK, "'''a'''", 2, "'''a'''"],
  ['decorator', PY_TOK, '@cache\ndef f(): pass', 3, '@cache'],
  ['keyword def', PY_TOK, 'def f(): pass', 4, 'def'],
  ['keyword async', PY_TOK, 'async def f(): pass', 4, 'async'],
  ['number', PY_TOK, 'x = 42', 5, '42'],
  ['float', PY_TOK, 'x = 3.14', 5, '3.14'],
  ['hex number', PY_TOK, 'x = 0xFF', 5, '0xFF'],
  ['builtin print', PY_TOK, 'print(1)', 6, 'print'],
  ['builtin self', PY_TOK, 'self.x = 1', 6, 'self'],
  ['call name', PY_TOK, 'foo(1)', 7, 'foo'],
  ['class-ish name (not called)', PY_TOK, 'x = MyClass', 8, 'MyClass'],
  ['called name wins over class-ish', PY_TOK, 'Foo(1)', 7, 'Foo'],
];
for (const [name, pat, src, want, token] of tokenCases) {
  const got = groupOf(pat, src, token);
  checks.push([`python tokenises ${name}`, got === want, `want group ${want}, got ${got}`]);
}
// A quote inside a string must not run away past the closing quote.
checks.push(['python: escaped quote stays inside the string', groupOf(PY_TOK, 's = "a\\"b"', '"a\\"b"') === 2, '']);
checks.push(['python: a lone quote does not swallow the file', groupOf(PY_TOK, 'x = 1', '1') === 5, '']);

const GO_TOK = new RegExp(GO_PATTERN, 'g');
const goCases: Array<[string, string, number, string]> = [
  ['line comment', 'x := 1 // hi', 1, '// hi'],
  ['block comment', '/* a\nb */', 1, '/* a\nb */'],
  ['interpreted string', 's := "abc"', 2, '"abc"'],
  ['rune literal', "r := 'a'", 2, "'a'"],
  ['keyword func', 'func main() {}', 3, 'func'],
  ['keyword package', 'package main', 3, 'package'],
  ['keyword defer', 'defer f()', 3, 'defer'],
  ['builtin type int', 'var x int', 4, 'int'],
  ['builtin type string', 'var s string', 4, 'string'],
  ['builtin type error', 'func f() error { return nil }', 4, 'error'],
  ['builtin func make', 'make([]int, 0)', 5, 'make'],
  ['builtin func len', 'len(xs)', 5, 'len'],
  ['number', 'x := 42', 6, '42'],
  ['float', 'x := 3.14', 6, '3.14'],
  ['hex number', 'x := 0xFF', 6, '0xFF'],
  ['underscored int', 'x := 1_000_000', 6, '1_000_000'],
  ['call name', 'foo(1)', 7, 'foo'],
  ['exported name', 'fmt.Println(x)', 8, 'Println'],
  ['exported type', 'x := MyStruct{}', 8, 'MyStruct'],
];
for (const [name, src, want, token] of goCases) {
  const got = groupOf(GO_TOK, src, token);
  checks.push([`go tokenises ${name}`, got === want, `want group ${want}, got ${got}`]);
}
// Raw strings use backticks. The pattern spells them \x60 so the emitted page
// source never contains a literal backtick (which would break the template).
const RAW = 's := ' + String.fromCharCode(96) + 'raw\\nstring' + String.fromCharCode(96);
checks.push([
  'go tokenises raw string (backticks)',
  groupOf(GO_TOK, RAW, RAW.slice(5)) === 2,
  '',
]);
checks.push([
  'no literal backtick leaks into our own markup',
  !shell.includes('`'),
  '',
]);
checks.push([
  'highlight class table covers both languages',
  !!HIGHLIGHT_CLASSES.python && !!HIGHLIGHT_CLASSES.go && HIGHLIGHT_CLASSES.go.length === 8,
  '',
]);

// ---- theme & hygiene ----
checks.push(['uses light theme background', /--bg-primary:\s*#FFFFFF/i.test(shell), '']);
checks.push(['uses CSS custom properties', (shell.match(/--[a-z-]+:/g) ?? []).length >= 15, '']);
checks.push(['declares utf-8 charset', /charset="utf-8"/i.test(shell), '']);
checks.push(['mentions the served port in the footer', shell.includes('127.0.0.1:7310'), '']);
checks.push(['has no emoji / pictographs', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(shell), '']);
checks.push(['inlines the sample set', shell.includes(SAMPLES[0].name) || html.includes(SAMPLES[0].name), '']);

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(`\nshell size: ${shell.length} bytes · inline sources: ${blocks.map((b) => b.length).join(' + ')} · total ${html.length} bytes`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
