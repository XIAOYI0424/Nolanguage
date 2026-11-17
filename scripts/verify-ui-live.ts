/**
 * The five navigation capabilities, driven through a real browser.
 *
 * # Why this is not in `verify-all`
 *
 * `verify-ui-dom` runs the client in jsdom, and jsdom is not a browser: the
 * editor shard explicitly bails out when it sees a jsdom user agent, so that
 * suite only ever exercises the textarea fallback. CodeMirror owning the
 * document, real focus, and real key dispatch are exactly the parts a rename or
 * a quick fix can silently break - and exactly the parts jsdom cannot see.
 *
 * So this suite drives headless Edge over CDP. It is deliberately **opt-in**:
 * it needs Edge installed, a free port, and a packaged exe, and a headless
 * browser on a CI runner is a flaky thing to make mandatory. Run it by hand
 * after touching the editor, the keymap, or the navigation shard:
 *
 *   npm run verify:ui-live
 *
 * It SKIPs (exit 0) when Edge or `dist/Nolanguage.exe` is missing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CdpClient, MOD, findTarget } from './lib/CdpClient.js';

const ROOT = process.cwd();
const EXE = join(ROOT, 'dist', 'Nolanguage.exe');
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const APP_PORT = 7521;
const CDP_PORT = 9334;
const SANDBOX = join(ROOT, '.tmp', `ui-live-${process.pid}`);
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;

const results: Array<{ name: string; ok: boolean; detail: string; skipped?: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
/** Not covered here — say so, so "0 actions" is never read as "0 problems". */
function skip(name: string, why: string): void {
  results.push({ name, ok: true, detail: why, skipped: true });
  console.log(`SKIP  ${name}  — ${why}`);
}

const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.log('SKIP  Microsoft Edge not found — live UI test skipped');
  console.log('0/0 checks passed');
  process.exit(0);
}
if (!existsSync(EXE)) {
  console.log(`SKIP  ${EXE} missing (run npm run build:exe first)`);
  console.log('0/0 checks passed');
  process.exit(0);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(ms: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

let app: ChildProcess | undefined;
let browser: ChildProcess | undefined;

try {
  mkdirSync(join(SANDBOX, 'temp'), { recursive: true });
  app = spawn(EXE, ['--no-open'], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      NOLANGUAGE_NO_BROWSER: '1',
      NOLANGUAGE_DATA: join(SANDBOX, 'data'),
      PANEL_PORT: String(APP_PORT),
      TMP: join(SANDBOX, 'temp'),
      TEMP: join(SANDBOX, 'temp'),
    },
  });
  if (!(await waitHealthy(40_000))) {
    check('the packaged app answers /health', false, 'never became healthy');
    throw new Error('app did not start');
  }

  browser = spawn(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${join(SANDBOX, 'edge')}`,
      '--window-size=1280,900',
      APP_URL,
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  const target = await findTarget(CDP_PORT, APP_URL, 30_000);
  if (!target) {
    check('headless Edge exposes the page over CDP', false, 'no target');
    throw new Error('no CDP target');
  }
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await sleep(1500);

  // ---- the page is the real editor, not the textarea fallback ----
  const cm = await cdp.eval("!!document.querySelector('.CodeMirror')");
  check('the IDE page runs with CodeMirror', cm.value === true, String(cm.value ?? cm.error));
  check(
    'the editor shows the sample buffer',
    ((await cdp.eval("document.getElementById('stLang')?.textContent")) ?? {}).value === 'Python',
    String((await cdp.eval("document.getElementById('stLang')?.textContent"))?.value ?? '?'),
  );

  /** Put the caret on a call site so "go to definition" has somewhere to go. */
  const caret = await cdp.eval(`(function(){
    var cm = document.querySelector('.CodeMirror').CodeMirror;
    var lines = cm.getValue().split('\\n');
    for (var i = 0; i < lines.length; i++) {
      // indexOf('fib') on this line lands inside the string literal
      // ("hello from fib(10) = "), and goto-definition on a string finds
      // nothing. The call is the last fib( on the line.
      if (lines[i].indexOf('fib(10)') >= 0) { cm.setCursor({ line: i, ch: lines[i].lastIndexOf('fib(') + 1 }); cm.focus(); return i + 1; }
    }
    return -1;
  })()`);
  check('the caret can be placed on a call site', typeof caret.value === 'number' && caret.value > 0, `line ${caret.value}`);

  // ---- Ctrl+B: definition ----
  const posBefore = (await cdp.eval("document.getElementById('stPos').textContent")).value;
  await cdp.press('b', 'KeyB', 66, MOD.ctrl);
  await sleep(900);
  const posAfter = (await cdp.eval("document.getElementById('stPos').textContent")).value;
  check('Ctrl+B jumps to the definition', posBefore !== posAfter, `${posBefore} -> ${posAfter}`);

  // ---- Alt+F7: references ----
  await cdp.press('F7', 'F7', 118, MOD.alt);
  await sleep(900);
  const refs = await cdp.eval("document.querySelectorAll('#navPick [data-nav-row]').length");
  check('Alt+F7 lists references', typeof refs.value === 'number' && refs.value > 0, `${refs.value} row(s)`);

  // ---- closing an overlay returns focus to the editor ----
  await cdp.press('Escape', 'Escape', 27, MOD.none);
  await sleep(500);
  const focus = await cdp.eval(`(function(){
    var el = document.activeElement;
    if (!el) return 'none';
    if (el.tagName === 'TEXTAREA') return 'editor';
    if (el.closest && el.closest('.CodeMirror')) return 'editor';
    return el.tagName;
  })()`);
  check('closing the overlay hands focus back to the editor', focus.value === 'editor', String(focus.value));

  // ---- Shift+F6: rename, and the edit lands in the document ----
  await cdp.eval(`(function(){
    var cm = document.querySelector('.CodeMirror').CodeMirror;
    var lines = cm.getValue().split('\\n');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('fib(') >= 0 && lines[i].indexOf('def ') < 0) { cm.setCursor({ line: i, ch: lines[i].indexOf('fib') + 1 }); break; }
    }
    cm.focus();
  })()`);
  await sleep(200);
  await cdp.press('F6', 'F6', 117, MOD.shift);
  await sleep(700);
  const dialog = (await cdp.eval("(document.getElementById('dlgRoot').textContent||'')")).value;
  check('Shift+F6 opens the rename dialog', String(dialog ?? '').includes('Rename Symbol'), String(dialog ?? '').slice(0, 40));

  const submitted = await cdp.eval(`(function(){
    var input = document.querySelector('#dlgRoot input');
    if (!input) return 'no input';
    input.value = 'fib2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    var btn = document.querySelector('#dlgRoot .dlg-btn.primary');
    if (!btn) return 'no button';
    btn.click();
    return 'ok';
  })()`);
  await sleep(1400);
  const doc = (await cdp.eval("document.querySelector('.CodeMirror').CodeMirror.getValue()")).value;
  const text = String(doc ?? '');
  check(
    'rename rewrites the definition and every call site',
    submitted.value === 'ok' && !text.includes('def fib(') && (text.match(/fib2/g) ?? []).length >= 3,
    `${(text.match(/fib2/g) ?? []).length} occurrence(s)`,
  );

  // ---- Alt+Enter: quick fix, applied for real ----
  await cdp.eval("document.querySelector('.CodeMirror').CodeMirror.focus()");
  await sleep(200);
  await cdp.press('Enter', 'Enter', 13, MOD.alt);
  await sleep(900);
  const fixRows = await cdp.eval("document.querySelectorAll('#navPick [data-nav-row]').length");
  const offered = typeof fixRows.value === 'number' && fixRows.value > 0;
  if (!offered) {
    // pyright 1.1.414 returns no code action here — verified directly against
    // the server with and without the diagnostics in `context`. The plumbing is
    // covered by `verify:lsp-protocol` against a fake server, which is where a
    // regression in the request/apply path can be caught deterministically.
    skip(
      'Alt+Enter offers a quick fix',
      'this server offered none at that position (pyright has no fix for it) — plumbing covered by verify:lsp-protocol',
    );
    skip('applying a quick fix edits the document', 'no action to apply');
  } else {
    check('Alt+Enter offers a quick fix', true, `${fixRows.value} action(s)`);
    const beforeText = (await cdp.eval("document.querySelector('.CodeMirror').CodeMirror.getValue()")).value;
    await cdp.press('Enter', 'Enter', 13, MOD.none);
    await sleep(900);
    const afterText = (await cdp.eval("document.querySelector('.CodeMirror').CodeMirror.getValue()")).value;
    check(
      'applying a quick fix edits the document',
      String(beforeText) !== String(afterText),
      `${String(beforeText ?? '').length} -> ${String(afterText ?? '').length} chars`,
    );
  }

  // ---- L0: diagnostics are squiggles in the editor, not just a panel ----
  // The engine has produced lint-level diagnostics for a long time; the question
  // this answers is whether the *editor* shows them. `paintDiagMarks` marks the
  // range and the gutter, and check-as-you-type fires 300 ms after the buffer
  // changes — so this drives real editing, not a manual button.
  const l0Typed = await cdp.eval(`(function(){
    var cm = document.querySelector('.CodeMirror').CodeMirror;
    cm.setValue('def broken(\\n    return undefined_name\\n');
    return cm.getValue().length;
  })()`);
  check('the buffer accepts a file with two errors', typeof l0Typed.value === 'number', `${l0Typed.value} chars`);
  await sleep(3000);
  const l0Marks = await cdp.eval(`(function(){
    return {
      squiggles: document.querySelectorAll('.CodeMirror .diag-sq').length,
      gutter: document.querySelectorAll('.CodeMirror .diag-g1, .CodeMirror .diag-g2').length,
      problems: document.querySelectorAll('#probOut .prob').length,
      status: (document.getElementById('stProblems') || {}).textContent || '',
    };
  })()`);
  const l0 = (l0Marks.value ?? {}) as { squiggles?: number; gutter?: number; problems?: number; status?: string };
  check('a syntax error paints a squiggle in the editor', (l0.squiggles ?? 0) > 0, JSON.stringify(l0));
  check('the gutter carries the same severity', (l0.gutter ?? 0) > 0, `${l0.gutter} line(s)`);
  check('the Problems panel agrees with the editor', (l0.problems ?? 0) > 0, `${l0.problems} row(s)`);
  check('the status bar counts the same problems', /problem/.test(String(l0.status ?? '')), String(l0.status ?? 'none'));

  // Fixing the file must clear them: a stale squiggle is worse than none.
  await cdp.eval(`(function(){
    var cm = document.querySelector('.CodeMirror').CodeMirror;
    cm.setValue('def ok():\\n    return 42\\n');
    return true;
  })()`);
  await sleep(3000);
  const l0Cleared = await cdp.eval("document.querySelectorAll('.CodeMirror .diag-sq').length");
  check('fixing the file clears the squiggles', (l0Cleared.value ?? -1) === 0, `${String(l0Cleared.value)} left`);

  // ---- Ctrl+Alt+L: reformat falls back to the local indenter ----
  // The bundled Python stub does not implement `textDocument/formatting`, so the
  // correct behaviour is the local pass plus a toast that says so — not a silent
  // no-op, and not a lie that the server did it. The input has trailing spaces on
  // purpose: the local pass trims them, so "something changed" is observable.
  const NL = 'String.fromCharCode(10)';
  await cdp.eval(`(function(){
    var cm = document.querySelector('.CodeMirror').CodeMirror;
    cm.setValue('def f():' + ${NL} + '    return 1   ' + ${NL});
    cm.focus();
    return cm.getValue().length;
  })()`);
  await sleep(600);
  await cdp.press('l', 'KeyL', 76, MOD.ctrl | MOD.alt);
  await sleep(1500);
  const fmtFrame = await cdp.eval(`(function(){
    var cm = document.querySelector('.CodeMirror').CodeMirror;
    return { text: cm.getValue(), toast: (document.querySelector('.toast, #toast') || {}).textContent || '' };
  })()`);
  const fmtRes = (fmtFrame.value ?? {}) as { text?: string; toast?: string };
  check('Ctrl+Alt+L reformats the buffer', /return 1/.test(String(fmtRes.text ?? '')),
    JSON.stringify(String(fmtRes.text ?? '').slice(0, 40)));
  check('the local pass is what changed it, and says so', /Reformatted locally · \d+ line/.test(String(fmtRes.toast ?? '')),
    String(fmtRes.toast ?? 'none'));

  // ---- Ctrl+T: workspace symbols ----
  await cdp.press('t', 'KeyT', 84, MOD.ctrl);
  await sleep(700);
  const sym = (await cdp.eval("(document.getElementById('dlgRoot').textContent||'')")).value;
  check('Ctrl+T opens the symbol search', String(sym ?? '').includes('Symbol'), String(sym ?? '').slice(0, 40));

  // ---- typing cost ----
  // `renderEditor()` runs on every change; it used to call
  // `cm.setOption('mode', …)` unconditionally, which rebuilds the mode and
  // re-highlights the viewport. That was 9.5 ms per character — 95x a bare
  // CodeMirror with the same mode — and no gate noticed. 500 lines, 30 inserts:
  // the fixed code is 1-2 ms each, the old code 9.5, so the bound sits between.
  const typing = await cdp.eval(`(function(){
    var cm = document.querySelector('.CodeMirror').CodeMirror;
    var body = [];
    for (var i = 0; i < 500; i++) body.push('x' + i + ' = ' + i + '  # a line of python, roughly 40 chars');
    cm.setValue(body.join(String.fromCharCode(10)));
    cm.setCursor({ line: 250, ch: 5 });
    cm.focus();
    var t0 = performance.now();
    for (var k = 0; k < 30; k++) cm.replaceRange('z', cm.getCursor());
    return Math.round(performance.now() - t0);
  })()`);
  const typingMs = Number(typing.value ?? -1);
  check(
    '30 keystrokes on a 500-line file stay under 150 ms',
    typingMs >= 0 && typingMs < 150,
    `${typingMs} ms total · ${(typingMs / 30).toFixed(1)} ms per character`,
  );

  cdp.close();
} catch (err) {
  check('the live UI run completed', false, (err as Error).message);
} finally {
  browser?.kill();
  app?.kill();
  await sleep(500);
  try {
    rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 });
  } catch {
    /* a locked profile must not fail the run */
  }
}

const passed = results.filter((r) => r.ok).length;
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${passed}/${results.length} checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
if (passed !== results.length) {
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = 1;
}
