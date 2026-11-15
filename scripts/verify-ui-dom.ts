/**
 * UI DOM test — mounts the Dev Panel pages (monitor + perf) in jsdom and drives
 * them against a fake WebSocket, proving the Vue apps really populate from the
 * server's frames.
 *
 * The old Vue IDE workspace page was removed in favour of the PyCharm-style
 * shell (`/pycharm`, served at `/`); its DOM coverage now lives in
 * `verify-pycharm.ts`, which mounts that shell the same way. The self-contained
 * static checks live in `check-panel-html.ts` / `check-perf-html.ts`.
 *
 * jsdom lives in the isolated node workspace (like esbuild/postject), never in
 * the project's dependency list. When it is missing the suite reports SKIP and
 * exits 0, so `verify-all` still passes on a clean machine.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-ui-dom.ts
 */
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderPanelHtml } from '../src/ui/ui.js';
import { renderPyCharmHtml } from '../src/panel/pycharm-ui.js';
import { renderPerfHtml } from '../src/ui/perf-ui.js';

const TOOLS = join('C:', 'Users', '15936', '.workbuddy-ai', 'binaries', 'node', 'workspace');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

let JSDOM: any;
let VirtualConsole: any;
try {
  try {
    const require = createRequire(join(TOOLS, 'package.json'));
    ({ JSDOM, VirtualConsole } = require('jsdom'));
  } catch {
    const require = createRequire(join(ROOT, 'package.json'));
    ({ JSDOM, VirtualConsole } = require('jsdom'));
  }
} catch {
  console.log('SKIP  jsdom not available (isolated workspace or project node_modules) — UI DOM test skipped');
  console.log('0/0 checks passed');
  process.exit(0);
}

/** Minimal WebSocket stand-in: records sends, lets the test push frames. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }, 0);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  /** Server -> client frame. */
  deliver(msg: Record<string, unknown>): void {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
  lastSentOf(kind: string): Record<string, unknown> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].kind === kind) return this.sent[i];
    }
    return undefined;
  }
}

/** Mount a rendered page: run its inline scripts in order inside a jsdom window. */
function mountPage(html: string): { window: any; socket: FakeSocket } {
  // A VirtualConsole with no listeners keeps jsdom's "not implemented" noise
  // (canvas, etc.) out of the test output.
  const vc = new VirtualConsole();
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window as any;
  w.WebSocket = FakeSocket;
  const blocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1] as string);
  for (const block of blocks) w.eval(block);
  return { window: w, socket: FakeSocket.instances[FakeSocket.instances.length - 1] };
}

/** Let Vue flush its scheduler queue (microtasks) plus a macrotask. */
async function settle(w: any, ms = 15): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => w.setTimeout(r, ms));
}

function q(w: any, sel: string): any {
  return w.document.querySelector(sel);
}
function qa(w: any, sel: string): any[] {
  return Array.from(w.document.querySelectorAll(sel)) as any[];
}
function fire(w: any, el: any, type: string, init: Record<string, unknown> = {}): void {
  const Ctor =
    type === 'click' ? w.MouseEvent : type === 'keydown' || type === 'keyup' ? w.KeyboardEvent : w.Event;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
}

// ============================================================ monitor

async function testMonitor(): Promise<void> {
  FakeSocket.instances = [];
  const { window: w, socket } = mountPage(renderPanelHtml(7310));
  await settle(w);

  socket.deliver({ kind: 'hello', appVersion: '0.6.0-workspace', arch: 'x64', os: 'Windows 11' });
  await settle(w);
  check(
    'monitor: hello fills the version badge',
    qa(w, 'header .badge').some((b) => b.textContent.indexOf('v0.6.0') !== -1),
    qa(w, 'header .badge')
      .map((b) => b.textContent)
      .join(' | '),
  );

  socket.deliver({
    kind: 'metrics',
    tick: 3,
    clients: 2,
    perfSummary: { total: 120 },
    metrics: { 'command.ping': { count: 2, p50: 0.4, p95: 0.8, p99: 1, min: 0, max: 1, mean: 0.5 } },
    series: { 'command.ping': [1, 2] },
  });
  await settle(w);
  check('monitor: metrics render', qa(w, '#metrics .metric').length === 1);
  check(
    'monitor: the footer counts are live',
    q(w, '#fTick').textContent === 'tick 3' && q(w, '#fClients').textContent === 'clients 2',
  );

  socket.deliver({
    kind: 'slow',
    spans: [{ commandId: 'demo.slow', name: 'demo.slow', traceId: '0011223344556677', durationMs: 88.5 }],
  });
  await settle(w);
  check('monitor: slow paths render', qa(w, '#slow .slow').length === 1 && q(w, '.slow .dur').textContent === '88.5ms');

  socket.deliver({
    kind: 'log',
    records: [
      { id: 'm1', ts: Date.now(), level: 2, levelName: 'INFO', component: 'kernel', message: 'ready' },
      {
        id: 'm2',
        ts: Date.now(),
        level: 4,
        levelName: 'ERROR',
        component: 'lsp',
        message: 'boom',
        errorType: 'Error',
        errorMessage: 'x',
      },
    ],
  });
  await settle(w);
  check('monitor: logs render', qa(w, '#logs .logrow').length === 2);
  check('monitor: the error row is styled', q(w, '.logrow .lv-ERROR') !== null);

  // pause freezes the performance view
  q(w, '#perfCol button').click();
  await settle(w);
  socket.deliver({
    kind: 'metrics',
    tick: 99,
    clients: 5,
    metrics: { 'command.ping': { count: 2, p50: 0.4, p95: 0.8, p99: 1, min: 0, max: 1, mean: 0.5 } },
    series: {},
  });
  await settle(w);
  check('monitor: pause freezes the tick counter', q(w, '#fTick').textContent === 'tick 3', q(w, '#fTick').textContent);

  // the level filter is applied server-side, and locally
  const lvl = q(w, '#logToolbar select');
  lvl.value = '4';
  fire(w, lvl, 'change');
  await settle(w);
  q(w, '#logToolbar button').click(); // apply
  await settle(w);
  const filterMsg = socket.lastSentOf('filter');
  check('monitor: apply sends the filter', !!filterMsg && filterMsg.minLevel === 4, JSON.stringify(filterMsg));
  check('monitor: the local filter hides INFO', qa(w, '#logs .logrow').length === 1, 'only the ERROR row');

  w.close();
}

// =============================================================== perf

/**
 * Kernel performance analysis page. Drives the real app with a digest shaped
 * like the server's (short + full metric summaries, a record mix, and a slow
 * span with a trace id) and asserts the analytical surfaces really populate:
 * KPI strip, subsystem attribution, sortable metric table, selectable trend
 * detail, slow-path histogram/table and the record-mix bars.
 */
async function testPerf(): Promise<void> {
  FakeSocket.instances = [];
  const { window: w, socket } = mountPage(renderPerfHtml(7310));
  await settle(w);

  check('perf: Vue mounts the analysis shell', !!q(w, '#app header') && !!q(w, '#kpis'));

  socket.deliver({
    kind: 'hello',
    appVersion: '0.6.0-workspace',
    arch: 'x64',
    os: 'Windows 11',
    pushIntervalMs: 1000,
    commands: [{ id: 'baseline.checkpoint', title: 'Capture a metric baseline' }],
  });
  socket.deliver({
    kind: 'metrics',
    tick: 12,
    clients: 1,
    perfSummary: { total: 480, byType: { metric: 300, sample: 120, event: 60 } },
    metrics: {
      'command.run': { count: 40, min: 0.2, max: 12, avg: 2.5, p50: 2.1, p95: 8.4, p99: 11.2 },
      'rpc.roundtrip.initialize': { count: 3, min: 120, max: 480, avg: 300, p50: 290, p95: 460, p99: 478 },
      'execution.run': { count: 12, min: 8, max: 260, avg: 70, p50: 40, p95: 250, p99: 259 },
      // A byte gauge with a huge magnitude: it must never be treated as a
      // latency or ranked as the worst p95 (see the unit checks below).
      'memory.rss': { count: 11, min: 73895936, max: 78503936, avg: 75798341, p50: 73908224, p95: 78503936, p99: 78503936 },
    },
    series: {
      'command.run': [1, 2, 3, 4, 5],
      'rpc.roundtrip.initialize': [100, 200, 300],
      'execution.run': [10, 30, 60, 90],
      'memory.rss': [75000000, 76000000, 77000000],
    },
  });
  await settle(w);

  // ---- KPI strip ----
  const kpis = qa(w, '#kpis .kpi .v').map((e: any) => e.textContent);
  check('perf: the KPI strip counts the metrics', kpis[0] === '4', kpis.join(' | '));
  check('perf: the worst p95 is reported', kpis[1].indexOf('460') !== -1 && kpis[1].indexOf('ms') !== -1, kpis[1]);
  check('perf: the hot-metric count finds p95 >= 200ms', kpis[2] === '2', kpis[2]);
  check('perf: the record total is shown', kpis[3] === '480', kpis[3]);

  /// Row lookup by metric name — position is unreliable because the table
  /// is re-sorted by several checks below.
  const rowFor = (name: string): any =>
    qa(w, '.mrow').find((el: any) => el.textContent.indexOf(name) !== -1);

  // ---- metric table ----
  const rows = qa(w, '.mrow');
  check('perf: every metric gets a row', rows.length === 4, `${rows.length} rows`);
  check('perf: rows are sorted worst p95 first', rows[0].textContent.indexOf('rpc.roundtrip.initialize') !== -1, rows[0].querySelector('.name b')?.textContent);
  check('perf: a large gauge does not outrank durations', rows[3].textContent.indexOf('memory.rss') !== -1, rows.map((r: any) => r.querySelector('.name b')?.textContent).join(' | '));
  check('perf: the slowest row is banded bad', q(w, '.mrow .n.lead.bad') !== null);
  check('perf: rows show the full percentile set', qa(w, '.mrow .n').length === 4 * 6, `${qa(w, '.mrow .n').length} cells`);
  check('perf: rows carry a subsystem chip', qa(w, '.mrow .chip').length === 4);

  // ---- subsystem attribution ----
  // "all" + Commands + RPC round-trip + Execution + Other (memory.rss).
  const scopes = qa(w, '#scopeCol .scope');
  check('perf: the "all" row plus one per subsystem', scopes.length === 5, `${scopes.length} entries`);
  const scopeText = scopes.map((e: any) => e.textContent).join(' | ');
  check('perf: subsystems are named, not metric prefixes', scopeText.indexOf('RPC round-trip') !== -1 && scopeText.indexOf('Execution') !== -1);
  check('perf: subsystems aggregate their metrics', /1 metrics/.test(scopeText));

  // filtering by subsystem narrows the table
  scopes[1].click();
  await settle(w);
  check('perf: clicking a subsystem filters the table', qa(w, '.mrow').length === 1, `${qa(w, '.mrow').length} rows`);
  scopes[0].click();
  await settle(w);
  check('perf: "all subsystems" restores the table', qa(w, '.mrow').length === 4);

  // ---- sorting ----
  const countHead = qa(w, '#metricHead span').find((s: any) => s.textContent.indexOf('count') !== -1) as any;
  countHead.click();
  await settle(w);
  check('perf: clicking a column header re-sorts', qa(w, '.mrow')[0].textContent.indexOf('command.run') !== -1, qa(w, '.mrow')[0].querySelector('.name b')?.textContent);

  // ---- trend detail ----
  check('perf: no trend is plotted before a selection', q(w, 'svg.trend') === null);
  rowFor('command.run').click();
  await settle(w);
  check('perf: selecting a metric opens the trend chart', q(w, 'svg.trend') !== null);
  const bars = qa(w, 'svg.trend rect');
  check('perf: the trend charts the accumulated history', bars.length === 5, `${bars.length} bars`);
  check('perf: the trend draws a moving line', q(w, 'svg.trend .trendLine') !== null);
  check('perf: the detail head names the metric', q(w, '#detail .head .t').textContent.indexOf('command.run') !== -1, q(w, '#detail .head .t').textContent);
  check('perf: the detail head shows the summary', q(w, '#detail .head .hint').textContent.indexOf('p99') !== -1);

  // a second digest extends the client-side history rather than resetting it
  socket.deliver({
    kind: 'metrics',
    tick: 13,
    clients: 1,
    perfSummary: { total: 500, byType: { metric: 320, sample: 120, event: 60 } },
    metrics: {
      'command.run': { count: 44, min: 0.2, max: 12, avg: 2.7, p50: 2.2, p95: 8.9, p99: 11.5 },
      'rpc.roundtrip.initialize': { count: 3, min: 120, max: 480, avg: 300, p50: 290, p95: 460, p99: 478 },
      'execution.run': { count: 12, min: 8, max: 260, avg: 70, p50: 40, p95: 250, p99: 259 },
      'memory.rss': { count: 12, min: 73895936, max: 78503936, avg: 76000000, p50: 74000000, p95: 78503936, p99: 78503936 },
    },
    series: {
      'command.run': [1, 2, 3, 4, 5, 6],
      'rpc.roundtrip.initialize': [100, 200, 300],
      'execution.run': [10, 30, 60, 90],
      'memory.rss': [75000000, 76000000, 77000000, 78000000],
    },
  });
  await settle(w);
  check('perf: the trend accumulates across digests', qa(w, 'svg.trend rect').length === 6, `${qa(w, 'svg.trend rect').length} bars`);

  // deselecting closes the detail
  rowFor('command.run').click();
  await settle(w);
  check('perf: clicking again closes the trend', q(w, 'svg.trend') === null);

  // ---- record mix ----
  const mix = qa(w, '.mix .r');
  check('perf: the record mix lists each type', mix.length === 3, `${mix.length} types`);
  check('perf: the record mix is ordered by volume', mix[0].textContent.indexOf('metric') !== -1, mix[0].textContent);
  check('perf: the record mix scales its bars', !!q(w, '.mix .r .b i'));

  // ---- slow paths ----
  check('perf: the histogram is present before any span', qa(w, '.hist .r').length === 5, `${qa(w, '.hist .r').length} buckets`);
  socket.deliver({
    kind: 'slow',
    spans: [
      { spanId: 's1', commandId: 'command.run', name: 'command.run', traceId: 'aaaabbbbccccdddd', durationMs: 88.5, at: Date.now() },
      { spanId: 's2', commandId: 'rpc.initialize', name: 'rpc.initialize', traceId: 'eeeeffff00001111', durationMs: 720.2, at: Date.now() },
    ],
  });
  await settle(w);
  const slow = qa(w, '.slow');
  check('perf: slow spans are listed', slow.length === 2, `${slow.length} rows`);
  check('perf: the slow list is newest-first', slow[0].textContent.indexOf('rpc.initialize') !== -1);
  check('perf: a slow span shows its trace id', slow[0].textContent.indexOf('#eeeeffff') !== -1, slow[0].textContent);
  check('perf: a slow span is timestamped', /\d{2}:\d{2}:\d{2}/.test(slow[0].textContent));
  check('perf: the >1s band is empty', qa(w, '.hist .r')[4].textContent.indexOf('0') !== -1);
  check('perf: the 500ms-1s band counted the span', qa(w, '.hist .r')[3].textContent.trim().endsWith('1'), qa(w, '.hist .r')[3].textContent);
  check('perf: a very slow span is banded bad', q(w, '.slow .dur.bad') !== null);

  // filtering slow paths
  const filterInput = q(w, 'input[type=text]');
  filterInput.value = 'initialize';
  fire(w, filterInput, 'input');
  await settle(w);
  check('perf: the slow filter narrows the list', qa(w, '.slow').length === 1, `${qa(w, '.slow').length} rows`);
  filterInput.value = '';
  fire(w, filterInput, 'input');
  await settle(w);

  // clearing
  qa(w, '.miniHead button')[0].click();
  await settle(w);
  check('perf: clear empties the slow list', qa(w, '.slow').length === 0);

  // ---- units: a gauge must not be rendered or banded as a duration ----
  const rssNow = rowFor('memory.rss');
  check('perf: a byte gauge is not banded hot', rssNow.querySelector('.n.lead').className.indexOf('bad') === -1, rssNow.querySelector('.n.lead').className);
  check('perf: a byte gauge renders in bytes, not ms', rssNow.textContent.indexOf('MB') !== -1 && rssNow.textContent.indexOf('ms') === -1);
  check('perf: a byte gauge is not claimed as the worst latency', q(w, '#kpis .kpi:nth-child(2) .s').textContent.indexOf('memory.rss') === -1, q(w, '#kpis .kpi:nth-child(2) .s').textContent);
  check('perf: the KPI strip labels the latency scope', q(w, '#kpis .kpi:nth-child(2) .k').textContent.indexOf('latency') !== -1);
  check('perf: hot metrics are counted against timed metrics only', q(w, '#kpis .kpi:nth-child(3) .s').textContent.trim() === 'of 3 timed', q(w, '#kpis .kpi:nth-child(3) .s').textContent);

  // ---- pause ----
  qa(w, '#mainCol .panelHead button')[0].click();
  await settle(w);
  socket.deliver({
    kind: 'metrics', tick: 999, clients: 9, perfSummary: { total: 1, byType: {} },
    metrics: { 'command.run': { count: 1, min: 1, max: 1, avg: 1, p50: 1, p95: 1, p99: 1 } }, series: {},
  });
  await settle(w);
  check('perf: pause freezes the digest tick', q(w, 'footer span:nth-child(2)').textContent === 'tick 13', q(w, 'footer span:nth-child(2)').textContent);

  w.close();
}

// ============================================================ navigation

/**
 * The five navigation capabilities are only reachable if the keys actually send
 * the requests, and if a reply actually moves the caret. Both halves are checked
 * here against the real client shards running in jsdom.
 */
async function testNavigation(): Promise<void> {
  FakeSocket.instances = [];
  // The IDE shell, not the dev panel: `#ta` only exists here.
  const { window: w, socket } = mountPage(renderPyCharmHtml(7310));
  await settle(w);
  socket.deliver({ kind: 'hello', appVersion: '0.7.23', arch: 'x64', os: 'Windows 11' });
  // Without a server-capable language the handlers refuse before sending, which
  // is correct behaviour but would make this test vacuous.
  socket.deliver({
    kind: 'workspace',
    languages: [{ id: 'python', displayName: 'Python', supportsRun: true, hasLsp: true, extensions: ['py'] }],
  });
  await settle(w);

  const ta = q(w, '#ta');
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['Ctrl+B', { key: 'b', ctrlKey: true }, 'definition'],
    ['Alt+F7', { key: 'F7', altKey: true }, 'references'],
    ['Shift+F6', { key: 'F6', shiftKey: true }, 'renameSymbol'],
    ['Alt+Enter', { key: 'Enter', altKey: true }, 'codeAction'],
  ];
  for (const [label, init, kind] of cases) {
    socket.sent.length = 0;
    fire(w, ta, 'keydown', init);
    await settle(w);
    // Shift+F6 opens a dialog first; the request only goes out on submit.
    if (kind === 'renameSymbol') {
      const ok = q(w, '#dlgRoot .dlg-btn.primary') ?? q(w, '#dlgRoot button');
      const input = q(w, '#dlgRoot input');
      if (input) { input.value = 'sum2'; }
      if (ok) { fire(w, ok, 'click'); }
      await settle(w);
    }
    const sent = socket.lastSentOf(kind);
    check(
      `nav: ${label} sends ${kind}`,
      !!sent && sent.language === 'python',
      sent ? `${sent.kind} line=${sent.line}` : 'nothing sent',
    );
  }

  // Ctrl+T is workspace-wide: it opens a query dialog, then sends on submit.
  socket.sent.length = 0;
  fire(w, w.document.body, 'keydown', { key: 't', ctrlKey: true });
  await settle(w);
  const symInput = q(w, '#dlgRoot input');
  const symOk = q(w, '#dlgRoot .dlg-btn.primary') ?? q(w, '#dlgRoot button');
  if (symInput) symInput.value = 'add';
  if (symOk) fire(w, symOk, 'click');
  await settle(w);
  check('nav: Ctrl+T sends workspaceSymbol', !!socket.lastSentOf('workspaceSymbol'), socket.lastSentOf('workspaceSymbol') ? 'sent' : 'nothing sent');

  // A reply must move the caret: that is the whole point of "go to definition".
  socket.sent.length = 0;
  fire(w, ta, 'keydown', { key: 'b', ctrlKey: true });
  await settle(w);
  const def = socket.lastSentOf('definition');
  if (def) {
    socket.deliver({
      kind: 'definitionResult',
      requestId: def.requestId,
      // Line 4 of the sample is `def fib(n):`. Line 2 is blank, and a character
      // offset on an empty line spills into the following newlines - which is
      // correct for the editor and useless for an assertion.
      locations: [{ uri: 'main.py', line: 4, character: 4 }],
    });
    await settle(w);
  }
  // A location in another buffer is applied after the buffer loads (the client
  // waits 260 ms), so this assertion has to outlive that delay.
  await settle(w, 320);
  check('nav: a definition reply moves the caret', (q(w, '#stPos')?.textContent ?? '').indexOf('Ln 5, Col 5') === 0, q(w, '#stPos')?.textContent ?? '?');

  // "unsupported" must not look like "nothing found".
  socket.sent.length = 0;
  fire(w, ta, 'keydown', { key: 'b', ctrlKey: true });
  await settle(w);
  const def2 = socket.lastSentOf('definition');
  if (def2) {
    socket.deliver({ kind: 'definitionResult', requestId: def2.requestId, locations: [], unsupported: 'gopls does not advertise definition' });
    await settle(w);
  }
  const modalText = (q(w, '#dlgRoot')?.textContent ?? '');
  check('nav: unsupported is reported, not shown as empty', modalText.indexOf('gopls does not advertise') >= 0, modalText.slice(0, 60) || '(no dialog)');

  w.close();
}

// =============================================================== run

await testMonitor();
console.log('');
await testPerf();
console.log('');
await testNavigation();

const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
