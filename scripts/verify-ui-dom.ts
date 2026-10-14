/**
 * UI DOM test — mounts the *real* pages in jsdom and drives them.
 *
 * The static checks (`check-ide-html.ts`) prove the markup is self-contained
 * and that the scripts parse; this one proves the page actually works: Vue
 * compiles the in-DOM template, the app mounts, the editor renders the sample,
 * language switching swaps the buffer, and every websocket message the server
 * can send produces the right DOM.
 *
 * The page talks to a fake WebSocket, so no server is needed and the run is
 * deterministic.
 *
 * jsdom lives in the isolated node workspace (like esbuild/postject), never in
 * the project's dependency list. When it is missing the suite reports SKIP and
 * exits 0, so `verify-all` still passes on a clean machine.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-ui-dom.ts
 */
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { renderIdeHtml } from '../src/panel/ide.js';
import { renderPanelHtml } from '../src/panel/ui.js';
import { SAMPLES, LANGUAGES } from '../src/panel/samples.js';

const TOOLS = join('C:', 'Users', '15936', '.workbuddy-ai', 'binaries', 'node', 'workspace');

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

let JSDOM: any;
let VirtualConsole: any;
try {
  const require = createRequire(join(TOOLS, 'package.json'));
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch {
  console.log('SKIP  jsdom not available in the isolated workspace — UI DOM test skipped');
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

// =============================================================== IDE

async function testIde(): Promise<void> {
  FakeSocket.instances = [];
  const html = renderIdeHtml(7310, SAMPLES, LANGUAGES);
  const { window: w, socket } = mountPage(html);
  await settle(w);

  // ---- mount & editor ----
  const ta = q(w, '#code');
  check('IDE: Vue mounts the workspace shell', !!q(w, '#app header') && !!ta);
  const firstPy = SAMPLES.find((s) => s.languageId === 'python');
  check('IDE: the first Python sample is loaded into the buffer', ta.value === (firstPy ? firstPy.code : null));
  check(
    'IDE: gutter renders one row per line',
    qa(w, '.gutter .ln').length === ta.value.split('\n').length,
    `${qa(w, '.gutter .ln').length} rows`,
  );
  const hl = q(w, '#highlight');
  check(
    'IDE: the highlight overlay tokenises Python',
    hl.innerHTML.indexOf('t-kw') !== -1 && hl.innerHTML.indexOf('t-com') !== -1,
    `${hl.innerHTML.length} chars of markup`,
  );
  check('IDE: the app opens a websocket', socket.url.endsWith('/'));
  check('IDE: the connection indicator reports connected', qa(w, '.conn span')[1].textContent === 'connected');

  // ---- typing: model, overlay and gutter all follow ----
  ta.value = 'x = 1  # hello';
  fire(w, ta, 'input');
  await settle(w);
  const hl2 = q(w, '#highlight').innerHTML;
  check('IDE: typing updates the overlay', hl2.indexOf('hello') !== -1 && hl2.indexOf('t-num') !== -1);
  check('IDE: typing updates the gutter', qa(w, '.gutter .ln').length === 1, 'one line');
  check('IDE: the status bar follows the caret', /Ln 1, Col 15/.test(q(w, '#fCursor').textContent), q(w, '#fCursor').textContent);

  // ---- language switch ----
  const langSel = q(w, 'header select');
  langSel.value = 'go';
  fire(w, langSel, 'change');
  await settle(w);
  const goDesc = LANGUAGES.find((l) => l.id === 'go');
  const firstGo = SAMPLES.find((s) => s.languageId === 'go');
  check('IDE: switching to Go swaps the file tab', q(w, '#editorCol .tab').textContent === (goDesc ? goDesc.fileName : ''));
  check('IDE: switching to Go loads a Go sample', ta.value === (firstGo ? firstGo.code : null));
  check('IDE: the Go highlighter is active', q(w, '#highlight').innerHTML.indexOf('t-kw') !== -1);
  check('IDE: Go shows the Test action', qa(w, 'header button').some((b) => b.textContent.indexOf('Test') !== -1));

  // ---- smart indent: Enter after a colon indents ----
  ta.value = 'def f():';
  fire(w, ta, 'input');
  await settle(w);
  ta.selectionStart = ta.value.length;
  ta.selectionEnd = ta.value.length;
  fire(w, ta, 'keydown', { key: 'Enter' });
  await settle(w);
  check('IDE: smart indent after a colon', ta.value === 'def f():\n    ', JSON.stringify(ta.value));

  // ---- back to Python for the message-driven checks ----
  langSel.value = 'python';
  fire(w, langSel, 'change');
  await settle(w);
  ta.value = 'def greet(name):\n    return "hi " + name\n\nprint(greet("world"))\n';
  fire(w, ta, 'input');
  await settle(w);

  // ---- diagnostics ----
  socket.deliver({
    kind: 'diagnostics',
    language: 'python',
    uri: 'file:///main.py',
    items: [
      {
        line: 3,
        character: 6,
        severity: 1,
        severityName: 'error',
        message: 'greet is not defined',
        code: 'reportUndefinedVariable',
      },
    ],
    errors: 1,
    warnings: 0,
    fromLsp: true,
    note: '',
  });
  await settle(w);
  check('IDE: diagnostics switch to the Problems tab', q(w, '#panel-prob') !== null);
  check('IDE: the problem is listed', q(w, '.prob .msg').textContent.indexOf('greet is not defined') !== -1);
  check('IDE: the problems pill counts it', q(w, '#sideCol .pill').textContent === '1');
  check('IDE: the diagnostic line is marked in the gutter', qa(w, '.gutter .ln.err').length === 1);

  // clicking a problem moves the caret to that line
  q(w, '.prob').click();
  await settle(w);
  check('IDE: clicking a problem moves the caret', q(w, '#fCursor').textContent === 'Ln 4, Col 7', q(w, '#fCursor').textContent);

  // ---- run ----
  const runBtn = qa(w, 'header button').find((b) => b.textContent.indexOf('Run') !== -1) as any;
  runBtn.click();
  await settle(w);
  const runMsg = socket.lastSentOf('run');
  check(
    'IDE: Run sends the buffer',
    !!runMsg && runMsg.language === 'python' && String(runMsg.code).indexOf('greet') !== -1,
  );
  check('IDE: Run goes busy', runBtn.textContent === 'Running…');
  socket.deliver({
    kind: 'runResult',
    language: 'python',
    mode: 'run',
    runId: 'r1',
    sessionId: 'ide',
    exitCode: 0,
    signal: null,
    stdout: 'hi world\n',
    stderr: '',
    durationMs: 42,
    timedOut: false,
    logLines: 1,
  });
  await settle(w);
  check('IDE: the run output is rendered', q(w, '#out').textContent.indexOf('hi world') !== -1);
  check('IDE: the meta line reports exit 0', q(w, '#out .meta').textContent.indexOf('exit 0') !== -1);
  check('IDE: the status bar counts the run', q(w, '#fRuns').textContent === 'runs 1');
  check('IDE: Run leaves the busy state', runBtn.textContent === 'Run');

  // ---- completion: typing a dot asks the language server ----
  ta.value = 'x.';
  fire(w, ta, 'input');
  await settle(w);
  const complete = socket.lastSentOf('complete');
  check('IDE: typing a dot requests completions', !!complete && complete.language === 'python', `requestId ${complete ? complete.requestId : '-'}`);
  socket.deliver({
    kind: 'completion',
    language: 'python',
    requestId: complete ? complete.requestId : -1,
    items: [
      { label: 'print(value)', kind: 3, detail: 'builtin' },
      { label: 'property(value)', kind: 10, detail: '' },
    ],
  });
  await settle(w);
  check('IDE: the completion popup opens', q(w, '#completion').classList.contains('open'));
  check('IDE: suggestions are listed', qa(w, '#completion .item').length === 2);
  check('IDE: the first suggestion is selected', q(w, '#completion .item.sel').textContent.indexOf('print') !== -1);

  // a stale response (old requestId) must be ignored
  const before = qa(w, '#completion .item').length;
  socket.deliver({ kind: 'completion', language: 'python', requestId: -999, items: [{ label: 'zzz', kind: 1 }] });
  await settle(w);
  check('IDE: a stale completion response is dropped', qa(w, '#completion .item').length === before);

  // picking the first suggestion inserts its name
  qa(w, '#completion .item')[0].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await settle(w);
  // The typed prefix ("x.") is replaced wholesale — same rule as the pre-Vue page.
  check('IDE: accepting a suggestion replaces the typed prefix', ta.value === 'print', JSON.stringify(ta.value));

  // ---- logs ----
  const logsTab = qa(w, '#sideCol .tab').find((t) => t.textContent.indexOf('Logs') !== -1) as any;
  logsTab.click();
  await settle(w);
  check('IDE: the Logs tab opens', q(w, '#panel-logs') !== null);
  socket.deliver({
    kind: 'log',
    records: [
      {
        id: 'l1',
        ts: Date.now(),
        level: 3,
        levelName: 'WARN',
        component: 'kernel.commands',
        message: 'slow command',
        fields: { ms: 12 },
        traceId: 'abcdef1234567890',
      },
      { id: 'l2', ts: Date.now(), level: 2, levelName: 'INFO', component: 'lsp.pyright', message: 'indexed' },
    ],
  });
  await settle(w);
  const rows = qa(w, '.logrow');
  check('IDE: log records render newest first', rows.length === 2 && rows[0].textContent.indexOf('indexed') !== -1);
  check('IDE: structured fields are shown', rows[1].textContent.indexOf('"ms":12') !== -1);
  const levelSel = q(w, '#sideCol .tabBar select');
  levelSel.value = '4';
  fire(w, levelSel, 'change');
  await settle(w);
  check('IDE: the level filter hides WARN/INFO', qa(w, '.logrow').length === 0, `${qa(w, '.logrow').length} rows at ERROR`);
  levelSel.value = '2';
  fire(w, levelSel, 'change');
  await settle(w);
  check('IDE: relaxing the filter shows them again', qa(w, '.logrow').length === 2);

  // ---- metrics ----
  const perfTab = qa(w, '#sideCol .tab').find((t) => t.textContent.indexOf('Performance') !== -1) as any;
  perfTab.click();
  await settle(w);
  socket.deliver({
    kind: 'metrics',
    tick: 7,
    metrics: {
      'execution.run': { count: 3, p50: 12, p95: 260, p99: 300, min: 5, max: 300, mean: 40 },
      'command.run': { count: 5, p50: 1, p95: 2, p99: 3, min: 0, max: 3, mean: 1 },
    },
    series: { 'execution.run': [1, 2, 3, 4] },
  });
  await settle(w);
  const metricRows = qa(w, '#panel-perf .metric');
  check('IDE: metrics are grouped', metricRows.length === 2, `${metricRows.length} rows`);
  check('IDE: a slow metric is flagged', q(w, '#panel-perf .metric.err') !== null);
  check('IDE: sparklines render bars', qa(w, '#panel-perf svg rect').length === 4, '4 rects for 4 samples');
  check('IDE: the metric text shows percentiles', q(w, '#panel-perf .metric .stat').textContent.indexOf('P95') !== -1);

  w.close();
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

await testIde();
console.log('');
await testMonitor();

const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
