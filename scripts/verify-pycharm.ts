/**
 * PyCharm-style shell — the workspace UI that replaced the old Vue IDE.
 *
 * This is the migrated feature-test set for the workspace page: it proves the
 * page is self-contained (no CDN/network), that its inline script parses and
 * *boots* in a real DOM (jsdom), that the shell renders every region, and that
 * the interactions are wired to the execution plane (Run -> `run`, terminal ->
 * `termExec`, theme toggle, tool-window toggle). It also sanity-checks the
 * Python tokeniser the shell ships.
 *
 * jsdom lives in the isolated node workspace (like esbuild/postject); when it
 * is missing the suite reports SKIP and exits 0.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-pycharm.ts
 */
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderPyCharmHtml, PY_PATTERN } from '../src/panel/pycharm-ui.js';

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
  console.log('SKIP  jsdom not available (isolated workspace or project node_modules) — PyCharm UI test skipped');
  console.log('0/0 checks passed');
  process.exit(0);
}

/**
 * The Tauri host, faked.
 *
 * In a Tauri build the page never opens a WebSocket: it calls
 * `invoke('engine_send', {msg})` on `window.__TAURI_INTERNALS__` (the Rust core
 * relays that to a Node sidecar pipe) and receives replies as `engine_message`
 * events registered through `plugin:event|listen`. This stand-in mirrors that
 * exact surface — including the `transformCallback` id the event plugin needs —
 * so the very same UI behaviour can be asserted on both hosts. That is the
 * evidence that moving the transport did not move the behaviour.
 */
class FakeTauri {
  static invokes: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  static listeners: Record<string, Array<(e: Record<string, unknown>) => void>> = {};
  /** Callback ids handed out by `transformCallback`, so several can coexist. */
  static callbacks = new Map<number, (e: Record<string, unknown>) => void>();

  static install(w: any): void {
    FakeTauri.invokes = [];
    FakeTauri.listeners = {};
    FakeTauri.callbacks = new Map();
    let nextId = 1;
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: Record<string, unknown>) => {
        FakeTauri.invokes.push({ cmd, args });
        // The real event plugin keeps the id alive and invokes it per event.
        if (cmd === 'plugin:event|listen' && typeof args?.handler === 'number') {
          const id = args.handler as number;
          (FakeTauri.listeners[String(args.event)] ??= []).push((e: Record<string, unknown>) => {
            FakeTauri.callbacks.get(id)?.(e);
          });
        }
        return Promise.resolve(null);
      },
      transformCallback: (fn: (e: Record<string, unknown>) => void) => {
        const id = nextId++;
        FakeTauri.callbacks.set(id, fn);
        return id;
      },
    };
  }

  static emit(name: string, payload: unknown): void {
    (FakeTauri.listeners[name] ?? []).forEach((fn) => fn({ payload, event: name, id: 1 }));
  }

  /** The last message of a given kind the page sent, in either host's shape. */
  static sent(kind: string): Record<string, unknown> | undefined {
    for (let i = FakeTauri.invokes.length - 1; i >= 0; i--) {
      const msg = FakeTauri.invokes[i]?.args?.msg as Record<string, unknown> | undefined;
      if (msg && msg.kind === kind) return msg;
    }
    return undefined;
  }
}

// ---------------------------------------------------------- static checks

const html = renderPyCharmHtml(7310);

check('self-contained: no external <script src>', !/<script[^>]+src=/i.test(html));
check('self-contained: no external <link>', !/<link[^>]+href=/i.test(html));
check('self-contained: no @import', !/@import/i.test(html));
check('self-contained: no CDN host', !/(unpkg|jsdelivr|cdnjs|googleapis)/i.test(html));
check('self-contained: no absolute http(s) reference', !/(src|href)=["']https?:/i.test(html));
check('theme: ships Darcula as the default', /data-theme="darcula"/.test(html));
check('theme: ships a Light variant', /\[data-theme="light"\]/.test(html));

// ---- native-app hardening: the browser must not leak native UI -----------
// The Rust shell disables context menus / DevTools / zoom / script dialogs at
// the WebView2 level; these assert the *page* half of the same contract, which
// is what protects the browser-hosted form.
check('hardening: no <form> element', !/<form[\s>]/i.test(html));
check('hardening: no anchor navigation', !/<a\s[^>]*href=/i.test(html));
check('hardening: no file input', !/<input[^>]+type=["']file/i.test(html));
check('hardening: no blob URLs', !/createObjectURL/.test(html));
// The vendored CodeMirror bundle contains its own drag-drop handler; the app
// disables file drops through `allowDropFileTypes: []`. Test the app's own
// script, not the third-party block, or the vendor's string trips a false
// positive.
const appScriptHtml = html.replace(/<script>[\s\S]*?CodeMirror[\s\S]*?<\/script>/, '');
check('hardening: no drag-drop file reads', !/dataTransfer\.files/.test(appScriptHtml));
check('editor: CodeMirror refuses dropped files', /allowDropFileTypes:\s*\[\s*\]/.test(html));
check('editor: ships the vendored CodeMirror', /CodeMirror\.defineMode/.test(html));
check('hardening: script dialogs replaced', /window\.alert\s*=/.test(html) && /window\.confirm\s*=/.test(html));
check('hardening: CSS disables selection outside inputs', /user-select:\s*none/.test(html));
check('hardening: CSS keeps the page from scrolling', /overflow:\s*hidden/.test(html));
check('hardening: Ctrl+wheel zoom blocked', /e\.ctrlKey/.test(html));
// Revealing the hidden window is the Rust shell's job (`on_page_load`); the
// page must not add a second IPC command for it.
check('hardening: page never calls window|show', !/plugin:window\|show/.test(html));
// The code background must be a pure colour: the indent-guide gradient overlay
// was removed on purpose (user request), so it must NOT be present.
check('editor: code background is solid (no indent-guide gradient)',
  !html.includes('repeating-linear-gradient(to right, var(--text-primary)'));
/**
 * The real inline scripts, from a real parser.
 *
 * The page legitimately mentions `<script>` inside CSS and HTML comments (the
 * command palette's usage hint), which a `<script>…</script>` regex happily
 * mistakes for a script element — and then hands a slab of CSS to `eval`.
 * Only an element is a script, so ask the parser.
 */
function scriptBlocks(markup: string): string[] {
  const dom = new JSDOM(markup, { runScripts: 'outside-only' });
  return Array.from(dom.window.document.querySelectorAll('script'))
    .map((s: any) => (s.textContent ?? '') as string)
    .filter((text) => text.trim().length > 0);
}

check('shell: inline script parses', (() => {
  const code = scriptBlocks(html).sort((a, b) => b.length - a.length)[0] ?? '';
  try { new Function(code); return true; } catch { return false; }
})());

// ---------------------------------------------------------- jsdom helpers

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
    setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen({}); }, 0);
  }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; }
  deliver(msg: Record<string, unknown>): void {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
  lastSentOf(kind: string): Record<string, unknown> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].kind === kind) return this.sent[i];
    return undefined;
  }
}

function mountPage(
  markup: string,
  seed?: string,
  bridge: 'ws' | 'tauri' = 'ws',
  url = 'http://localhost/',
): { window: any; socket?: FakeSocket } {
  const vc = new VirtualConsole();
  const dom = new JSDOM(markup, { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc, url });
  const w = dom.window as any;
  if (bridge === 'tauri') FakeTauri.install(w);
  else w.WebSocket = FakeSocket;
  if (seed) { try { w.localStorage.setItem('nolanguage.pycharm.v1', seed); } catch { /* no storage */ } }
  // Read the scripts back out of the parsed document: a regex over the markup
  // would also "find" the `<script>` the page mentions inside a comment.
  const blocks = Array.from(dom.window.document.querySelectorAll('script'))
    .map((s: any) => (s.textContent ?? '') as string)
    .filter((text) => text.trim().length > 0);
  for (const block of blocks) w.eval(block);
  return { window: w, socket: bridge === 'tauri' ? undefined : FakeSocket.instances[FakeSocket.instances.length - 1] };
}
async function settle(w: any, ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => w.setTimeout(r, ms));
}
function q(w: any, sel: string): any { return w.document.querySelector(sel); }
function qa(w: any, sel: string): any[] { return Array.from(w.document.querySelectorAll(sel)) as any[]; }
function fire(w: any, el: any, type: string, init: Record<string, unknown> = {}): Event {
  const Ctor = type === 'click' || type.indexOf('mouse') === 0 || type === 'contextmenu'
    ? w.MouseEvent
    : type === 'keydown' || type === 'keyup' ? w.KeyboardEvent : w.Event;
  const ev = new Ctor(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev as Event;
}

/**
 * Open a document the way a user does: Search Everywhere (the shell has no file
 * picker on purpose). Matches on the exact file name so a symbol row whose path
 * merely contains it is never chosen instead.
 */
function openViaFile(w: any, name: string): boolean {
  q(w, '#searchBtn').click();
  const input = q(w, '#searchInput');
  input.value = name;
  fire(w, input, 'input', {});
  const row = qa(w, '#searchBody .mres').find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === name);
  if (!row) return false;
  row.click();
  return true;
}

// ---------------------------------------------------------- boot & regions

async function testBoot(): Promise<void> {
  FakeSocket.instances = [];
  const { window: w, socket } = mountPage(html);
  await settle(w);

  // The label is the menu's own text node; its dropdown (`.pop`) is a child
  // element whose item text must not be counted as part of the label.
  const menus = qa(w, '#menubar .menu').map((m: any) =>
    Array.from(m.childNodes)
      .filter((n: any) => n.nodeType === 3)
      .map((n: any) => n.textContent)
      .join('')
      .trim(),
  );
  check('boot: menu bar lists the PyCharm menus',
    ['File', 'Edit', 'View', 'Navigate', 'Code', 'Run', 'Tools', 'VCS', 'Window', 'Help'].every((m) => menus.indexOf(m) !== -1),
    menus.join(','));
  check('boot: main toolbar renders the run widget', !!q(w, '#runBtn') && !!q(w, '#projWidget'));
  check('boot: tool strip renders 10 tools + settings', qa(w, '#strip .sbtn').length === 11, `${qa(w, '#strip .sbtn').length} buttons`);
  check('boot: icons are painted as inline SVG', qa(w, '#strip .sbtn svg').length === 11);
  check('boot: editor gutter renders line numbers', qa(w, '#glines .gline').length > 5, `${qa(w, '#glines .gline').length} rows`);
  check('boot: editor loads the main.py sample', (q(w, '#ta')?.value ?? '').indexOf('def fib') !== -1);
  check('boot: three document tabs render', qa(w, '#etabs .etab').length === 3, `${qa(w, '#etabs .etab').length} tabs`);
  check('boot: bottom dock renders 6 tool windows', qa(w, '#dockTabs .dtab').length === 6, `${qa(w, '#dockTabs .dtab').length} tabs`);
  check('boot: status bar shows file + caret + perf cells',
    !!q(w, '#stFile') && !!q(w, '#stPos') && !!q(w, '#stPerf'));
  check('boot: terminal input is present', !!q(w, '#termIn') && !!q(w, '#termOut'));

  // ---- Run is wired to the execution plane ----
  q(w, '#runBtn').click();
  await settle(w);
  const run = socket.lastSentOf('run');
  check('run: toolbar Run sends a `run` message', !!run && run.language === 'python', JSON.stringify(run && { language: run.language }));
  check('run: the run message carries the buffer', typeof (run?.code) === 'string' && (run.code as string).indexOf('def fib') !== -1);

  // ---- editor behaviours: affordances + auto-pair + auto-indent ----
  check('editor: current-line + completion + hover affordances exist',
    !!q(w, '#curline') && !!q(w, '#cmp') && !!q(w, '#hoverTip'));
  const ed = q(w, '#ta') as any;
  ed.value = ''; ed.setSelectionRange(0, 0);
  fire(w, ed, 'keydown', { key: '(' });
  check('editor: a typed bracket auto-closes', ed.value === '()', JSON.stringify(ed.value));
  ed.value = 'if x:'; ed.setSelectionRange(ed.value.length, ed.value.length);
  fire(w, ed, 'keydown', { key: 'Enter' });
  check('editor: Enter after a colon indents the new line',
    ed.value.indexOf('if x:' + String.fromCharCode(10) + '    ') === 0, JSON.stringify(ed.value));
  const scriptText = qa(w, 'script').map((s: any) => (s.textContent || '')).join('');
  check('editor: multi-language rule table ships (LANG_RULES)',
    scriptText.indexOf('LANG_RULES') !== -1 && scriptText.indexOf('markdown') !== -1);

  // ---- completion popup round-trip (debounced request -> popup) ----
  ed.value = 'pri'; ed.setSelectionRange(3, 3);
  fire(w, ed, 'input', {});
  await settle(w, 180);
  const comp = socket.lastSentOf('complete');
  check('editor: typing requests completion from the LSP',
    !!comp && comp.language === 'python' && comp.requestId != null, JSON.stringify(comp && { line: comp.line, character: comp.character }));
  socket.deliver({ kind: 'completion', language: 'python', requestId: comp?.requestId,
    items: [{ label: 'print', kind: 3, detail: 'builtin' }, { label: 'printer', kind: 5 }] });
  await settle(w);
  check('editor: completion response opens a filtered popup',
    q(w, '#cmp').className.indexOf('open') !== -1 && (q(w, '#cmp').textContent || '').indexOf('print') !== -1);

  // ---- L1 · built-in lexical completion (no LSP required) ----
  // The popup must appear from the buffer alone, before any `completion` frame
  // is delivered: that is the whole promise of L1 — it cannot be slow, cold or
  // absent, because it never leaves the page.
  ed.value = 'def calculate_total(items):\n    pass\n\ntotal_price = 1\ntotal_count = 2\ncal';
  ed.setSelectionRange(ed.value.length, ed.value.length);
  fire(w, ed, 'input', {});
  await settle(w, 180);
  const l1Text = q(w, '#cmp').textContent || '';
  const l1Open = q(w, '#cmp').className.indexOf('open') !== -1;
  check('L1: buffer identifiers complete without an LSP answer',
    l1Open && l1Text.indexOf('calculate_total') !== -1, l1Text.slice(0, 70));
  check('L1: the weak classifier marks a called name as a function',
    (qa(w, '#cmp .row .k')[0]?.textContent ?? '') === 'fn', qa(w, '#cmp .row .k')[0]?.textContent);

  const compL1 = socket.lastSentOf('complete');
  socket.deliver({ kind: 'completion', language: 'python', requestId: compL1?.requestId,
    items: [{ label: 'calendar', kind: 9, detail: 'module' }] });
  await settle(w);
  const mergedText = q(w, '#cmp').textContent || '';
  check('L1 + L2: the LSP answer is merged with, not substituted for, the buffer words',
    mergedText.indexOf('calendar') !== -1 && mergedText.indexOf('calculate_total') !== -1,
    mergedText.slice(0, 90));

  // The prefix filter must be case-insensitive, the same rule L1 uses: an LSP
  // that returns `Calendar` for a typed `cal` would otherwise be dropped.
  socket.deliver({ kind: 'completion', language: 'python', requestId: compL1?.requestId,
    items: [{ label: 'Calendar', kind: 9, detail: 'module' }] });
  await settle(w);
  const casedText = q(w, '#cmp').textContent || '';
  check('L1 + L2: the prefix match is case-insensitive (Calendar for cal)',
    casedText.indexOf('Calendar') !== -1, casedText.slice(0, 90));

  // Esc is a real dismissal: a late LSP answer for the same request must not
  // yank the popup back open.
  fire(w, ed, 'keydown', { key: 'Escape' });
  await settle(w);
  check('L2: Esc closes the popup', q(w, '#cmp').className.indexOf('open') === -1, q(w, '#cmp').className);
  socket.deliver({ kind: 'completion', language: 'python', requestId: compL1?.requestId,
    items: [{ label: 'calendar_late', kind: 9 }] });
  await settle(w);
  check('L2: a late answer does not reopen a dismissed popup',
    q(w, '#cmp').className.indexOf('open') === -1, q(w, '#cmp').className);

  // A manifest that says `contributes.completion.lexical.enabled: false`
  // (Markdown) turns the source off; the catalogue is the only channel for it.
  socket.deliver({ kind: 'workspace', languages: [{ id: 'python', displayName: 'Python', lexical: false, supportsRun: true, hasLsp: true }] });
  await settle(w);
  fire(w, ed, 'input', {});
  await settle(w, 180);
  check('L1: a language can opt out through its manifest',
    q(w, '#cmp').className.indexOf('open') === -1,
    q(w, '#cmp').className);
  socket.deliver({ kind: 'workspace', languages: [{ id: 'python', displayName: 'Python', supportsRun: true, hasLsp: true }] });
  await settle(w);

  // ---- hover tooltip round-trip (dwell -> request -> tooltip) ----
  ed.value = 'print'; ed.setSelectionRange(0, 0);
  fire(w, ed, 'mousemove', { clientX: 32, clientY: 20 });
  await settle(w, 520);
  const hov = socket.lastSentOf('hover');
  check('editor: hovering a word requests hover from the LSP',
    !!hov && hov.language === 'python' && hov.requestId != null, JSON.stringify(hov && { line: hov.line, character: hov.character }));
  socket.deliver({ kind: 'hover', language: 'python', requestId: hov?.requestId,
    hover: { contents: { kind: 'plaintext', value: 'built-in print' } } });
  await settle(w);
  check('editor: hover response opens the tooltip',
    q(w, '#hoverTip').className.indexOf('open') !== -1 && (q(w, '#hoverTip').textContent || '').indexOf('print') !== -1);

  // ---- terminal: builtin + backend command ----
  const tin = q(w, '#termIn');
  tin.value = 'help';
  fire(w, tin, 'keydown', { key: 'Enter' });
  await settle(w);
  check('terminal: a builtin (`help`) renders locally', (q(w, '#termOut')?.textContent ?? '').indexOf('Built-ins') !== -1);

  tin.value = 'echo hello-from-terminal';
  fire(w, tin, 'keydown', { key: 'Enter' });
  await settle(w);
  const term = socket.lastSentOf('termExec');
  check('terminal: a shell command is sent as `termExec`', !!term && term.cmd === 'echo hello-from-terminal', JSON.stringify(term));

  // termResult renders back into the terminal
  socket.deliver({ kind: 'termResult', cmd: 'echo hello-from-terminal', stdout: 'hello-from-terminal\n', stderr: '', code: 0, ms: 3 });
  await settle(w);
  check('terminal: termResult stdout is rendered', (q(w, '#termOut')?.textContent ?? '').indexOf('hello-from-terminal') !== -1);

  // ---- theme toggle ----
  check('theme: starts on Darcula', w.document.documentElement.getAttribute('data-theme') === 'darcula');
  q(w, '#themeBtn').click();
  await settle(w);
  check('theme: toggle switches to Light', w.document.documentElement.getAttribute('data-theme') === 'light');

  // ---- persistence (localStorage) ----
  const store = w.localStorage.getItem('nolanguage.pycharm.v1') || '';
  check('persist: theme choice is written to localStorage', store.indexOf('"theme":"light"') !== -1, store);
  check('persist: open tabs are written to localStorage', store.indexOf('"tabs"') !== -1, store);

  // ---- tool-window toggle (Project widget opens the left panel) ----
  const panel = q(w, '#leftPanel');
  check('panel: starts hidden', panel.className.indexOf('hidden') !== -1);
  q(w, '#projWidget').click();
  await settle(w);
  check('panel: Project widget opens the left tool window', panel.className.indexOf('hidden') === -1);
  check('persist: layout is written after a tool-window toggle',
    (w.localStorage.getItem('nolanguage.pycharm.v1') || '').indexOf('"left":"project"') !== -1);
  socket.deliver({ kind: 'fsListing', path: '', entries: [
    { name: 'src', path: 'src', kind: 'dir', size: 0, mtime: 0, editable: false },
    { name: 'main.py', path: 'main.py', kind: 'file', size: 10, mtime: 0, editable: true },
    { name: 'utils.py', path: 'utils.py', kind: 'file', size: 10, mtime: 0, editable: true },
    { name: 'README.md', path: 'README.md', kind: 'file', size: 10, mtime: 0, editable: true },
    { name: 'package.json', path: 'package.json', kind: 'file', size: 10, mtime: 0, editable: true },
  ] });
  await settle(w);
  check('panel: the project tree renders from fsListing', qa(w, '#panelBody .tnode').length > 3, `${qa(w, '#panelBody .tnode').length} nodes`);

  // ---- recent files: File menu -> Open Recent ----
  const fileMenu = qa(w, '#menubar .menu').find((m: any) => (m.textContent || '').indexOf('File') === 0);
  fileMenu.click();
  await settle(w);
  const recentBtn = qa(w, '#menubar .menu.open .item').find((b: any) => (b.textContent || '').indexOf('Open Recent') !== -1);
  check('recent: File menu exposes Open Recent', !!recentBtn);
  recentBtn.click();
  await settle(w);
  check('recent: Open Recent opens the modal', q(w, '#recentModal').className.indexOf('open') !== -1);
  check('recent: opening a file populates the recent list',
    (w.localStorage.getItem('nolanguage.pycharm.v1') || '').indexOf('"recent"') !== -1);

  w.close();
}

// ---------------------------------------------------------- JavaScript

// The shell has no language picker on purpose: a document's language follows its
// file extension, which is what the token table is keyed by. So "switch to
// JavaScript" means opening `main.js` — this drives the real user path (Search
// Everywhere) and then checks the three things that must follow: highlighting,
// the status bar, and the language sent to the execution plane.
async function testJavaScript(): Promise<void> {
  FakeSocket.instances = [];
  const { window: w, socket } = mountPage(html);
  await settle(w);

  check('js: Search Everywhere finds main.js', openViaFile(w, 'main.js'));
  await settle(w);

  check('js: opening main.js switches the active document',
    q(w, '#stFile')?.textContent === 'main.js' && q(w, '#etabs .etab.active .nm')?.textContent === 'main.js',
    String(q(w, '#stFile')?.textContent));
  const src: string = q(w, '#ta')?.value ?? '';
  check('js: the editor holds the JavaScript sample', /const nums/.test(src), src.split('\n')[0] ?? '');

  // ---- syntax highlighting: the token classes the shell colours ----
  const tok = (cls: string) => qa(w, `#hlCode .tok-${cls}`).length;
  const tokText = (cls: string) => qa(w, `#hlCode .tok-${cls}`).map((s: any) => s.textContent);
  check('js: keywords are tokenised', tok('k') > 0, `${tok('k')} keyword(s)`);
  check('js: the keyword set is JavaScript\'s', tokText('k').indexOf('const') !== -1, tokText('k').slice(0, 6).join(','));
  check('js: builtins are tokenised', tokText('b').indexOf('console') !== -1, tokText('b').slice(0, 6).join(','));
  check('js: strings are tokenised', tok('s') > 0, `${tok('s')} string(s)`);
  check('js: numbers are tokenised', tok('n') > 0, `${tok('n')} number(s)`);
  check('js: call names are tokenised', tokText('f').indexOf('sum') !== -1, tokText('f').slice(0, 6).join(','));
  check('js: comments are tokenised', tok('c') > 0, `${tok('c')} comment(s)`);
  check('js: highlighting emits real spans',
    q(w, '#hlCode')?.innerHTML.length > src.length,
    `${q(w, '#hlCode')?.innerHTML.length} markup chars for ${src.length} source chars`);

  // ---- Run / Check follow the file, not a picker ----
  const onOpen = socket.lastSentOf('check');
  check('js: opening the file asks the backend to check it as javascript',
    !!onOpen && onOpen.language === 'javascript', JSON.stringify(onOpen && { language: onOpen.language }));

  q(w, '#runBtn').click();
  await settle(w);
  const run = socket.lastSentOf('run');
  check('js: Run sends the run message as javascript',
    !!run && run.language === 'javascript', JSON.stringify(run && { language: run.language }));
  check('js: the run message carries the buffer',
    typeof run?.code === 'string' && (run.code as string).indexOf('const nums') !== -1);

  socket.deliver({ kind: 'runOut', stream: 'stdout', text: 'fresh context: runs visible = 1\n' });
  socket.deliver({ kind: 'runResult', language: 'javascript', mode: 'run', runId: 'r-js', sessionId: 'pycharm',
    exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 12, timedOut: false, logLines: 1, binary: 'node' });
  await settle(w);
  const out = q(w, '#runOut')?.textContent ?? '';
  check('js: the run output renders into the Run tool window',
    out.indexOf('runs visible = 1') !== -1 && out.indexOf('exit code 0') !== -1, out.replace(/\s+/g, ' ').trim().slice(0, 90));

  w.close();
}

// ---------------------------------------------------------- tauri bridge

// The same page on the other host. What must be true here and is *not* true of
// the WebSocket build: no socket is opened at all (no port to collide with), the
// handshake and every message travel as `invoke('engine_send')`, replies arrive
// as events, and an engine that disappears is reported rather than ignored.
async function testTauriBridge(): Promise<void> {
  FakeSocket.instances = [];
  const { window: w } = mountPage(html, undefined, 'tauri');
  await settle(w);

  check('tauri: no WebSocket is opened at all', FakeSocket.instances.length === 0, String(FakeSocket.instances.length));
  check('tauri: every message is an engine_send invoke',
    FakeTauri.invokes.length > 0 &&
    FakeTauri.invokes.every((i) => i.cmd === 'engine_send' || i.cmd === 'plugin:event|listen' || /^plugin:window\|/.test(i.cmd)),
    FakeTauri.invokes.map((i) => (i.cmd === 'engine_send' ? String(i.args?.msg?.kind) : i.cmd)).join(','));
  check('tauri: the handshake reaches the engine over IPC', !!FakeTauri.sent('listExtensions'));

  // ---- title bar: the OS chrome is off, so the shell owns the buttons ----
  // The buttons used to call window.__TAURI__.window.getCurrentWindow(), which
  // does not exist on this page (no @tauri-apps/api bundle) — so no handler was
  // ever attached and every click did nothing. They now go through the
  // internals, the same global the transport bridge uses.
  fire(w, q(w, '#tbMin'), 'click', {});
  fire(w, q(w, '#tbMax'), 'click', {});
  fire(w, q(w, '#tbClose'), 'click', {});
  await settle(w);
  const cmds = FakeTauri.invokes.map((i) => i.cmd);
  check('tauri: minimize reaches the window plugin',
    cmds.indexOf('plugin:window|minimize') !== -1, cmds.join(','));
  check('tauri: toggle_maximize reaches the window plugin',
    cmds.indexOf('plugin:window|toggle_maximize') !== -1, cmds.join(','));
  check('tauri: close reaches the window plugin',
    cmds.indexOf('plugin:window|close') !== -1, cmds.join(','));
  check('tauri: the title bar marks the document as a Tauri window',
    q(w, 'html').getAttribute('data-tauri') === '1', String(q(w, 'html').getAttribute('data-tauri')));

  // Dragging the bar moves the window (WebView2 ignores -webkit-app-region,
  // which is what the Edge --app build uses), but a press on a button must not.
  fire(w, q(w, '.titlebar .tb-spacer'), 'mousedown', { button: 0 });
  await settle(w);
  const drags = FakeTauri.invokes.filter((i) => i.cmd === 'plugin:window|start_dragging').length;
  check('tauri: dragging the title bar asks the window to move', drags === 1, String(drags));
  fire(w, q(w, '#tbClose'), 'mousedown', { button: 0 });
  await settle(w);
  check('tauri: a press on a button does not start a drag',
    FakeTauri.invokes.filter((i) => i.cmd === 'plugin:window|start_dragging').length === 1,
    String(FakeTauri.invokes.filter((i) => i.cmd === 'plugin:window|start_dragging').length));

  // Engine → UI is an event, not a frame.
  FakeTauri.emit('engine_message', {
    kind: 'fsListing', path: '',
    entries: [{ name: 'app.py', path: 'app.py', kind: 'file', editable: true }],
  });
  await settle(w);
  check('tauri: an engine event renders the project tree',
    qa(w, '#ptree .tnode.file').some((r: any) => (r.textContent ?? '').indexOf('app.py') !== -1),
    qa(w, '#ptree .tnode.file').map((r: any) => r.textContent).join(','));

  check('tauri: opened main.js', openViaFile(w, 'main.js'));
  await settle(w);
  q(w, '#runBtn').click();
  await settle(w);
  // main.js is the active document, so the run follows its file type.
  check('tauri: Run sends the run message over IPC', FakeTauri.sent('run')?.language === 'javascript', String(FakeTauri.sent('run')?.language));
  check('tauri: the run message carries the buffer', String(FakeTauri.sent('run')?.code ?? '').indexOf('const nums') !== -1);

  FakeTauri.emit('engine_message', { kind: 'runOut', stream: 'stdout', text: 'hello 55\n' });
  FakeTauri.emit('engine_message', {
    kind: 'runResult', language: 'python', mode: 'run', runId: 'r-1', sessionId: 'pycharm',
    exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 3, timedOut: false, logLines: 1, binary: 'python',
  });
  await settle(w);
  check('tauri: engine output renders in the Run tool window',
    (q(w, '#runOut')?.textContent ?? '').indexOf('hello 55') !== -1,
    (q(w, '#runOut')?.textContent ?? '').trim().slice(0, 40));

  // The features added on the ws host keep working here, unchanged.
  q(w, '#stLang').click();
  await settle(w);
  qa(w, '#langBody .mres').find((r: any) => r.getAttribute('data-lang') === 'javascript')?.click();
  await settle(w);
  check('tauri: an explicit language switch reaches the engine',
    FakeTauri.sent('check')?.language === 'javascript', String(FakeTauri.sent('check')?.language));
  q(w, '#runBtn').click();
  await settle(w);
  check('tauri: Run follows the language the user chose', FakeTauri.sent('run')?.language === 'javascript', String(FakeTauri.sent('run')?.language));

  fire(w, q(w, '#gutter'), 'contextmenu', { clientX: 10, clientY: 10, button: 2 });
  await settle(w);
  check('tauri: the context menu still works on this host', q(w, '#ctxMenu').classList.contains('open'));

  FakeTauri.emit('engine_exit', { code: null });
  await settle(w);
  check('tauri: a vanished engine is reported, not silent',
    /Workspace disconnected/.test(q(w, '#toast')?.textContent ?? ''), (q(w, '#toast')?.textContent ?? '').trim());

  const stored = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('tauri: the language override still persists locally',
    stored.langs?.['main.js'] === 'javascript', JSON.stringify(stored.langs));

  w.close();
}

// ---------------------------------------------------------- context menus

// Right-click must never surface the browser's own menu (its only useful entry
// on this page is a page Reload). Every region gets a PyCharm-style menu: the
// editor, the tab bar, the bottom dock, the left tool windows, and the project
// tree — which keeps its own, more specific one.
async function testContextMenus(): Promise<void> {
  FakeSocket.instances = [];
  const { window: w, socket } = mountPage(html);
  await settle(w);

  const menu = () => q(w, '#ctxMenu');
  const isOpen = () => menu().classList.contains('open');
  const labels = () => qa(w, '#ctxMenu .citem .clbl').map((e: any) => e.textContent);
  const item = (label: string) => qa(w, '#ctxMenu .citem').find((e: any) => (e.querySelector('.clbl')?.textContent ?? '') === label);
  const ctx = (el: any, x = 400, y = 300) => fire(w, el, 'contextmenu', { clientX: x, clientY: y, button: 2 });
  const ta = () => q(w, '#ta');
  const same = (want: string[]) => JSON.stringify(labels()) === JSON.stringify(want);

  // ---- the editor ----
  ctx(q(w, '#gutter'));
  await settle(w);
  check('ctx: the editor shows a menu on right-click', isOpen());
  check('ctx: the editor menu is PyCharm\'s',
    same(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Delete', 'Select All', 'Change Language Mode…']), labels().join(' / '));
  check('ctx: the editor menu shows shortcuts',
    qa(w, '#ctxMenu .citem .csc').map((e: any) => e.textContent).join(',').indexOf('Ctrl+Z') !== -1,
    qa(w, '#ctxMenu .citem .csc').map((e: any) => e.textContent).join(','));
  check('ctx: the editor menu groups its items', qa(w, '#ctxMenu .csep').length === 2, String(qa(w, '#ctxMenu .csep').length));
  check('ctx: no menu offers a page reload', labels().every((l: string) => !/refresh|reload|重新/i.test(l)), labels().join(' / '));

  // the editing items act on the buffer
  const size = ta().value.length;
  item('Select All').click();
  await settle(w);
  check('ctx: Select All selects the whole buffer',
    ta().selectionEnd - ta().selectionStart === size, `${ta().selectionEnd - ta().selectionStart} of ${size}`);
  item('Delete').click();
  await settle(w);
  check('ctx: Delete removes the selection', ta().value.length === 0 && ta().selectionStart === 0, JSON.stringify(ta().value));

  let copied = '';
  Object.defineProperty(w.navigator, 'clipboard', {
    value: { readText: () => Promise.resolve('PASTED'), writeText: (t: string) => { copied = t; return Promise.resolve(); } },
    configurable: true,
  });
  item('Paste').click();
  await settle(w, 40);
  check('ctx: Paste inserts at the caret', ta().value === 'PASTED', JSON.stringify(ta().value));

  // Undo / Redo / Copy are the browser's editing commands (jsdom has none).
  const execd: string[] = [];
  Object.defineProperty(w.document, 'execCommand', { value: (c: string) => { execd.push(c); return true; }, configurable: true });
  for (const [label, want] of [['Undo', 'undo'], ['Redo', 'redo'], ['Copy', 'copy']] as [string, string][]) {
    ctx(ta());
    await settle(w);
    item(label).click();
    await settle(w);
    check(`ctx: ${label} issues the ${want} command`, execd.indexOf(want) !== -1, execd.join(','));
  }

  // a right-click near the edge must not open the menu off-screen
  ctx(q(w, '#gutter'), 100000, 100000);
  await settle(w);
  const left = parseInt(menu().style.left, 10), top = parseInt(menu().style.top, 10);
  check('ctx: the menu stays inside the viewport',
    left >= 6 && left <= w.innerWidth - 200 && top >= 6 && top <= w.innerHeight - 100, `${left},${top} in ${w.innerWidth}x${w.innerHeight}`);

  // ---- the tab bar ----
  const tabs = () => qa(w, '#etabs .etab');
  const tabWith = (name: string) => tabs().find((t: any) => (t.textContent ?? '').indexOf(name) !== -1);
  ctx(tabWith('main.py')!);
  await settle(w);
  check('ctx: the tab bar shows a menu on right-click', isOpen());
  check('ctx: the tab menu is PyCharm\'s', same(['Close', 'Close Others', 'Close All']), labels().join(' / '));
  item('Close Others').click();
  await settle(w);
  check('ctx: Close Others leaves only that tab',
    tabs().length === 1 && (tabs()[0].textContent ?? '').indexOf('main.py') !== -1,
    tabs().map((t: any) => t.textContent).join(','));
  ctx(tabs()[0]);
  await settle(w);
  item('Close').click();
  await settle(w);
  check('ctx: Close closes the tab', tabs().length === 0, String(tabs().length));
  check('ctx: with no document the language cell says so',
    /No file/.test(q(w, '#stLang')?.textContent ?? ''), (q(w, '#stLang')?.textContent ?? '').trim());
  ctx(q(w, '#gutter'));
  await settle(w);
  check('ctx: with no document every editor item is disabled',
    qa(w, '#ctxMenu .citem').every((e: any) => e.classList.contains('dis')), labels().join(' / '));

  // ---- the dock ----
  check('ctx: reopened main.py', openViaFile(w, 'main.py'));
  await settle(w);
  q(w, '#runBtn').click();
  await settle(w);
  socket.deliver({ kind: 'runOut', stream: 'stdout', text: 'console line\n' });
  await settle(w);
  ctx(q(w, '#dockBody'));
  await settle(w);
  check('ctx: the dock shows a menu on right-click', isOpen());
  check('ctx: the dock menu is PyCharm\'s console menu', same(['Copy', 'Clear Buffer']), labels().join(' / '));
  item('Clear Buffer').click();
  await settle(w);
  check('ctx: Clear Buffer empties the console',
    (q(w, '#runOut')?.textContent ?? '').indexOf('console line') === -1, (q(w, '#runOut')?.textContent ?? '').trim().slice(0, 40));

  // ---- the left tool windows ----
  const stripBtn = (title: string) => qa(w, '#strip .sbtn').find((b: any) => (b.title ?? '').indexOf(title) === 0);
  stripBtn('Structure').click();
  await settle(w);
  ctx(q(w, '#panelBody'));
  await settle(w);
  check('ctx: a read-only tool window shows no menu', !isOpen());
  stripBtn('Project').click();
  await settle(w);
  ctx(q(w, '#panelBody'));
  await settle(w);
  check('ctx: the project tool window shows a menu', isOpen());
  check('ctx: the project menu offers the basics',
    labels().indexOf('New') !== -1 && labels().indexOf('Collapse All') !== -1, labels().join(' / '));

  // ---- the project tree keeps its own, more specific menu ----
  socket.deliver({ kind: 'fsListing', path: '', entries: [{ name: 'main.py', path: 'main.py', kind: 'file', editable: true }] });
  await settle(w);
  const row = qa(w, '#ptree .tnode.file').find((r: any) => (r.textContent ?? '').indexOf('main.py') !== -1);
  ctx(row!, 200, 200);
  await settle(w);
  check('ctx: the project tree keeps its own menu',
    labels().indexOf('New') !== -1 && labels().indexOf('Copy Path') !== -1 && labels().indexOf('Rename…') !== -1,
    labels().join(' / '));
  item('Copy Path').click();
  await settle(w, 40);
  check('ctx: Copy Path copies the relative path', copied === 'main.py', copied);

  // ---- closing and not touching inputs ----
  ctx(q(w, '#gutter'), 300, 300);
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'Escape' });
  await settle(w);
  check('ctx: Escape closes the menu', !isOpen());
  const ev = fire(w, q(w, '#searchInput'), 'contextmenu', { clientX: 5, clientY: 5, button: 2 });
  check('ctx: an input keeps the native clipboard menu', !ev.defaultPrevented && !isOpen());

  w.close();
}

// ---------------------------------------------------------- language mode

// Two rules, one control: a document's language is its file type by default,
// and the user can override it explicitly. The override has to be visible
// (status bar), reversible (the "Auto" row), scoped to its own document, and
// carried back with the session — all four are behaviour, so all four are here.
async function testLanguageSwitch(): Promise<void> {
  FakeSocket.instances = [];
  const { window: w, socket } = mountPage(html);
  await settle(w);

  check('lang: opened main.js', openViaFile(w, 'main.js'));
  await settle(w);

  const stLang = () => (q(w, '#stLang')?.textContent ?? '').trim();
  const rows = () => qa(w, '#langBody .mres');
  const rowOf = (id: string) => rows().find((r: any) => (r.getAttribute('data-lang') ?? '') === id);
  const hintOf = (id: string) => (rowOf(id)?.querySelector('.path')?.textContent ?? '');
  const tokK = () => qa(w, '#hlCode .tok-k').map((s: any) => s.textContent);
  const overrides = () => (JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}').langs || {});
  const pick = async (id: string) => {
    q(w, '#stLang').click();
    await settle(w);
    rowOf(id)?.click();
    await settle(w);
  };

  // ---- default: the file type decides ----
  check('lang: the status bar reads the language from the file type', stLang() === 'JavaScript', stLang());
  check('lang: the default is not labelled manual', stLang().indexOf('manual') === -1);
  check('lang: the cell explains where the language came from',
    /main\.js/.test(q(w, '#stLang')?.getAttribute('title') ?? ''), (q(w, '#stLang')?.getAttribute('title') ?? '').slice(0, 52));

  // ---- the picker ----
  q(w, '#stLang').click();
  await settle(w);
  check('lang: clicking the cell opens the picker', q(w, '#langModal').classList.contains('open'));
  check('lang: the picker offers the file-type default first',
    (rows()[0]?.querySelector('.nm')?.textContent ?? '') === 'Auto — JavaScript', rows()[0]?.querySelector('.nm')?.textContent ?? '');
  const ids = rows().map((r: any) => r.getAttribute('data-lang'));
  check('lang: every runnable language is listed',
    ['python', 'go', 'javascript'].every((l) => ids.indexOf(l) !== -1), ids.join(','));
  check('lang: only languages the tokeniser can colour are listed',
    ids.indexOf('sql') === -1 && ids.indexOf('text') === -1, ids.join(','));
  check('lang: the active choice is marked',
    qa(w, '#langBody .mres.sel').length === 1 && rowOf('')?.classList.contains('sel'),
    qa(w, '#langBody .mres.sel').map((r: any) => r.getAttribute('data-lang')).join(','));
  check('lang: runnable languages say what they support', hintOf('python') === 'run · check', hintOf('python'));
  check('lang: highlight-only languages say so', hintOf('css') === 'highlight only', hintOf('css'));

  const inp = q(w, '#langInput');
  inp.value = 'py';
  fire(w, inp, 'input', {});
  await settle(w);
  const filtered = rows().map((r: any) => r.getAttribute('data-lang'));
  check('lang: typing filters the list', filtered.indexOf('python') !== -1 && filtered.indexOf('css') === -1, filtered.join(','));
  inp.value = '';
  fire(w, inp, 'input', {});
  await settle(w);

  // ---- explicit override ----
  rowOf('python')?.click();
  await settle(w);
  check('lang: picking a language closes the picker', !q(w, '#langModal').classList.contains('open'));
  check('lang: the status bar shows the override', stLang() === 'Python · manual', stLang());
  check('lang: the override is explained in the tooltip',
    /set manually/.test(q(w, '#stLang')?.getAttribute('title') ?? ''), (q(w, '#stLang')?.getAttribute('title') ?? '').slice(0, 46));
  check('lang: the override re-tokenises the buffer', tokK().indexOf('const') === -1, tokK().slice(0, 6).join(','));
  q(w, '#runBtn').click();
  await settle(w);
  check('lang: Run follows the override, not the extension',
    socket.lastSentOf('run')?.language === 'python', String(socket.lastSentOf('run')?.language));
  check('lang: the override is persisted', overrides()['main.js'] === 'python', JSON.stringify(overrides()));

  // A switch can move the document on while a check is still in flight.
  socket.deliver({ kind: 'diagnostics', language: 'python', items: [{ line: 0, character: 0, severity: 1, message: 'python problem' }] });
  await settle(w);
  check('lang: diagnostics for the active language render',
    (q(w, '#probOut')?.textContent ?? '').indexOf('python problem') !== -1,
    (q(w, '#probOut')?.textContent ?? '').trim().slice(0, 40));
  socket.deliver({ kind: 'diagnostics', language: 'javascript', items: [{ line: 0, character: 0, severity: 1, message: 'stale js problem' }] });
  await settle(w);
  check('lang: diagnostics from the language the document left behind are ignored',
    (q(w, '#probOut')?.textContent ?? '').indexOf('stale js problem') === -1,
    (q(w, '#probOut')?.textContent ?? '').trim().slice(0, 40));

  // ---- L0: the same diagnostics reach the editor, not just the panel ----
  const glineAt = (i: number) => qa(w, '#glines .gline')[i];
  check('diag: an error tints its gutter line',
    /haserr/.test(glineAt(0)?.className ?? ''), String(glineAt(0)?.className ?? ''));
  socket.deliver({ kind: 'diagnostics', language: 'python', items: [{ line: 1, character: 0, severity: 2, message: 'heads up' }] });
  await settle(w);
  check('diag: a warning uses its own tint',
    /haswarn/.test(glineAt(1)?.className ?? '') && !/haserr/.test(glineAt(1)?.className ?? ''),
    String(glineAt(1)?.className ?? ''));
  check('diag: an info diagnostic is tinted too',
    (() => { socket.deliver({ kind: 'diagnostics', language: 'python', items: [{ line: 2, character: 0, severity: 3, message: 'fyi' }] }); return /hasinfo/.test(glineAt(2)?.className ?? ''); })(),
    String(glineAt(2)?.className ?? ''));

  // A Problems row is a navigation shortcut: clicking it puts the caret there.
  // Line 2 of the JS sample is blank, so ask for column 0 and expect line 3.
  socket.deliver({ kind: 'diagnostics', language: 'python', items: [{ line: 2, character: 0, severity: 1, message: 'jump target' }] });
  await settle(w);
  const probRow = qa(w, '#probOut .prob')[0];
  check('diag: a problem row is addressable for jumping', !!probRow && probRow.getAttribute('data-pi') === '0',
    String(probRow && probRow.getAttribute('data-pi')));
  probRow?.click();
  await settle(w);
  check('diag: clicking a problem row moves the caret to its line',
    (q(w, '#stPos')?.textContent ?? '').indexOf('Ln 3') !== -1,
    (q(w, '#stPos')?.textContent ?? '').trim());

  // L1: check as you type — an edit schedules a check instead of waiting for
  // the manual button.
  const checksBefore = socket.sent.filter((m: any) => m.kind === 'check').length;
  const ta = q(w, '#ta');
  ta.value = 'x = undeclared_var\n';
  fire(w, ta, 'input', {});
  check('diag: an edit does not check synchronously',
    socket.sent.filter((m: any) => m.kind === 'check').length === checksBefore,
    `${socket.sent.filter((m: any) => m.kind === 'check').length - checksBefore} sent`);
  await settle(w, 360);
  const lastCheck = socket.lastSentOf('check');
  check('diag: an edit schedules a debounced check',
    !!lastCheck && (lastCheck.code as string).indexOf('undeclared_var') !== -1 && lastCheck.language === 'python',
    JSON.stringify(lastCheck && { language: lastCheck.language, code: String(lastCheck.code).slice(0, 24) }));

  // L3: saving re-checks and reports errors once, with a way to open the panel.
  // Save has no button of its own — it is Ctrl+S (or the File menu).
  socket.deliver({ kind: 'diagnostics', language: 'python', items: [{ line: 0, character: 0, severity: 1, message: 'still broken' }] });
  await settle(w);
  q(w, '#ta').value = 'y = 1\n';
  fire(w, q(w, '#ta'), 'input', {});
  await settle(w, 360);
  fire(w, w.document, 'keydown', { key: 's', ctrlKey: true });
  await settle(w, 360);
  socket.deliver({ kind: 'diagnostics', language: 'python', items: [{ line: 0, character: 0, severity: 1, message: 'still broken' }] });
  await settle(w);
  check('diag: saving with errors raises a balloon that offers the panel',
    (q(w, '#balloons')?.textContent ?? '').indexOf('syntax error') !== -1 &&
    (q(w, '#balloons')?.textContent ?? '').indexOf('Show') !== -1,
    `writes=${socket.sent.filter((m: any) => m.kind === 'fsWrite').length} · ${(q(w, '#balloons')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 70)}`);
  // A clean document must not claim problems it does not have.
  socket.deliver({ kind: 'diagnostics', language: 'python', items: [] });
  await settle(w);
  check('diag: a clean answer clears the gutter tint',
    !/haserr|haswarn|hasinfo/.test(glineAt(0)?.className ?? '') &&
    (q(w, '#probOut')?.textContent ?? '').indexOf('No problems') !== -1,
    String(glineAt(0)?.className ?? ''));

  // ---- scoped to its own document ----
  check('lang: opened main.py', openViaFile(w, 'main.py'));
  await settle(w);
  check('lang: another document keeps its own language', stLang() === 'Python', stLang());
  check('lang: the override did not leak to the other document',
    overrides()['main.js'] === 'python' && !overrides()['main.py'], JSON.stringify(overrides()));
  check('lang: reopening the overridden file restores its override', openViaFile(w, 'main.js'));
  await settle(w);
  check('lang: the override survives a document round-trip', stLang() === 'Python · manual', stLang());

  // ---- reversible ----
  await pick('');
  check('lang: the Auto row goes back to the file type', stLang() === 'JavaScript', stLang());
  check('lang: Auto drops the stored override', overrides()['main.js'] === undefined, JSON.stringify(overrides()));
  check('lang: Auto re-tokenises back to JavaScript', tokK().indexOf('const') !== -1, tokK().slice(0, 6).join(','));

  // ---- a language with no runner ----
  await pick('css');
  const runsBefore = socket.sent.filter((m: any) => m.kind === 'run').length;
  q(w, '#runBtn').click();
  await settle(w);
  check('lang: Run refuses a language with no runner',
    socket.sent.filter((m: any) => m.kind === 'run').length === runsBefore &&
    /only Python \/ Go \/ JavaScript/.test(q(w, '#toast')?.textContent ?? ''),
    (q(w, '#toast')?.textContent ?? '').trim());
  check('lang: a highlight-only switch clears the previous language\'s problems',
    (q(w, '#probOut')?.textContent ?? '').indexOf('No problems') !== -1 &&
    (q(w, '#probOut')?.textContent ?? '').indexOf('python problem') === -1,
    (q(w, '#probOut')?.textContent ?? '').trim().slice(0, 40));

  // ---- the other entry points ----
  q(w, '#stLang').click();
  await settle(w);
  fire(w, q(w, '#langInput'), 'keydown', { key: 'Escape' });
  await settle(w);
  check('lang: Escape closes the picker', !q(w, '#langModal').classList.contains('open'));
  q(w, '#searchBtn').click();
  const si = q(w, '#searchInput');
  si.value = 'language';
  fire(w, si, 'input', {});
  await settle(w);
  check('lang: the picker is reachable from Search Everywhere\'s actions',
    qa(w, '#searchBody .mres').some((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'Change Language Mode'),
    qa(w, '#searchBody .mres .nm').map((n: any) => n.textContent).slice(0, 4).join(','));

  w.close();
}

// A language override is part of the session, so it must come back with the tabs.
async function testLanguageRestore(): Promise<void> {
  FakeSocket.instances = [];
  const seed = JSON.stringify({
    theme: 'darcula',
    tabs: ['main.js'],
    current: 'main.js',
    langs: { 'main.js': 'python' },
  });
  const { window: w, socket } = mountPage(html, seed);
  await settle(w);

  check('lang: a restored session applies the stored override',
    (q(w, '#stLang')?.textContent ?? '').trim() === 'Python · manual', (q(w, '#stLang')?.textContent ?? '').trim());
  check('lang: the restored language drives the tokeniser',
    qa(w, '#hlCode .tok-k').map((s: any) => s.textContent).indexOf('const') === -1);
  q(w, '#runBtn').click();
  await settle(w);
  check('lang: the restored language drives Run',
    socket.lastSentOf('run')?.language === 'python', String(socket.lastSentOf('run')?.language));

  w.close();
}

// ---------------------------------------------------------- restore

// The save path is proven above; this proves the *other* half of the round-trip.
// A fresh page is mounted with a `localStorage` blob seeded the way the save path
// writes it, and the shell must rehydrate theme, tabs, current file, layout and
// recents before the first paint — including re-showing a panel that was left
// visible (the bootstrap markup ships every panel hidden).
function testRestore(): void {
  const seed = JSON.stringify({
    theme: 'light',
    tabs: ['utils.py', 'main.py'],
    current: 'utils.py',
    left: 'structure',
    bottom: 'problems',
    leftHidden: false,
    bottomHidden: true,
    recent: ['utils.py', 'main.py'],
  });
  FakeSocket.instances = [];
  const { window: w } = mountPage(html, seed);

  check('restore: persisted theme is applied on boot',
    w.document.documentElement.getAttribute('data-theme') === 'light',
    String(w.document.documentElement.getAttribute('data-theme')));

  const names = qa(w, '#etabs .etab .nm').map((n: any) => (n.textContent || '').trim());
  check('restore: persisted tabs are re-opened (not the defaults)',
    names.length === 2 && names.indexOf('utils.py') !== -1 && names.indexOf('main.py') !== -1,
    names.join(','));

  const active = q(w, '#etabs .etab.active .nm');
  check('restore: persisted current file becomes the active tab',
    !!active && (active.textContent || '').trim() === 'utils.py',
    active ? (active.textContent || '').trim() : 'none');
  check('restore: the editor loads the restored file',
    (q(w, '#ta').value || '').length > 0 && (q(w, '#stFile')?.textContent ?? '').indexOf('utils.py') !== -1,
    (q(w, '#stFile')?.textContent ?? '').trim());

  check('restore: the persisted tool window is selected',
    q(w, '#panelTitle')?.textContent === 'Structure', String(q(w, '#panelTitle')?.textContent));
  check('restore: a visible left panel is un-hidden on boot',
    q(w, '#leftPanel').className.indexOf('hidden') === -1, q(w, '#leftPanel').className);
  check('restore: a collapsed bottom dock stays hidden',
    q(w, '#dock').className.indexOf('hidden') !== -1, q(w, '#dock').className);

  const kept = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('restore: recents survive the round-trip',
    Array.isArray(kept.recent) && kept.recent[0] === 'utils.py' && kept.recent.length === 2,
    JSON.stringify(kept.recent));

  // Re-saving after restore must not silently drop the restored fields.
  q(w, '#themeBtn').click();
  const after = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('restore: a later save preserves restored tabs + recents',
    after.theme === 'darcula' && Array.isArray(after.tabs) && after.tabs.length === 2 &&
    Array.isArray(after.recent) && after.recent[0] === 'utils.py',
    JSON.stringify({ theme: after.theme, tabs: after.tabs, recent: after.recent }));

  w.close();
}

// ---------------------------------------------------------- tokeniser

function testTokens(): void {
  const re = new RegExp(PY_PATTERN, 'g');
  const sample = 'x = "hi"  # note\nif x >= 2:\n    print(x)\n';
  const groups: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sample))) {
    for (let g = 1; g <= 8; g++) if (m[g] != null) groups.push(g);
    if (m[0].length === 0) re.lastIndex++;
  }
  check('tokens: comment captured (group 1)', groups.indexOf(1) !== -1);
  check('tokens: string captured (group 2)', groups.indexOf(2) !== -1);
  check('tokens: keyword captured (group 4)', groups.indexOf(4) !== -1);
  check('tokens: number captured (group 5)', groups.indexOf(5) !== -1);
  check('tokens: builtin captured (group 6)', groups.indexOf(6) !== -1);
}

// ---------------------------------------------------------- run

// The PyCharm-style interaction layer: browser-native dialogs are gone, replaced
// by self-drawn modals, balloons, inline edits, dropdowns and the Find panel.
async function testInteractions(): Promise<void> {
  FakeSocket.instances = [];
  const { window: w, socket } = mountPage(html);
  await settle(w);

  const ctxMenu = () => q(w, '#ctxMenu');
  const isOpen = () => ctxMenu().classList.contains('open');
  const labels = () => qa(w, '#ctxMenu .citem .clbl').map((e: any) => (e.textContent || '').trim());
  const item = (t: string) => qa(w, '#ctxMenu .citem').find((e: any) => ((e.querySelector('.clbl')?.textContent) || '').indexOf(t) !== -1);
  const ctx = (el: any, x = 200, y = 200) => fire(w, el, 'contextmenu', { clientX: x, clientY: y, button: 2 });

  // ---- browser dialogs disabled -> balloons / safe defaults ----
  w.alert('boom');
  await settle(w);
  check('interactions: window.alert is replaced by a balloon', !!q(w, '.balloon'));
  check('interactions: window.confirm returns false (no native popup)', w.confirm('sure') === false);
  check('interactions: window.prompt returns null (no native popup)', w.prompt('name') === null);

  // ---- project tree menu -> New popup ----
  socket.deliver({ kind: 'fsListing', path: '', entries: [{ name: 'main.py', path: 'main.py', kind: 'file', editable: true }] });
  await settle(w);
  const row = qa(w, '#ptree .tnode.file').find((r: any) => (r.textContent ?? '').indexOf('main.py') !== -1);
  ctx(row, 100, 100);
  await settle(w);
  check('interactions: tree menu offers New', isOpen() && labels().indexOf('New') !== -1);
  item('New')!.click();
  await settle(w);
  check('interactions: New opens a type popup', isOpen() && labels().indexOf('Python File') !== -1);
  fire(w, w.document, 'keydown', { key: 'Escape' });
  await settle(w);

  // ---- inline rename ----
  ctx(row, 100, 100);
  await settle(w);
  item('Rename…')!.click();
  await settle(w);
  check('interactions: rename becomes an inline input', !!q(w, '.inline-rename'));
  fire(w, w.document, 'keydown', { key: 'Escape' });
  await settle(w);

  // ---- delete confirmation (danger button) ----
  ctx(row, 100, 100);
  await settle(w);
  item('Delete…')!.click();
  await settle(w);
  check('interactions: delete opens a confirm dialog', !!q(w, '#dlgRoot .dlg'));
  check('interactions: delete dialog has a danger action', !!q(w, '#dlgRoot .dlg-btn.danger'));
  const close = q(w, '#dlgRoot .dlg-foot .dlg-btn');
  close && close.click();
  await settle(w);

  // ---- Settings (Ctrl+Alt+S) ----
  fire(w, w.document, 'keydown', { key: 'S', ctrlKey: true, altKey: true });
  await settle(w);
  check('interactions: Ctrl+Alt+S opens Settings', (q(w, '#dlgRoot .dlg-title')?.textContent || '').indexOf('Settings') !== -1);
  const ok = qa(w, '#dlgRoot .dlg-foot .dlg-btn').find((b: any) => (b.textContent || '').indexOf('OK') !== -1);
  ok && ok.click();
  await settle(w);

  // ---- Run configuration dropdown ----
  q(w, '#cfgBtn').click();
  await settle(w);
  check('interactions: run-config opens a dropdown with Edit Configurations', isOpen() && labels().indexOf('Edit Configurations…') !== -1);
  fire(w, w.document, 'keydown', { key: 'Escape' });
  await settle(w);

  // ---- native file picker degrades gracefully in the web preview ----
  fire(w, w.document, 'keydown', { key: 'O', ctrlKey: true });
  await settle(w);
  check('interactions: Open (Ctrl+O) gives a balloon, not a browser dialog', !!q(w, '.balloon'));

  // ---- Find in Files (Ctrl+Shift+F) ----
  fire(w, w.document, 'keydown', { key: 'F', ctrlKey: true, shiftKey: true });
  await settle(w);
  const fin = q(w, '#findIn') as any;
  check('interactions: Ctrl+Shift+F opens Find in Files', !!fin);
  fin.value = 'fib';
  fire(w, fin, 'input', {});
  await settle(w);
  check('interactions: Find shows matches from open buffers', qa(w, '#findOut .fhit').length > 0, `${qa(w, '#findOut .fhit').length} hits`);

  w.close();
}

// ---------------------------------------------------------- i18n (localization plugin)

async function testI18n(): Promise<void> {
  // The built-in zh-cn localization plugin reaches the page as a bundle.
  check('i18n: built-in zh-cn bundle is embedded in the page', html.indexOf('"menu.File":"文件"') !== -1);

  // Default locale is English: menus keep their source strings.
  const en = mountPage(html);
  await settle(en.window);
  const enMenus = qa(en.window, '#menubar .menu').map((m: any) => (m.textContent || '').trim());
  check('i18n: default locale keeps English menus', enMenus.some((m: string) => m.indexOf('File') === 0), enMenus.join('|'));
  en.window.close();

  // With locale zh-CN persisted, the same menus render in Chinese and the
  // toolbar label follows the locale.
  const zh = mountPage(html, JSON.stringify({ locale: 'zh-CN' }));
  await settle(zh.window);
  const zhMenus = qa(zh.window, '#menubar .menu').map((m: any) => (m.textContent || '').trim());
  check('i18n: zh-CN locale renders Chinese menus', zhMenus.some((m: string) => m.indexOf('文件') === 0), zhMenus.join('|'));
  const tb = q(zh.window, '#runBtn span[data-i18n]') as any;
  check('i18n: toolbar label follows the locale', !!tb && (tb.textContent || '') === '运行');
  zh.window.close();
}

// ---------------------------------------------------------- MCP sidebar

async function testMcp(): Promise<void> {
  FakeSocket.instances = [];
  const { window: w, socket } = mountPage(html);
  await settle(w);

  // Open the sidebar tool window the way a user does.
  const btn = qa(w, '#strip .sbtn').find((b: any) => (b.title ?? '').indexOf('MCP') === 0);
  check('mcp: the strip exposes an MCP tool window', !!btn);
  btn.click();
  await settle(w);
  check('mcp: the panel renders', !!q(w, '#panelBody .mcp'));
  check('mcp: opening the panel asks the engine for the catalogue', !!socket?.lastSentOf('mcpList'));

  // The engine's frame: one ready server with a tool, one idle server.
  socket!.deliver({
    kind: 'mcp',
    configPath: 'C:\\data\\mcp.json',
    configExists: true,
    configError: '',
    servers: [
      { id: 'filesystem', command: 'npx', args: ['-y', 'server-fs'], description: 'Files', status: 'ready', error: '', tools: [{ name: 'read_file', description: 'Read a file' }] },
      { id: 'demo', command: 'node', args: ['demo.js'], description: '', status: 'idle', error: '', tools: [] },
    ],
  });
  await settle(w);
  check('mcp: a ready server renders with its tool', (q(w, '#panelBody')?.textContent ?? '').indexOf('filesystem') !== -1
    && qa(w, '#panelBody .mcp-tool').length === 1, `${qa(w, '#panelBody .mcp-tool').length} tools`);
  check('mcp: an idle server offers Connect', qa(w, '#panelBody button[data-id="demo"]').length === 1);

  // Clicking a tool asks the engine to call it.
  qa(w, '#panelBody .mcp-tool')[0].click();
  await settle(w);
  const call = socket!.lastSentOf('mcpCall');
  check('mcp: clicking a tool sends mcpCall', !!call && call.id === 'filesystem' && call.tool === 'read_file');

  // And the result lands in the output block.
  socket!.deliver({ kind: 'mcpCallResult', id: 'filesystem', tool: 'read_file', ok: true, result: { content: [{ type: 'text', text: 'hi' }] } });
  await settle(w);
  check('mcp: the tool result renders in the output block',
    (q(w, '#mcpOut')?.textContent ?? '').indexOf('"text": "hi"') !== -1, (q(w, '#mcpOut')?.textContent ?? '').slice(0, 40));

  // A failed connect shows the reason instead of a spinner forever.
  socket!.deliver({ kind: 'mcp', configPath: 'x', configExists: true, configError: '', servers: [
    { id: 'broken', command: 'nope', args: [], description: '', status: 'error', error: 'spawn nope ENOENT', tools: [] },
  ] });
  await settle(w);
  check('mcp: a failed server shows its error', (q(w, '#panelBody')?.textContent ?? '').indexOf('ENOENT') !== -1);

  w.close();
}

// ---------------------------------------------------------- update hand-off

/**
 * A launch that replaced an older build opens the window on
 * `/?updated=<old version>` (see `src/desktop/handshake.ts`). The shell has to
 * say so exactly once and then drop the parameter — otherwise the upgrade is
 * invisible and a reload repeats the message forever.
 */
async function testUpdateNotice(): Promise<void> {
  const replaced = mountPage(html, undefined, 'ws', 'http://localhost/?updated=0.7.1-workspace');
  const w = replaced.window;
  await settle(w, 900);
  const text = (q(w, '#toast')?.textContent ?? '') as string;
  check('update: the replaced version is announced', text.indexOf('Updated from 0.7.1-workspace') !== -1, text);
  check('update: the query is stripped so a reload is quiet', w.location.search === '', w.location.search);
  w.close();

  const plain = mountPage(html, undefined, 'ws', 'http://localhost/');
  await settle(plain.window, 900);
  const quiet = (q(plain.window, '#toast')?.textContent ?? '') as string;
  check('update: a plain launch says nothing', quiet.indexOf('Updated from') === -1, quiet);
  plain.window.close();
}

// ---------------------------------------------------------- run

await testBoot();
console.log('');
await testTauriBridge();
console.log('');
await testContextMenus();
console.log('');
await testJavaScript();
console.log('');
await testLanguageSwitch();
console.log('');
await testLanguageRestore();
console.log('');
await testI18n();
console.log('');
await testMcp();
console.log('');
await testUpdateNotice();
console.log('');
await testInteractions();
console.log('');
testRestore();
console.log('');
testTokens();

const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
