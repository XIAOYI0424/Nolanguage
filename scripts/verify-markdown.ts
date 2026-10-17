/**
 * Stage 8 · Markdown verification.
 *
 * Three layers, each with its own checks:
 *
 *   1. Renderer unit tests — the zero-dependency CommonMark-subset renderer
 *      (blocks, inlines, frontmatter, slug dedup, the safety contract that
 *      keeps raw HTML and `javascript:` URLs out of the preview, and the
 *      guard that clips a runaway document instead of hanging the backend).
 *   2. marksman discovery — the Markdown LSP is optional; a missing binary is
 *      a graceful `launch: null` (SKIP), never a failure, exactly like gopls.
 *   3. Backend integration — the live server renders a Markdown document over
 *      the WebSocket (`mdRender` -> `mdPreview`) and rejects `run` for a
 *      render-only language with a clear error.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-markdown.ts
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawWsClient } from './lib/RawWsClient.js';
import {
  renderMarkdown,
  escapeHtml,
  safeUrl,
  slugify,
  parseFrontmatter,
  MAX_LINES,
} from '../src/markdown/MdRenderer.js';
import { discoverMarksmanServer, resolveMarksman } from '../src/markdown/discover.js';
import { sampleById } from '../src/panel/samples.js';

const PORT = Number(process.env.VERIFY_PORT ?? 7511);

const results: { name: string; ok: boolean; detail: string; skipped?: boolean }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name: string, detail = ''): void {
  results.push({ name, ok: true, detail, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

// ============================================================ renderer unit

function testRenderer(): void {
  // ---- headings: ATX with GitHub-style slug anchors ----
  const h = renderMarkdown('# Hello World\n\n## A Sub Section\n');
  check('renderer: ATX heading becomes an <h1> with slug id',
    /<h1 id="hello-world">Hello World<\/h1>/.test(h.html), h.html.slice(0, 80));
  check('renderer: nested heading level is preserved',
    /<h2 id="a-sub-section">/.test(h.html));
  check('renderer: headings are reported for the outline',
    h.headings.length === 2 && h.headings[0].slug === 'hello-world' && h.headings[1].level === 2,
    `${h.headings.length} headings`);

  // ---- setext headings (underline form) ----
  const se1 = renderMarkdown('Title\n=====\n\nbody\n');
  check('renderer: setext heading (===) renders as <h1>',
    /<h1 id="title">Title<\/h1>/.test(se1.html));
  const se2 = renderMarkdown('Sub\n---\n\nbody\n');
  check('renderer: setext heading (---) renders as <h2> (wins over thematic)',
    /<h2 id="sub">Sub<\/h2>/.test(se2.html) && !/<hr/.test(se2.html), se2.html.slice(0, 60));

  // ---- slug dedup ----
  const dup = renderMarkdown('# Note\n\n# Note\n\n# Note\n');
  check('renderer: duplicate slugs get numeric suffixes',
    dup.headings.map((x) => x.slug).join(',') === 'note,note-1,note-2',
    dup.headings.map((x) => x.slug).join(','));

  // ---- fenced code with language class ----
  const code = renderMarkdown('```python\nx = 1\nprint(x)\n```\n');
  check('renderer: fenced code carries a language class',
    /<pre><code class="language-python">/.test(code.html), code.html.slice(0, 60));

  // ---- indented code block ----
  const ind = renderMarkdown('    let y = 2;\n    y = y * 3;\n');
  check('renderer: indented code block is preserved', /<pre><code>/.test(ind.html), ind.html.slice(0, 50));

  // ---- thematic break ----
  check('renderer: a thematic break becomes <hr>', /<hr \/>/.test(renderMarkdown('---').html));

  // ---- blockquote nesting ----
  const bq = renderMarkdown('> outer\n> > inner\n');
  check('renderer: nested blockquotes render',
    /<blockquote>[\s\S]*<blockquote>[\s\S]*inner/.test(bq.html));

  // ---- lists ----
  const ul = renderMarkdown('- one\n- two\n- three\n');
  check('renderer: bullet list becomes <ul>', /<ul>[\s\S]*<li>one<\/li>[\s\S]*<li>three<\/li>/.test(ul.html));
  const ol = renderMarkdown('1. first\n2. second\n');
  check('renderer: ordered list becomes <ol> with items',
    /<ol>[\s\S]*<li>first<\/li>[\s\S]*<li>second<\/li>/.test(ol.html));
  const nested = renderMarkdown('- a\n  - b\n  - c\n');
  check('renderer: nested list items are indented',
    /<ul>[\s\S]*<ul>[\s\S]*<li>b<\/li>/.test(nested.html));

  // ---- GFM task list ----
  const task = renderMarkdown('- [x] done\n- [ ] todo\n');
  check('renderer: task list renders checkboxes',
    /class="task-list">/.test(task.html) && /<input type="checkbox" disabled checked \/>/.test(task.html) &&
      /<input type="checkbox" disabled \/>/.test(task.html));

  // ---- GFM table with alignment ----
  const tbl = renderMarkdown('| Name | Score |\n| :--- | ---: |\n| Ada | 99 |\n| Bob | 12 |\n');
  check('renderer: a table renders <thead>/<tbody>',
    /<table>[\s\S]*<thead>[\s\S]*<th[^>]*>Name<\/th>[\s\S]*<tbody>/.test(tbl.html));
  check('renderer: table alignment is emitted',
    /<th style="text-align:left">Name<\/th>/.test(tbl.html) &&
      /<td style="text-align:right">99<\/td>/.test(tbl.html));

  // ---- frontmatter ----
  const fm = parseFrontmatter('title: Release notes\ntags:\n  - launch\n  - docs\ndate: 2026-01-02\n');
  check('renderer: frontmatter parses title and nested tags',
    fm.title === 'Release notes' && fm.tags.length === 2 && fm.tags[0] === 'launch',
    JSON.stringify(fm.tags));
  const fmInline = parseFrontmatter('title: Notes\ntags: [a, b, c]\n');
  check('renderer: frontmatter also parses inline tags',
    fmInline.tags.length === 3 && fmInline.tags[2] === 'c', JSON.stringify(fmInline.tags));
  const withFm = renderMarkdown('---\ntitle: My Doc\ntags:\n  - a\n---\n\n# Heading\n');
  check('renderer: frontmatter title lifts to the document title',
    withFm.title === 'My Doc' && /<h1 id="heading">Heading<\/h1>/.test(withFm.html));

  // ---- inline emphasis / code / link / image ----
  const inl = renderMarkdown('**bold** and *em* and ~~strike~~ and `code`.\n');
  check('renderer: inline emphasis and code',
    /<strong>bold<\/strong>/.test(inl.html) && /<em>em<\/em>/.test(inl.html) &&
      /<del>strike<\/del>/.test(inl.html) && /<code>code<\/code>/.test(inl.html));
  const link = renderMarkdown('see [site](https://example.com) now.\n');
  check('renderer: a safe link is anchored',
    /<a href="https:\/\/example.com">site<\/a>/.test(link.html), link.html.slice(0, 80));
  const img = renderMarkdown('![alt text](https://example.com/x.png)\n');
  check('renderer: an image renders with alt text',
    /alt="alt text"/.test(img.html) && /src="https:\/\/example.com\/x.png"/.test(img.html), img.html.slice(0, 90));

  // ---- safety: raw HTML is escaped, not passed through ----
  const raw = renderMarkdown('A <script>alert(1)</script> try.\n');
  check('renderer: raw HTML in text is escaped (no live tag)',
    !/<script>/.test(raw.html) && /&lt;script&gt;/.test(raw.html), raw.html.slice(0, 80));

  // ---- safety: dangerous URL schemes are dropped ----
  const evil = renderMarkdown('[click](javascript:alert(1))\n');
  check('renderer: javascript: links are neutralised',
    !/href="javascript:/.test(evil.html) && /click/.test(evil.html), evil.html.slice(0, 80));
  const proto = renderMarkdown('[x](//evil.example.com)\n');
  check('renderer: protocol-relative URLs are rejected', !/href="\/\/evil/.test(proto.html));

  // ---- safeUrl / slugify / escapeHtml are exported and correct ----
  check('safeUrl: allows http/https/mailto', safeUrl('https://x.com') === 'https://x.com' &&
    safeUrl('mailto:a@b.com') === 'mailto:a@b.com');
  check('safeUrl: rejects javascript: and //protocol-relative', safeUrl('javascript:x') === null &&
    safeUrl('//evil') === null);
  check('safeUrl: allows relative paths', safeUrl('docs/guide.md') === 'docs/guide.md');
  check('slugify: lowercases and dashes', slugify('Hello, World!') === 'hello-world');
  check('escapeHtml: escapes the five characters',
    escapeHtml(`<a & "b" 'c'>`) === '&lt;a &amp; &quot;b&quot; &#39;c&#39;&gt;');

  // ---- stats are always populated ----
  const stats = renderMarkdown('# T\n\nword word word\n').stats;
  check('renderer: stats report blocks/words/headings',
    stats.blocks >= 1 && stats.words >= 3 && stats.headings === 1,
    JSON.stringify(stats));

  // ---- performance guard: a runaway document is clipped, not hung ----
  const big = '# H\n\n' + Array.from({ length: MAX_LINES + 5000 }, () => 'line of text').join('\n');
  const t0 = Date.now();
  const bigR = renderMarkdown(big);
  const bigMs = Date.now() - t0;
  check('renderer: oversized input is clipped (truncated flag)', bigR.truncated === true,
    `lines=${MAX_LINES + 5000}`);
  check('renderer: oversized input still returns promptly', bigMs < 2000, `${bigMs}ms`);
}

// ============================================================ discovery

function testDiscovery(): void {
  // A missing marksman must be a graceful skip, not a failure.
  const absent = discoverMarksmanServer();
  check('discovery: absent marksman reports launch:null', absent.launch === null);
  check('discovery: absent marksman is source "none"', absent.source === 'none');
  check('discovery: absent marksman explains the degradation',
    !!absent.note && /preview/.test(absent.note), absent.note?.slice(0, 40) ?? '');

  // An explicit-but-missing path stays "missing" (a misconfiguration worth
  // reporting), and never quietly falls back to PATH.
  const missingPath = join(tmpdir(), 'nolanguage-marksman-does-not-exist-xyz.exe');
  const explicitMissing = discoverMarksmanServer(missingPath);
  check('discovery: explicit missing path keeps launch:null', explicitMissing.launch === null);
  const res = resolveMarksman(missingPath);
  check('discovery: explicit missing path is source "missing"', res.source === 'missing', res.bin);

  // A real binary is resolved and surfaced as a launch spec.
  const fakeBin = join(tmpdir(), `nolanguage-marksman-fake-${process.pid}.exe`);
  writeFileSync(fakeBin, '#!/bin/sh\necho marksman\n');
  try {
    const present = discoverMarksmanServer(fakeBin);
    check('discovery: a present binary yields a launch spec',
      !!present.launch && present.launch.command === fakeBin && present.launch.languageId === 'markdown',
      present.launch ? present.launch.command : 'null');
    check('discovery: present binary is source MARKSMAN', resolveMarksman(fakeBin).source === 'MARKSMAN');
  } finally {
    try { writeFileSync(fakeBin, ''); } catch { /* cleanup best-effort */ }
  }
}

// ===================================================== backend integration

async function waitForHttp(port: number, ms: number): Promise<unknown> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error('server did not start');
    await delay(150);
  }
}

async function testBackend(): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--experimental-loader',
      './resolve-loader.mjs',
      'src/panel/server.ts',
    ],
    {
      env: {
        ...process.env,
        PANEL_PORT: String(PORT),
        PANEL_SLOW_MS: '40',
        PANEL_NO_DEMO: '1',
        PANEL_NO_STORE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverOut = '';
  child.stdout.on('data', (d) => (serverOut += d.toString()));
  child.stderr.on('data', (d) => (serverOut += d.toString()));

  let client: RawWsClient | undefined;
  let failed = false;
  try {
    await waitForHttp(PORT, 25_000);
    client = new RawWsClient(PORT);
    await client.ready;
    const hello = await client.waitFor('hello', 8000);
    check('backend: server greets the IDE client', !!hello, String(hello?.appVersion ?? ''));

    const ws = await client.waitFor('workspace', 8000);
    const samples = (ws?.samples ?? []) as Array<{ id: string; languageId: string }>;
    const mdSample = sampleById('md-tour') ?? samples.find((s) => s.languageId === 'markdown');
    check('backend: a Markdown sample is advertised', !!mdSample, mdSample?.id ?? 'none');

    // ---- render round-trip ----
    client.clearReceived();
    const mdCode = '# Preview Title\n\nSome **bold** text and a [link](https://example.com).\n\n- [x] done\n';
    client.send({ kind: 'mdRender', language: 'markdown', code: mdCode, requestId: 1 });
    const prev = await client.waitFor('mdPreview', 8000);
    const p = prev as {
      ok?: boolean;
      html?: string;
      title?: string;
      stats?: { blocks: number; headings: number };
      ms?: number;
      truncated?: boolean;
    };
    check('backend: mdRender returns a preview', !!p && p.ok === true, `ok=${p?.ok}`);
    check('backend: preview HTML renders the heading',
      !!p?.html && /<h1 id="preview-title">Preview Title<\/h1>/.test(p.html), (p?.html ?? '').slice(0, 60));
    check('backend: preview HTML sanitises nothing dangerous',
      !!p?.html && !/<script>/.test(p.html));
    check('backend: preview carries title + stats',
      p?.title === 'Preview Title' && !!p?.stats && p.stats.blocks >= 1,
      JSON.stringify(p?.stats ?? {}));

    // ---- stale requestId is dropped (like completions) ----
    client.clearReceived();
    client.send({ kind: 'mdRender', language: 'markdown', code: mdCode, requestId: 2 });
    const prev2 = await client.waitFor('mdPreview', 8000);
    check('backend: preview echoes the latest requestId',
      (prev2 as { requestId?: number })?.requestId === 2,
      String((prev2 as { requestId?: number })?.requestId ?? '-'));

    // ---- run is rejected for a render-only language ----
    client.clearReceived();
    client.send({ kind: 'run', language: 'markdown', sessionId: 'verify', code: '# nope\n' });
    const err = await client.waitFor('error', 8000);
    check('backend: running Markdown is rejected with a clear error',
      !!err && /render/i.test(String((err as { message?: string }).message ?? '')),
      String((err as { message?: string })?.message ?? ''));
  } catch (e) {
    failed = true;
    const detail = (e as Error).message;
    check('backend: integration completed without a crash', false, detail);
    if (serverOut) console.log(serverOut.slice(-800));
  } finally {
    if (client) try { client.close(); } catch { /* ignore */ }
    child.kill('SIGTERM');
  }
  if (failed) throw new Error('backend integration failed');
}

// ================================================================ driver

async function main(): Promise<void> {
  console.log('— renderer unit checks —');
  testRenderer();
  console.log('— marksman discovery —');
  testDiscovery();
  console.log('— backend integration —');
  await testBackend();

  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  const total = results.length;
  console.log(`\n${passed}/${total} checks passed (${skipped} skipped, ${failed} failed)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
