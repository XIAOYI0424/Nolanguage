/**
 * Sanitizing a recording: does the exported file actually stop leaking?
 *
 * The file this produces is meant to be pasted into a bug report, so every check
 * here is "would a reader of that file learn something they should not". The
 * fixture is deliberately full of the three ways a recording leaks: the token in
 * the header, the token in the `hello`, and a secret sitting inside a plain
 * string value where field-name matching cannot see it.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-sanitize.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DebugSession } from '../src/debugtool/session.js';
import { readRecording } from '../src/debugtool/recorder.js';
import { describeReport, renderSanitized, sanitizeRecording } from '../src/debugtool/sanitize.js';
import { defaultConfig, mergeConfig } from '../src/debugtool/redact.js';
import type { SNode } from '../src/debugtool/protocol.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const SECRET = 'sk-live-abcdef123456';
const TOKEN = 'a'.repeat(32);

const header = {
  v: 1,
  t: 'rec-meta',
  at: 1_700_000_000_000,
  tool: 'ndebug',
  version: '0.7.11',
  lang: 'python',
  target: 'app.py',
  hz: 10,
  redact: ['password', 'token'],
  token: TOKEN,
};

const value = (): SNode => ({
  k: 'obj',
  t: 'Order',
  fields: [
    ['id', { k: 'prim', t: 'int', v: '12' }],
    // Matches the default `token` rule: must be hidden.
    ['api_token', { k: 'prim', t: 'str', v: SECRET }],
    // Not a secret, and must stay visible — otherwise the export is useless.
    ['price', { k: 'prim', t: 'float', v: '9.5' }],
    // A secret *inside* a normal field: only a scrub pattern can find it.
    ['note', { k: 'prim', t: 'str', v: `connect with ${SECRET} please` }],
    ['items', { k: 'seq', t: 'list', n: 1, items: [{ k: 'obj', t: 'Item', fields: [['sku', { k: 'prim', t: 'str', v: 'A-1' }]] }] }],
  ],
});

const events = [
  JSON.stringify({ v: 1, t: 'hello', token: TOKEN, lang: 'python', pid: 42, target: 'app.py', agentVersion: '0.3', caps: ['stack', 'snapshot'] }),
  JSON.stringify({ v: 1, t: 'stack', at: 1, tid: 1, state: 'running', frames: [{ fn: 'main', file: 'app.py', line: 3 }] }),
  JSON.stringify({ v: 1, t: 'snapshot', id: 'live-locals', at: 2, path: 'locals', value: value() }),
  JSON.stringify({ v: 1, t: 'watch', at: 3, id: 'order.api_token', ok: true, value: { k: 'prim', t: 'str', v: SECRET } }),
  JSON.stringify({ v: 1, t: 'exception', at: 4, tid: 1, type: 'RuntimeError', message: `auth failed with ${SECRET}`, frames: [] }),
];

const dir = mkdtempSync(join(tmpdir(), 'nlg-san-'));
try {
  const rawPath = join(dir, 'raw.ndlog');
  writeFileSync(rawPath, [JSON.stringify(header), ...events].join('\n') + '\n', 'utf8');

  const raw = readRecording(rawPath);
  check('raw: the fixture loads', raw.lines.length === events.length, String(raw.lines.length));
  check('raw: the file really does contain the token', readFileSync(rawPath, 'utf8').includes(TOKEN));

  // ---------------------------------------------------------- 1. sanitize

  const scrub = [new RegExp('sk-[A-Za-z0-9-]+', 'g')];
  const result = sanitizeRecording(raw, { redact: defaultConfig(), scrub });
  const outPath = join(dir, 'share.ndlog');
  writeFileSync(outPath, renderSanitized(result), 'utf8');
  const outText = readFileSync(outPath, 'utf8');

  check('sanitize: the header token is gone', !outText.includes(TOKEN), outText.slice(0, 120));
  check('sanitize: the hello token is gone', result.report.helloTokensRemoved === 1, String(result.report.helloTokensRemoved));
  check('sanitize: the header says it was sanitized', result.header.sanitized?.tokenRemoved === true, JSON.stringify(result.header.sanitized ?? null));

  const parsed = readRecording(outPath);
  check('sanitize: the output is a valid recording', parsed.lines.length === events.length && !parsed.note, `${parsed.lines.length} lines${parsed.note ? ' — ' + parsed.note : ''}`);
  check('sanitize: the output keeps the header metadata', parsed.header.target === 'app.py' && parsed.header.lang === 'python' && parsed.header.hz === 10);
  check('sanitize: the output header has no token', parsed.header.token === undefined);

  // ---------------------------------------------------------- 2. the tree

  const snap = parsed.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.t === 'snapshot') as
    | { value: SNode }
    | undefined;
  const field = (name: string): SNode | undefined => (snap?.value.k === 'obj' ? snap.value.fields.find(([k]) => k === name)?.[1] : undefined);

  const token = field('api_token');
  check('sanitize: a sensitive field is redacted', token?.k === 'trunc' && token.why === 'redacted', token?.k === 'trunc' ? token.why : String(token?.k));
  const price = field('price');
  check('sanitize: a normal field survives', price?.k === 'prim' && price.v === '9.5', price?.k === 'prim' ? price.v : String(price?.k));
  const note = field('note');
  check('sanitize: a secret inside a string is scrubbed', note?.k === 'prim' && !note.v.includes(SECRET) && note.v.includes('[scrubbed]'), note?.k === 'prim' ? note.v : String(note?.k));
  check('sanitize: nothing anywhere in the file still contains the secret', !outText.includes(SECRET));

  const exception = parsed.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.t === 'exception') as { message: string } | undefined;
  check('sanitize: an exception message is scrubbed', exception?.message.includes('[scrubbed]') === true && !exception?.message.includes(SECRET), exception?.message ?? '');

  const watch = parsed.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.t === 'watch') as { value: SNode } | undefined;
  check('sanitize: a watched string is scrubbed', watch?.value.k === 'prim' && !watch.value.v.includes(SECRET), watch?.value.k === 'prim' ? watch.value.v : '');

  // ---------------------------------------------------------- 3. the report

  check('report: counts the redacted fields', result.report.fieldsRedacted >= 1, String(result.report.fieldsRedacted));
  check('report: counts the scrubbed values', result.report.valuesScrubbed >= 2, String(result.report.valuesScrubbed));
  check('report: names what changed', result.report.samples.length > 0, result.report.samples.join(', '));
  check('report: reads as a sentence', /events/.test(describeReport(result.report)), describeReport(result.report));

  // ---------------------------------------------------------- 4. replayable

  {
    const session = new DebugSession({ hz: 10 });
    await session.listen();
    for (const line of parsed.lines) session.ingest(line);
    const view = session.view();
    check('output: still attaches without the token', view.state === 'attached', view.state);
    check('output: the target is preserved', view.target === 'app.py' && view.pid === 42, `${view.target}/${view.pid}`);
    check('output: the stacks are preserved', view.samples === 1 && view.hot.length === 1, `${view.samples} samples`);
    await session.close();
  }

  // ---------------------------------------------------------- 5. idempotent

  {
    const again = sanitizeRecording(parsed, { redact: defaultConfig(), scrub });
    check('idempotent: a second pass changes no field', again.report.fieldsRedacted === 0, String(again.report.fieldsRedacted));
    check('idempotent: a second pass scrubs nothing new', again.report.valuesScrubbed === 0, String(again.report.valuesScrubbed));
    check('idempotent: no token is reported twice', again.report.tokenRemoved === false && again.report.helloTokensRemoved === 0);
  }

  // ---------------------------------------------------------- 6. no scrub

  {
    const noScrub = sanitizeRecording(raw, { redact: defaultConfig() });
    const text = renderSanitized(noScrub);
    check('no-scrub: fields are still redacted', noScrub.report.fieldsRedacted >= 1);
    // Without a pattern the secret inside `note` survives — that is the honest
    // limit of name-based redaction, and the reason `--scrub` exists.
    check('no-scrub: a string secret survives (and is reported as zero)', noScrub.report.valuesScrubbed === 0 && text.includes(SECRET), String(noScrub.report.valuesScrubbed));
  }

  // ---------------------------------------------------------- 7. custom rules

  {
    const cfg = mergeConfig(defaultConfig(), { names: ['sku'] });
    const custom = sanitizeRecording(raw, { redact: cfg });
    const customSnap = custom.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.t === 'snapshot') as { value: SNode } | undefined;
    const seq = customSnap?.value.k === 'obj' ? customSnap.value.fields.find(([k]) => k === 'items')?.[1] : undefined;
    const sku = seq?.k === 'seq' && seq.items[0]?.k === 'obj' ? seq.items[0].fields.find(([k]) => k === 'sku')?.[1] : undefined;
    check('custom: a user-supplied name is redacted too', sku?.k === 'trunc' && sku.why === 'redacted', sku?.k === 'trunc' ? sku.why : String(sku?.k));
  }

  // ---------------------------------------------------------- 8. bad input

  {
    const brokenPath = join(dir, 'broken.ndlog');
    writeFileSync(brokenPath, [JSON.stringify(header), '{ not json', JSON.stringify({ v: 1, t: 'bye', reason: 'x' })].join('\n') + '\n', 'utf8');
    const broken = readRecording(brokenPath);
    const cleaned = sanitizeRecording(broken, { redact: defaultConfig() });
    // `readRecording` drops the unparseable line and says so; the sanitizer then
    // works on what is left. One good event (the `bye`) is what should survive.
    check('bad input: unreadable lines do not abort the export', cleaned.report.lines === 1, String(cleaned.report.lines));
    check('bad input: the drop is explained, not silent', /incomplete/.test(broken.note ?? ''), broken.note ?? 'no note');
  }
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = 1;
}
