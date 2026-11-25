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
import { readFileSync, readdirSync } from 'node:fs';
import { renderPyCharmHtml, PY_PATTERN } from '../src/panel/pycharm-ui.js';
import { CLIENT_FRAGMENTS } from '../src/ui/client-assets.js';
import { pyCharmClientScript } from '../src/ui/pycharm-client.js';

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

// The client script is assembled from text fragments (`src/ui/client/*.js`).
// The old shape was one 4,200-line template literal, and a single backtick in a
// comment truncated it twice. Three invariants now hold that line:
//   - no fragment may contain a backtick (there is no literal left to end),
//   - only the known seed tokens may interpolate,
//   - the assembled script must have substituted every one of them.
const CLIENT_DIR = join(ROOT, 'src', 'ui', 'client');
const fragmentFiles = readdirSync(CLIENT_DIR).filter((f) => f.endsWith('.js')).sort();
// The band keeps the client from collapsing back into one 4,200-line literal
// (the old shape) or splintering into dozens of files. It was 6-9 until the five
// navigation capabilities arrived, then 6-10; the project wizard is the same kind
// of coherent feature and earned its own shard too. Moving the ceiling beats
// merging it into a file it does not belong to.
check('client: split into 6-11 fragments', fragmentFiles.length >= 6 && fragmentFiles.length <= 11, fragmentFiles.join(','));
check(
  'client: every fragment on disk is wired into the assembler',
  fragmentFiles.length === CLIENT_FRAGMENTS.length &&
    fragmentFiles.every((f, i) => CLIENT_FRAGMENTS[i].file === f),
  `${fragmentFiles.length} files vs ${CLIENT_FRAGMENTS.length} imported`,
);
const fragmentText = fragmentFiles.map((f) => readFileSync(join(CLIENT_DIR, f), 'utf8')).join('\n');
check('client: no fragment contains a backtick', fragmentText.indexOf('`') === -1);
check(
  'reference keymap: Ctrl+K, Shift+F10, Shift+F9 and Find Action are bound to real actions',
  fragmentText.indexOf("key === 'k'") !== -1 &&
    fragmentText.indexOf("e.key === 'F10' && e.shiftKey") !== -1 &&
    fragmentText.indexOf("e.shiftKey && e.key === 'F9'") !== -1 &&
    fragmentText.indexOf("openFindAction()") !== -1 &&
    fragmentText.indexOf("e.code === 'Backquote'") === -1,
);
const SEED_KEYS = ['iconsJson', 'patternJson', 'mainJson', 'utilsJson', 'jsJson', 'readmeJson', 'i18nJson'];
const tokens = Array.from(new Set(fragmentText.match(/\$\{[A-Za-z0-9_]+\}/g) || []));
check(
  'client: only the known seed tokens interpolate',
  tokens.length === SEED_KEYS.length && tokens.every((t) => SEED_KEYS.indexOf(t.slice(2, -1)) !== -1),
  tokens.join(','),
);
check(
  'client: the assembled script substituted every seed',
  pyCharmClientScript({
    iconsJson: '{}', patternJson: '""', mainJson: '""', utilsJson: '""',
    jsJson: '""', readmeJson: '""', i18nJson: '{}',
  }).indexOf('${') === -1,
);

// The adapter is not reachable through jsdom (CodeMirror is stripped from the
// mounted page), so exercise the real adapter source against a fake editor that
// fires one change event per setValue, exactly like CodeMirror 5 does.
{
  const source = readFileSync(join(CLIENT_DIR, '20-editor.js'), 'utf8');
  const start = source.indexOf('function makeCmAdapter(cm)');
  const end = source.indexOf('\n  (function initCodeMirror()', start);
  check('editor: the CodeMirror adapter is available for a guard test', start >= 0 && end > start);
  if (start >= 0 && end > start) {
    const factory = new Function(source.slice(start, end) + '\nreturn makeCmAdapter;')() as any;
    let value = '';
    const handlers: Record<string, Array<() => void>> = {};
    const wrapper = { addEventListener() {}, getBoundingClientRect() { return { top: 0, left: 0 }; } };
    const fake = {
      getValue: () => value,
      setValue(v: string) { value = v; (handlers.change || []).forEach((fn) => fn()); },
      on(type: string, fn: () => void) { (handlers[type] || (handlers[type] = [])).push(fn); },
      getCursor: () => ({ line: 0, ch: 0 }),
      posFromIndex: (i: number) => ({ line: 0, ch: i }),
      indexFromPos: (p: any) => p.ch || 0,
      setSelection() {}, setOption() {}, getOption: () => false,
      getScrollInfo: () => ({ top: 0, left: 0 }), scrollTo() {}, focus() {},
      getWrapperElement: () => wrapper,
    };
    const api = factory(fake);
    let first = 0, second = 0;
    api.addEventListener('input', () => { first++; });
    api.addEventListener('input', () => { second++; });
    api.value = 'loaded from disk';
    check('editor: a programmatic open is silent for every input listener',
      first === 0 && second === 0, `${first}/${second}`);
    (handlers.change || []).forEach((fn) => fn());
    check('editor: a real edit still reaches every input listener',
      first === 1 && second === 1, `${first}/${second}`);
  }
}

// ---------------------------------------------------------- jsdom helpers

class FakeSocket {
  static instances: FakeSocket[] = [];
  /**
   * The page currently being mounted.
   *
   * A socket belongs to whichever page was open when it was created — including
   * the reconnects the client opens by itself. Without this, a queued open event
   * from a page that has already been closed would still boot it, and booting a
   * closed window throws inside the client because `document` is undefined.
   */
  static currentWindow: { closed?: boolean } | null = null;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
    const page = FakeSocket.currentWindow;
    setTimeout(() => {
      // No page, or the page is gone: this event has nothing left to boot.
      // `closed` is not reliable here (jsdom clears the document without
      // setting it), so the real question is whether the page still has one.
      if (!page || !(page as { document?: unknown }).document) return;
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }, 0);
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
  // Sockets created while this page is the current one belong to it; closing the
  // page clears that, so a late open event cannot boot a closed window.
  FakeSocket.currentWindow = w;
  const closeWindow = w.close.bind(w);
  w.close = () => { if (FakeSocket.currentWindow === w) FakeSocket.currentWindow = null; closeWindow(); };
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
/**
 * The socket the page opened, or a loud failure.
 *
 * `mountPage` types it as optional because the Tauri bridge has none; every call
 * site that destructures `socket` mounted the webview bridge, so a missing one
 * means the page never connected — worth failing here rather than 34 "possibly
 * undefined" errors further down.
 */
function needSocket(mounted: { socket?: FakeSocket }): FakeSocket {
  if (!mounted.socket) throw new Error('the page did not open a socket (webview bridge expected)');
  return mounted.socket;
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
function caretLine(w: any): number {
  const ta = q(w, '#ta') as any;
  return String(ta?.value ?? '').slice(0, ta?.selectionStart ?? 0).split('\n').length - 1;
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
  // `mountPage` types `socket` as optional because the Tauri bridge has none.
  // This block mounts the webview bridge, so a missing socket means the page
  // never opened one — fail loudly here instead of 48 "possibly undefined" below.
  const mounted = mountPage(html);
  const w = mounted.window;
  if (!mounted.socket) throw new Error('the page did not open a socket (webview bridge expected)');
  const socket = mounted.socket;
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
  const codeMenu = qa(w, '#menubar .menu').find((m: any) =>
    Array.from(m.childNodes).filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join('').trim() === 'Code');
  codeMenu?.click();
  const codeMenuText = (codeMenu?.textContent ?? '').replace(/\s+/g, ' ');
  check('keymap: fold block and fold all advertise distinct shortcuts',
    /Fold Code BlockCtrl\+Shift\+\[/.test(codeMenuText) &&
      /Fold AllCtrl\+Shift\+NumPad-/.test(codeMenuText) &&
      /Unfold AllCtrl\+Shift\+NumPad\+/.test(codeMenuText), codeMenuText);
  check('reference: menu order matches the reference shell',
    menus.join(',') === 'File,Edit,View,Navigate,Code,Refactor,Run,Debug,Tools,VCS,Window,Help',
    menus.join(','));
  check('boot: main toolbar renders the run widget', !!q(w, '#runBtn') && !!q(w, '#projWidget'));
  check('reference: toolbar renders the Build / Check button', !!q(w, '#buildBtn') && !!q(w, '#buildBtn svg'));
  check('boot: tool strip renders 11 tools + settings', qa(w, '#strip .sbtn').length === 12, `${qa(w, '#strip .sbtn').length} buttons`);
  check('boot: icons are painted as inline SVG', qa(w, '#strip .sbtn svg').length === 12, `${qa(w, '#strip .sbtn svg').length} icons`);
  check('boot: editor gutter renders line numbers', qa(w, '#glines .gline').length > 5, `${qa(w, '#glines .gline').length} rows`);
  check('boot: editor loads the main.py sample', (q(w, '#ta')?.value ?? '').indexOf('def fib') !== -1);
  check('boot: three document tabs render', qa(w, '#etabs .etab').length === 3, `${qa(w, '#etabs .etab').length} tabs`);
  check('boot: bottom dock renders 9 tool windows', qa(w, '#dockTabs .dtab').length === 9, `${qa(w, '#dockTabs .dtab').length} tabs`);
  check('boot: Test Explorer offers Run all, Stop and a filter', !!q(w, '#testRunAll') && !!q(w, '#testStop') && !!q(w, '#testFilter'));
  check('boot: Test Explorer has an empty tree until the engine reports cases', !!q(w, '#testTree') && qa(w, '#testTree .test-row').length === 0);
  check('boot: status bar shows file + caret + perf cells',
    !!q(w, '#stFile') && !!q(w, '#stPos') && !!q(w, '#stPerf'));
  check('boot: terminal input is present', !!q(w, '#termIn') && !!q(w, '#termOut'));
  check('layout: Project splitter is accessible', q(w, '#leftResize')?.getAttribute('role') === 'separator');
  check('layout: bottom dock splitter is accessible', q(w, '#dockResize')?.getAttribute('aria-orientation') === 'horizontal');
  check('layout: Darcula reference palette and resizable sizes ship',
    html.includes('--bg-editor:#2B2B2B') && html.includes('--accent:#9876AA') && html.includes('--project-width:240px') && html.includes('--dock-height:205px'));
  check('reference: breadcrumbs, minimap and file badges ship',
    /id="breadcrumbs"/.test(html) && /id="minimapLines"/.test(html) && /file-badge--py/.test(html));
  check('reference: Project / Structure header tabs ship',
    /data-project-view="project"/.test(html) && /data-project-view="structure"/.test(html));
  check('reference: AI Assistant drawer and toolbar toggle ship',
    /id="assistantPanel"/.test(html) && /id="assistantToggle"/.test(html) && /id="assistantForm"/.test(html));
  check('reference: Search Everywhere advertises Ctrl+K in the toolbar', /id="searchBtn"[\s\S]{0,300}Ctrl K/.test(html));

  // ---- reference interactions are live, not just painted ----
  check('reference: breadcrumbs and minimap paint with the first document',
    qa(w, '#breadcrumbs .crumb').length > 0 && qa(w, '#minimapLines .minimap__line').length > 0,
    `${qa(w, '#breadcrumbs .crumb').length} crumbs / ${qa(w, '#minimapLines .minimap__line').length} minimap lines`);
  fire(w, w.document, 'keydown', { key: 'k', ctrlKey: true });
  check('keymap: Ctrl+K opens Search Everywhere', q(w, '#searchModal').className.indexOf('open') !== -1);
  q(w, '#searchClose').click();
  await settle(w);
  const structureTab = qa(w, '.tw-head .tw-tab').find((t: any) => t.getAttribute('data-project-view') === 'structure');
  structureTab?.click();
  await settle(w);
  check('reference: Structure tab activates without leaving the panel',
    (structureTab?.className ?? '').indexOf('is-active') !== -1 && q(w, '#leftPanel').className.indexOf('hidden') === -1);
  const projectTab = qa(w, '.tw-head .tw-tab').find((t: any) => t.getAttribute('data-project-view') === 'project');
  projectTab?.click();
  await settle(w);
  const drawer = q(w, '#assistantPanel');
  check('reference: AI Assistant starts closed', drawer.className.indexOf('hidden') !== -1);
  q(w, '#assistantToggle').click();
  await settle(w);
  check('reference: AI Assistant opens with a clear provider status',
    drawer.className.indexOf('hidden') === -1 && qa(w, '#assistantMessages .amsg').length === 1 &&
      /Ask about the current file/.test(q(w, '#assistantMessages')?.textContent ?? ''));
  const rightHandle = q(w, '#rightResize');
  check('layout: AI splitter appears with the drawer', !rightHandle.classList.contains('hidden'));
  fire(w, rightHandle, 'keydown', { key: 'ArrowLeft' });
  check('layout: AI splitter keyboard-resizes and persists width',
    w.document.documentElement.style.getPropertyValue('--right-width') === '228px' &&
      Number(JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}').assistantWidth) === 228);
  const ask = q(w, '#assistantInput');
  ask.value = 'Explain this file';
  q(w, '#assistantForm .assistant-send').click();
  await settle(w);
  check('reference: AI Assistant sends the question to the engine',
    qa(w, '#assistantMessages .amsg').length === 3 && ask.value === '' &&
      /Thinking/.test(q(w, '#assistantMessages')?.textContent ?? '') &&
      !/No model was called/.test(q(w, '#assistantMessages')?.textContent ?? ''));
  const drawerAsk = socket.lastSentOf('aiAsk') as any;
  check('reference: the drawer sends aiAsk with the typed prompt', drawerAsk?.prompt === 'Explain this file');
  socket.deliver({ kind: 'aiDone', requestId: drawerAsk.requestId, ok: true, ms: 1, bytes: 0 });
  await settle(w);
  q(w, '#assistantClose').click();
  await settle(w);
  check('reference: AI Assistant closes and hides its splitter',
    drawer.className.indexOf('hidden') !== -1 && rightHandle.classList.contains('hidden'));
  const aiToolButton = qa(w, '#strip .sbtn').find((b: any) => (b.getAttribute('title') ?? '').indexOf('AI Assistant') === 0);
  aiToolButton?.click();
  const aiQuestion = q(w, '#aiInput');
  if (aiQuestion) aiQuestion.value = 'Explain the current file';
  q(w, '#aiAsk')?.click();
  await settle(w);
  check('tool window: Ask sends aiAsk from the panel instead of a canned answer',
    !!q(w, '#aiInput') && (socket.lastSentOf('aiAsk') as any)?.prompt === 'Explain the current file' &&
      !/No model was called/.test(q(w, '#assistantMessages')?.textContent ?? ''));
  q(w, '#assistantClose').click();
  const projectToolButton = qa(w, '#strip .sbtn').find((b: any) => (b.getAttribute('title') ?? '').indexOf('Project') === 0);
  projectToolButton?.click();
  await settle(w);
  const refactorMenu = qa(w, '#menubar .menu').find((m: any) => (m.textContent || '').indexOf('Refactor') === 0);
  refactorMenu?.click();
  await settle(w);
  const refactorItems = qa(w, '#menubar .menu.open .item') as any[];
  const refactorText = refactorItems.map((b) => b.textContent ?? '').join(' | ');
  check('menus: Refactor lists only implemented commands',
    /Rename/.test(refactorText) && /Quick Fix/.test(refactorText) &&
      !/Extract Method|Extract Variable|Extract Constant|Move|Change Signature/.test(refactorText), refactorText);
  check('menus: no "not implemented" command is advertised',
    !/not implemented/i.test(q(w, '#menubar')?.textContent ?? ''));
  const renameRefactor = refactorItems.find((b) => /Rename/.test(b.textContent ?? ''));
  renameRefactor?.click();
  await settle(w);
  check('menus: Rename opens the real rename dialog',
    /Rename Symbol/.test(q(w, '#dlgRoot')?.textContent ?? ''));
  q(w, '#dlgRoot .dlg-btn')?.click();
  await settle(w);

  // ---- Packages window (Alt+6): a projection of the dependency frames ----
  // The pane never parses a dependency file itself: it asks, then renders. So
  // these check the two halves that can break independently — the request the
  // tab sends, and what each frame turns into on screen.
  const pkgTab = qa(w, '#dockTabs .dtab').find((b) => /Packages/.test(b.textContent ?? ''));
  check('packages: the dock has a Packages tab', !!pkgTab);
  pkgTab?.click();
  await settle(w);
  const depReq = socket.lastSentOf('dependencyReport');
  check('packages: opening the tab asks for the declaration', !!depReq, JSON.stringify(depReq && { language: depReq.language }));
  check('packages: the request carries the open buffer', typeof depReq?.code === 'string' && depReq.code.length > 0);
  check('packages: the request names the current language', depReq?.language === 'python', String(depReq?.language ?? ''));

  socket.deliver({
    kind: 'dependencies', language: 'python', supported: true, format: 'requirements',
    file: 'requirements.txt', searched: ['requirements.txt'],
    packages: [{ name: 'requests', version: '==2.31.0' }],
    undeclared: ['flask'], installable: true, installTemplate: ['{toolchain}', '-m', 'pip', 'install'],
  });
  await settle(w);
  check('packages: the file it read is shown', (q(w, '#pkgFile')?.textContent ?? '') === 'requirements.txt', q(w, '#pkgFile')?.textContent ?? '');
  check('packages: a declared package renders with its version', /requests/.test(q(w, '#pkgList')?.textContent ?? '') && /2\.31\.0/.test(q(w, '#pkgList')?.textContent ?? ''));
  check('packages: an undeclared import is labelled', /not declared/.test(q(w, '#pkgList')?.textContent ?? ''));

  // "Use" fills the installer input instead of installing straight away: the
  // engine would otherwise run a command the user never saw.
  const useBtn = q(w, '#pkgList button[data-pkg="use"]');
  useBtn?.click();
  await settle(w);
  check('packages: Use puts the name in the install box', (q(w, '#pkgName')?.value ?? '') === 'flask', q(w, '#pkgName')?.value ?? '');

  q(w, '#pkgGo')?.click();
  await settle(w);
  const install = socket.lastSentOf('dependencyInstall');
  check('packages: Install sends the package it was given', install?.package === 'flask', String(install?.package ?? ''));
  check('packages: the install carries the language', install?.language === 'python', String(install?.language ?? ''));
  check('packages: the Stop button is live while installing', q(w, '#pkgStop')?.disabled === false);

  socket.deliver({ kind: 'dependencyOut', language: 'python', stream: 'stdout', text: 'Collecting flask\n' });
  await settle(w);
  check('packages: installer output streams into the console', /Collecting flask/.test(q(w, '#pkgOut')?.textContent ?? ''));

  socket.deliver({ kind: 'dependencyResult', language: 'python', package: 'flask', ok: true, code: 0, ms: 1200, command: 'pip install flask', truncated: false, refresh: { ok: true } });
  await settle(w);
  check('packages: a finished install reports the restart', /language server restarted/.test(q(w, '#pkgOut')?.textContent ?? ''));
  check('packages: the buttons come back after the install', q(w, '#pkgGo')?.disabled === false && q(w, '#pkgStop')?.disabled === true);
  check('packages: a successful install re-reads the declaration', socket.sent.filter((m) => m.kind === 'dependencyReport').length >= 2);

  // "From Path…" installs a checkout rather than a name. The choices come from
  // the report, so this also proves the dialog is manifest-driven: python
  // declares two kinds, and the UI names neither of them.
  socket.deliver({
    kind: 'dependencies', language: 'python', supported: true, format: 'requirements',
    file: 'requirements.txt', searched: ['requirements.txt'],
    packages: [{ name: 'requests', version: '==2.31.0' }], undeclared: [],
    installable: true, installTemplate: ['{toolchain}', '-m', 'pip', 'install'],
    installLocal: [{ kind: 'editable', label: 'Editable' }, { kind: 'file', label: 'Local file' }],
  });
  await settle(w);
  q(w, '#pkgLocal')?.click();
  await settle(w);
  const localKinds = qa(w, '#dlgRoot .dlg-radios input[data-r="kind"]');
  check('packages: From Path offers the kinds the report declares', localKinds.length === 2,
    `${localKinds.length} choices`);
  const pathInput = q(w, '#dlgRoot input[data-f="path"]');
  check('packages: From Path asks for a path', !!pathInput);
  if (pathInput) { pathInput.value = './packages/my-lib'; fire(w, pathInput, 'input', {}); }
  q(w, '#dlgRoot .dlg-btn.primary')?.click();
  await settle(w);
  const localInstall = socket.lastSentOf('dependencyInstall');
  check('packages: From Path sends the kind and the path, not a package name',
    localInstall?.installKind === 'editable' && localInstall?.path === './packages/my-lib' && localInstall?.package === undefined,
    JSON.stringify(localInstall && { kind: localInstall.kind, installKind: localInstall.installKind, path: localInstall.path, package: localInstall.package }));
  check('packages: a local install still carries the message kind', localInstall?.kind === 'dependencyInstall', String(localInstall?.kind ?? ''));
  socket.deliver({ kind: 'dependencyResult', language: 'python', ok: true, code: 0, ms: 800, command: 'pip install -e ./packages/my-lib', truncated: false });
  await settle(w);
  check('packages: a finished local install re-enables its buttons', q(w, '#pkgLocal')?.disabled === false);

  // A frame for another language must not paint over the current one.
  const before = q(w, '#pkgFile')?.textContent ?? '';
  socket.deliver({ kind: 'dependencies', language: 'go', supported: true, format: 'gomod', file: 'go.mod', searched: ['go.mod'], packages: [], undeclared: [], installable: true });
  await settle(w);
  check('packages: a stale frame from another language is dropped', (q(w, '#pkgFile')?.textContent ?? '') === before, q(w, '#pkgFile')?.textContent ?? '');

  // Put the dock back where the rest of the suite expects it.
  qa(w, '#dockTabs .dtab').find((b) => (b.textContent ?? '').trim() === 'Run')?.click();
  await settle(w);

  // ---- Build / Check is wired to the real diagnostic path ----
  const checksBeforeBuild = socket.sent.filter((m) => m.kind === 'check').length;
  q(w, '#buildBtn').click();
  await settle(w);
  check('build: toolbar Build sends a real check request',
    socket.sent.filter((m) => m.kind === 'check').length > checksBeforeBuild);

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

  // ---- terminal: builtins + backend command ----
  const tin = q(w, '#termIn');
  tin.value = 'help';
  fire(w, tin, 'keydown', { key: 'Enter' });
  await settle(w);
  check('terminal: a builtin (`help`) renders locally', (q(w, '#termOut')?.textContent ?? '').indexOf('Built-ins') !== -1);

  tin.value = 'echo hello-from-terminal';
  fire(w, tin, 'keydown', { key: 'Enter' });
  await settle(w);
  check('terminal: echo is handled locally with its arguments',
    (q(w, '#termOut')?.textContent ?? '').includes('hello-from-terminal') &&
      !socket.sent.some((m: any) => m.kind === 'termExec' && String(m.cmd).includes('echo hello')),
    q(w, '#termOut')?.textContent ?? '');

  tin.value = 'theme dark';
  fire(w, tin, 'keydown', { key: 'Enter' });
  await settle(w);
  check('terminal: theme builtin splits whitespace',
    (q(w, '#termOut')?.textContent ?? '').includes('theme -> darcula') &&
      w.document.documentElement.getAttribute('data-theme') === 'darcula',
    q(w, '#termOut')?.textContent ?? '');

  tin.value = 'ls';
  fire(w, tin, 'keydown', { key: 'Enter' });
  await settle(w);
  const lsTerm = socket.lastSentOf('termExec');
  check('terminal: a command ending in s is not truncated', !!lsTerm && lsTerm.cmd === 'ls', JSON.stringify(lsTerm));

  tin.value = '   git status   ';
  fire(w, tin, 'keydown', { key: 'Enter' });
  await settle(w);
  const statusTerm = socket.sent.filter((m: any) => m.kind === 'termInput').pop();
  check('terminal: attached input keeps internal spaces and loses outer ones',
    !!statusTerm && typeof statusTerm.text === 'string' &&
      statusTerm.text.replace(/\s+$/, '') === '   git status',
    JSON.stringify(statusTerm));

  // termResult renders back into the terminal
  socket.deliver({ kind: 'termResult', cmd: 'ls', stdout: 'main.py\n', stderr: '', code: 0, ms: 3 });
  await settle(w);
  check('terminal: termResult stdout is rendered', (q(w, '#termOut')?.textContent ?? '').includes('main.py'));

  // ---- theme toggle ----
  check('theme: starts on Darcula', w.document.documentElement.getAttribute('data-theme') === 'darcula');
  q(w, '#themeBtn').click();
  await settle(w);
  check('theme: toggle switches to Light', w.document.documentElement.getAttribute('data-theme') === 'light');

  // ---- persistence (localStorage) ----
  const store = w.localStorage.getItem('nolanguage.pycharm.v1') || '';
  check('persist: theme choice is written to localStorage', store.indexOf('"theme":"light"') !== -1, store);
  check('persist: open tabs are written to localStorage', store.indexOf('"tabs"') !== -1, store);

  // ---- tool-window toggle (Project is open in the reference workspace) ----
  const panel = q(w, '#leftPanel');
  check('panel: Project is visible on first launch', panel.className.indexOf('hidden') === -1);
  q(w, '#projWidget').click();
  await settle(w);
  check('panel: Project widget hides the open left tool window', panel.className.indexOf('hidden') !== -1);
  q(w, '#projWidget').click();
  await settle(w);
  check('panel: Project widget restores the left tool window', panel.className.indexOf('hidden') === -1);
  check('persist: layout is written after a tool-window toggle',
    (w.localStorage.getItem('nolanguage.pycharm.v1') || '').indexOf('"left":"project"') !== -1);
  const leftResize = q(w, '#leftResize');
  leftResize.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
  check('layout: Project splitter resizes by keyboard', w.document.documentElement.style.getPropertyValue('--project-width') === '248px');
  check('layout: Project width is persisted', JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}').projectWidth === 248);
  leftResize.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
  const dockResize = q(w, '#dockResize');
  dockResize.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }));
  check('layout: bottom dock splitter resizes by keyboard', w.document.documentElement.style.getPropertyValue('--dock-height') === '213px');
  check('layout: dock height is persisted', JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}').dockHeight === 213);
  dockResize.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
  socket.deliver({ kind: 'fsListing', path: '', entries: [
    { name: 'src', path: 'src', kind: 'dir', size: 0, mtime: 0, editable: false },
    { name: 'main.py', path: 'main.py', kind: 'file', size: 10, mtime: 0, editable: true },
    { name: 'utils.py', path: 'utils.py', kind: 'file', size: 10, mtime: 0, editable: true },
    { name: 'README.md', path: 'README.md', kind: 'file', size: 10, mtime: 0, editable: true },
    { name: 'package.json', path: 'package.json', kind: 'file', size: 10, mtime: 0, editable: true },
  ] });
  await settle(w);
  check('panel: the project tree renders from fsListing', qa(w, '#panelBody .tnode').length > 3, `${qa(w, '#panelBody .tnode').length} nodes`);
  check('reference: file badges render in tabs and project tree',
    qa(w, '#etabs .etab .file-badge').length === 3 && qa(w, '#panelBody .tnode .file-badge').length > 0,
    `${qa(w, '#etabs .etab .file-badge').length} tab badges / ${qa(w, '#panelBody .tnode .file-badge').length} tree badges`);

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
  const mountedPage = mountPage(html);
  const w = mountedPage.window;
  const socket = needSocket(mountedPage);
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
    FakeTauri.invokes.map((i) => (i.cmd === 'engine_send' ? String((i.args?.msg as { kind?: string } | undefined)?.kind) : i.cmd)).join(','));
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
  const mountedPage = mountPage(html);
  const w = mountedPage.window;
  const socket = needSocket(mountedPage);
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
  const pinnedTabs = () => tabs().filter((t: any) => t.classList.contains('pinned'));
  ctx(tabWith('main.py')!);
  await settle(w);
  check('ctx: the tab bar shows a menu on right-click', isOpen());
  check('ctx: the tab menu is PyCharm\'s', same(['Pin Tab', 'Close', 'Close Others', 'Close All', 'Reopen Closed Tab']), labels().join(' / '));
  item('Pin Tab').click();
  await settle(w);
  check('ctx: Pin Tab pins the tab',
    pinnedTabs().length === 1 && !!tabWith('main.py')!.classList.contains('pinned'),
    `${pinnedTabs().length} pinned of ${tabs().length}`);
  ctx(tabWith('main.py')!);
  await settle(w);
  check('ctx: a pinned tab offers Unpin Tab', same(['Unpin Tab', 'Close', 'Close Others', 'Close All', 'Reopen Closed Tab']), labels().join(' / '));
  item('Close Others').click();
  await settle(w);
  check('ctx: Close Others keeps the pinned tab',
    tabs().length === 1 && (tabs()[0].textContent ?? '').indexOf('main.py') !== -1,
    tabs().map((t: any) => t.textContent).join(','));
  ctx(tabs()[0]);
  await settle(w);
  item('Unpin Tab').click();
  await settle(w);
  check('ctx: Unpin Tab clears the pin', pinnedTabs().length === 0, String(pinnedTabs().length));
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
  const mountedPage = mountPage(html);
  const w = mountedPage.window;
  const socket = needSocket(mountedPage);
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

  // The earlier diagnostic probe replaced the buffer with Python-like text;
  // restore a JavaScript snippet before verifying that Auto re-tokenises by file type.
  q(w, '#ta').value = 'const restored = 1;\n';
  fire(w, q(w, '#ta'), 'input', {});
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
  const mountedPage = mountPage(html, seed);
  const w = mountedPage.window;
  const socket = needSocket(mountedPage);
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
  const mountedPage = mountPage(html);
  const w = mountedPage.window;
  const socket = needSocket(mountedPage);
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
  await settle(w, 160);
  check('interactions: Find shows matches from open buffers', qa(w, '#findOut .fhit').length > 0, `${qa(w, '#findOut .fhit').length} hits`);

  socket.deliver({ kind: 'fsFile', file: {
    path: 'large.txt', name: 'large.txt', content: Array(1200).fill('needle').join('\n'), size: 8_399, mtime: 1,
    languageId: 'markdown', editable: true,
  } });
  fin.value = 'needle';
  fire(w, fin, 'input', {});
  await settle(w, 160);
  check('interactions: Find result DOM is capped', qa(w, '#findOut .fhit').length <= 1000, String(qa(w, '#findOut .fhit').length));
  check('interactions: capped Find reports that more results were omitted', (q(w, '#findOut')?.textContent || '').includes('Search limited'), (q(w, '#findOut')?.textContent || '').slice(-90));

  const beforeLargeCheck = socket.sent.filter((m: any) => m.kind === 'check').length;
  const editor = q(w, '#ta') as any;
  editor.value = 'x'.repeat(1024 * 1024 + 1);
  fire(w, editor, 'input', {});
  await settle(w, 380);
  const newChecks = socket.sent.filter((m: any) => m.kind === 'check').slice(beforeLargeCheck);
  check('interactions: live diagnostics skip files over 1 Mi characters', !newChecks.some((m: any) => String(m.code || '').length > 1024 * 1024), `sent ${newChecks.length} check(s)`);
  check('interactions: large-file diagnostics degradation is visible', (q(w, '#toast')?.textContent || '').includes('Live checks paused'));

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
  const mountedPage = mountPage(html);
  const w = mountedPage.window;
  const socket = needSocket(mountedPage);
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

// ---------------------------------------------------------- keymap + migration

/**
 * The P1 threshold, as a user experiences it: the keys they already press and
 * the run setups they already have.
 *
 * Ctrl+F must not reach the browser's find bar, a match must be *selected* so
 * Replace acts on it, and an imported `.idea` configuration must end up in the
 * same preference store the run widget reads.
 */
async function testKeymap(): Promise<void> {
  FakeSocket.instances = [];
  const mountedPage = mountPage(html);
  const w = mountedPage.window;
  const socket = needSocket(mountedPage);
  await settle(w);
  const ed = q(w, '#ta') as any;

  // ---- find ----
  ed.value = 'alpha beta alpha';
  ed.setSelectionRange(0, 0);
  const ctrlF = fire(w, ed, 'keydown', { key: 'f', ctrlKey: true });
  check('keymap: Ctrl+F opens the in-editor find bar', !!q(w, '.findbar') && q(w, '.findbar').classList.contains('open'));
  check('keymap: Ctrl+F suppresses the browser find', (ctrlF as any).defaultPrevented === true);

  const input = q(w, '.findbar .fb-in') as any;
  input.value = 'alpha';
  fire(w, input, 'input', {});
  await settle(w, 30);
  check('keymap: matches are counted', (q(w, '.findbar .fb-count')?.textContent ?? '') === '1/2', q(w, '.findbar .fb-count')?.textContent);
  check('keymap: the first match is selected', ed.selectionStart === 0 && ed.selectionEnd === 5, `${ed.selectionStart}-${ed.selectionEnd}`);

  fire(w, input, 'keydown', { key: 'Enter' });
  check('keymap: Enter jumps to the next match', ed.selectionStart === 11 && ed.selectionEnd === 16, `${ed.selectionStart}-${ed.selectionEnd}`);
  check('keymap: the counter follows', (q(w, '.findbar .fb-count')?.textContent ?? '') === '2/2');
  fire(w, input, 'keydown', { key: 'Enter', shiftKey: true });
  check('keymap: Shift+Enter goes back', ed.selectionStart === 0);

  // ---- replace ----
  fire(w, ed, 'keydown', { key: 'h', ctrlKey: true });
  check('keymap: Ctrl+H switches the bar to replace', q(w, '.findbar').classList.contains('replace'));
  const rep = q(w, '.findbar .fb-rep') as any;
  rep.value = 'ALPHA';
  (q(w, '.findbar [data-a="all"]') as any).click();
  await settle(w, 10);
  check('keymap: Replace All rewrites every match', ed.value === 'ALPHA beta ALPHA', JSON.stringify(ed.value));
  check('keymap: Replace All reports the count', /Replaced 2/.test(q(w, '#toast')?.textContent ?? ''), q(w, '#toast')?.textContent);

  fire(w, input, 'keydown', { key: 'Escape' });
  check('keymap: Escape closes the bar', !q(w, '.findbar').classList.contains('open'));

  // ---- line editing ----
  ed.value = 'one\ntwo\nthree';
  ed.setSelectionRange(4, 4);
  fire(w, ed, 'keydown', { key: 'd', ctrlKey: true });
  check('keymap: Ctrl+D duplicates the line', ed.value === 'one\ntwo\ntwo\nthree', JSON.stringify(ed.value));
  check('keymap: the caret follows the copy', ed.selectionStart === 8, String(ed.selectionStart));
  fire(w, ed, 'keydown', { key: 'y', ctrlKey: true });
  check('keymap: Ctrl+Y deletes the line', ed.value === 'one\ntwo\nthree', JSON.stringify(ed.value));

  ed.value = 'x = 1\ny = 2';
  ed.setSelectionRange(0, 0);
  fire(w, ed, 'keydown', { key: '/', ctrlKey: true });
  check('keymap: Ctrl+/ comments with the language prefix', ed.value === '# x = 1\ny = 2', JSON.stringify(ed.value));
  fire(w, ed, 'keydown', { key: '/', ctrlKey: true });
  check('keymap: Ctrl+/ toggles the comment back off', ed.value === 'x = 1\ny = 2', JSON.stringify(ed.value));

  // ---- go to line ----
  ed.value = 'one\ntwo\nthree';
  ed.setSelectionRange(0, 0);
  fire(w, ed, 'keydown', { key: 'g', ctrlKey: true });
  const dlg = q(w, '.dlg');
  check('keymap: Ctrl+G opens the line dialog', !!dlg && /Go to Line/.test(dlg.textContent ?? ''));
  const lineInput = dlg.querySelector('input[data-f="line"]') as any;
  lineInput.value = '3';
  const go = Array.from(dlg.querySelectorAll('.dlg-btn')).find((b: any) => b.textContent === 'Go') as any;
  go.click();
  check('keymap: Go places the caret on that line', ed.selectionStart === 8, String(ed.selectionStart));

  // Editor comment and documentation commands have real handlers in this shell.
  ed.value = 'value = 1';
  ed.setSelectionRange(0, ed.value.length);
  fire(w, ed, 'keydown', { key: '/', ctrlKey: true, shiftKey: true });
  check('keymap: Ctrl+Shift+/ wraps selected Python text in a block comment', ed.value === '"""value = 1"""', JSON.stringify(ed.value));
  fire(w, ed, 'keydown', { key: '/', ctrlKey: true, shiftKey: true });
  check('keymap: Ctrl+Shift+/ removes the matching block comment', ed.value === 'value = 1', JSON.stringify(ed.value));
  ed.value = 'def sample():\n    return 1\nsample';
  ed.setSelectionRange(ed.value.length, ed.value.length);
  fire(w, ed, 'keydown', { key: 'q', ctrlKey: true });
  check('keymap: Ctrl+Q opens Quick Documentation',
    /Quick Documentation/.test(q(w, '#dlgRoot')?.textContent ?? '') && /def sample/.test(q(w, '#dlgRoot')?.textContent ?? ''));
  q(w, '#dlgRoot .dlg-btn')?.click();

  // Unimplemented refactorings are not advertised: no menu item, no key, and
  // no toast pretending a command exists. A free key is better than a broken
  // promise.
  const moveKey = fire(w, w.document, 'keydown', { key: 'F6' });
  const signatureKey = fire(w, w.document, 'keydown', { key: 'F6', ctrlKey: true });
  check('keymap: F6 and Ctrl+F6 are unbound, not fake commands',
    !moveKey.defaultPrevented && !signatureKey.defaultPrevented &&
      !/not implemented/i.test(q(w, '#toast')?.textContent ?? ''));

  // Fold a block and fold-all have distinct shortcuts. The jsdom editor uses the
  // textarea fallback, so the expected outcome is a visible availability hint.
  const foldBlock = fire(w, ed, 'keydown', { key: '[', ctrlKey: true, shiftKey: true });
  check('keymap: Ctrl+Shift+[ routes to Fold Code Block',
    /Folding needs the CodeMirror editor/.test(q(w, '#toast')?.textContent ?? '') && foldBlock.defaultPrevented);
  const foldAll = fire(w, w.document, 'keydown', { key: 'Subtract', code: 'NumpadSubtract', ctrlKey: true, shiftKey: true });
  check('keymap: Ctrl+Shift+NumPad- routes to Fold All',
    /Folding needs the CodeMirror editor/.test(q(w, '#toast')?.textContent ?? '') && foldAll.defaultPrevented);

  ed.value = 'one\ntwo';
  ed.setSelectionRange(0, 7);
  fire(w, ed, 'keydown', { key: 'j', ctrlKey: true, shiftKey: true });
  check('keymap: Ctrl+Shift+J joins the selected lines', ed.value === 'one two', JSON.stringify(ed.value));
  ed.value = 'one\ntwo\nthree';
  ed.setSelectionRange(4, 4);
  fire(w, ed, 'keydown', { key: 'ArrowUp', altKey: true, shiftKey: true });
  check('keymap: Alt+Shift+Up moves the current line', ed.value === 'two\none\nthree', JSON.stringify(ed.value));
  fire(w, ed, 'keydown', { key: 'ArrowDown', altKey: true, shiftKey: true });
  check('keymap: Alt+Shift+Down moves the line back', ed.value === 'one\ntwo\nthree', JSON.stringify(ed.value));

  fire(w, w.document, 'keydown', { key: 'F12', ctrlKey: true });
  check('keymap: Ctrl+F12 opens File Structure', (q(w, '#panelTitle')?.textContent ?? '') === 'Structure', q(w, '#panelTitle')?.textContent ?? '');
  const profilesBeforeAlt9 = socket.sent.filter((m: any) => m.kind === 'profile').length;
  fire(w, w.document, 'keydown', { key: '9', altKey: true });
  check('keymap: Alt+9 opens VCS without invoking Profile',
    (q(w, '#panelTitle')?.textContent ?? '') === 'Version Control' &&
      socket.sent.filter((m: any) => m.kind === 'profile').length === profilesBeforeAlt9,
    q(w, '#panelTitle')?.textContent ?? '');
  fire(w, w.document, 'keydown', { key: '5', altKey: true });
  check('keymap: Alt+5 opens the Test Explorer',
    q(w, '.dock-pane.active')?.getAttribute('data-pane') === 'tests',
    q(w, '.dock-pane.active')?.getAttribute('data-pane') ?? '');
  fire(w, w.document, 'keydown', { key: 'p', ctrlKey: true, altKey: true });
  check('keymap: Ctrl+Alt+P invokes Profile',
    socket.sent.filter((m: any) => m.kind === 'profile').length === profilesBeforeAlt9 + 1);

  // ---- interpreter picker ----
  socket!.deliver({
    kind: 'interpreters', language: 'python', root: '/proj', active: '/proj/.venv/Scripts/python.exe', pinned: null,
    candidates: [
      { path: '/proj/.venv/Scripts/python.exe', label: 'Python 3.13.14 (.venv)', version: '3.13.14', kind: 'venv', source: '.venv' },
      { path: '/usr/bin/python3', label: 'Python 3.11.9 (PATH)', version: '3.11.9', kind: 'path', source: 'PATH' },
    ],
  });
  await settle(w);
  const radios = qa(w, '.dlg input[data-r="bin"]');
  check('migration: the picker lists candidates plus "auto"', radios.length === 3, String(radios.length));
  check('migration: the active interpreter is preselected', radios[0].checked === true);
  const firstChoice = radios[0].parentElement?.textContent ?? '';
  check('migration: the picker shows version and environment kind',
    firstChoice.includes('3.13.14') && firstChoice.includes('venv'), String(firstChoice));
  const apply = Array.from(q(w, '.dlg').querySelectorAll('.dlg-btn')).find((b: any) => b.textContent === 'Apply') as any;
  apply.click();
  const setMsg = socket!.lastSentOf('setInterpreter');
  check('migration: Apply sends the chosen path', !!setMsg && setMsg.path === '/proj/.venv/Scripts/python.exe', JSON.stringify(setMsg));
  check('migration: the language travels with it', setMsg?.language === 'python', String(setMsg?.language));

  // ---- .idea import ----
  socket!.deliver({
    kind: 'ideaImport', root: '/proj', missing: false, projectSdk: 'Python 3.13 (proj)', modules: ['proj'], warnings: [],
    configurations: [
      { name: 'web', type: 'NodeJSConfigurationType', factory: 'Node.js', script: 'web/index.js', scriptPath: '/proj/web/index.js', parameters: 'serve --port 3000', workdir: 'web', env: {}, source: '.run/web.xml', language: 'javascript' },
      { name: 'main', type: 'PythonConfigurationType', factory: 'Python', script: 'main.py', scriptPath: '/proj/main.py', parameters: '--fast', workdir: '.', env: { MODE: 'dev' }, source: '.idea/runConfigurations/main.xml', language: 'python' },
    ],
  });
  await settle(w);
  const prefs = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  const names = (prefs.runConfigs || []).map((c: any) => c.name);
  check('migration: imported configurations reach the run store', names.indexOf('web') !== -1 && names.indexOf('main') !== -1, names.join(','));
  check('migration: the script path is carried over', (prefs.runConfigs || []).some((c: any) => c.name === 'web' && c.path === 'web/index.js'));
  const webCfg = (prefs.runConfigs || []).find((c: any) => c.name === 'web') || {};
  check('migration: program arguments are carried over (not just the script)', webCfg.args === 'serve --port 3000', JSON.stringify(webCfg.args));
  check('migration: the working directory is carried over', webCfg.cwd === 'web', JSON.stringify(webCfg.cwd));
  check('migration: the import is announced', /Imported \d+ run configuration/.test(q(w, '#toast')?.textContent ?? ''), q(w, '#toast')?.textContent);
  check('migration: an existing name is not duplicated', (prefs.runConfigs || []).filter((c: any) => c.name === 'main').length === 1, String((prefs.runConfigs || []).length));

  // The configuration the debugger would use must actually see those args.
  // Seeding the store and pressing Shift+F9 exercises the real path
  // (`activeConfig` -> `normCfg` -> `debug`), not a copy of the splitter.
  const seeded = mountPage(
    html,
    JSON.stringify({
      runConfigs: [{ name: 'web', path: 'web/index.js', args: 'serve --data "C:/My Data"', cwd: 'web' }],
      activeConfig: 'web',
    }),
  );
  await settle(seeded.window);
  fire(seeded.window, q(seeded.window, '#ta'), 'keydown', { key: 'F9', shiftKey: true });
  await settle(seeded.window);
  const dbg = seeded.socket!.lastSentOf('debug');
  check(
    'migration: the debugger receives the imported args (quotes preserved)',
    JSON.stringify(dbg?.args) === JSON.stringify(['serve', '--data', 'C:/My Data']),
    JSON.stringify(dbg?.args),
  );
  check('migration: the debugger receives the working directory', dbg?.cwd === 'web', String(dbg?.cwd));
  seeded.window.close();

  w.close();
}

// ---------------------------------------------------------- debug views

/**
 * A stop must carry more than a stack: frames, scopes and the variables in
 * them are what make a debugger usable. These checks drive the real message
 * the engine sends, so they cover the wiring end to end (server reply shape
 * -> applyDebugState -> Debug window) without needing a real adapter.
 */
async function testDebugViews(): Promise<void> {
  FakeSocket.instances = [];
  const mountedPage = mountPage(html);
  const w = mountedPage.window;
  const socket = needSocket(mountedPage);
  await settle(w);

  socket.deliver({
    kind: 'debugState', ok: true, state: 'stopped', reason: 'breakpoint', threadId: 7,
    frames: [
      { id: 11, name: 'fib', file: '/ws/main.py', line: 4, column: 2 },
      { id: 12, name: 'main', file: '/ws/main.py', line: 13, column: 1 },
    ],
    scopes: [
      { name: 'Locals', variablesReference: 100, variables: [
        { name: 'n', value: '5', variablesReference: 0 },
        { name: 'obj', value: 'Point(1, 2)', type: 'Point', variablesReference: 200 },
      ] },
      { name: 'Globals', variablesReference: 101, variables: [] },
    ],
  });
  await settle(w);

  check('debug: a stop raises the Debug tool window',
    (q(w, '#dockTabs .dtab.active')?.textContent ?? '').indexOf('Debug') !== -1,
    (q(w, '#dockTabs .dtab.active')?.textContent ?? '').trim());
  check('debug: the call stack renders every frame',
    qa(w, '#dbgFrames .dbg-frame').length === 2, `${qa(w, '#dbgFrames .dbg-frame').length} frames`);
  check('debug: the top frame is marked as current',
    /cur/.test(qa(w, '#dbgFrames .dbg-frame')[0]?.className ?? ''),
    String(qa(w, '#dbgFrames .dbg-frame')[0]?.className ?? ''));
  check('debug: variables render grouped by scope',
    qa(w, '#dbgVars .dbg-scope').length === 2 &&
    (q(w, '#dbgVars')?.textContent ?? '').indexOf('Point(1, 2)') !== -1,
    (q(w, '#dbgVars')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60));
  check('debug: the stopped line is marked in the editor',
    /dbgcur/.test(qa(w, '#glines .gline')[3]?.className ?? ''),
    String(qa(w, '#glines .gline')[3]?.className ?? ''));

  // Expanding a structured variable asks the adapter for its children.
  const expandable = qa(w, '#dbgVars .dbg-var.expandable')[0];
  check('debug: a structured variable is expandable', !!expandable,
    `${qa(w, '#dbgVars .dbg-var.expandable').length} expandable`);
  expandable?.click();
  await settle(w);
  const varsReq = socket.lastSentOf('debugCmd');
  check('debug: expanding asks the adapter for children',
    varsReq?.cmd === 'vars' && Number(varsReq?.variablesReference) === 200,
    JSON.stringify(varsReq && { cmd: varsReq.cmd, ref: varsReq.variablesReference }));
  socket.deliver({
    kind: 'debugVars', ok: true, variablesReference: 200,
    variables: [{ name: 'x', value: '1', variablesReference: 0 }, { name: 'y', value: '2', variablesReference: 0 }],
  });
  await settle(w);
  check('debug: the children appear under the expanded variable',
    (q(w, '#dbgVars')?.textContent ?? '').indexOf('y') !== -1 && qa(w, '#dbgVars .dbg-var').length >= 4,
    `${qa(w, '#dbgVars .dbg-var').length} rows`);

  // Watches: pin an expression, then see the adapter's answer.
  const evalIn = q(w, '#dbgEvalIn') as any;
  evalIn.value = 'n * 2';
  q(w, '#dbgWatchAdd').click();
  await settle(w);
  const watchReq = socket.lastSentOf('debugCmd');
  check('debug: pinning a watch asks the adapter to evaluate it',
    watchReq?.cmd === 'evaluate' && watchReq?.expression === 'n * 2',
    JSON.stringify(watchReq && { cmd: watchReq.cmd, e: watchReq.expression }));
  socket.deliver({ kind: 'debugEval', ok: true, expression: 'n * 2', result: '10', type: 'int', variablesReference: 0 });
  await settle(w);
  check('debug: the watch shows the evaluated value',
    (q(w, '#dbgWatches')?.textContent ?? '').indexOf('10') !== -1,
    (q(w, '#dbgWatches')?.textContent ?? '').trim().slice(0, 40));

  // A one-off evaluation lands in the debugger console.
  evalIn.value = 'n + 1';
  fire(w, evalIn, 'keydown', { key: 'Enter' });
  await settle(w);
  socket.deliver({ kind: 'debugEval', ok: true, expression: 'n + 1', result: '6', variablesReference: 0 });
  await settle(w);
  check('debug: an evaluated expression lands in the console',
    (q(w, '#dbgConsole')?.textContent ?? '').indexOf('6') !== -1,
    (q(w, '#dbgConsole')?.textContent ?? '').trim().slice(0, 40));

  // The step buttons are live only while stopped — that is the whole point of
  // the toolbar's enabled rules.
  check('debug: stepping is enabled while stopped',
    q(w, '#dbgBar [data-dbg="next"]')?.disabled === false,
    String(q(w, '#dbgBar [data-dbg="next"]')?.disabled));
  check('debug: Pause is not offered while stopped',
    q(w, '#dbgBar [data-dbg="pause"]')?.disabled === true,
    String(q(w, '#dbgBar [data-dbg="pause"]')?.disabled));

  // Terminating clears both the view and the stopped-line marker.
  socket.deliver({ kind: 'debugState', ok: true, state: 'terminated' });
  await settle(w);
  check('debug: terminating clears the stopped-line marker',
    qa(w, '#glines .gline.dbgcur').length === 0 &&
    (q(w, '#dbgFrames')?.textContent ?? '').indexOf('Not stopped') !== -1,
    `${qa(w, '#glines .gline.dbgcur').length} still marked`);

  w.close();
}

/**
 * Breakpoints must outlive the window: they are the one piece of debug state a
 * user rebuilds by hand every time. Attach must travel as a request with a
 * connection, not be silently downgraded to a launch.
 */
async function testBreakpointsAndAttach(): Promise<void> {
  FakeSocket.instances = [];
  const mountedPage = mountPage(html);
  const w = mountedPage.window;
  const socket = needSocket(mountedPage);
  await settle(w);

  const line3 = () => qa(w, '#glines .gline')[2];
  line3().click();
  await settle(w);
  const saved = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('bp: a breakpoint is persisted',
    !!saved.breakpoints && !!(saved.breakpoints['main.py'] || {})['3'],
    JSON.stringify(saved.breakpoints || {}));
  check('bp: the gutter shows the breakpoint',
    /hasbp/.test(line3()?.className ?? ''), String(line3()?.className ?? ''));

  // Toggling off must persist too, or the dots come back on every restart.
  line3().click();
  await settle(w);
  const saved2 = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('bp: removing a breakpoint persists as well',
    !(saved2.breakpoints['main.py'] || {})['3'], JSON.stringify(saved2.breakpoints['main.py'] || {}));

  // Put one back and prove a fresh window reads it.
  line3().click();
  await settle(w);
  const restart = mountPage(html, w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  await settle(restart.window);
  check('bp: breakpoints survive a restart',
    /hasbp/.test(qa(restart.window, '#glines .gline')[2]?.className ?? ''),
    String(qa(restart.window, '#glines .gline')[2]?.className ?? ''));
  restart.window.close();

  // ---- attach ----
  const seeded = mountPage(html, JSON.stringify({
    runConfigs: [{ name: 'remote', path: 'main.py', request: 'attach', port: 5678, host: '127.0.0.1' }],
    activeConfig: 'remote',
  }));
  await settle(seeded.window);
  fire(seeded.window, q(seeded.window, '#ta'), 'keydown', { key: 'F9', shiftKey: true });
  await settle(seeded.window);
  const dmsg = seeded.socket!.lastSentOf('debug');
  check('debug: an attach configuration asks to attach', dmsg?.request === 'attach', String(dmsg?.request));
  check('debug: an attach configuration carries the connection',
    Number(dmsg?.port) === 5678 && dmsg?.host === '127.0.0.1',
    JSON.stringify({ port: dmsg?.port, host: dmsg?.host }));
  seeded.window.close();

  w.close();
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
await testDebugViews();
console.log('');
await testBreakpointsAndAttach();
console.log('');
await testUpdateNotice();
console.log('');
await testKeymap();
console.log('');
await testInteractions();
console.log('');
testRestore();
console.log('');
testTokens();

// ------------------------------------------------- Markdown preview (#40)
// The pane is only useful if the whole loop works: open a .md file, ask the
// engine, render the answer, and let the outline move the caret. Checking that
// the markup exists would pass with a pane that never renders anything.
console.log('');
{
  const html = renderPyCharmHtml(7310);
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w, 30);

  const doc = w.document;
  const pane = doc.getElementById('mdprev');
  const split = doc.getElementById('mdSplit') as any;
  check('preview: the pane exists and starts hidden', !!pane && pane.classList.contains('hidden'), pane ? pane.className : 'missing');
  check('preview: resize separator is hidden with the pane', !!split && split.classList.contains('hidden'), split ? split.className : 'missing');
  check('preview: resize separator exposes accessible range', !!split && split.getAttribute('role') === 'separator' && split.getAttribute('aria-valuemin') === '24' && split.getAttribute('aria-valuemax') === '64', split ? split.getAttribute('aria-label') : 'missing');

  // The project tree is the only way in from a cold page: deliver a listing and
  // click the row, exactly like a user would.
  socket.deliver({ kind: 'fsListing', path: '', entries: [{ name: 'README.md', path: 'README.md', kind: 'file' }] });
  await settle(w, 20);
  const row = Array.from(doc.querySelectorAll('.tnode') as ArrayLike<any>)
    .find((n: any) => n.getAttribute('data-path') === 'README.md');
  check('preview: the project tree lists the markdown file', !!row);
  if (row) (row as any).dispatchEvent(new w.MouseEvent('click', { bubbles: true, button: 0 }));
  await settle(w, 20);

  const btn = doc.getElementById('mdPrevBtn') as any;
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(w, 20);

  const req = socket.lastSentOf('mdRender');
  check('preview: opening it asks the engine to render', !!req && req.language === 'markdown', JSON.stringify(req || {}));
  check('preview: the request carries a requestId', typeof req?.requestId === 'number', String(req?.requestId));
  check('preview: the pane is visible after the toggle', !pane.classList.contains('hidden'), pane.className);
  check('preview: resize handle appears with the pane', !split.classList.contains('hidden'), split.className);
  check('preview: default split is 42 percent', pane.style.getPropertyValue('--mdprev-basis') === '42%', pane.style.getPropertyValue('--mdprev-basis'));

  socket.deliver({
    kind: 'mdPreview', ok: true, requestId: req?.requestId,
    html: '<h1 id="t">Title</h1><p>body</p>',
    title: 'Title', headings: [{ level: 1, text: 'Title', slug: 't', line: 3 }],
    stats: { blocks: 2, words: 2, codeBlocks: 0, links: 0, headings: 1 }, ms: 4, truncated: false,
  });
  await settle(w, 20);

  const body = doc.getElementById('mdHtml') as any;
  const outline = doc.getElementById('mdOutline') as any;
  check('preview: the engine answer is rendered into the pane', !!body && body.innerHTML.includes('<h1'), String(body?.innerHTML).slice(0, 48));
  check('preview: the headings become the outline', !!outline && outline.querySelectorAll('.mdoh').length === 1, String(outline?.innerHTML).slice(0, 48));

  // A render that finished after a newer keystroke must not win.
  socket.deliver({
    kind: 'mdPreview', ok: true, requestId: Number(req?.requestId) - 1,
    html: '<p>stale</p>', title: '', headings: [], stats: {}, ms: 1, truncated: false,
  });
  await settle(w, 20);
  check('preview: a stale render is ignored', !String(body?.innerHTML).includes('stale'), String(body?.innerHTML).slice(0, 40));

  // gotoLine is 0-based, a heading line is 1-based: line 3 means index 2.
  const oh = outline.querySelector('.mdoh') as any;
  oh.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(w, 20);
  const ta = doc.getElementById('ta') as any;
  const caretLine = String(ta.value).slice(0, ta.selectionStart).split('\n').length;
  check('preview: clicking an outline row jumps to its heading', caretLine === 3, 'line ' + caretLine);

  split.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
  check('preview: keyboard resize increases preview width', pane.style.getPropertyValue('--mdprev-basis') === '44%' && split.getAttribute('aria-valuenow') === '44', pane.style.getPropertyValue('--mdprev-basis'));
  const prefsAfterKey = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('preview: keyboard resize is persisted', prefsAfterKey.mdPreviewWidth === 44, String(prefsAfterKey.mdPreviewWidth));

  const wrap = doc.querySelector('.edwrap') as any;
  Object.defineProperty(wrap, 'getBoundingClientRect', { value: () => ({ left: 0, right: 1000, width: 1000 }) });
  split.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 500 }));
  doc.dispatchEvent(new w.MouseEvent('pointermove', { bubbles: true, clientX: 480 }));
  doc.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, clientX: 480 }));
  check('preview: drag resizes the split and saves it', pane.style.getPropertyValue('--mdprev-basis') === '52%' && split.getAttribute('aria-valuenow') === '52', pane.style.getPropertyValue('--mdprev-basis'));
  const prefsAfterDrag = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('preview: dragged width survives reload', prefsAfterDrag.mdPreviewWidth === 52, String(prefsAfterDrag.mdPreviewWidth));

  const restored = mountPage(html, JSON.stringify(prefsAfterDrag));
  await settle(restored.window, 10);
  check('preview: saved split width is restored', restored.window.document.getElementById('mdprev').style.getPropertyValue('--mdprev-basis') === '52%', restored.window.document.getElementById('mdprev').style.getPropertyValue('--mdprev-basis'));
  restored.window.close();
  w.close();
}

// ---------------------------------------------- tab lifecycle / data safety
console.log('');
{
  const mounted = mountPage(renderPyCharmHtml(7310));
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w, 25);
  const doc = w.document;
  const ta = doc.getElementById('ta') as any;
  const tab = (name: string) => doc.querySelector('.etab[data-tab="' + name + '"]');
  const marker = '# unsaved-switch-roundtrip';

  (tab('README.md') as any).click();
  await settle(w, 10);
  ta.value += '\n' + marker;
  fire(w, ta, 'input', {});
  (tab('main.py') as any).click();
  await settle(w, 10);
  (tab('README.md') as any).click();
  await settle(w, 10);
  check('tabs: unsaved edits survive switching away and back', String(ta.value).includes(marker), String(ta.value).slice(-36));
  check('tabs: the edited buffer keeps its dirty marker', !!tab('README.md')?.querySelector('.dirty'));

  const ctrlF4 = () => doc.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'F4', ctrlKey: true }));
  const dialogButtons = () => Array.from(doc.querySelectorAll('#dlgRoot .dlg-btn')) as any[];
  ctrlF4();
  check('tabs: Ctrl+F4 prompts before closing a dirty file', (doc.querySelector('#dlgRoot .dlg-title')?.textContent || '').includes('Unsaved Changes'));
  dialogButtons().find((b) => b.textContent === 'Cancel')?.click();
  check('tabs: cancelling close preserves the dirty tab', !!tab('README.md') && !!tab('README.md')?.querySelector('.dirty'));

  ctrlF4();
  dialogButtons().find((b) => b.textContent === 'Save')?.click();
  const save = socket.lastSentOf('fsWrite');
  check('tabs: Save sends the active buffer and request id', !!save && save.path === 'README.md' && String(save.content).includes(marker) && typeof save.reqId === 'number', JSON.stringify(save && { path: save.path, reqId: save.reqId }));
  check('tabs: Save keeps the tab open until disk acknowledges', !!tab('README.md'));
  socket.deliver({ kind: 'fsSaved', path: 'README.md', reqId: save?.reqId, mtime: 1, size: String(save?.content || '').length });
  await settle(w, 10);
  check('tabs: acknowledged Save closes the tab', !tab('README.md'));

  // If the user edits during a write, the earlier acknowledgement must not close
  // the tab or mark newer content clean; the next Save queues behind the first.
  check('tabs: a closed file can be reopened from recent files', openViaFile(w, 'README.md'));
  await settle(w, 10);
  ta.value += '\n# first-write';
  fire(w, ta, 'input', {});
  ctrlF4();
  dialogButtons().find((b) => b.textContent === 'Save')?.click();
  const firstWrite = socket.lastSentOf('fsWrite') as any;
  ta.value += '\n# newer-write';
  fire(w, ta, 'input', {});
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 's', ctrlKey: true }));
  check('tabs: a second save queues while the first write is in flight', socket.sent.filter((m) => m.kind === 'fsWrite').length === 2, String(socket.sent.filter((m) => m.kind === 'fsWrite').length));
  socket.deliver({ kind: 'fsSaved', path: 'README.md', reqId: firstWrite.reqId, mtime: 2, size: String(firstWrite.content).length });
  await settle(w, 10);
  const secondWrite = socket.lastSentOf('fsWrite') as any;
  check('tabs: an earlier save ACK keeps newer edits open', !!tab('README.md') && !!tab('README.md')?.querySelector('.dirty'), String(secondWrite?.reqId));
  check('tabs: the queued write contains the newest buffer', secondWrite?.reqId !== firstWrite.reqId && String(secondWrite?.content).includes('# newer-write'), String(secondWrite?.content).slice(-35));
  socket.deliver({ kind: 'fsSaved', path: 'README.md', reqId: secondWrite.reqId, mtime: 3, size: String(secondWrite.content).length });
  await settle(w, 10);
  check('tabs: the newest save ACK finally closes the tab', !tab('README.md'));

  (tab('utils.py') as any).click();
  await settle(w, 10);
  ta.value += '\n# discard-test';
  fire(w, ta, 'input', {});
  const closeButton = tab('utils.py')?.querySelector('[data-close]') as any;
  closeButton.click();
  dialogButtons().find((b) => b.textContent === "Don't Save")?.click();
  check('tabs: explicit Don\'t Save discards and closes', !tab('utils.py'));

  // A failed write must never silently close or clean the buffer.
  (tab('main.py') as any).click();
  await settle(w, 10);
  ta.value += '\n# write-failure-test';
  fire(w, ta, 'input', {});
  ctrlF4();
  dialogButtons().find((b) => b.textContent === 'Save')?.click();
  const failedSave = socket.lastSentOf('fsWrite');
  socket.deliver({ kind: 'fsError', path: 'main.py', reqId: failedSave?.reqId, code: 'denied', message: 'write denied' });
  await settle(w, 10);
  check('tabs: a failed Save leaves the dirty file open', !!tab('main.py') && !!tab('main.py')?.querySelector('.dirty'));
  check('tabs: a failed Save explains the write error', (doc.querySelector('#dlgRoot .dlg-title')?.textContent || '').includes('Save failed'));
  w.close();
}

// Closing a group of dirty tabs should produce one Save All decision, not a
// stack of dialogs that replaces itself while iterating over the tabs.
console.log('');
{
  const mounted = mountPage(renderPyCharmHtml(7310));
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w, 20);
  const doc = w.document;
  const ta = doc.getElementById('ta') as any;
  const tab = (name: string) => doc.querySelector('.etab[data-tab="' + name + '"]');

  (tab('main.py') as any).click();
  ta.value += '\n# save-all-main';
  fire(w, ta, 'input', {});
  (tab('utils.py') as any).click();
  ta.value += '\n# save-all-utils';
  fire(w, ta, 'input', {});
  doc.getElementById('etabs')?.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  Array.from(doc.querySelectorAll('#ctxMenu .citem') as ArrayLike<any>)
    .find((n: any) => (n.textContent || '').includes('Close All'))?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('tabs: Close All presents one Save All decision', (doc.querySelector('#dlgRoot .dlg-title')?.textContent || '').includes('Unsaved Changes'));
  Array.from(doc.querySelectorAll('#dlgRoot .dlg-btn') as ArrayLike<any>)
    .find((b: any) => b.textContent === 'Save All')?.click();
  const writes = socket.sent.filter((m) => m.kind === 'fsWrite');
  check('tabs: Save All writes each dirty buffer', writes.length === 2 && writes.some((m: any) => m.path === 'main.py') && writes.some((m: any) => m.path === 'utils.py'), JSON.stringify(writes.map((m: any) => m.path)));
  check('tabs: Save All waits for disk acknowledgement', !!tab('main.py') && !!tab('utils.py'));
  const first = writes[0] as any, second = writes[1] as any;
  socket.deliver({ kind: 'fsSaved', path: first.path, reqId: first.reqId, mtime: 1, size: String(first.content).length });
  await settle(w, 5);
  check('tabs: one Save All acknowledgement does not close the group early', !!tab('main.py') && !!tab('utils.py'));
  socket.deliver({ kind: 'fsSaved', path: second.path, reqId: second.reqId, mtime: 2, size: String(second.content).length });
  await settle(w, 10);
  check('tabs: Save All closes tabs only after every write succeeds', !tab('main.py') && !tab('utils.py') && !tab('README.md'));
  w.close();
}

// ------------------------------------------------ bounded run-console output
console.log('');
{
  const mounted = mountPage(renderPyCharmHtml(7310));
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w, 20);
  q(w, '#runBtn').click();
  socket.deliver({ kind: 'runOut', stream: 'stdout', text: 'x'.repeat(600 * 1024) });
  const text = String(q(w, '#runOut')?.textContent || '');
  check('console: noisy output is capped to a bounded DOM buffer', text.length < 525 * 1024, String(text.length));
  check('console: cap is visible to the user', text.includes('console output truncated'), text.slice(-70));
  socket.deliver({ kind: 'runOut', stream: 'stdout', text: 'later output must not regrow the buffer' });
  check('console: later chunks do not bypass the cap', String(q(w, '#runOut')?.textContent || '').length === text.length);
  w.close();
}

// ------------------------------------------------------- folding (gutter + LSP)
// jsdom has no layout, so the *folded* state cannot be observed here; what this
// pins is the wiring that has been wrong before: the addons actually ship, the
// client asks for spans on a debounce, and the request carries the buffer.
console.log('');
{
  const html = renderPyCharmHtml(7311);
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  const doc = w.document;
  check('folding: the vendored foldgutter addon is inlined', html.includes('CodeMirror.defineOption("foldGutter"'));
  check('folding: the brace and indent finders are inlined', html.includes('CodeMirror.fold.brace') && html.includes('CodeMirror.fold.indent'));
  check('folding: the fold gutter has theme rules', html.includes('.CodeMirror-foldgutter'));
  check('folding: Code > Fold Code Block exists', html.includes('Fold Code Block'), '');
  await settle(w, 20);

  const foldsSent = (): number => socket.sent.filter((m: any) => m.kind === 'folding').length;
  // Boot opens a buffer, which already asks once. Wait that out so the baseline
  // below measures the *edit*, not the file switch.
  await settle(w, 600);
  const beforeEdit = foldsSent();
  const ta = doc.getElementById('ta') as any;
  ta.value = 'def outer():\n    def inner():\n        return 1\n    return inner\n';
  fire(w, ta, 'input', {});
  await settle(w, 60);
  check('folding: no request before the debounce', foldsSent() === beforeEdit, `${beforeEdit} -> ${foldsSent()}`);
  await settle(w, 700);
  const req = socket.lastSentOf('folding') as any;
  check('folding: an edit asks the server for spans', foldsSent() === beforeEdit + 1, `${beforeEdit} -> ${foldsSent()}`);
  check('folding: the request carries the buffer and its language', !!req && String(req.code).includes('def outer') && !!req.language, req ? String(req.code).slice(0, 12) : '');
  socket.deliver({ kind: 'folding', requestId: req.requestId, ranges: [{ startLine: 0, endLine: 3 }] });
  await settle(w, 20);
  check('folding: a reply for the current buffer is not reported as an error', !q(w, '#toast')?.textContent?.includes('folding'));
  w.close();
}

// ------------------------------------------------- inlay hints (inline widgets)
// jsdom cannot lay out a zero-width widget, so what this pins is the request path
// and the silence rules: a hint layer that exists, one request per edit after the
// debounce, and an unsupported reply that is not turned into a toast.
console.log('');
{
  const html = renderPyCharmHtml(7312);
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  const doc = w.document;
  check('inlay: the hint layer is inlined', html.includes('function setInlayHints(') && html.includes('.cm-inlay'));
  await settle(w, 20);
  // Boot opens a buffer, which already asks once; let that one go by.
  await settle(w, 700);
  const sentOf = (): any[] => socket.sent.filter((m: any) => m.kind === 'inlayHints');
  const before = sentOf().length;
  const ta = doc.getElementById('ta') as any;
  ta.value = 'count = 3\nname = "x"\n';
  fire(w, ta, 'input', {});
  await settle(w, 60);
  check('inlay: no request before the debounce', sentOf().length === before, `${before} -> ${sentOf().length}`);
  await settle(w, 600);
  const req = socket.lastSentOf('inlayHints') as any;
  check(
    'inlay: an edit asks for hints for the whole small buffer',
    sentOf().length === before + 1 && !!req && req.fromLine === 0 && req.toLine === 2 && String(req.code).includes('count = 3'),
    req ? `${req.fromLine}..${req.toLine}` : 'no request',
  );
  socket.deliver({ kind: 'inlayHints', requestId: req.requestId, hints: [{ line: 0, character: 5, label: 'int', kind: 'type' }] });
  await settle(w, 20);
  check('inlay: a reply for the current buffer is not reported as an error', !/inlay/i.test(String(q(w, '#toast')?.textContent ?? '')));
  socket.deliver({ kind: 'inlayHints', requestId: req.requestId, hints: [], unsupported: 'server does not advertise inlayHint' });
  await settle(w, 20);
  check('inlay: an unsupported reply stays silent', !/inlay/i.test(String(q(w, '#toast')?.textContent ?? '')));
  w.close();
}

// ---------------------------------------- plugin dialog: the remote index list
// The browser build has /plugins over HTTP; the Tauri shell has no HTTP server,
// so the same catalogue has to be reachable from the Tools menu. What this pins
// is the request path and the refusal that happens *before* a click: a row
// without a published sha256 offers no Install button at all.
console.log('');
{
  const html = renderPyCharmHtml(7313);
  // The index section only exists on the Tauri host: the browser build sends the
  // user to /plugins, which the Rust shell does not serve.
  const { window: w } = mountPage(html, undefined, 'tauri');
  check(
    'catalog: the shell inlines the index section',
    html.includes("kind: 'catalogSearch'") && html.includes('no sha256 published'),
  );
  const label = (m: any): string =>
    Array.from(m.childNodes).filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join('').trim();
  qa(w, '#menubar .menu').find((m: any) => label(m) === 'Tools')?.click();
  await settle(w, 20);
  qa(w, '#menubar .menu.open .item')
    .find((b: any) => (b.textContent || '').indexOf('Language Plugins') !== -1)
    ?.click();
  await settle(w, 20);
  check('catalog: Tools > Language Plugins opens the dialog', !!q(w, '#dlgRoot .dlg-body #catQ'));
  check('catalog: opening the dialog asks for the installed plugins', !!FakeTauri.sent('listPlugins'));
  check(
    'catalog: a dialog with no search yet says how to get one',
    /Search the index to install/.test(String(q(w, '#dlgRoot .dlg-body')?.textContent ?? '')),
  );

  const input = q(w, '#dlgRoot .dlg-body #catQ');
  input.value = 'rust';
  fire(w, input, 'keydown', { key: 'Enter' });
  const search = FakeTauri.sent('catalogSearch');
  check('catalog: Enter in the search box asks the index', search?.query === 'rust', String(search?.query ?? ''));

  FakeTauri.emit('engine_message', {
    kind: 'catalog',
    query: 'rust',
    entries: [
      { id: 'rust', version: '1.2.0', displayName: 'Rust', description: 'Rust support', sha256: true, installed: false },
      { id: 'zig', version: '0.1.0', displayName: 'Zig', sha256: false, installed: false },
    ],
  });
  await settle(w, 20);
  const installOf = (id: string): any =>
    qa(w, '#dlgRoot .dlg-body button[data-cat]').find((b: any) => b.getAttribute('data-cat') === id);
  check('catalog: the reply paints one row per entry', !!installOf('rust') && !!installOf('zig'));
  check('catalog: a row with a published hash offers Install', installOf('rust')?.disabled === false);
  check(
    'catalog: a row without a published hash is disabled and says why',
    installOf('zig')?.disabled === true &&
      /no sha256 published/.test(String(q(w, '#dlgRoot .dlg-body')?.textContent ?? '')),
  );

  installOf('rust')?.click();
  await settle(w, 20);
  const install = FakeTauri.sent('langInstall');
  check(
    'catalog: Install carries the id and the version the row described',
    install?.id === 'rust' && install?.version === '1.2.0',
    JSON.stringify(install && { id: install.id, version: install.version }),
  );
  check('catalog: the clicked row stops offering a second install', installOf('rust')?.disabled === true);

  FakeTauri.emit('engine_message', { kind: 'catalog', query: '', entries: [], unavailable: 'no plugin index is configured' });
  await settle(w, 20);
  check(
    'catalog: an unreachable index is reported as unavailable, not as empty',
    /index unavailable: no plugin index is configured/.test(String(q(w, '#dlgRoot .dlg-body')?.textContent ?? '')),
  );
  w.close();
}

// ------------------------------------------------------------- AI Assistant
// The panel used to be a shell that printed a fixed "not configured" paragraph.
// What this pins: opening it asks the engine for the configuration, the key input
// is a password field that is cleared after saving, a prompt becomes one aiAsk,
// streamed text lands in the output without being parsed as HTML, and the drawer
// (Alt+A) goes through the same path instead of faking an answer.
console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(renderPyCharmHtml(7314));
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  const doc = w.document;
  const btn = qa(w, '#strip .sbtn').find((b: any) => (b.title ?? '').indexOf('AI') === 0);
  check('ai: the strip exposes the AI Assistant window', !!btn);
  btn.click();
  await settle(w, 20);
  check('ai: the panel renders its input, output and stop button',
    !!q(w, '#panelBody .ai-wrap #aiInput') && !!q(w, '#panelBody #aiOut') && !!q(w, '#panelBody #aiStop'));
  check('ai: opening the panel asks the engine for the configuration', !!socket.lastSentOf('aiConfig'));
  check('ai: a fresh install asks the engine for the status instead of inventing an answer',
    /Checking the provider/.test(String(q(w, '#aiState')?.textContent ?? '')) && !/No model was called/.test(String(q(w, '#panelBody')?.textContent ?? '')));

  socket.deliver({ kind: 'aiConfig', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', hasKey: true });
  await settle(w, 20);
  check('ai: the configuration reply labels the provider and hides the key',
    /gpt-4o-mini .* key saved/.test(String(q(w, '#aiState')?.textContent ?? '')) &&
      !/sk-/.test(String(q(w, '#panelBody')?.textContent ?? '')) &&
      !String(q(w, '#panelBody')?.innerHTML ?? '').includes('sk-'));
  check('ai: the base URL and model are prefilled for editing',
    (q(w, '#aiBase') as any)?.value === 'https://api.example.com/v1' && (q(w, '#aiModel') as any)?.value === 'gpt-4o-mini');

  (q(w, '#aiGear') as any).click();
  await settle(w, 20);
  check('ai: Configure reveals the settings form', !(q(w, '#aiCfg') as any).classList.contains('hidden'));
  check('ai: the key field is a password field', (q(w, '#aiKey') as any)?.type === 'password');
  (q(w, '#aiKey') as any).value = 'sk-test-abcdef';
  (q(w, '#aiSave') as any).click();
  await settle(w, 20);
  const saved = socket.lastSentOf('aiSetConfig') as any;
  check('ai: saving sends the key once and clears the field',
    saved?.key === 'sk-test-abcdef' && (q(w, '#aiKey') as any).value === '');
  check('ai: the key is never written into the page', !String(q(w, '#panelBody')?.innerHTML ?? '').includes('sk-test-abcdef'));

  (q(w, '#aiSave') as any).click();
  await settle(w, 20);
  const resaved = socket.lastSentOf('aiSetConfig') as any;
  check('ai: saving again without retyping the key keeps the stored key',
    !!resaved && !('key' in resaved), JSON.stringify(resaved && Object.keys(resaved)));

  (q(w, '#aiInput') as any).value = 'what does this do?';
  (q(w, '#aiAsk') as any).click();
  await settle(w, 20);
  const ask = socket.lastSentOf('aiAsk') as any;
  check('ai: the prompt is sent with the current language',
    !!ask && ask.prompt === 'what does this do?' && ask.language === 'python', JSON.stringify(ask && { language: ask.language }));
  check('ai: Stop is enabled while an answer streams', (q(w, '#aiStop') as any).disabled === false);
  check('ai: the panel says it is waiting rather than showing an empty box',
    /Thinking/.test(String(q(w, '#aiOut')?.textContent ?? '')));

  socket.deliver({ kind: 'aiOut', requestId: ask.requestId, text: '<b>not markup</b> ' });
  socket.deliver({ kind: 'aiOut', requestId: ask.requestId, text: 'second chunk' });
  await settle(w, 20);
  check('ai: streamed text is appended as text, never parsed as HTML',
    /<b>not markup<\/b> second chunk/.test(String(q(w, '#aiOut')?.textContent ?? '')) && qa(w, '#aiOut b').length === 0);

  socket.deliver({ kind: 'aiDone', requestId: ask.requestId, ok: true, ms: 12, bytes: 27 });
  await settle(w, 20);
  check('ai: a finished answer re-enables the next ask and disables Stop', (q(w, '#aiStop') as any).disabled === true);

  (q(w, '#aiInput') as any).value = 'second question';
  (q(w, '#aiAsk') as any).click();
  await settle(w, 20);
  const ask2 = socket.lastSentOf('aiAsk') as any;
  socket.deliver({ kind: 'aiDone', requestId: ask2.requestId, ok: false, error: 'provider returned HTTP 401' });
  await settle(w, 20);
  check('ai: a failed answer is visible in the panel and does not hang the Stop button',
    /AI: provider returned HTTP 401/.test(String(q(w, '#aiOut')?.textContent ?? '')) && (q(w, '#aiStop') as any).disabled === true);

  // Stop sends the cancel frame for the running request.
  (q(w, '#aiInput') as any).value = 'long one';
  (q(w, '#aiAsk') as any).click();
  await settle(w, 20);
  const ask3 = socket.lastSentOf('aiAsk') as any;
  (q(w, '#aiStop') as any).click();
  await settle(w, 20);
  const cancel = socket.lastSentOf('aiCancel') as any;
  check('ai: Stop sends aiCancel for the running request', cancel?.requestId === ask3.requestId);
  socket.deliver({ kind: 'aiCancelled', requestId: ask3.requestId, ok: true });
  await settle(w, 20);
  check('ai: a cancelled answer says so instead of pretending it finished',
    /cancelled/.test(String(q(w, '#aiOut')?.textContent ?? '')) && (q(w, '#aiStop') as any).disabled === true);

  // The drawer is the second entry point: same frames, no mock text.
  const drawer = q(w, '#assistantToggle') as any;
  drawer?.click();
  await settle(w, 20);
  (q(w, '#assistantInput') as any).value = 'from the drawer';
  (q(w, '#assistantForm .assistant-send') as any)?.click();
  await settle(w, 20);
  const ask4 = socket.lastSentOf('aiAsk') as any;
  check('ai: the drawer asks the engine too', ask4?.prompt === 'from the drawer');
  socket.deliver({ kind: 'aiOut', requestId: ask4.requestId, text: 'drawer answer' });
  await settle(w, 20);
  check('ai: streamed text reaches the drawer bubble',
    /drawer answer/.test(String(q(w, '#assistantMessages')?.textContent ?? '')));
  check('ai: the old fake "Unavailable" reply is gone',
    !/No model was called/.test(String(q(w, '#assistantMessages')?.textContent ?? '')));
  socket.deliver({ kind: 'aiDone', requestId: ask4.requestId, ok: true, ms: 5, bytes: 12 });
  await settle(w, 20);
  w.close();
}

// ------------------------------------------------ crash recovery (draft copies)
// The copy is debounced by 2s in the client, so this block is the one place the
// suite waits on real time. Removing either half of the mechanism goes red:
// no `draftSave` without the timer, no `draftDrop` without the disk ACK.
console.log('');
{
  const mounted = mountPage(renderPyCharmHtml(7310));
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  const doc = w.document;
  const tabOf = (name: string): any => qa(w, '#etabs .etab').find((b: any) => b.getAttribute('data-tab') === name);
  const sentOf = (kind: string): any[] => socket.sent.filter((m: any) => m.kind === kind);
  await settle(w, 20);
  check('drafts: boot asks the engine for leftovers', !!socket.lastSentOf('draftList'));

  const ta = doc.getElementById('ta') as any;
  ta.value = 'x = 1  # draft-gate\n';
  fire(w, ta, 'input', {});
  await settle(w, 60);
  check('drafts: a keystroke alone does not write a copy', sentOf('draftSave').length === 0, String(sentOf('draftSave').length));

  await settle(w, 2200);
  const copy = socket.lastSentOf('draftSave') as any;
  check('drafts: a dirty buffer produces a recovery copy', !!copy && String(copy.content).includes('draft-gate'), String(copy?.content || '').slice(-24));
  check('drafts: the status bar says a copy exists', /Draft \d\d:\d\d/.test(String(q(w, '#stDraft')?.textContent || '')), String(q(w, '#stDraft')?.textContent || ''));

  doc.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 's', ctrlKey: true }));
  await settle(w, 20);
  const write = socket.lastSentOf('fsWrite') as any;
  socket.deliver({ kind: 'fsSaved', path: write.path, reqId: write.reqId, mtime: 7, size: String(write.content).length });
  await settle(w, 20);
  check('drafts: a disk ACK retires the copy', sentOf('draftDrop').some((m: any) => m.path === write.path), JSON.stringify(sentOf('draftDrop').map((m: any) => m.path)));
  check('drafts: the status cell hides once nothing is pending', !String(q(w, '#stDraft')?.textContent || ''), String(q(w, '#stDraft')?.textContent || ''));

  socket.deliver({
    kind: 'drafts',
    drafts: [
      { path: 'README.md', content: '# recovered\n', savedAt: Date.now(), stale: false, sameAsDisk: false },
      { path: 'utils.py', content: 'x = 2\n', savedAt: Date.now() - 1000, stale: true, sameAsDisk: false },
      { path: 'main.py', content: 'same\n', savedAt: Date.now(), stale: false, sameAsDisk: true },
    ],
  });
  await settle(w, 20);
  check('drafts: leftovers are offered, not forced', (doc.querySelector('#dlgRoot .dlg-title')?.textContent || '').includes('Restore Unsaved Changes'));
  check('drafts: a copy already on disk is dropped without asking', sentOf('draftDrop').some((m: any) => m.path === 'main.py'));
  const writesBefore = sentOf('fsWrite').length;
  Array.from(doc.querySelectorAll('#dlgRoot .dlg-btn') as ArrayLike<any>)
    .find((b: any) => b.textContent === 'Restore')?.click();
  await settle(w, 20);
  check('drafts: restore opens the recovered text as an unsaved tab', !!tabOf('README.md')?.querySelector('.dirty'));
  check('drafts: restore never writes to disk', sentOf('fsWrite').length === writesBefore, String(sentOf('fsWrite').length - writesBefore));
  check('drafts: a copy whose file changed lands beside it as .recovered', !!tabOf('utils.py.recovered'), JSON.stringify(qa(w, '#etabs .etab').map((b: any) => b.getAttribute('data-tab'))));

  socket.deliver({ kind: 'drafts', drafts: [{ path: 'utils.py', content: 'y = 3\n', savedAt: Date.now(), stale: false, sameAsDisk: false }] });
  await settle(w, 20);
  const dropsBefore = sentOf('draftDrop').length;
  Array.from(doc.querySelectorAll('#dlgRoot .dlg-btn') as ArrayLike<any>)
    .find((b: any) => b.textContent === 'Discard All')?.click();
  await settle(w, 20);
  check('drafts: Discard All removes the copy instead of restoring it', sentOf('draftDrop').length === dropsBefore + 1, String(sentOf('draftDrop').length - dropsBefore));
  w.close();
}

// ---------------------------------------------- file operations + preferences
console.log('');
{
  const mounted = mountPage(renderPyCharmHtml(7312));
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  const doc = w.document;
  await settle(w, 20);
  const tabOf = (name: string) => qa(w, '.etab').find((b: any) => b.getAttribute('data-tab') === name) as any;

  check('files: a freshly opened file carries no dirty marker',
    !!tabOf('README.md') && !tabOf('README.md').querySelector('.dirty'));
  const writesBefore = socket.sent.filter((m: any) => m.kind === 'fsWrite').length;
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 's', ctrlKey: true }));
  await settle(w, 10);
  check('files: saving an unchanged file does not rewrite it',
    socket.sent.filter((m: any) => m.kind === 'fsWrite').length === writesBefore);

  const readsBefore = socket.sent.filter((m: any) => m.kind === 'fsRead').length;
  (qa(w, '#menubar .menu')[0] as any).click();
  const reload = qa(w, '#menubar .menu .pop .item')
    .find((b: any) => (b.textContent || '').indexOf('Reload from Disk') !== -1) as any;
  check('files: File menu offers Reload from Disk', !!reload);
  reload && reload.click();
  await settle(w, 10);
  check('files: Reload from Disk re-reads the active document',
    socket.sent.filter((m: any) => m.kind === 'fsRead').length === readsBefore + 1,
    String(socket.sent.filter((m: any) => m.kind === 'fsRead').length - readsBefore));

  doc.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'S', ctrlKey: true, altKey: true }));
  await settle(w, 10);
  check('settings: Preferences opens with a six-category tree',
    qa(w, '.settings-dlg .set-cat').length === 6 && qa(w, '.settings-dlg .set-page').length === 6,
    `${qa(w, '.settings-dlg .set-cat').length} categories`);
  (qa(w, '.settings-dlg .set-cat').find((b: any) => b.getAttribute('data-cat') === 'editor') as any).click();
  check('settings: selecting a category shows only its page',
    (q(w, '.settings-dlg .set-page[data-page="editor"]') as any).style.display !== 'none' &&
    (q(w, '.settings-dlg .set-page[data-page="appearance"]') as any).style.display === 'none');
  (q(w, '.settings-dlg [data-s="softWrap"]') as any).checked = true;
  (q(w, '.settings-dlg [data-s="tabSize"]') as any).value = '2';
  const search = q(w, '.settings-dlg .set-search') as any;
  search.value = 'interpreter';
  fire(w, search, 'input', {});
  check('settings: search filters the category tree',
    (q(w, '.settings-dlg .set-cat[data-cat="interpreter"]') as any).style.display !== 'none' &&
    (q(w, '.settings-dlg .set-cat[data-cat="markdown"]') as any).style.display === 'none');
  (qa(w, '.settings-dlg [data-foot]').find((b: any) => b.getAttribute('data-foot') === 'ok') as any).click();
  await settle(w, 10);
  const saved = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('settings: OK persists editor options', saved.softWrap === true && Number(saved.tabSize) === 2,
    JSON.stringify({ softWrap: saved.softWrap, tabSize: saved.tabSize }));
  check('settings: OK closes the dialog', !q(w, '.settings-dlg'));
  w.close();
}

// ---------------------------------------------------------- encoding + EOL controls
console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(renderPyCharmHtml(7313));
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w, 20);
  const doc = w.document;
  socket.deliver({ kind: 'fsFile', file: { path: 'main.py', content: '\uFEFFalpha\r\nbeta\r\n', editable: true, truncated: false, mtime: 1 } });
  await settle(w, 20);
  check('file format: CRLF and UTF-8 BOM are detected on open',
    q(w, '#stEol')?.textContent === 'CRLF' && q(w, '#stEnc')?.textContent === 'UTF-8 BOM',
    (q(w, '#stEnc')?.textContent ?? '') + ' / ' + (q(w, '#stEol')?.textContent ?? ''));
  check('file format: editor text is normalized while metadata is retained',
    q(w, '#ta')?.value === 'alpha\nbeta\n', JSON.stringify(q(w, '#ta')?.value));

  const chooseStatus = (cell: string, label: string) => {
    q(w, cell)?.click();
    const item = qa(w, '#ctxMenu .citem').find((row: any) => (row.querySelector('.clbl')?.textContent ?? '').trim() === label);
    item?.click();
    return !!item;
  };
  check('file format: EOL selector offers LF and CRLF', chooseStatus('#stEol', 'LF'));
  check('file format: encoding selector offers UTF-8 without BOM', chooseStatus('#stEnc', 'UTF-8'));
  check('file format: changed metadata marks the buffer dirty', !!qa(w, '#etabs .etab .dirty').length);
  fire(w, doc, 'keydown', { key: 's', ctrlKey: true });
  await settle(w, 10);
  const lfWrite = socket.lastSentOf('fsWrite') as any;
  check('file format: save writes LF and removes the UTF-8 BOM',
    lfWrite?.content === 'alpha\nbeta\n', JSON.stringify(lfWrite?.content));
  socket.deliver({ kind: 'fsSaved', path: lfWrite.path, reqId: lfWrite.reqId, mtime: 2, size: String(lfWrite.content).length });
  await settle(w, 10);

  check('file format: CRLF selector is interactive', chooseStatus('#stEol', 'CRLF'));
  check('file format: UTF-8 BOM selector is interactive', chooseStatus('#stEnc', 'UTF-8 with BOM'));
  fire(w, doc, 'keydown', { key: 's', ctrlKey: true });
  await settle(w, 10);
  const crlfWrite = socket.lastSentOf('fsWrite') as any;
  check('file format: save writes CRLF and restores the BOM',
    String(crlfWrite?.content || '').charCodeAt(0) === 0xFEFF && String(crlfWrite?.content || '').indexOf('\r\n') !== -1,
    JSON.stringify(crlfWrite?.content));
  w.close();
}

// ---------------------------------------------------------- project restore
console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(
    renderPyCharmHtml(7314),
    JSON.stringify({ lastProjectRoot: '/work/last', restoreProject: true, tabs: ['main.py'], current: 'main.py' }),
  );
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w, 20);

  const open = socket.sent.find((m: any) => m.kind === 'openFolder') as any;
  check('startup: reopens the last project folder',
    open?.path === '/work/last' && typeof open?.reqId === 'number', JSON.stringify(open));
  check('startup: it waits for the acknowledged root before loading files',
    socket.sent.filter((m: any) => m.kind === 'fsList' || m.kind === 'fsRead').length === 0);

  // The engine announces its default root on every connection. That frame can
  // arrive before the openFolder reply; accepting it would boot the default
  // folder and ask discovery about the wrong project.
  socket.deliver({ kind: 'fsRoot', reqId: 0, root: '/default', name: 'default' });
  await settle(w);
  check('startup: the bootstrap root does not replace the pending restore',
    socket.sent.filter((m: any) => m.kind === 'interpreters').length === 0 &&
      socket.sent.filter((m: any) => m.kind === 'fsList').length === 0);

  socket.deliver({ kind: 'fsRoot', reqId: open.reqId, root: '/work/last', name: 'last' });
  await settle(w);
  const saved = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('startup: only the acknowledged project root is persisted',
    saved.lastProjectRoot === '/work/last', String(saved.lastProjectRoot));
  check('startup: the restored project loads its own tree and file',
    socket.sent.some((m: any) => m.kind === 'fsList' && m.path === '') &&
      socket.sent.some((m: any) => m.kind === 'fsRead' && m.path === 'main.py'));

  const auto = socket.sent.find((m: any) => m.kind === 'interpreters') as any;
  check('startup: local environment discovery asks once for the restored root',
    !!auto && auto.auto === true && typeof auto.requestId === 'number', JSON.stringify(auto));

  socket.deliver({
    kind: 'interpreters', language: 'python', root: '/default', requestId: auto?.requestId, auto: true,
    candidates: [{ path: '/default/.venv/Scripts/python.exe', label: 'default venv', kind: 'venv', source: '.venv' }],
  });
  await settle(w);
  check('startup: a discovery reply for the old root is ignored', !socket.lastSentOf('setInterpreter'));

  socket.deliver({
    kind: 'interpreters', language: 'python', root: '/work/last', requestId: auto?.requestId, auto: true,
    candidates: [{ path: '/work/last/.venv/Scripts/python.exe', label: 'Python 3.12.4 (.venv)', version: '3.12.4', kind: 'venv', source: '.venv' }],
  });
  await settle(w);
  const pinned = socket.lastSentOf('setInterpreter') as any;
  const finalPrefs = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('startup: the best local venv is adopted automatically',
    pinned?.path === '/work/last/.venv/Scripts/python.exe' && pinned?.auto === true, JSON.stringify(pinned));
  check('startup: the automatic choice is remembered for this project',
    (finalPrefs.projectInterpreters || {})['/work/last'] === '/work/last/.venv/Scripts/python.exe',
    JSON.stringify(finalPrefs.projectInterpreters));
  w.close();
}

// ---------------------------------------------------------- stale project
console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(renderPyCharmHtml(7315), JSON.stringify({ lastProjectRoot: '/gone' }));
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w, 20);
  const open = socket.sent.find((m: any) => m.kind === 'openFolder') as any;
  check('startup: a stale path is attempted once', !!open && open.path === '/gone', JSON.stringify(open));

  socket.deliver({ kind: 'fsError', reqId: open?.reqId, path: '/gone', message: 'not found' });
  await settle(w);
  const saved = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('startup: a refused project is cleared from preferences', saved.lastProjectRoot === '', JSON.stringify(saved.lastProjectRoot));
  check('startup: a refused project falls back to the default folder',
    socket.sent.some((m: any) => m.kind === 'fsList' && m.path === '') &&
      socket.sent.some((m: any) => m.kind === 'fsRead' && m.path === 'main.py'));
  check('startup: a refused project is not retried in a loop',
    socket.sent.filter((m: any) => m.kind === 'openFolder').length === 1,
    String(socket.sent.filter((m: any) => m.kind === 'openFolder').length));
  w.close();
}

// ---------------------------------------------------------- compiler choice
console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(
    renderPyCharmHtml(7316),
    JSON.stringify({
      lastProjectRoot: '/work/manual', restoreProject: false, autoVenv: false,
      projectInterpreters: { '/work/manual': 'C:/Python312/python.exe' },
    }),
  );
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w, 20);
  const before = socket.sent.length;
  socket.deliver({ kind: 'fsRoot', reqId: 42, root: '/work/manual', name: 'manual' });
  await settle(w);
  const savedPin = socket.lastSentOf('setInterpreter') as any;
  check('interpreter: a saved per-project compiler applies even with auto matching off',
    savedPin?.path === 'C:/Python312/python.exe', JSON.stringify(savedPin));
  check('interpreter: auto matching off sends no discovery request',
    !socket.sent.slice(before).some((m: any) => m.kind === 'interpreters'));

  socket.deliver({
    kind: 'interpreters', language: 'python', root: '/work/manual', requestId: 77, active: null, pinned: null,
    candidates: [{ path: '/usr/bin/python3', label: 'Python 3.11', version: '3.11', kind: 'path', source: 'PATH' }],
  });
  await settle(w);
  const custom = q(w, '.dlg input[data-f="custom"]') as any;
  check('interpreter: the picker offers a compiler path field', !!custom);
  if (custom) custom.value = 'D:/Compilers/Python313/python.exe';
  const applyButton = Array.from(q(w, '.dlg').querySelectorAll('.dlg-btn'))
    .find((b: any) => b.textContent === 'Apply') as any;
  applyButton?.click();
  await settle(w);
  const typed = socket.lastSentOf('setInterpreter') as any;
  const prefsAfterApply = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('interpreter: a typed compiler path is sent for engine validation',
    typed?.path === 'D:/Compilers/Python313/python.exe', JSON.stringify(typed));
  check('interpreter: the typed path is remembered for this project',
    (prefsAfterApply.projectInterpreters || {})['/work/manual'] === 'D:/Compilers/Python313/python.exe',
    JSON.stringify(prefsAfterApply.projectInterpreters));

  socket.deliver({
    kind: 'interpreters', language: 'python', root: '/work/manual', requestId: 78, active: null, pinned: null,
    candidates: [{ path: '/usr/bin/python3', label: 'Python 3.11', version: '3.11', kind: 'path', source: 'PATH' }],
  });
  await settle(w);
  const browse = Array.from(q(w, '.dlg').querySelectorAll('.dlg-btn'))
    .find((b: any) => b.textContent === 'Browse…') as any;
  check('interpreter: Browse… is available in the picker', !!browse);
  browse?.click();
  await settle(w);
  const pick = socket.lastSentOf('nativePick') as any;
  check('interpreter: Browse opens the native executable picker',
    pick?.mode === 'file' && /compiler/i.test(String(pick?.title ?? '')), JSON.stringify(pick));
  socket.deliver({ kind: 'nativePicked', path: 'D:/Compilers/Python314/python.exe' });
  await settle(w);
  const browsed = socket.lastSentOf('setInterpreter') as any;
  check('interpreter: the picked executable becomes the project compiler',
    browsed?.path === 'D:/Compilers/Python314/python.exe', JSON.stringify(browsed));
  w.close();
}

// ---------------------------------------------------------- small IDE features
console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);

  const actionKey = fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  check('find action: Ctrl+Shift+A is consumed', (actionKey as any).defaultPrevented === true);
  check('find action: Search Everywhere opens on the Actions tab',
    q(w, '#searchModal').classList.contains('open') &&
      q(w, '#searchChips .chip[data-tab="actions"]').classList.contains('on'));
  const search = q(w, '#searchInput') as any;
  search.value = 'Rename';
  fire(w, search, 'input', {});
  await settle(w);
  const actionNames = qa(w, '#searchBody .mres .nm').map((n: any) => String(n.textContent ?? ''));
  check('find action: real menu commands are searchable', actionNames.indexOf('Refactor > Rename') >= 0, actionNames.slice(0, 5).join(','));
  const groups = qa(w, '#searchBody .mgrp').map((g: any) => String(g.textContent ?? ''));
  check('find action: the Actions tab hides files and symbols', groups.length > 0 && groups.every((g) => g === 'Actions'), groups.join(','));

  const surroundKey = fire(w, w.document, 'keydown', { key: 't', ctrlKey: true, altKey: true });
  const historyKey = fire(w, w.document, 'keydown', { key: '`', altKey: true });
  const toastText = String(q(w, '#toast')?.textContent ?? '');
  check('shortcuts: dead Surround With / Show History prompts are gone',
    (surroundKey as any).defaultPrevented === false &&
      (historyKey as any).defaultPrevented === false &&
      !/Surround With|Show History/.test(toastText), toastText);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ta = q(w, '#ta') as any;
  ta.value = 'one\ntwo\nthree';
  ta.setSelectionRange(4, 4);

  const bookmarkKey = fire(w, ta, 'keydown', { key: 'F11' });
  check('bookmarks: F11 is consumed', (bookmarkKey as any).defaultPrevented === true);
  check('bookmarks: F11 marks the caret line',
    qa(w, '#glines .gline.hasbm').length === 1 &&
      q(w, '#glines .gline[data-line="2"]').classList.contains('hasbm'));
  let prefs = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('bookmarks: a line bookmark survives into preferences',
    prefs.bookmarks?.['main.py']?.['2']?.label === 'two', JSON.stringify(prefs.bookmarks));

  ta.setSelectionRange(8, 8);
  fire(w, ta, 'keydown', { key: 'F11', ctrlKey: true });
  const mnemonic = q(w, '.dlg input[data-f="m"]') as any;
  check('bookmarks: Ctrl+F11 opens the mnemonic dialog', !!mnemonic);
  if (mnemonic) mnemonic.value = 'A';
  const setButton = Array.from(q(w, '.dlg')?.querySelectorAll('.dlg-btn') ?? [])
    .find((b: any) => b.textContent === 'Set') as any;
  setButton?.click();
  await settle(w);
  prefs = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('bookmarks: a mnemonic is stored with its own line',
    prefs.bookmarks?.['main.py']?.['3']?.mnemonic === 'A' &&
      qa(w, '#glines .gline.hasbm').length === 2, JSON.stringify(prefs.bookmarks));

  fire(w, w.document, 'keydown', { key: 'F11', shiftKey: true });
  check('bookmarks: Shift+F11 lists every bookmark',
    /Line bookmarks/.test(String(q(w, '.dlg-title')?.textContent ?? '')) &&
      qa(w, '.dlg-radios input[data-r="bm"]').length === 2);
  const cancel = Array.from(q(w, '.dlg')?.querySelectorAll('.dlg-btn') ?? [])
    .find((b: any) => b.textContent === 'Cancel') as any;
  cancel?.click();

  fire(w, w.document, 'keydown', { key: 'F11', ctrlKey: true, shiftKey: true });
  check('bookmarks: Ctrl+Shift+F11 stays full screen and does not change bookmarks',
    !/Line bookmarks/.test(String(q(w, '.dlg-title')?.textContent ?? '')) &&
      qa(w, '#glines .gline.hasbm').length === 2);

  const saved = String(w.localStorage.getItem('nolanguage.pycharm.v1') ?? '');
  w.close();
  const restored = mountPage(html, saved);
  const w2 = restored.window as any;
  await settle(w2);
  check('bookmarks: restored preferences repaint the gutter', qa(w2, '#glines .gline.hasbm').length === 2, `${qa(w2, '#glines .gline.hasbm').length} rows`);
  w2.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const tab = (name: string) => qa(w, '#etabs .etab')
    .find((t: any) => (t.querySelector('.nm')?.textContent ?? '') === name);
  tab('utils.py')?.click();
  await settle(w);
  check('ctrl tab: opening a tab makes it most recent', String(q(w, '#stFile')?.textContent ?? '') === 'utils.py');

  const first = fire(w, w.document, 'keydown', { key: 'Tab', ctrlKey: true });
  check('ctrl tab: Ctrl+Tab is consumed', (first as any).defaultPrevented === true);
  check('ctrl tab: the MRU popup opens with the current tab first',
    q(w, '#ctxMenu').classList.contains('open') &&
      /utils\.py/.test(String(q(w, '#ctxMenu .citem')?.textContent ?? '')));
  fire(w, w.document, 'keydown', { key: 'Tab', ctrlKey: true });
  const selected = q(w, '#ctxMenu .citem.sel');
  check('ctrl tab: a second press advances to the previous file',
    /main\.py/.test(String(selected?.textContent ?? '')), String(selected?.textContent ?? ''));
  (selected as any)?.click();
  await settle(w);
  check('ctrl tab: selecting a row switches editors', String(q(w, '#stFile')?.textContent ?? '') === 'main.py');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  const todoButton = qa(w, '#strip .sbtn').find((b: any) => String(b.title ?? '').indexOf('TODO') === 0);
  (todoButton as any)?.click();
  await settle(w);
  check('todo: the tool window opens from the strip',
    !q(w, '#leftPanel').classList.contains('hidden') && String(q(w, '#panelTitle')?.textContent ?? '') === 'TODO');
  const listReq = socket.sent.find((m: any) => m.kind === 'fsList' && Number(m.reqId) >= 700000) as any;
  check('todo: opening the window starts a bounded project scan', !!listReq && listReq.path === '', JSON.stringify(listReq));
  if (!listReq) { w.close(); } else {
    socket.deliver({ kind: 'fsListing', reqId: listReq.reqId, path: '', entries: [
      { name: 'notes.py', path: 'notes.py', kind: 'file', editable: true },
    ] });
    await settle(w);
    const readReq = socket.sent.find((m: any) => m.kind === 'fsRead' && Number(m.reqId) >= 700000) as any;
    check('todo: the scan reads candidate source files', readReq?.path === 'notes.py', JSON.stringify(readReq));
    if (readReq) socket.deliver({
      kind: 'fsFile', reqId: readReq.reqId,
      file: { path: 'notes.py', content: 'x = 1\n# TODO: fix parser\n# FIXME: broken', editable: true },
    });
    await settle(w);
    const rows = qa(w, '#panelBody .todo-row');
    check('todo: comments become tagged rows with a file location',
      rows.length === 2 &&
        /TODO/.test(String(rows[0]?.textContent ?? '')) && /notes\.py:2/.test(String(rows[0]?.textContent ?? '')) &&
        /FIXME/.test(String(rows[1]?.textContent ?? '')),
      rows.map((r: any) => String(r.textContent ?? '')).join(' | '));
    (rows[1] as any)?.click();
    await settle(w);
    const openReq = socket.sent.find((m: any) => m.kind === 'fsRead' && m.path === 'notes.py' && !m.reqId) as any;
    check('todo: clicking a row asks the engine for that file', !!openReq, JSON.stringify(openReq));
    if (openReq) socket.deliver({
      kind: 'fsFile', reqId: openReq.reqId,
      file: { path: 'notes.py', content: 'x = 1\n# TODO: fix parser\n# FIXME: broken', editable: true },
    });
    await settle(w);
    check('todo: clicking a row opens its file', String(q(w, '#stFile')?.textContent ?? '') === 'notes.py',
      String(q(w, '#stFile')?.textContent ?? ''));
    w.close();
  }
}

// ---------------------------------------------------------- programmer workflows
console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'F', ctrlKey: true, shiftKey: true });
  await settle(w);
  const input = q(w, '#findIn') as any;
  const mask = q(w, '#findMask') as any;
  check('find in project: Regex and file mask controls are present', !!q(w, '#findRegex') && !!mask);
  input.value = 'needle';
  if (mask) mask.value = '*.py';
  fire(w, input, 'input', {});
  await settle(w, 160);
  const listReq = socket.sent.find((m: any) => m.kind === 'fsList' && Number(m.reqId) >= 800000) as any;
  check('find in project: typing starts a bounded project scan', !!listReq && listReq.path === '', JSON.stringify(listReq));
  if (listReq) socket.deliver({
    kind: 'fsListing', reqId: listReq.reqId, path: '', entries: [
      { name: 'hidden.py', path: 'hidden.py', kind: 'file', editable: true },
      { name: 'notes.txt', path: 'notes.txt', kind: 'file', editable: true },
    ],
  });
  await settle(w);
  const readReq = socket.sent.find((m: any) => m.kind === 'fsRead' && Number(m.reqId) >= 800000) as any;
  check('find in project: the file mask filters out non-matching files', readReq?.path === 'hidden.py', JSON.stringify(readReq));
  if (readReq) socket.deliver({
    kind: 'fsFile', reqId: readReq.reqId,
    file: { path: 'hidden.py', content: '# needle in an unopened file\n', editable: true },
  });
  await settle(w, 160);
  const hit = qa(w, '#findOut .fhit').find((r: any) => (r.textContent ?? '').indexOf('needle in an unopened file') >= 0);
  check('find in project: a match outside open buffers is shown', !!hit && (hit.getAttribute('data-path') ?? '') === 'hidden.py',
    qa(w, '#findOut .fhit').map((r: any) => r.getAttribute('data-path')).join(','));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'E', ctrlKey: true, shiftKey: true });
  await settle(w);
  const listReq = socket.lastSentOf('historyList') as any;
  check('history: Ctrl+Shift+E asks the engine for recent changes', !!listReq && listReq.path === '', JSON.stringify(listReq));
  const entries = [{ id: 'a00000000000000000000000-1-abcdef12', path: 'main.py', root: '', savedAt: Date.now(), size: 9, reason: 'save' }];
  socket.deliver({ kind: 'historyEntries', reqId: listReq?.reqId, entries });
  await settle(w);
  check('history: recent revisions are listed with a reason',
    /Recent Changes/.test(String(q(w, '.dlg-title')?.textContent ?? '')) &&
      qa(w, '.dlg-radios input[data-r="rev"]').length === 1 &&
      /save/.test(String(q(w, '.dlg-radios')?.textContent ?? '')));
  const compare = Array.from(q(w, '.dlg')?.querySelectorAll('.dlg-btn') ?? [])
    .find((b: any) => b.textContent === 'Compare') as any;
  compare?.click();
  await settle(w);
  const readReq = socket.lastSentOf('historyRead') as any;
  check('history: Compare reads the selected revision', readReq?.id === entries[0].id, JSON.stringify(readReq));
  socket.deliver({ kind: 'historyFile', reqId: readReq?.reqId, id: entries[0].id, path: 'main.py', savedAt: entries[0].savedAt, reason: 'save', content: 'old text\n' });
  await settle(w);
  check('history: Compare opens the diff viewer', !!q(w, '.diffcard') && qa(w, '.diff-row.del').length > 0,
    String(qa(w, '.diff-row.del').length) + ' removed rows');
  const closeDiff = q(w, '.diffcard [data-close]') as any;
  closeDiff?.click();

  fire(w, w.document, 'keydown', { key: 'E', ctrlKey: true, shiftKey: true });
  await settle(w);
  const listReq2 = socket.lastSentOf('historyList') as any;
  socket.deliver({ kind: 'historyEntries', reqId: listReq2?.reqId, entries });
  await settle(w);
  const revert = Array.from(q(w, '.dlg')?.querySelectorAll('.dlg-btn') ?? [])
    .find((b: any) => b.textContent === 'Revert') as any;
  revert?.click();
  await settle(w);
  const revertReq = socket.lastSentOf('historyRevert') as any;
  check('history: Revert sends the selected revision id', revertReq?.id === entries[0].id, JSON.stringify(revertReq));
  socket.deliver({ kind: 'historyReverted', reqId: revertReq?.reqId, path: 'main.py', id: entries[0].id, mtime: 1, size: 9 });
  await settle(w);
  check('history: a revert reloads the file instead of leaving stale text',
    /Reverted main\.py/.test(String(q(w, '#toast')?.textContent ?? '')) && !!socket.sent.find((m: any) => m.kind === 'fsRead' && m.path === 'main.py'));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  Object.defineProperty(w.navigator, 'clipboard', {
    configurable: true,
    value: { readText: () => Promise.resolve('one\nTWO\n') },
  });
  fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  await settle(w);
  const si = q(w, '#searchInput') as any;
  si.value = 'Compare with Clipboard';
  fire(w, si, 'input', {});
  await settle(w);
  const row = qa(w, '#searchBody .mres').find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'Code > Compare with Clipboard');
  check('clipboard: Find Action exposes Compare with Clipboard', !!row);
  (row as any)?.click();
  await settle(w);
  check('clipboard: the active buffer is compared with the clipboard',
    !!q(w, '.diffcard') && qa(w, '.diff-row').length > 2 &&
      qa(w, '.diff-row.del').length > 0 && qa(w, '.diff-row.add').length > 0,
    qa(w, '.diff-row').length + ' rows');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'Insert', ctrlKey: true, altKey: true, shiftKey: true });
  await settle(w);
  check('scratch: Ctrl+Alt+Shift+Insert opens the new scratch dialog',
    /New Scratch File/.test(String(q(w, '.dlg-title')?.textContent ?? '')));
  const name = q(w, '.dlg input[data-f="name"]') as any;
  if (name) name.value = 'scratch-demo.py';
  const create = Array.from(q(w, '.dlg')?.querySelectorAll('.dlg-btn') ?? [])
    .find((b: any) => b.textContent === 'Create') as any;
  create?.click();
  await settle(w);
  check('scratch: a new scratch file becomes the active tab',
    String(q(w, '#stFile')?.textContent ?? '') === 'scratch-demo.py', String(q(w, '#stFile')?.textContent ?? ''));
  const ta = q(w, '#ta') as any;
  ta.value = 'print(1)';
  fire(w, ta, 'input', {});
  fire(w, w.document, 'keydown', { key: 's', ctrlKey: true });
  await settle(w);
  const prefs = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('scratch: saving a scratch does not write into the project',
    !socket.sent.some((m: any) => m.kind === 'fsWrite' && m.path === 'scratch-demo.py') &&
      prefs.scratch?.files?.['scratch-demo.py']?.content === 'print(1)', JSON.stringify(prefs.scratch?.files));
  const saved = String(w.localStorage.getItem('nolanguage.pycharm.v1') ?? '');
  w.close();

  const restored = mountPage(html, saved);
  const w2 = restored.window as any;
  await settle(w2);
  check('scratch: scratch files come back with the IDE profile, not the project',
    String(q(w2, '#stFile')?.textContent ?? '') === 'scratch-demo.py' &&
      (q(w2, '#ta') as any)?.value === 'print(1)', String(q(w2, '#stFile')?.textContent ?? ''));
  w2.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'Alpha alpha alphabet alpha';
  ed.setSelectionRange(0, 0);
  fire(w, ed, 'keydown', { key: 'f', ctrlKey: true });
  await settle(w);
  check('find options: Match case, Whole word and Regex controls are present',
    qa(w, '.findbar [data-opt]').length === 3, String(qa(w, '.findbar [data-opt]').length));
  const input = q(w, '.findbar .fb-in') as any;
  input.value = 'alpha';
  fire(w, input, 'input', {});
  await settle(w, 30);
  check('find options: default matching is case-insensitive',
    (q(w, '.findbar .fb-count')?.textContent ?? '') === '1/4', q(w, '.findbar .fb-count')?.textContent);
  const cs = q(w, '.findbar [data-opt="cs"]') as any;
  cs.checked = true;
  fire(w, cs, 'change', {});
  await settle(w, 30);
  check('find options: Match case limits hits',
    (q(w, '.findbar .fb-count')?.textContent ?? '') === '1/3' && ed.selectionStart === 6,
    q(w, '.findbar .fb-count')?.textContent + ' @' + ed.selectionStart);
  const word = q(w, '.findbar [data-opt="word"]') as any;
  word.checked = true;
  fire(w, word, 'change', {});
  await settle(w, 30);
  check('find options: Whole word excludes a substring match',
    (q(w, '.findbar .fb-count')?.textContent ?? '') === '1/2', q(w, '.findbar .fb-count')?.textContent);
  const prefs = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('find options: choices are persisted in the IDE profile',
    prefs.findOpts?.cs === true && prefs.findOpts?.word === true, JSON.stringify(prefs.findOpts));

  cs.checked = false;
  fire(w, cs, 'change', {});
  word.checked = false;
  fire(w, word, 'change', {});
  const rx = q(w, '.findbar [data-opt="rx"]') as any;
  rx.checked = true;
  fire(w, rx, 'change', {});
  ed.value = 'cat cot cut';
  input.value = 'c.t';
  fire(w, input, 'input', {});
  await settle(w, 30);
  check('find options: Regex matches patterns, not literal text',
    (q(w, '.findbar .fb-count')?.textContent ?? '') === '1/3' && ed.selectionStart === 0 && ed.selectionEnd === 3,
    q(w, '.findbar .fb-count')?.textContent + ' @' + ed.selectionStart + '-' + ed.selectionEnd);
  input.value = '(';
  fire(w, input, 'input', {});
  await settle(w, 30);
  check('find options: an invalid regex is reported, not silently empty',
    (q(w, '.findbar .fb-count')?.textContent ?? '') === 'invalid regex', q(w, '.findbar .fb-count')?.textContent);
  ed.value = 'a@b';
  input.value = '(a)@(b)';
  fire(w, input, 'input', {});
  await settle(w, 30);
  const rep = q(w, '.findbar .fb-rep') as any;
  rep.value = '$2.$1';
  (q(w, '.findbar [data-a="all"]') as any).click();
  await settle(w, 10);
  check('find options: regex replacement keeps capture groups', ed.value === 'b.a', JSON.stringify(ed.value));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  const target = ed.value.indexOf('print') + 2;
  ed.setSelectionRange(target, target);
  fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  await settle(w);
  const si = q(w, '#searchInput') as any;
  si.value = 'Reopen Closed Tab';
  fire(w, si, 'input', {});
  await settle(w);
  check('reopen tab: Find Action exposes the command',
    !!qa(w, '#searchBody .mres').find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'File > Reopen Closed Tab'));
  fire(w, w.document, 'keydown', { key: 'Escape' });
  (q(w, '.etab[data-tab="main.py"] [data-close]') as any)?.click();
  await settle(w);
  check('reopen tab: closing removes the tab', !q(w, '.etab[data-tab="main.py"]'));
  const reopenKey = fire(w, w.document, 'keydown', { key: 't', ctrlKey: true, shiftKey: true });
  await settle(w);
  check('reopen tab: Ctrl+Shift+T is consumed', (reopenKey as any).defaultPrevented === true);
  check('reopen tab: the last closed file comes back active',
    (q(w, '#stFile')?.textContent ?? '') === 'main.py' && !!q(w, '.etab[data-tab="main.py"]'),
    String(q(w, '#stFile')?.textContent ?? ''));
  check('reopen tab: the caret returns to where the file was closed',
    ed.selectionStart === target, `${ed.selectionStart} vs ${target}`);
  (q(w, '.etab[data-tab="utils.py"] [data-close]') as any)?.click();
  await settle(w);
  fire(w, w.document, 'keydown', { key: 't', ctrlKey: true, shiftKey: true });
  await settle(w);
  check('reopen tab: the stack is last-closed-first-reopened',
    (q(w, '#stFile')?.textContent ?? '') === 'utils.py', String(q(w, '#stFile')?.textContent ?? ''));
  fire(w, w.document, 'keydown', { key: 't', ctrlKey: true, shiftKey: true });
  await settle(w);
  check('reopen tab: an empty stack says so instead of doing nothing',
    /No closed tab/.test(String(q(w, '#toast')?.textContent ?? '')), q(w, '#toast')?.textContent);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'one\ntwo\nthree';
  fire(w, ed, 'input', {});
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  await settle(w);
  const si = q(w, '#searchInput') as any;
  si.value = 'Compare with Saved Version';
  fire(w, si, 'input', {});
  await settle(w);
  const row = qa(w, '#searchBody .mres').find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'File > Compare with Saved Version');
  check('saved diff: Find Action exposes Compare with Saved Version', !!row);
  (row as any)?.click();
  await settle(w);
  const readReq = socket.lastSentOf('fsRead') as any;
  check('saved diff: it reads the saved copy with its own request id',
    readReq?.path === 'main.py' && typeof readReq?.reqId === 'number', JSON.stringify(readReq));
  socket.deliver({ kind: 'fsFile', reqId: readReq?.reqId, file: { path: 'main.py', content: 'one\nTWO\nthree', languageId: 'python' } });
  await settle(w);
  check('saved diff: the disk and editor versions are compared',
    !!q(w, '.diffcard') && qa(w, '.diff-row.del').length > 0 && qa(w, '.diff-row.add').length > 0,
    qa(w, '.diff-row').length + ' rows');
  check('saved diff: reading never replaces the live buffer',
    ed.value === 'one\ntwo\nthree' && !!q(w, '.etab[data-tab="main.py"] .dirty'), JSON.stringify(ed.value));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'def alpha():\n    return alpha';
  ed.setSelectionRange(9, 9);
  fire(w, ed, 'keydown', { key: 'q', ctrlKey: true });
  await settle(w);
  const req = socket.lastSentOf('hover') as any;
  check('quick doc: Ctrl+Q asks the language server for hover',
    req?.kind === 'hover' && req?.code === ed.value && typeof req?.requestId === 'number', JSON.stringify(req));
  check('quick doc: the local answer appears before the server replies',
    /Quick Documentation/.test(String(q(w, '.dlg-title')?.textContent ?? '')) &&
      (q(w, '.dlg-detail')?.textContent ?? '').length > 0);
  socket.deliver({ kind: 'hover', requestId: req?.requestId, hover: { contents: 'LSP docs for alpha' } });
  await settle(w);
  check('quick doc: the real hover replaces the fallback in the same dialog',
    (q(w, '.dlg-detail')?.textContent ?? '') === 'LSP docs for alpha' &&
      /language server/.test(String(q(w, '.dlg-msg .sub')?.textContent ?? '')),
    q(w, '.dlg-detail')?.textContent);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  await settle(w);
  const si = q(w, '#searchInput') as any;
  si.value = 'Go to Matching Bracket';
  fire(w, si, 'input', {});
  await settle(w);
  check('bracket jump: Find Action exposes the command',
    !!qa(w, '#searchBody .mres').find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'Navigate > Go to Matching Bracket'));
  fire(w, w.document, 'keydown', { key: 'Escape' });
  ed.value = 'def f():\n    return (1 + 2)';
  const open = ed.value.indexOf('(1');
  const close = ed.value.indexOf(')', open);
  ed.setSelectionRange(open, open);
  const jump = fire(w, ed, 'keydown', { key: 'm', ctrlKey: true, shiftKey: true });
  check('bracket jump: Ctrl+Shift+M is consumed', (jump as any).defaultPrevented === true);
  check('bracket jump: the caret moves to the matching parenthesis',
    ed.selectionStart === close, `${ed.selectionStart} vs ${close}`);
  ed.setSelectionRange(close + 1, close + 1);
  fire(w, ed, 'keydown', { key: 'm', ctrlKey: true, shiftKey: true });
  check('bracket jump: it also works from just after a closing bracket',
    ed.selectionStart === open, `${ed.selectionStart} vs ${open}`);
  ed.value = 's = "("';
  ed.setSelectionRange(5, 5);
  fire(w, ed, 'keydown', { key: 'm', ctrlKey: true, shiftKey: true });
  check('bracket jump: a bracket inside a string is ignored',
    /Place the caret on a bracket/.test(String(q(w, '#toast')?.textContent ?? '')), q(w, '#toast')?.textContent);
  ed.value = 'x = (1';
  ed.setSelectionRange(4, 4);
  fire(w, ed, 'keydown', { key: 'm', ctrlKey: true, shiftKey: true });
  check('bracket jump: an unmatched bracket is reported honestly',
    /No matching bracket/.test(String(q(w, '#toast')?.textContent ?? '')), q(w, '#toast')?.textContent);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const actionRow = (name: string) => qa(w, '#searchBody .mres').find(
    (r: any) => (r.querySelector('.nm')?.textContent ?? '') === name);
  fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  const si = q(w, '#searchInput') as any;
  si.value = 'Open Project';
  fire(w, si, 'input', {});
  check('keymap conflicts: Open Project no longer claims Ctrl+Alt+O',
    (actionRow('File > Open Project...')?.querySelector('.path')?.textContent ?? '') === 'Ctrl+Alt+Shift+O',
    actionRow('File > Open Project...')?.textContent ?? '');
  si.value = 'Optimize Imports';
  fire(w, si, 'input', {});
  check('keymap conflicts: Optimize Imports keeps Ctrl+Alt+O',
    (actionRow('Code > Optimize Imports')?.querySelector('.path')?.textContent ?? '') === 'Ctrl+Alt+O',
    actionRow('Code > Optimize Imports')?.textContent ?? '');
  fire(w, w.document, 'keydown', { key: 'Escape' });
  const ed = q(w, '#ta') as any;
  fire(w, ed, 'keydown', { key: 'o', ctrlKey: true, altKey: true });
  check('keymap conflicts: Ctrl+Alt+O runs Optimize Imports, not the project wizard',
    !/打开项目/.test(String(q(w, '#nlImp')?.textContent || '')),
    String(q(w, '#nlImp')?.textContent || '').slice(0, 80));
  fire(w, w.document, 'keydown', { key: 'o', ctrlKey: true, altKey: true, shiftKey: true });
  check('keymap conflicts: Ctrl+Alt+Shift+O opens the project wizard',
    /打开项目/.test(String(q(w, '#nlImp')?.textContent || '')),
    String(q(w, '#nlImp')?.textContent || '').slice(0, 80));
  fire(w, w.document, 'keydown', { key: 'Escape' });
  fire(w, ed, 'contextmenu', {});
  check('keymap conflicts: editor Redo advertises Ctrl+Shift+Z',
    /Ctrl\+Shift\+Z/.test(String((q(w, '#ctxMenu') || w.document).textContent || '')),
    String((q(w, '#ctxMenu') || w.document).textContent || '').slice(0, 120));
  check('keymap conflicts: Ctrl+K still means Search Everywhere, not Commit',
    !/Ctrl\+K/.test(String((q(w, '#strip') || w.document).querySelector?.('[data-win="commit"]')?.textContent || '')));
  fire(w, w.document, 'keydown', { key: '6', altKey: true });
  check('keymap conflicts: Alt+6 opens Packages',
    !!q(w, '.dock-pane[data-pane="packages"].active'), String(q(w, '#dock')?.className ?? ''));
  fire(w, w.document, 'keydown', { key: 'F12', altKey: true });
  check('keymap conflicts: Alt+F12 opens Terminal',
    !!q(w, '.dock-pane[data-pane="terminal"].active'), String(q(w, '#dock')?.className ?? ''));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'n', ctrlKey: true, shiftKey: true });
  check('go to file: Search Everywhere opens on the Files tab',
    q(w, '#searchModal')?.classList.contains('open') === true &&
    q(w, '#searchChips .chip.on')?.getAttribute('data-tab') === 'files',
    q(w, '#searchChips .chip.on')?.getAttribute('data-tab'));
  const rootReq = socket.sent.find((m: any) => m.kind === 'fsList' && Number(m.reqId) > 870000);
  check('go to file: the real workspace is scanned, not bundled samples', !!rootReq, JSON.stringify(rootReq));
  socket.deliver({ kind: 'fsListing', path: '', reqId: rootReq?.reqId, entries: [
    { name: 'src', path: 'src', kind: 'dir' },
    { name: 'notes.md', path: 'notes.md', kind: 'file' }
  ] });
  await settle(w);
  const nested = socket.sent.find((m: any) => m.kind === 'fsList' && m.path === 'src');
  check('go to file: nested folders are included in the index', !!nested, JSON.stringify(nested));
  socket.deliver({ kind: 'fsListing', path: 'src', reqId: nested?.reqId, entries: [
    { name: 'api_client.py', path: 'src/api_client.py', kind: 'file' }
  ] });
  await settle(w);
  const si = q(w, '#searchInput') as any;
  si.value = 'apic';
  fire(w, si, 'input', {});
  const rows = qa(w, '#searchBody .mres');
  check('go to file: fuzzy matching finds a workspace file by name',
    rows.some((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'api_client.py'),
    rows.map((r: any) => r.querySelector('.nm')?.textContent).join(' / '));
  const row = rows.find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'api_client.py');
  row?.click();
  await settle(w);
  const read = socket.sent.find((m: any) => m.kind === 'fsRead' && m.path === 'src/api_client.py');
  check('go to file: choosing a result reads the real workspace path', !!read, JSON.stringify(read));
  socket.deliver({ kind: 'fsFile', path: 'src/api_client.py', reqId: read?.reqId,
    file: { path: 'src/api_client.py', content: 'value = 1', languageId: 'python', editable: true } });
  await settle(w);
  check('go to file: choosing a result opens the real workspace path',
    (q(w, '#stFile')?.textContent ?? '') === 'src/api_client.py', q(w, '#stFile')?.textContent ?? '');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  socket.deliver({ kind: 'fsListing', path: '', reqId: 101, entries: [
    { name: 'main.py', path: 'main.py', kind: 'file', editable: true }
  ] });
  await settle(w);
  const row = qa(w, '#ptree .tnode.file').find((r: any) => r.getAttribute('data-path') === 'main.py');
  check('tree F2: rows are keyboard-focusable', row?.getAttribute('tabindex') === '0', String(row?.getAttribute('tabindex')));
  fire(w, row, 'keydown', { key: 'F2' });
  check('tree F2: starts inline rename on the selected row', !!q(w, '#ptree .inline-rename'), q(w, '#ptree')?.textContent ?? '');
  const rename = q(w, '#ptree .inline-rename') as any;
  check('tree F2: rename starts with the whole name selected',
    rename?.value === 'main.py' && rename.selectionStart === 0 && rename.selectionEnd === 7,
    `${rename?.value} ${rename?.selectionStart}-${rename?.selectionEnd}`);
  fire(w, rename, 'keydown', { key: 'Escape' });
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'one\ntwo\nthree\nfour\nfive\nsix\nseven';
  ed.setSelectionRange(8, 11);
  fire(w, w.document, 'keydown', { key: 'n', ctrlKey: true, shiftKey: true });
  const rootReq = socket.sent.find((m: any) => m.kind === 'fsList' && Number(m.reqId) > 870000);
  socket.deliver({ kind: 'fsListing', path: '', reqId: rootReq?.reqId, entries: [
    { name: 'view.py', path: 'view.py', kind: 'file' }
  ] });
  await settle(w);
  const fileRow = qa(w, '#searchBody .mres').find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'view.py');
  fileRow?.click();
  await settle(w);
  const read = socket.sent.find((m: any) => m.kind === 'fsRead' && m.path === 'view.py');
  socket.deliver({ kind: 'fsFile', path: 'view.py', reqId: read?.reqId,
    file: { path: 'view.py', content: 'alpha\nbeta\ngamma', languageId: 'python', editable: true } });
  await settle(w);
  check('tab view: another file becomes active after an explicit open',
    (q(w, '#stFile')?.textContent ?? '') === 'view.py', q(w, '#stFile')?.textContent ?? '');
  fire(w, w.document, 'keydown', { key: 'Tab', ctrlKey: true });
  const switchRow = qa(w, '#ctxMenu .citem').find((r: any) => (r.querySelector('.clbl')?.textContent ?? '').indexOf('main.py') >= 0);
  switchRow?.click();
  await settle(w);
  check('tab view: Ctrl+Tab returns to the previous file',
    (q(w, '#stFile')?.textContent ?? '') === 'main.py', q(w, '#stFile')?.textContent ?? '');
  check('tab view: selection and caret are restored',
    q(w, '#ta')?.value === 'one\ntwo\nthree\nfour\nfive\nsix\nseven' &&
    (q(w, '#ta') as any).selectionStart === 8 && (q(w, '#ta') as any).selectionEnd === 11,
    `${(q(w, '#ta') as any).selectionStart}-${(q(w, '#ta') as any).selectionEnd}`);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  const si = q(w, '#searchInput') as any;
  si.value = 'Save All';
  fire(w, si, 'input', {});
  const row = qa(w, '#searchBody .mres').find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'File > Save All');
  check('save all: the command is exposed in Find Action', !!row);
  row?.click();
  await settle(w);
  const writes = socket.sent.filter((m: any) => m.kind === 'fsWrite');
  check('save all: a clean profile writes nothing', writes.length === 0, String(writes.length));

  const ed = q(w, '#ta') as any;
  ed.value = 'changed main';
  fire(w, ed, 'input', {});
  const scratch = 'scratch-a.txt';
  fire(w, w.document, 'keydown', { key: 'Insert', ctrlKey: true, altKey: true, shiftKey: true });
  await settle(w);
  const ok = qa(w, '.dlg-scrim button, .modal button').find((b: any) => /OK|Create/.test(b.textContent ?? ''));
  ok?.click();
  await settle(w);
  const scratchEd = q(w, '#ta') as any;
  scratchEd.value = 'changed scratch';
  fire(w, scratchEd, 'input', {});
  fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  si.value = 'Save All';
  fire(w, si, 'input', {});
  qa(w, '#searchBody .mres').find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'File > Save All')?.click();
  await settle(w);
  const writes2 = socket.sent.filter((m: any) => m.kind === 'fsWrite');
  check('save all: only dirty real files are written',
    writes2.length === writes.length + 1 && writes2[writes2.length - 1]?.path === 'main.py',
    JSON.stringify(writes2.map((m: any) => m.path)));
  const prefs = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('save all: scratch files go to preferences, not the workspace',
    JSON.stringify(prefs.scratch?.files || {}).includes('changed scratch') &&
    !writes2.some((m: any) => String(m.path).includes('scratch')),
    JSON.stringify(prefs.scratch?.files || {}).slice(0, 120));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'F', ctrlKey: true, shiftKey: true });
  const findIn = q(w, '#findIn') as any;
  check('project find: Whole word control is present', !!q(w, '#findWord'));
  (q(w, '#findWord') as any).checked = true;
  fire(w, q(w, '#findWord'), 'change', {});
  findIn.value = 'alpha';
  fire(w, findIn, 'input', {});
  await settle(w, 200);
  const listing = socket.sent.find((m: any) => m.kind === 'fsList' && Number(m.reqId) > 800000);
  socket.deliver({ kind: 'fsListing', path: '', reqId: listing?.reqId, entries: [
    { name: 'words.py', path: 'words.py', kind: 'file' }
  ] });
  await settle(w);
  const read = socket.sent.find((m: any) => m.kind === 'fsRead' && m.path === 'words.py');
  socket.deliver({ kind: 'fsFile', path: 'words.py', reqId: read?.reqId,
    file: { path: 'words.py', content: 'alpha\nalphabet\nxalpha\nalpha again', languageId: 'python' } });
  await settle(w);
  const hits = qa(w, '#findOut .fhit');
  const lines = hits.map((h: any) => h.getAttribute('data-line')).join(',');
  check('project find: Whole word drops substring matches',
    lines === '1,4', lines);
  const prefs = JSON.parse(w.localStorage.getItem('nolanguage.pycharm.v1') || '{}');
  check('project find: Whole word is persisted', prefs.findProjectOpts?.word === true, JSON.stringify(prefs.findProjectOpts));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'a@b';
  ed.setSelectionRange(0, 0);
  fire(w, ed, 'keydown', { key: 'f', ctrlKey: true });
  await settle(w);
  const input = q(w, '.findbar .fb-in') as any;
  input.value = '(a)@(b)';
  fire(w, input, 'input', {});
  (q(w, '.findbar [data-opt="rx"]') as any).checked = true;
  fire(w, q(w, '.findbar [data-opt="rx"]'), 'change', {});
  const rep = q(w, '.findbar .fb-rep') as any;
  rep.value = '$2.$1';
  await settle(w, 30);
  (q(w, '.findbar [data-a="next"]') as any).click();
  (q(w, '.findbar [data-a="rep"]') as any).click();
  await settle(w);
  check('regex replace: single Replace expands capture groups like Replace All',
    ed.value === 'b.a', JSON.stringify(ed.value));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  fire(w, q(w, '#searchBtn'), 'click');
  const si = q(w, '#searchInput') as any;
  si.value = 'fib';
  fire(w, si, 'input', {});
  const fallback = qa(w, '#searchBody .mres').some((r: any) =>
    /^fib/.test(r.querySelector('.nm')?.textContent ?? ''));
  check('search symbols: a local declaration is available before LSP answers', fallback,
    qa(w, '#searchBody .mres').map((r: any) => r.querySelector('.nm')?.textContent).join(' / '));
  await settle(w, 240);
  const sent = socket.lastSentOf('workspaceSymbol');
  check('search symbols: typing asks the language server for workspace symbols',
    sent?.kind === 'workspaceSymbol' && sent?.query === 'fib' && sent?.language === 'python',
    JSON.stringify(sent));
  socket.deliver({ kind: 'workspaceSymbolResult', requestId: sent?.requestId, symbols: [
    { name: 'fib_lsp', kind: 'function', uri: 'main.py', line: 4 }
  ] });
  await settle(w);
  const row = qa(w, '#searchBody .mres').find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'fib_lsp');
  check('search symbols: the real symbol result replaces the sample list', !!row,
    qa(w, '#searchBody .mres').map((r: any) => r.querySelector('.nm')?.textContent).join(' / '));
  (row as any)?.click();
  await settle(w);
  check('search symbols: choosing a symbol jumps to its definition',
    (q(w, '#stPos')?.textContent ?? '').indexOf('Ln 5') === 0, q(w, '#stPos')?.textContent ?? '');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'first line\ntarget line\nthird line';
  ed.setSelectionRange(12, 17);
  const origin = q(w, '#stFile')?.textContent ?? 'main.py';
  const other = origin === 'main.py' ? 'utils.py' : 'main.py';
  fire(w, w.document, 'keydown', { key: 'Tab', ctrlKey: true });
  const item = qa(w, '#ctxMenu .citem').find((r: any) => (r.querySelector('.clbl')?.textContent ?? '').indexOf(other) >= 0);
  item?.click();
  await settle(w);
  check('nav history: a tab switch moves to the other file', (q(w, '#stFile')?.textContent ?? '') === other, q(w, '#stFile')?.textContent ?? '');
  fire(w, w.document, 'keydown', { key: 'ArrowLeft', altKey: true });
  await settle(w);
  check('nav history: Alt+Left goes back to the file', (q(w, '#stFile')?.textContent ?? '') === origin, q(w, '#stFile')?.textContent ?? '');
  fire(w, w.document, 'keydown', { key: 'ArrowLeft', altKey: true });
  check('nav history: back restores the previous caret and selection',
    (q(w, '#ta') as any).selectionStart === 12 && (q(w, '#ta') as any).selectionEnd === 17,
    `${(q(w, '#ta') as any).selectionStart}-${(q(w, '#ta') as any).selectionEnd}`);
  const before = (q(w, '#ta') as any).selectionStart;
  (q(w, '#ta') as any).setSelectionRange(1, 1);
  fire(w, w.document, 'keydown', { key: 'ArrowRight', altKey: true });
  fire(w, w.document, 'keydown', { key: 'ArrowLeft', altKey: true });
  check('nav history: the outgoing position is saved before navigating away',
    (q(w, '#ta') as any).selectionStart === 1 && before === 12,
    `${(q(w, '#ta') as any).selectionStart}`);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'F', ctrlKey: true, shiftKey: true });
  const findIn = q(w, '#findIn') as any;
  findIn.value = 'alpha';
  fire(w, findIn, 'input', {});
  await settle(w, 200);
  const listing = socket.sent.find((m: any) => m.kind === 'fsList' && Number(m.reqId) > 800000);
  socket.deliver({ kind: 'fsListing', path: '', reqId: listing?.reqId, entries: [
    { name: 'replace.py', path: 'replace.py', kind: 'file' }
  ] });
  await settle(w);
  const read = socket.sent.find((m: any) => m.kind === 'fsRead' && m.path === 'replace.py');
  socket.deliver({ kind: 'fsFile', path: 'replace.py', reqId: read?.reqId,
    file: { path: 'replace.py', content: 'alpha\nalphabet\nalpha', languageId: 'python' } });
  await settle(w);
  const rep = q(w, '#findRep') as any;
  check('replace in files: a replacement input is available', !!rep);
  rep.value = 'BETA';
  fire(w, rep, 'input', {});
  (q(w, '#findPreview') as any).click();
  await settle(w);
  const picks = qa(w, '.frepl-pick');
  check('replace in files: preview lists every match with a checkbox',
    picks.length === 3 && picks.every((p: any) => p.checked), String(picks.length));
  check('replace in files: preview does not write anything',
    !socket.sent.some((m: any) => m.kind === 'applyWorkspaceEdits'));
  picks[1].checked = false;
  fire(w, picks[1], 'change', {});
  (q(w, '#findReplApply') as any).click();
  await settle(w);
  const apply = socket.lastSentOf('applyWorkspaceEdits');
  check('replace in files: unchecked matches are excluded',
    (apply?.edits as any[])?.length === 2, JSON.stringify(apply?.edits));
  check('replace in files: exact zero-based spans are sent',
    (apply?.edits as any[])?.[0]?.line === 0 && (apply?.edits as any[])?.[0]?.endCharacter === 5 &&
    (apply?.edits as any[])?.[1]?.line === 2 && (apply?.edits as any[])?.[1]?.newText === 'BETA',
    JSON.stringify(apply?.edits));
  socket.deliver({ kind: 'workspaceEditsApplied', requestId: apply?.requestId, ok: true, applied: 2, files: [] });
  await settle(w);
  check('replace in files: the server result closes preview and reports success',
    !q(w, '#findReplApply') && /Replaced 2/.test(String(q(w, '#toast')?.textContent ?? '')),
    q(w, '#toast')?.textContent ?? '');

  const ed = q(w, '#ta') as any;
  ed.value = 'buffer alpha';
  fire(w, ed, 'input', {});
  (q(w, '#findPreview') as any).click();
  await settle(w);
  const before = socket.sent.filter((m: any) => m.kind === 'applyWorkspaceEdits').length;
  (q(w, '#findReplApply') as any).click();
  await settle(w);
  check('replace in files: a dirty open buffer refuses the batch',
    socket.sent.filter((m: any) => m.kind === 'applyWorkspaceEdits').length === before &&
    /Save changes/.test(String(q(w, '#toast')?.textContent ?? '')), q(w, '#toast')?.textContent ?? '');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'def fib(n):\n    return n';
  fire(w, ed, 'input', {});
  fire(w, w.document, 'keydown', { key: 'N', ctrlKey: true, altKey: true, shiftKey: true });
  await settle(w);
  const localRow = qa(w, '#goSymRows .gosym-name').map((n: any) => n.textContent ?? '').join(' / ');
  check('go to symbol: the dialog opens with a local outline immediately', localRow.indexOf('fib') !== -1, localRow);
  await settle(w, 240);
  const req = socket.lastSentOf('workspaceSymbol');
  check('go to symbol: opening asks the language server for symbols',
    req?.kind === 'workspaceSymbol' && req?.query === '' && req?.language === 'python', JSON.stringify(req));
  socket.deliver({ kind: 'workspaceSymbolResult', requestId: req?.requestId, symbols: [
    { name: 'fib_lsp', kind: 'function', uri: 'main.py', line: 1 }
  ] });
  await settle(w);
  const names = qa(w, '#goSymRows .gosym-name').map((n: any) => n.textContent ?? '');
  check('go to symbol: the language-service result replaces the syntax outline',
    names.indexOf('fib_lsp') !== -1 && names.indexOf('fib') === -1, names.join(' / '));
  check('go to symbol: the dialog says where its rows came from',
    /Language server symbols/.test(q(w, '#goSymHint')?.textContent ?? ''), q(w, '#goSymHint')?.textContent ?? '');
  (qa(w, '#goSymRows .gosym-row')[0] as any)?.click();
  await settle(w);
  check('go to symbol: choosing a server symbol jumps to its location',
    (q(w, '#stPos')?.textContent ?? '').indexOf('Ln 2') === 0 && !q(w, '.dlg-scrim'),
    `${q(w, '#stPos')?.textContent ?? ''} · dialog=${!!q(w, '.dlg-scrim')}`);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'def local_only():\n    pass';
  fire(w, ed, 'input', {});
  fire(w, w.document, 'keydown', { key: 'F12', ctrlKey: true });
  await settle(w, 260);
  const req = socket.lastSentOf('workspaceSymbol');
  check('structure: opening the window asks the language server for symbols',
    req?.kind === 'workspaceSymbol' && req?.query === '' && req?.language === 'python', JSON.stringify(req));
  check('structure: the syntax outline is visible while the server answers',
    (q(w, '#panelBody')?.textContent ?? '').indexOf('local_only') !== -1,
    (q(w, '#panelBody')?.textContent ?? '').slice(0, 100));
  socket.deliver({ kind: 'workspaceSymbolResult', requestId: req?.requestId, symbols: [
    { name: 'SemanticCalculator', kind: 5, uri: 'main.py', line: 1 },
    { name: 'Elsewhere', kind: 12, uri: 'utils.py', line: 2 }
  ] });
  await settle(w);
  const pane = q(w, '#panelBody')?.textContent ?? '';
  check('structure: semantic symbols replace the local parse',
    pane.indexOf('SemanticCalculator') !== -1 && pane.indexOf('local_only') === -1, pane.slice(0, 160));
  check('structure: symbols from other files are not shown in the file outline',
    pane.indexOf('Elsewhere') === -1 && /language server/.test(pane), pane.slice(0, 160));
  (qa(w, '#panelBody .struct-node')[0] as any)?.click();
  await settle(w);
  check('structure: a semantic row moves the caret to the reported line',
    (q(w, '#stPos')?.textContent ?? '').indexOf('Ln 2') === 0, q(w, '#stPos')?.textContent ?? '');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  const writesBefore = socket.sent.filter((m: any) => m.kind === 'fsWrite').length;
  fire(w, w.document, 'keydown', { key: 's', ctrlKey: true });
  await settle(w);
  check('ctrl+s: a clean profile writes nothing',
    socket.sent.filter((m: any) => m.kind === 'fsWrite').length === writesBefore,
    String(socket.sent.filter((m: any) => m.kind === 'fsWrite').length - writesBefore));

  check('ctrl+s: a second tab is available', openViaFile(w, 'utils.py'));
  await settle(w);
  const utils = q(w, '#ta') as any;
  utils.value = 'utils dirty';
  fire(w, utils, 'input', {});
  check('ctrl+s: the first tab is available', openViaFile(w, 'main.py'));
  await settle(w);
  const main = q(w, '#ta') as any;
  main.value = 'main dirty';
  fire(w, main, 'input', {});
  const start = socket.sent.filter((m: any) => m.kind === 'fsWrite').length;
  fire(w, w.document, 'keydown', { key: 's', ctrlKey: true });
  await settle(w);
  const writes = socket.sent.filter((m: any) => m.kind === 'fsWrite').slice(start);
  check('ctrl+s: all dirty tabs are written, not only the active one',
    writes.length === 2 && writes.some((m: any) => m.path === 'main.py') && writes.some((m: any) => m.path === 'utils.py'),
    JSON.stringify(writes.map((m: any) => m.path)));

  const mainWrite = writes.find((m: any) => m.path === 'main.py');
  socket.deliver({ kind: 'fsError', path: 'main.py', reqId: mainWrite?.reqId, message: 'disk full' });
  await settle(w);
  const mainTab = qa(w, '#etabs .etab').find((t: any) => t.getAttribute('data-tab') === 'main.py');
  check('ctrl+s: a failed write leaves its tab dirty',
    !!mainTab?.querySelector('.dirty'), mainTab?.className ?? 'missing');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  socket.deliver({ kind: 'fsRoot', reqId: 31, root: 'D:/proj', name: 'proj' });
  await settle(w);
  const rootList = socket.sent.find((m: any) => m.kind === 'fsList' && m.path === '');
  socket.deliver({ kind: 'fsListing', path: '', reqId: rootList?.reqId, entries: [
    { name: 'src', path: 'src', kind: 'dir' },
    { name: 'main.py', path: 'main.py', kind: 'file', editable: true }
  ] });
  await settle(w);
  const rows = qa(w, '#ptree .tnode');
  check('tree keys: visible rows are focusable', rows.length === 2 && rows[0].getAttribute('tabindex') === '0', String(rows.length));
  rows[0].focus();
  fire(w, rows[0], 'keydown', { key: 'ArrowDown' });
  check('tree keys: ArrowDown moves focus to the next row',
    w.document.activeElement === rows[1], String((w.document.activeElement as any)?.getAttribute?.('data-path')));
  fire(w, rows[1], 'keydown', { key: 'Enter' });
  await settle(w);
  check('tree keys: Enter opens the selected file', (q(w, '#stFile')?.textContent ?? '') === 'main.py', q(w, '#stFile')?.textContent ?? '');
  fire(w, rows[0], 'keydown', { key: 'ArrowRight' });
  await settle(w);
  check('tree keys: ArrowRight expands a directory',
    !!qa(w, '#ptree .tnode.dir')[0]?.classList.contains('open'), qa(w, '#ptree .tnode.dir')[0]?.className ?? '');
  const expanded = qa(w, '#ptree .tnode.dir')[0];
  fire(w, expanded, 'keydown', { key: 'ArrowLeft' });
  await settle(w);
  check('tree keys: ArrowLeft collapses an expanded directory',
    !qa(w, '#ptree .tnode.dir')[0]?.classList.contains('open'), qa(w, '#ptree .tnode.dir')[0]?.className ?? '');

  const beforeRefresh = socket.sent.filter((m: any) => m.kind === 'fsList').length;
  const refreshKey = fire(w, w.document, 'keydown', { key: 'F5' });
  check('tree refresh: F5 is consumed instead of reloading the page', refreshKey.defaultPrevented,
    String(refreshKey.defaultPrevented));
  await settle(w);
  const refreshes = socket.sent.filter((m: any) => m.kind === 'fsList').slice(beforeRefresh);
  check('tree refresh: F5 requests fresh cached listings',
    refreshes.some((m: any) => m.path === ''), JSON.stringify(refreshes.map((m: any) => m.path)));
  const refreshedRoot = refreshes.find((m: any) => m.path === '');
  socket.deliver({ kind: 'fsListing', path: '', reqId: refreshedRoot?.reqId, entries: [
    { name: 'src', path: 'src', kind: 'dir' },
    { name: 'external.py', path: 'external.py', kind: 'file', editable: true }
  ] });
  await settle(w);
  check('tree refresh: externally added files appear',
    qa(w, '#ptree .tnode').some((r: any) => r.getAttribute('data-path') === 'external.py'),
    qa(w, '#ptree .tnode').map((r: any) => r.getAttribute('data-path')).join(','));

  let copied = '';
  Object.defineProperty(w.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => { copied = t; return Promise.resolve(); } },
  });
  const fileRow = qa(w, '#ptree .tnode.file').find((r: any) => r.getAttribute('data-path') === 'external.py');
  fire(w, fileRow, 'contextmenu', { clientX: 120, clientY: 120, button: 2 });
  await settle(w);
  const absItem = qa(w, '#ctxMenu .citem').find((r: any) => (r.querySelector('.clbl')?.textContent ?? '') === 'Copy Absolute Path');
  check('tree path: the context menu offers an absolute path', !!absItem);
  (absItem as any)?.click();
  await settle(w, 40);
  check('tree path: the absolute path uses the confirmed project root',
    copied === 'D:/proj/external.py', copied);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  const si = q(w, '#searchInput') as any;
  for (const [query, label] of [
    ['Find in Files', 'Navigate > Find in Files...'],
    ['Go to Definition', 'Navigate > Go to Definition'],
    ['Find Usages', 'Navigate > Find Usages'],
  ]) {
    si.value = query;
    fire(w, si, 'input', {});
    await settle(w);
    check('find action: ' + query + ' is reachable from the real menu',
      qa(w, '#searchBody .mres').some((r: any) => (r.querySelector('.nm')?.textContent ?? '') === label),
      qa(w, '#searchBody .mres').map((r: any) => r.querySelector('.nm')?.textContent).join(' / '));
  }
  si.value = 'Find in Files';
  fire(w, si, 'input', {});
  await settle(w);
  qa(w, '#searchBody .mres').find((r: any) => (r.querySelector('.nm')?.textContent ?? '') === 'Navigate > Find in Files...')?.click();
  await settle(w);
  check('find action: Find in Files opens the real tool window',
    !!q(w, '#findIn') && q(w, '.dock-pane.active')?.getAttribute('data-pane') === 'find',
    q(w, '.dock-pane.active')?.getAttribute('data-pane') ?? '');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  (q(w, '#etabs .more') as any)?.click();
  await settle(w);
  const choices = qa(w, '#ctxMenu .citem').map((r: any) => r.querySelector('.clbl')?.textContent ?? '');
  check('tabs: Show hidden tabs lists every open document',
    choices.includes('main.py') && choices.includes('utils.py') && choices.includes('README.md'), choices.join(' / '));
  qa(w, '#ctxMenu .citem').find((r: any) => (r.querySelector('.clbl')?.textContent ?? '') === 'utils.py')?.click();
  await settle(w);
  check('tabs: choosing a hidden tab activates it', (q(w, '#stFile')?.textContent ?? '') === 'utils.py', q(w, '#stFile')?.textContent ?? '');

  const readme = qa(w, '#etabs .etab').find((t: any) => t.getAttribute('data-tab') === 'README.md');
  fire(w, readme, 'mousedown', { button: 1 });
  await settle(w);
  check('tabs: middle click closes a clean tab',
    !qa(w, '#etabs .etab').some((t: any) => t.getAttribute('data-tab') === 'README.md'),
    qa(w, '#etabs .etab').map((t: any) => t.getAttribute('data-tab')).join(','));

  const ed = q(w, '#ta') as any;
  ed.value = 'unsaved utils';
  fire(w, ed, 'input', {});
  const active = qa(w, '#etabs .etab').find((t: any) => t.getAttribute('data-tab') === 'utils.py');
  fire(w, active, 'mousedown', { button: 1 });
  await settle(w);
  check('tabs: middle click on a dirty tab asks before closing',
    /Unsaved Changes/.test(q(w, '#dlgRoot .dlg-title')?.textContent ?? ''),
    q(w, '#dlgRoot .dlg-title')?.textContent ?? '');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'alpha\nbeta\ngamma\ndelta';
  fire(w, ed, 'input', {});
  socket.deliver({ kind: 'diagnostics', language: 'python', items: [
    { line: 0, character: 0, severity: 1, message: 'first problem' },
    { line: 2, character: 1, severity: 2, message: 'third problem' }
  ] });
  await settle(w);
  ed.setSelectionRange(0, 0);
  const nextKey = fire(w, ed, 'keydown', { key: 'F2' });
  check('diagnostics: F2 is consumed by the editor', (nextKey as any).defaultPrevented === true);
  check('diagnostics: F2 moves to the next problem', caretLine(w) === 2 && ed.selectionStart === 12,
    caretLine(w) + ':' + ed.selectionStart);
  const prevKey = fire(w, ed, 'keydown', { key: 'F2', shiftKey: true });
  check('diagnostics: Shift+F2 moves to the previous problem',
    (prevKey as any).defaultPrevented === true && caretLine(w) === 0 && ed.selectionStart === 0,
    caretLine(w) + ':' + ed.selectionStart);

  socket.deliver({ kind: 'fsRoot', reqId: 31, root: 'D:/proj', name: 'proj' });
  await settle(w);
  const rootList = socket.sent.find((m: any) => m.kind === 'fsList' && m.path === '');
  socket.deliver({ kind: 'fsListing', path: '', reqId: rootList?.reqId, entries: [
    { name: 'main.py', path: 'main.py', kind: 'file', editable: true }
  ] });
  await settle(w);
  const treeRow = qa(w, '#ptree .tnode.file')[0];
  treeRow?.focus();
  fire(w, treeRow, 'keydown', { key: 'F2' });
  await settle(w);
  const rename = q(w, '.inline-rename') as any;
  check('diagnostics: F2 on a tree row still starts a rename',
    !!rename && rename.value === 'main.py', rename?.value ?? 'no inline input');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'alpha beta alpha';
  ed.setSelectionRange(0, 0);
  fire(w, ed, 'keydown', { key: 'f', ctrlKey: true });
  const input = q(w, '.findbar .fb-in') as any;
  input.value = 'alpha';
  fire(w, input, 'input', {});
  await settle(w, 30);
  fire(w, input, 'keydown', { key: 'Escape' });
  ed.setSelectionRange(5, 5);
  const key = fire(w, ed, 'keydown', { key: 'F3' });
  check('find keys: F3 is consumed with the find bar closed', (key as any).defaultPrevented === true);
  check('find keys: F3 jumps to the next match of the last query',
    ed.selectionStart === 11 && ed.selectionEnd === 16, `${ed.selectionStart}-${ed.selectionEnd}`);
  fire(w, ed, 'keydown', { key: 'F3', shiftKey: true });
  check('find keys: Shift+F3 returns to the previous match',
    ed.selectionStart === 0 && ed.selectionEnd === 5, `${ed.selectionStart}-${ed.selectionEnd}`);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const noQuery = fire(w, w.document, 'keydown', { key: 'F3' });
  check('find keys: F3 without a query says what to do',
    (noQuery as any).defaultPrevented === true && /No find query/.test(q(w, '#toast')?.textContent ?? ''),
    q(w, '#toast')?.textContent ?? '');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const replaceKey = fire(w, w.document, 'keydown', { key: 'R', ctrlKey: true, shiftKey: true });
  check('replace keys: Ctrl+Shift+R is consumed at the capture boundary',
    (replaceKey as any).defaultPrevented === true);
  check('replace keys: Ctrl+Shift+R enters the existing replace preview',
    (q(w, '#findPreview')?.textContent ?? '') === 'Close Preview' &&
      q(w, '.dock-pane.active')?.getAttribute('data-pane') === 'find',
    q(w, '#findPreview')?.textContent ?? '');
  const findInput = q(w, '#findIn') as any;
  findInput.value = 'target';
  fire(w, findInput, 'input', {});
  await settle(w, 160);
  check('replace keys: the preview keeps its selection and apply controls',
    !!q(w, '#findOut .find-repl-bar') && !!q(w, '#findReplApply'));

  fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  const actionInput = q(w, '#searchInput') as any;
  actionInput.value = 'Replace in Files';
  fire(w, actionInput, 'input', {});
  await settle(w, 30);
  check('replace keys: Find Action exposes the real menu command',
    qa(w, '#searchBody .mres').some((r: any) =>
      (r.querySelector('.nm')?.textContent ?? '') === 'Navigate > Replace in Files...'),
    qa(w, '#searchBody .mres').map((r: any) => r.querySelector('.nm')?.textContent).join(' / '));
  fire(w, w.document, 'keydown', { key: 'Escape' });

  const ed = q(w, '#ta') as any;
  ed.value = 'hello World';
  ed.setSelectionRange(0, ed.value.length);
  const caseKey = fire(w, ed, 'keydown', { key: 'U', ctrlKey: true, shiftKey: true });
  check('case keys: Ctrl+Shift+U is consumed', (caseKey as any).defaultPrevented === true);
  check('case keys: Ctrl+Shift+U toggles case and keeps the selection',
    ed.value === 'HELLO wORLD' && ed.selectionStart === 0 && ed.selectionEnd === 11,
    ed.value + ' ' + ed.selectionStart + '-' + ed.selectionEnd);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  socket.deliver({ kind: 'fsRoot', reqId: 31, root: 'D:/proj', name: 'proj' });
  await settle(w);
  const rootList = socket.sent.find((m: any) => m.kind === 'fsList' && m.path === '');
  socket.deliver({ kind: 'fsListing', path: '', reqId: rootList?.reqId, entries: [
    { name: 'main.py', path: 'main.py', kind: 'file', editable: true }
  ] });
  await settle(w);
  const ed = q(w, '#ta') as any;
  const beforeValue = ed.value;
  const readsBefore = socket.sent.filter((m: any) => m.kind === 'fsRead').length;
  const revealKey = fire(w, w.document, 'keydown', { key: 'F1', altKey: true });
  check('reveal: Alt+F1 is consumed', (revealKey as any).defaultPrevented === true);
  check('reveal: Alt+F1 selects the active file in the project tree',
    (w.document.activeElement as any)?.getAttribute?.('data-path') === 'main.py',
    (w.document.activeElement as any)?.getAttribute?.('data-path') ?? 'no focus');
  check('reveal: Alt+F1 does not reopen the file or overwrite the buffer',
    socket.sent.filter((m: any) => m.kind === 'fsRead').length === readsBefore && ed.value === beforeValue);

  let copied = '';
  Object.defineProperty(w.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => { copied = t; return Promise.resolve(); } },
  });
  ed.value = 'a\nb\nc';
  ed.setSelectionRange(4, 4);
  fire(w, ed, 'input', {});
  const refKey = fire(w, w.document, 'keydown', { key: 'C', ctrlKey: true, altKey: true, shiftKey: true });
  await settle(w, 40);
  check('reference: Ctrl+Alt+Shift+C is consumed',
    (refKey as any).defaultPrevented === true);
  check('reference: the copied reference is a one-based file:line location',
    copied === 'main.py:3' && ed.selectionStart === 4 && ed.value === 'a\nb\nc', copied);

  ed.value = 'anchor\nsecond\nthird';
  ed.setSelectionRange(0, 0);
  fire(w, ed, 'input', {});
  const utilsTab = qa(w, '#etabs .etab').find((t: any) => t.getAttribute('data-tab') === 'utils.py');
  utilsTab?.click();
  await settle(w);
  check('last edit: navigation moved to another file', (q(w, '#stFile')?.textContent ?? '') === 'utils.py',
    q(w, '#stFile')?.textContent ?? '');
  const backKey = fire(w, w.document, 'keydown', { key: 'Backspace', ctrlKey: true, shiftKey: true });
  await settle(w);
  check('last edit: Ctrl+Shift+Backspace is consumed', (backKey as any).defaultPrevented === true);
  check('last edit: the caret returns to the recorded edit position',
    (q(w, '#stFile')?.textContent ?? '') === 'main.py' && caretLine(w) === 0 && ed.selectionStart === 0,
    (q(w, '#stFile')?.textContent ?? '') + ' ' + caretLine(w) + ':' + ed.selectionStart);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'def first():\n    pass\n\ndef second():\n    pass\n\ndef third():\n    pass';
  ed.setSelectionRange(0, 0);
  const down = fire(w, ed, 'keydown', { key: 'ArrowDown', altKey: true });
  check('methods: Alt+Down is consumed by the editor', (down as any).defaultPrevented === true);
  check('methods: Alt+Down moves to the next declaration', caretLine(w) === 3, String(caretLine(w)));
  fire(w, ed, 'keydown', { key: 'ArrowDown', altKey: true });
  check('methods: repeated Alt+Down advances again', caretLine(w) === 6, String(caretLine(w)));
  fire(w, ed, 'keydown', { key: 'ArrowDown', altKey: true });
  check('methods: next declaration wraps at the end of the file', caretLine(w) === 0, String(caretLine(w)));
  fire(w, ed, 'keydown', { key: 'ArrowUp', altKey: true });
  check('methods: Alt+Up wraps backwards to the last declaration', caretLine(w) === 6, String(caretLine(w)));
  check('methods: navigation reports the declaration it reached',
    /Previous method/.test(String(q(w, '#stHint')?.textContent ?? '')),
    q(w, '#stHint')?.textContent ?? '');

  fire(w, w.document, 'keydown', { key: 'a', ctrlKey: true, shiftKey: true });
  const action = q(w, '#searchInput') as any;
  for (const [query, label] of [
    ['Next Method', 'Navigate > Next Method'],
    ['Previous Method', 'Navigate > Previous Method'],
    ['Quick Definition', 'Navigate > Quick Definition'],
    ['Highlight Usages in File', 'Navigate > Highlight Usages in File']
  ]) {
    action.value = query;
    fire(w, action, 'input', {});
    await settle(w);
    check('efficiency actions: ' + query + ' is reachable from Find Action',
      qa(w, '#searchBody .mres').some((r: any) => (r.querySelector('.nm')?.textContent ?? '') === label),
      qa(w, '#searchBody .mres').map((r: any) => r.querySelector('.nm')?.textContent).join(' / '));
  }
  fire(w, w.document, 'keydown', { key: 'Escape' });

  const src = 'def target():\n    return 1\n\nvalue = target()';
  ed.value = src;
  const at = src.lastIndexOf('target') + 2;
  ed.setSelectionRange(at, at);
  const qk = fire(w, ed, 'keydown', { key: 'I', ctrlKey: true, shiftKey: true });
  check('quick definition: Ctrl+Shift+I is consumed', (qk as any).defaultPrevented === true);
  check('quick definition: a read-only preview opens with the local declaration',
    /Quick Definition/.test(String(q(w, '#dlgRoot .dlg-title')?.textContent ?? '')) &&
      /line 1 . def target\(\):/.test(String(q(w, '#dlgRoot .dlg-detail')?.textContent ?? '')),
    String(q(w, '#dlgRoot .dlg-detail')?.textContent ?? ''));
  const defReq = socket.lastSentOf('definition');
  check('quick definition: it asks the language server without navigating',
    Number(defReq?.requestId) >= 960000 && defReq?.line === 3,
    JSON.stringify(defReq));
  socket.deliver({ kind: 'definitionResult', requestId: defReq?.requestId, locations: [
    { uri: 'main.py', line: 0, character: 4 }
  ] });
  await settle(w);
  check('quick definition: the server answer upgrades the same preview',
    /From the language server/.test(String(q(w, '#dlgRoot .dlg-detail')?.textContent ?? '')) ||
      /From the language server/.test(String(q(w, '#dlgRoot .sub')?.textContent ?? '')),
    String(q(w, '#dlgRoot .dlg-detail')?.textContent ?? ''));
  check('quick definition: the caret never leaves the symbol being inspected',
    ed.selectionStart === at && caretLine(w) === 3, `${ed.selectionStart} L${caretLine(w)}`);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'target = 1\n# target\nmsg = "target"\ntarget += 2';
  ed.setSelectionRange(2, 2);
  const key = fire(w, ed, 'keydown', { key: 'F7', ctrlKey: true, shiftKey: true });
  check('usages: Ctrl+Shift+F7 is consumed', (key as any).defaultPrevented === true);
  check('usages: only code occurrences are highlighted, not comments or strings',
    qa(w, '#glines .gline.hasusage').length === 2,
    qa(w, '#glines .gline.hasusage').map((g: any) => g.getAttribute('data-line')).join(','));
  check('usages: the status bar counts the matches',
    /Highlighted 2 usages/.test(String(q(w, '#stHint')?.textContent ?? '')),
    q(w, '#stHint')?.textContent ?? '');

  ed.value = 'alpha beta';
  ed.setSelectionRange(10, 10);
  const back = fire(w, ed, 'keydown', { key: 'Backspace', ctrlKey: true });
  check('word delete: Ctrl+Backspace is consumed', (back as any).defaultPrevented === true);
  check('word delete: Ctrl+Backspace removes the previous word with trailing space',
    ed.value === 'alpha' && ed.selectionStart === 5, `${ed.value} ${ed.selectionStart}`);
  ed.value = 'alpha beta';
  ed.setSelectionRange(5, 5);
  const fwd = fire(w, ed, 'keydown', { key: 'Delete', ctrlKey: true });
  check('word delete: Ctrl+Delete is consumed', (fwd as any).defaultPrevented === true);
  check('word delete: Ctrl+Delete removes the next word with leading space',
    ed.value === 'alpha', ed.value);

  ed.value = 'alpha beta\ngamma delta';
  ed.setSelectionRange(2, 2);
  fire(w, ed, 'keydown', { key: 'w', ctrlKey: true });
  check('selection: Ctrl+W first selects the word',
    ed.selectionStart === 0 && ed.selectionEnd === 5, `${ed.selectionStart}-${ed.selectionEnd}`);
  fire(w, ed, 'keydown', { key: 'w', ctrlKey: true });
  check('selection: a second Ctrl+W grows to the line',
    ed.selectionStart === 0 && ed.selectionEnd === 10, `${ed.selectionStart}-${ed.selectionEnd}`);
  fire(w, ed, 'keydown', { key: 'w', ctrlKey: true });
  check('selection: a third Ctrl+W grows to the paragraph',
    ed.selectionEnd === ed.value.length, `${ed.selectionStart}-${ed.selectionEnd}`);
  fire(w, ed, 'keydown', { key: 'w', ctrlKey: true, shiftKey: true });
  check('selection: Ctrl+Shift+W shrinks one stage',
    ed.selectionStart === 0 && ed.selectionEnd === 10, `${ed.selectionStart}-${ed.selectionEnd}`);
  fire(w, ed, 'keydown', { key: 'w', ctrlKey: true, shiftKey: true });
  fire(w, ed, 'keydown', { key: 'w', ctrlKey: true, shiftKey: true });
  check('selection: shrinking reaches the original caret',
    ed.selectionStart === 2 && ed.selectionEnd === 2, `${ed.selectionStart}-${ed.selectionEnd}`);

  ed.value = 'first second';
  ed.setSelectionRange(0, 5);
  fire(w, ed, 'copy', {});
  ed.setSelectionRange(ed.value.length, ed.value.length);
  const pasteKey = fire(w, ed, 'keydown', { key: 'v', ctrlKey: true, shiftKey: true });
  check('paste history: Ctrl+Shift+V is consumed', (pasteKey as any).defaultPrevented === true);
  check('paste history: copied text is offered for reuse',
    /Paste from History/.test(String(q(w, '#dlgRoot .dlg-title')?.textContent ?? '')) &&
      qa(w, '#dlgRoot .dlg-radios label').some((l: any) => /first/.test(l.textContent ?? '')),
    qa(w, '#dlgRoot .dlg-radios label').map((l: any) => l.textContent).join(' / '));
  qa(w, '#dlgRoot .dlg-btn').find((b: any) => b.textContent === 'Paste')?.click();
  await settle(w);
  check('paste history: choosing an entry inserts it at the caret',
    ed.value === 'first secondfirst' && !q(w, '#dlgRoot .dlg-scrim'), ed.value);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'n', ctrlKey: true, shiftKey: true });
  const rootReq = socket.sent.find((m: any) => m.kind === 'fsList' && Number(m.reqId) > 870000);
  socket.deliver({ kind: 'fsListing', path: '', reqId: rootReq?.reqId, entries: [
    { name: 'src', path: 'src', kind: 'dir' }
  ] });
  await settle(w);
  const nested = socket.sent.find((m: any) => m.kind === 'fsList' && m.path === 'src');
  socket.deliver({ kind: 'fsListing', path: 'src', reqId: nested?.reqId, entries: [
    { name: 'api_client.py', path: 'src/api_client.py', kind: 'file' }
  ] });
  await settle(w);
  const si = q(w, '#searchInput') as any;
  si.value = 'apic';
  fire(w, si, 'input', {});
  await settle(w);
  qa(w, '#searchBody .mres').find((r: any) =>
    (r.querySelector('.nm')?.textContent ?? '') === 'api_client.py')?.click();
  await settle(w);
  const read = socket.sent.find((m: any) => m.kind === 'fsRead' && m.path === 'src/api_client.py');
  socket.deliver({ kind: 'fsFile', path: 'src/api_client.py', reqId: read?.reqId,
    file: { path: 'src/api_client.py', content: 'def request():\n    pass\n\nvalue = request()', languageId: 'python', editable: true } });
  await settle(w);

  const paths = qa(w, '#breadcrumbs [data-crumb-path]').map((b: any) => b.getAttribute('data-crumb-path'));
  check('breadcrumbs: every path segment is a real control',
    paths.includes('src') && paths.includes('src/api_client.py') &&
      qa(w, '#breadcrumbs button.crumb[data-crumb-path]').length === paths.length,
    paths.join(' / '));
  const ed = q(w, '#ta') as any;
  const at = ed.value.lastIndexOf('request') + 2;
  ed.setSelectionRange(at, at);
  fire(w, ed, 'click');
  await settle(w);
  const sym = q(w, '#breadcrumbs .crumb--symbol');
  check('breadcrumbs: the enclosing declaration appears as a clickable crumb',
    /def request/.test(String(sym?.textContent ?? '')), String(sym?.textContent ?? ''));
  (sym as any)?.click();
  await settle(w);
  check('breadcrumbs: choosing the symbol crumb jumps to its declaration', caretLine(w) === 0, String(caretLine(w)));

  socket.deliver({ kind: 'fsRoot', reqId: 31, root: 'D:/proj', name: 'proj' });
  await settle(w);
  const treeReq = socket.sent.find((m: any) => m.kind === 'fsList' && m.path === '');
  socket.deliver({ kind: 'fsListing', path: '', reqId: treeReq?.reqId, entries: [
    { name: 'src', path: 'src', kind: 'dir' }
  ] });
  await settle(w);
  (qa(w, '#breadcrumbs [data-crumb-path="src"]')[0] as any)?.click();
  await settle(w);
  check('breadcrumbs: a directory crumb reveals that folder in the project tree',
    (w.document.activeElement as any)?.getAttribute?.('data-path') === 'src',
    (w.document.activeElement as any)?.getAttribute?.('data-path') ?? 'no focus');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = Array.from({ length: 20 }, (_, i) => 'line ' + (i + 1)).join('\n');
  Object.defineProperty(ed, 'scrollHeight', { configurable: true, value: 400 });
  Object.defineProperty(ed, 'clientHeight', { configurable: true, value: 100 });
  ed.scrollTop = 0;
  const mini = q(w, '#minimap') as any;
  mini.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 200, right: 58, width: 58, height: 200, x: 0, y: 0 });
  fire(w, mini, 'click', { clientY: 100 });
  await settle(w);
  check('minimap: clicking halfway scrolls to the middle of the buffer',
    ed.scrollTop === 150, String(ed.scrollTop));
  ed.scrollTop = 300;
  fire(w, ed, 'scroll');
  await settle(w);
  const vp = q(w, '#minimapViewport') as any;
  check('minimap: the viewport marker tracks editor scroll position',
    !!vp && vp.style.height === '25%' && vp.style.top === '75%',
    `${vp?.style?.height} / ${vp?.style?.top}`);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  socket.deliver({ kind: 'fsRoot', reqId: 31, root: 'D:/proj', name: 'proj' });
  await settle(w);
  const treeReq = socket.sent.find((m: any) => m.kind === 'fsList' && m.path === '');
  socket.deliver({ kind: 'fsListing', path: '', reqId: treeReq?.reqId, entries: [
    { name: 'main.py', path: 'main.py', kind: 'file', editable: true },
    { name: 'utils.py', path: 'utils.py', kind: 'file', editable: true }
  ] });
  await settle(w);
  const row = qa(w, '#ptree .tnode.file').find((r: any) => r.getAttribute('data-path') === 'main.py');
  fire(w, row, 'contextmenu', { clientX: 120, clientY: 120, button: 2 });
  await settle(w);
  const compareItem = qa(w, '#ctxMenu .citem').find((r: any) =>
    (r.querySelector('.clbl')?.textContent ?? '').includes('Compare with File'));
  check('compare files: the project tree offers file-to-file comparison', !!compareItem);
  (compareItem as any)?.click();
  await settle(w);
  const field = q(w, '#dlgRoot input[data-f="path"]') as any;
  check('compare files: a workspace-relative path can be typed', !!field);
  field.value = 'utils.py';
  fire(w, field, 'input', {});
  qa(w, '#dlgRoot .dlg-btn').find((b: any) => b.textContent === 'Compare')?.click();
  await settle(w);
  const reads = socket.sent.filter((m: any) => m.kind === 'fsRead' && Number(m.reqId) >= 950000);
  check('compare files: both sides are read with separate request ids',
    reads.length === 2 && reads.some((m: any) => m.path === 'main.py') &&
      reads.some((m: any) => m.path === 'utils.py') && reads[0]?.reqId !== reads[1]?.reqId,
    JSON.stringify(reads.map((m: any) => [m.path, m.reqId])));
  const left = reads.find((m: any) => m.path === 'main.py');
  const right = reads.find((m: any) => m.path === 'utils.py');
  const activeBefore = q(w, '#stFile')?.textContent ?? '';
  const textBefore = (q(w, '#ta') as any)?.value ?? '';
  socket.deliver({ kind: 'fsFile', path: 'main.py', reqId: left?.reqId,
    file: { path: 'main.py', content: 'same\nleft', languageId: 'python', editable: true } });
  socket.deliver({ kind: 'fsFile', path: 'utils.py', reqId: right?.reqId,
    file: { path: 'utils.py', content: 'same\nright', languageId: 'python', editable: true } });
  await settle(w);
  const head = q(w, '#dlgRoot .diff-head')?.textContent ?? '';
  check('compare files: the real diff viewer opens with both file names',
    head.includes('main.py') && head.includes('utils.py') && !!q(w, '#dlgRoot .diff-row.del') &&
      !!q(w, '#dlgRoot .diff-row.add'), head);
  check('compare files: neither read replaces an editor buffer',
    (q(w, '#stFile')?.textContent ?? '') === activeBefore &&
      ((q(w, '#ta') as any)?.value ?? '') === textBefore,
    q(w, '#stFile')?.textContent ?? '');
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html, JSON.stringify({ tabSize: 2, useTabs: false }));
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'x';
  ed.setSelectionRange(1, 1);
  const tab = fire(w, ed, 'keydown', { key: 'Tab' });
  check('editor details: Tab uses the configured tab width',
    ed.value === 'x  ' && tab.defaultPrevented, JSON.stringify(ed.value));
  ed.value = 'if ok:';
  ed.setSelectionRange(6, 6);
  fire(w, ed, 'keydown', { key: 'Enter' });
  check('editor details: auto-indent uses the configured tab width',
    ed.value === 'if ok:\n  ', JSON.stringify(ed.value));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html, JSON.stringify({ tabSize: 4, useTabs: true }));
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'y';
  ed.setSelectionRange(1, 1);
  fire(w, ed, 'keydown', { key: 'Tab' });
  check('editor details: Tab inserts a real tab when useTabs is on',
    ed.value === 'y\t', JSON.stringify(ed.value));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'one\ntwo';
  ed.setSelectionRange(7, 7);
  fire(w, ed, 'keydown', { key: 'g', ctrlKey: true });
  await settle(w);
  const line = q(w, '#dlgRoot input[data-f="line"]') as any;
  check('editor details: Go to Line opens on the current line', !!line && line.value === '2', line?.value ?? '');
  const before = ed.value;
  const stolen = fire(w, line, 'keydown', { key: 'd', ctrlKey: true });
  await settle(w);
  check('editor details: a dialog field does not trigger editor shortcuts',
    ed.value === before && !stolen.defaultPrevented, ed.value);
  fire(w, line, 'keydown', { key: 'Escape' });
  await settle(w);
  check('editor details: Escape still closes the dialog', !q(w, '#dlgRoot .dlg-scrim'));
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'alpha\nbeta';
  ed.setSelectionRange(10, 10);
  fire(w, ed, 'keydown', { key: 'd', ctrlKey: true });
  await settle(w);
  check('editor details: Duplicate Line records an edit location',
    ed.value === 'alpha\nbeta\nbeta' && /Duplicated line/.test(String(q(w, '#stHint')?.textContent ?? '')),
    `${JSON.stringify(ed.value)} / ${q(w, '#stHint')?.textContent ?? ''}`);
  ed.setSelectionRange(0, 0);
  fire(w, ed, 'keydown', { key: 'Backspace', ctrlKey: true, shiftKey: true });
  await settle(w);
  check('editor details: Ctrl+Shift+Backspace returns to a programmatic edit',
    caretLine(w) === 2, `${caretLine(w)} / ${q(w, '#stHint')?.textContent ?? ''}`);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'a\nb\nc';
  ed.setSelectionRange(2, 2);
  fire(w, ed, 'keydown', { key: 'g', ctrlKey: true });
  await settle(w);
  const line = q(w, '#dlgRoot input[data-f="line"]') as any;
  line.value = '99';
  qa(w, '#dlgRoot .dlg-btn').find((b: any) => b.textContent === 'Go')?.click();
  await settle(w);
  check('editor details: out-of-range Go to Line clamps to the real last line',
    caretLine(w) === 2 && /last line/.test(String(q(w, '#stHint')?.textContent ?? '')),
    `${caretLine(w)} / ${q(w, '#stHint')?.textContent ?? ''}`);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.value = 'alpha beta';
  ed.setSelectionRange(0, 5);
  fire(w, ed, 'copy', {});
  const paste = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: { getData: (type: string) => type === 'text/plain' ? 'gamma delta' : '' },
  });
  w.document.dispatchEvent(paste);
  fire(w, ed, 'keydown', { key: 'v', ctrlKey: true, shiftKey: true });
  await settle(w);
  const labels = qa(w, '#dlgRoot .dlg-radios label').map((n: any) => String(n.textContent ?? ''));
  check('editor details: clipboard history includes copy and system paste',
    labels.some((s) => s.includes('alpha')) && labels.some((s) => s.includes('gamma delta')),
    labels.join(' | '));
  qa(w, '#dlgRoot .dlg-btn').find((b: any) => b.textContent === 'Paste')?.click();
  await settle(w);
  check('editor details: the newest history entry replaces the current selection',
    ed.value === 'gamma delta beta', ed.value);
  w.close();
}

console.log('');
{
  FakeSocket.instances = [];
  const mounted = mountPage(html);
  const w = mounted.window as any;
  const socket = needSocket(mounted);
  await settle(w);
  fire(w, w.document, 'keydown', { key: 'n', ctrlKey: true, shiftKey: true });
  const rootReq = socket.sent.find((m: any) => m.kind === 'fsList' && Number(m.reqId) > 870000);
  socket.deliver({ kind: 'fsListing', path: '', reqId: rootReq?.reqId, entries: [
    { name: 'types.ts', path: 'types.ts', kind: 'file', editable: true }
  ] });
  await settle(w);
  const si = q(w, '#searchInput') as any;
  si.value = 'types';
  fire(w, si, 'input', {});
  await settle(w);
  const row = qa(w, '#searchBody .mres').find((r: any) =>
    (r.querySelector('.nm')?.textContent ?? '') === 'types.ts');
  check('editor details: TypeScript file opens from the workspace index', !!row);
  (row as any)?.click();
  await settle(w);
  const read = socket.sent.find((m: any) => m.kind === 'fsRead' && m.path === 'types.ts');
  socket.deliver({ kind: 'fsFile', path: 'types.ts', reqId: read?.reqId,
    file: { path: 'types.ts', content: 'const a = 1;\nlet b = 2;', languageId: 'typescript', editable: true } });
  await settle(w);
  const ed = q(w, '#ta') as any;
  ed.setSelectionRange(0, 0);
  fire(w, ed, 'keydown', { key: '/', ctrlKey: true });
  await settle(w);
  check('editor details: Ctrl+/ uses the TypeScript line-comment prefix',
    ed.value.startsWith('// const a = 1;'), ed.value);
  w.close();
}

// ------------------------------------------------- untrusted file names
// A workspace file name is data from disk, not markup. The Run status used to
// splice `currentFile` into an innerHTML string; a name containing an `<img>`
// tag became a DOM element before any output arrived. Keep the regression at
// the real entry point: a hostile name from fsListing, opened and run.
async function testUntrustedFileNames(): Promise<void> {
  FakeSocket.instances = [];
  const mountedPage = mountPage(html);
  const w = mountedPage.window;
  const socket = needSocket(mountedPage);
  await settle(w, 20);

  const hostile = 'x<img src=x onerror=window.__nlg_pwned=1>" data-hack="1.py';
  socket.deliver({
    kind: 'fsListing',
    path: '',
    entries: [{ name: hostile, path: hostile, kind: 'file', editable: true }],
  });
  await settle(w, 20);

  const row = qa(w, '#ptree .tnode.file').find(
    (r: any) => r.getAttribute('data-path') === hostile,
  ) as any;
  check(
    'escape: a hostile file name from the project tree stays text',
    !!row && !row.querySelector('img'),
    row ? row.textContent : 'not listed',
  );
  check(
    'escape: a quoted file name cannot open a second attribute',
    !!row && row.getAttribute('data-path') === hostile && !row.hasAttribute('data-hack'),
    row ? String(row.getAttribute('data-path')) : 'not listed',
  );

  if (row) {
    row.dispatchEvent(new w.MouseEvent('click', { bubbles: true, button: 0 }));
    await settle(w, 20);
    const read = socket.sent.find((m: any) => m.kind === 'fsRead' && m.path === hostile) as any;
    socket.deliver({
      kind: 'fsFile',
      path: hostile,
      reqId: read?.reqId,
      file: { path: hostile, content: 'value = 1\n', languageId: 'python', editable: true },
    });
    await settle(w, 20);

    check(
      'escape: the hostile name becomes the active document as text',
      (q(w, '#stFile')?.textContent ?? '') === hostile && !q(w, '#stFile')?.querySelector('img'),
      String(q(w, '#stFile')?.textContent),
    );

    q(w, '#runBtn')?.click();
    await settle(w, 20);
    socket.deliver({ kind: 'runStart' });
    await settle(w, 20);

    const out = q(w, '#runOut');
    check(
      'escape: run status escapes the active file name',
      !!out && !out.querySelector('img') && (out.textContent ?? '').includes('Running ' + hostile),
      (out?.textContent ?? '').slice(0, 120),
    );
    check('escape: the injected handler never ran', w.__nlg_pwned === undefined);
  }
  w.close();
}

await testUntrustedFileNames();
console.log('');

const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
