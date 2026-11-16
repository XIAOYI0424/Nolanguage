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
// navigation capabilities arrived; that is a coherent feature and earned its own
// shard, so the ceiling moved by one rather than merging it into a file it does
// not belong to.
check('client: split into 6-10 fragments', fragmentFiles.length >= 6 && fragmentFiles.length <= 10, fragmentFiles.join(','));
check(
  'client: every fragment on disk is wired into the assembler',
  fragmentFiles.length === CLIENT_FRAGMENTS.length &&
    fragmentFiles.every((f, i) => CLIENT_FRAGMENTS[i].file === f),
  `${fragmentFiles.length} files vs ${CLIENT_FRAGMENTS.length} imported`,
);
const fragmentText = fragmentFiles.map((f) => readFileSync(join(CLIENT_DIR, f), 'utf8')).join('\n');
check('client: no fragment contains a backtick', fragmentText.indexOf('`') === -1);
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
  check('boot: main toolbar renders the run widget', !!q(w, '#runBtn') && !!q(w, '#projWidget'));
  check('boot: tool strip renders 10 tools + settings', qa(w, '#strip .sbtn').length === 11, `${qa(w, '#strip .sbtn').length} buttons`);
  check('boot: icons are painted as inline SVG', qa(w, '#strip .sbtn svg').length === 11);
  check('boot: editor gutter renders line numbers', qa(w, '#glines .gline').length > 5, `${qa(w, '#glines .gline').length} rows`);
  check('boot: editor loads the main.py sample', (q(w, '#ta')?.value ?? '').indexOf('def fib') !== -1);
  check('boot: three document tabs render', qa(w, '#etabs .etab').length === 3, `${qa(w, '#etabs .etab').length} tabs`);
  check('boot: bottom dock renders 8 tool windows', qa(w, '#dockTabs .dtab').length === 8, `${qa(w, '#dockTabs .dtab').length} tabs`);
  check('boot: status bar shows file + caret + perf cells',
    !!q(w, '#stFile') && !!q(w, '#stPos') && !!q(w, '#stPerf'));
  check('boot: terminal input is present', !!q(w, '#termIn') && !!q(w, '#termOut'));

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

  // A frame for another language must not paint over the current one.
  const before = q(w, '#pkgFile')?.textContent ?? '';
  socket.deliver({ kind: 'dependencies', language: 'go', supported: true, format: 'gomod', file: 'go.mod', searched: ['go.mod'], packages: [], undeclared: [], installable: true });
  await settle(w);
  check('packages: a stale frame from another language is dropped', (q(w, '#pkgFile')?.textContent ?? '') === before, q(w, '#pkgFile')?.textContent ?? '');

  // Put the dock back where the rest of the suite expects it.
  qa(w, '#dockTabs .dtab').find((b) => (b.textContent ?? '').trim() === 'Run')?.click();
  await settle(w);

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

  // ---- interpreter picker ----
  socket!.deliver({
    kind: 'interpreters', language: 'python', root: '/proj', active: '/proj/.venv/Scripts/python.exe', pinned: null,
    candidates: [
      { path: '/proj/.venv/Scripts/python.exe', label: 'Python 3.13.14 (.venv)', kind: 'venv', source: '.venv' },
      { path: '/usr/bin/python3', label: 'Python 3.11.9 (PATH)', kind: 'path', source: 'PATH' },
    ],
  });
  await settle(w);
  const radios = qa(w, '.dlg input[data-r="bin"]');
  check('migration: the picker lists candidates plus "auto"', radios.length === 3, String(radios.length));
  check('migration: the active interpreter is preselected', radios[0].checked === true);
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

const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
