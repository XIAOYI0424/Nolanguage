/**
 * CodeMirror 5 vendor drop check.
 *
 * The editor plugin inlines CM5 statically (`?raw`), so the files must be on
 * disk before it can be wired. This script is the checklist: it names every
 * required file, reports what is missing, and sanity-checks the two entry
 * points so a truncated download does not slip through.
 *
 * Run:
 *   node --experimental-transform-types --no-warnings \
 *     --experimental-loader ./resolve-loader.mjs scripts/verify-editor-assets.ts
 *
 * Exit 0 = ready to wire. Exit 1 = something required is missing/empty.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dir = join(root, 'src', 'panel', 'vendor', 'codemirror');

const REQUIRED = [
  'codemirror.js',
  'codemirror.css',
  'mode/python/python.js',
  'mode/go/go.js',
  'mode/javascript/javascript.js',
  'mode/markdown/markdown.js',
  'mode/xml/xml.js',
  'addon/hint/show-hint.js',
  'addon/hint/show-hint.css',
];

const OPTIONAL = [
  'addon/edit/matchbrackets.js',
  'addon/edit/closebrackets.js',
  'addon/selection/active-line.js',
  'addon/comment/comment.js',
  'addon/fold/foldcode.js',
  'addon/fold/foldgutter.js',
  'addon/fold/brace-fold.js',
  'addon/fold/indent-fold.js',
  'addon/fold/markdown-fold.js',
];

let missing = 0;
const rows: Array<[string, string, string]> = [];

for (const rel of REQUIRED) {
  const p = join(dir, rel);
  if (!existsSync(p)) {
    missing++;
    rows.push(['MISSING', rel, '']);
    continue;
  }
  const size = statSync(p).size;
  if (size === 0) {
    missing++;
    rows.push(['EMPTY', rel, '0 bytes']);
    continue;
  }
  rows.push(['ok', rel, `${size} bytes`]);
}

for (const rel of OPTIONAL) {
  const p = join(dir, rel);
  rows.push([existsSync(p) ? 'ok' : '—', rel, existsSync(p) ? `${statSync(p).size} bytes` : 'optional']);
}

// Entry-point sanity: a valid CM5 build defines CodeMirror and its stylesheet
// targets `.CodeMirror`. A renamed/HTML error page must not pass.
const jsPath = join(dir, 'codemirror.js');
const cssPath = join(dir, 'codemirror.css');
const jsOk = existsSync(jsPath) && /CodeMirror/.test(readFileSync(jsPath, 'utf8'));
const cssOk = existsSync(cssPath) && /\.CodeMirror/.test(readFileSync(cssPath, 'utf8'));

const width = Math.max(...rows.map((r) => r[1].length));
for (const [mark, rel, detail] of rows) {
  console.log(`  ${mark.padEnd(8)} ${rel.padEnd(width)}  ${detail}`);
}

console.log('');
console.log(`  entry points: codemirror.js ${jsOk ? 'ok' : 'INVALID'} · codemirror.css ${cssOk ? 'ok' : 'INVALID'}`);
console.log(`  ${missing === 0 ? 'READY' : 'NOT READY'} — ${REQUIRED.length - missing}/${REQUIRED.length} required files present`);

process.exit(missing === 0 && jsOk && cssOk ? 0 : 1);
