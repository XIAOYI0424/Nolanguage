/**
 * Debug Observatory — the standalone app.
 *
 * Three layers, cheapest first:
 *
 *   1. the session, driven with synthetic NDJSON (no process, no socket);
 *   2. the page, checked for self-containment and for the parts that make it
 *      usable (three panes, a tree renderer, the watch input);
 *   3. the whole thing against a real Python program: attach, collect stacks,
 *      add a watch, read it back through the page's own WebSocket.
 *
 * Layer 3 is the one that matters. Everything below it can pass while the app is
 * useless — an agent that never attaches, or a page that never receives a view,
 * fails only here.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-ndebug.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DebugSession } from '../src/debugtool/session.js';
import { renderDebugHtml } from '../src/debugtool/ui.js';
import { startDebugApp, languageOf } from '../src/debugtool/main.js';
import { parseArgs } from '../src/debugtool/cli.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ 1. the session

const session = new DebugSession({ hz: 10 });
await session.listen();
check('session: binds a loopback port', session.boundPort > 0, String(session.boundPort));
check('session: hands the agent its port and token', (() => {
  const env = session.agentEnv();
  return env.NLG_DEBUG_PORT === String(session.boundPort) && /^[0-9a-f]{32}$/.test(env.NLG_DEBUG_TOKEN);
})());

const line = (obj: unknown): string => JSON.stringify(obj);

// A wrong token must not attach: the port is on localhost, but localhost is
// shared with every other process on the machine.
session.ingest(line({ v: 1, t: 'hello', token: 'not-the-token', lang: 'python', pid: 1, target: 'x.py', agentVersion: '0', caps: [] }));
check('session: a wrong token is rejected', session.view().state === 'rejected', session.view().state);

// A fresh session for the rest of the checks.
const s2 = new DebugSession({ hz: 10 });
await s2.listen();
s2.ingest(line({ v: 1, t: 'hello', token: s2.agentEnv().NLG_DEBUG_TOKEN, lang: 'python', pid: 42, target: 'app.py', agentVersion: '0.2', caps: ['stack'] }));
check('session: a good token attaches', s2.view().state === 'attached' && s2.view().pid === 42, s2.view().state);

const frames = (names: string[]): Array<{ fn: string; file: string; line: number }> =>
  names.map((fn) => ({ fn, file: 'app.py', line: 1 }));

for (let i = 0; i < 12; i++) {
  s2.ingest(line({
    v: 1, t: 'stack', at: 1000 + i * 100, tid: 1,
    state: i > 6 ? 'blocked' : 'running',
    frames: frames(i > 6 ? ['main', 'work', 'sleep'] : ['main', 'work', 'step']),
  }));
}
const v2 = s2.view();
check('session: stacks become hot paths', v2.hot.length === 2 && v2.hot[0].hits === 7 && v2.hot[1].hits === 5, v2.hot.map((h) => `${h.stack}:${h.hits}`).join(' '));
check('session: the measured rate is reported', v2.actualHz > 9 && v2.actualHz < 11, v2.actualHz.toFixed(2));
check('session: a blocked run is a stall', v2.stalls.length >= 1, JSON.stringify(v2.stalls[0]?.stack ?? ''));

s2.ingest(line({ v: 1, t: 'watch', at: 2000, id: 'x', ok: true, value: { k: 'prim', t: 'int', v: '7' } }));
s2.ingest(line({ v: 1, t: 'watch', at: 2100, id: 'x', ok: true, value: { k: 'prim', t: 'int', v: '9' } }));
const watch = s2.view().watches.find((w) => w.expr === 'x');
check('session: watch values keep history', watch?.history.join(',') === '7,9', JSON.stringify(watch?.history));

s2.ingest(line({ v: 1, t: 'watch', at: 2200, id: 'y', ok: false, error: 'NameError: y' }));
check('session: a broken expression is data, not a crash', s2.view().watches.find((w) => w.expr === 'y')?.ok === false);

s2.ingest(line({ v: 1, t: 'snapshot', id: 'live-locals', at: 3000, path: 'locals', value: { k: 'obj', t: 'dict', fields: [['a', { k: 'prim', t: 'int', v: '1' }]] } }));
s2.ingest(line({ v: 1, t: 'snapshot', id: 'live-locals', at: 3100, path: 'locals', value: { k: 'obj', t: 'dict', fields: [['a', { k: 'prim', t: 'int', v: '2' }]] } }));
check('session: live locals replace instead of piling up', s2.view().snapshots.length === 1, String(s2.view().snapshots.length));

const before = s2.view().badLines;
s2.ingest(line({ v: 1, t: 'from-the-future' }));
check('session: an unknown event only counts as a bad line', s2.view().badLines === before + 1 && s2.view().state === 'attached', String(s2.view().badLines));

s2.ingest('{"v":1,"t":"stack"'); // truncated JSON
check('session: broken JSON is fatal', s2.view().state === 'rejected', s2.view().state);
await s2.close();
await session.close();

// ------------------------------------------------------------ 2. the page

const html = renderDebugHtml({ port: 7320, target: 'app.py', lang: 'python' });
check('page: is a single self-contained document', /^<!doctype html>/i.test(html) && html.indexOf('</html>') > 0);
check('page: no external requests', !/(src|href)\s*=\s*["']https?:/i.test(html), '');
check('page: inlines the Vue runtime', html.includes('createApp') && html.length > 120_000, `${Math.round(html.length / 1024)} KiB`);
check('page: has the three panes', ['Watch', 'Live stacks', 'Inspector'].every((t) => html.includes(t)));
check('page: renders the value tree', html.includes('<snode') && html.includes('app.component'));
check("page: shows the observatory's own overhead", html.includes('dropped') && html.includes('samples'));
check('page: no emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html));
check('page: warns that a watch is evaluated in the target', html.includes('相当于 eval'));
check('page: can freeze the view', html.includes('togglePause') && html.includes("'resume'"));
check(
  'page: the shell has no leftover template tokens',
  (() => {
    const shell = html.slice(0, html.indexOf('<script>'));
    return shell.indexOf('${') === -1;
  })(),
  '',
);
check('page: the target name is escaped into the title', html.includes('app.py'));

// The same trap that bit the panel shell twice: a backtick inside a template
// literal ends it early and the failure surfaces dozens of lines later.
const uiSource = readFileSync(join(root, 'src', 'debugtool', 'ui.ts'), 'utf8');
check('page: no stray backtick inside the template', (() => {
  const open = uiSource.indexOf('return `');
  const close = uiSource.lastIndexOf('`;');
  if (open < 0 || close <= open) return false;
  return uiSource.slice(open + 8, close).indexOf('`') === -1;
})());

// --------------------------------------------------- 3. the CLI contract

const parsed = parseArgs(['app.py', '--port', '7400', '--hz', '20', '--no-open', '--', '60', '--flag']);
check('cli: the script is the first positional', !('error' in parsed) && !('help' in parsed) && parsed.script === 'app.py');
check('cli: options are parsed', !('error' in parsed) && !('help' in parsed) && parsed.port === 7400 && parsed.hz === 20 && parsed.open === false);
check('cli: everything after -- belongs to the target', !('error' in parsed) && !('help' in parsed) && parsed.args.join(' ') === '60 --flag');
check('cli: no arguments means help', 'help' in parseArgs([]));
check('cli: an unknown option is an error, not a guess', 'error' in parseArgs(['app.py', '--nope']));
check('cli: an out-of-range hz is refused', 'error' in parseArgs(['app.py', '--hz', '0']));
check('cli: a bad port is refused', 'error' in parseArgs(['app.py', '--port', '70000']));

// ------------------------------------------------------------ 4. the app

check('language: .py is observable', languageOf('a.py') === 'python');
check('language: .js is observable', languageOf('a.js') === 'javascript' && languageOf('b.mjs') === 'javascript');
check('language: .go is refused, not silently attached', languageOf('a.go') === null);

const sample = join(root, 'debugtool', 'samples', 'py', 'app.py');
if (!existsSync(sample)) {
  console.log('SKIP  end-to-end (sample missing)');
} else {
  let app: Awaited<ReturnType<typeof startDebugApp>> | undefined;
  try {
    // Long enough that the watch below cannot race the program's exit: under
    // `verify-all` the machine is busier, and a 4-second target used to finish
    // before the watch was evaluated (flaky, not wrong). 400 rounds ≈ 20 s, and
    // `app.close()` kills it at the end of this block.
    app = await startDebugApp({ script: sample, port: 0, hz: 10, quiet: true, args: ['400'] });
    check('app: serves a page', app.port > 0, app.url);

    const res = await fetch(app.url, { signal: AbortSignal.timeout(3000) });
    const served = await res.text();
    check('app: the page is served over HTTP', res.status === 200 && served.includes('Live stacks'), String(res.status));

    const health = await (await fetch(`http://127.0.0.1:${app.port}/health`, { signal: AbortSignal.timeout(3000) })).json();
    check('app: /health reports the session', health.ok === true, JSON.stringify(health));

    // Speak to the page's own socket, like a browser would.
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/`);
    const views: Array<Record<string, unknown>> = [];
    let sawAttached = false;
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg.kind === 'view') {
          views.push(msg.view as Record<string, unknown>);
          if ((msg.view as Record<string, unknown>).state === 'attached') sawAttached = true;
        }
      } catch {
        /* ignore */
      }
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws failed'));
      setTimeout(() => reject(new Error('ws timeout')), 5000);
    });

    // The sample runs ~1.5 s; give the agent time to attach and produce stacks.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !sawAttached) await sleep(100);
    check('app: the agent attaches through PYTHONPATH', sawAttached, `${views.length} views`);

    await sleep(1200);
    const last = views[views.length - 1] as Record<string, unknown> | undefined;
    const hot = (last?.hot as Array<{ stack: string; hits: number }> | undefined) ?? [];
    check('app: stacks reach the page', hot.length > 0, hot.slice(0, 3).map((h) => h.stack).join(' | '));
    check('app: the stacks are the target program', hot.some((h) => /work|step|main/.test(h.stack)), hot[0]?.stack ?? '');
    check('app: live locals arrive without asking', ((last?.snapshots as unknown[]) ?? []).length > 0, String(((last?.snapshots as unknown[]) ?? []).length));

    // A watch added from the page must come back with a value.
    ws.send(JSON.stringify({ kind: 'watch-add', expr: 'len(order.items)' }));
    const watchDeadline = Date.now() + 8000;
    let watched: { ok?: boolean; value?: { v?: string } } | undefined;
    // The engine registers a watch optimistically (ok:false) the moment it is
    // added; waiting for *presence* would assert against the placeholder. Wait
    // for the first evaluated value instead.
    while (Date.now() < watchDeadline) {
      const v = views[views.length - 1] as Record<string, unknown> | undefined;
      const list = (v?.watches as Array<{ expr: string; ok: boolean; value?: { v?: string } }> | undefined) ?? [];
      const found = list.find((w) => w.expr === 'len(order.items)');
      if (found && found.ok) {
        watched = found;
        break;
      }
      await sleep(150);
    }
    check('app: a watch added from the page evaluates in the target', watched?.ok === true, JSON.stringify(watched?.value ?? null));
    check('app: the watch value is the real one', watched?.value?.v === '3', String(watched?.value?.v));

    ws.close();

    // The agent prepends its own directory to PYTHONPATH, which shadows any
    // sitecustomize the user already had (only the first one runs). The chain in
    // our sitecustomize is what keeps `coverage run` working under ndebug.
    const hookDir = mkdtempSync(join(tmpdir(), 'nlg-hook-'));
    const hookLog = join(hookDir, 'hook-ran.txt');
    writeFileSync(
      join(hookDir, 'sitecustomize.py'),
      `import pathlib\npathlib.Path(${JSON.stringify(hookLog)}).write_text('user-hook-ran', encoding='utf-8')\n`,
      'utf8',
    );
    const previousPath = process.env.PYTHONPATH;
    process.env.PYTHONPATH = hookDir;
    let hooked: Awaited<ReturnType<typeof startDebugApp>> | undefined;
    try {
      hooked = await startDebugApp({ script: sample, port: 0, hz: 5, quiet: true, args: ['20'] });
      await hooked.exited;
      check('app: a pre-existing sitecustomize still runs', existsSync(hookLog), existsSync(hookLog) ? 'chained' : 'shadowed');
    } finally {
      await hooked?.close();
      if (previousPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = previousPath;
      rmSync(hookDir, { recursive: true, force: true });
    }

    // A busy port must fail loudly instead of leaving an orphaned child behind.
    const busy = await startDebugApp({ script: sample, port: 0, hz: 5, quiet: true, args: ['20'] });
    let busyError = '';
    try {
      await startDebugApp({ script: sample, port: busy.port, hz: 5, quiet: true, args: ['20'] });
    } catch (err) {
      busyError = (err as Error).message;
    }
    check('app: a busy port is reported, not swallowed', /cannot serve the page/.test(busyError), busyError.slice(0, 60));
    const stillAlive = await (await fetch(`http://127.0.0.1:${busy.port}/health`, { signal: AbortSignal.timeout(2000) })).json();
    check('app: the first instance keeps running after the collision', stillAlive.ok === true, JSON.stringify(stillAlive));
    await busy.close();

    // ---- JavaScript target: inspector window sampling ----
    const jsSample = join(root, 'debugtool', 'samples', 'js', 'app.js');
    if (!existsSync(jsSample)) {
      console.log('SKIP  javascript end-to-end (sample missing)');
    } else {
      const jsApp = await startDebugApp({ script: jsSample, port: 0, hz: 10, quiet: true, args: ['300'] });
      try {
        const jsWs = new WebSocket(`ws://127.0.0.1:${jsApp.port}/`);
        const jsViews: Array<Record<string, unknown>> = [];
        jsWs.onmessage = (ev: MessageEvent) => {
          try {
            const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
            if (msg.kind === 'view') jsViews.push(msg.view as Record<string, unknown>);
          } catch {
            /* ignore */
          }
        };
        await new Promise<void>((resolve, reject) => {
          jsWs.onopen = () => resolve();
          jsWs.onerror = () => reject(new Error('js ws failed'));
          setTimeout(() => reject(new Error('js ws timeout')), 5000);
        });

        jsWs.send(JSON.stringify({ kind: 'watch-add', expr: 'order.items.length' }));

        // Wait for stacks: the profiler needs a full 500 ms window first.
        const jsDeadline = Date.now() + 12000;
        let jsHot: Array<{ stack: string }> = [];
        while (Date.now() < jsDeadline) {
          const last = jsViews[jsViews.length - 1] as Record<string, unknown> | undefined;
          jsHot = (last?.hot as Array<{ stack: string }> | undefined) ?? [];
          if (jsHot.length && (last?.samples as number) > 2) break;
          await sleep(200);
        }
        check('js: the agent attaches through --require', jsViews.some((v) => v.state === 'attached'), `${jsViews.length} views`);
        check('js: window sampling produces stacks', jsHot.length > 0, jsHot.slice(0, 2).map((h) => h.stack).join(' | '));
        check('js: the stacks are the target program', jsHot.some((h) => /work|step|main/.test(h.stack)), jsHot[0]?.stack ?? '');

        const lastJs = jsViews[jsViews.length - 1] as Record<string, unknown> | undefined;
        check('js: the page is told this language has no live locals', !((lastJs?.caps as string[]) ?? []).includes('locals'), JSON.stringify(lastJs?.caps ?? []));

        const jsWatchDeadline = Date.now() + 8000;
        let jsWatch: { ok?: boolean; value?: { v?: string } } | undefined;
        while (Date.now() < jsWatchDeadline) {
          const v = jsViews[jsViews.length - 1] as Record<string, unknown> | undefined;
          const list = (v?.watches as Array<{ expr: string; ok: boolean; value?: { v?: string } }> | undefined) ?? [];
          const found = list.find((w) => w.expr === 'order.items.length');
          if (found && found.ok) {
            jsWatch = found;
            break;
          }
          await sleep(200);
        }
        check('js: a watch evaluates in global scope', jsWatch?.ok === true && jsWatch?.value?.v === '2', JSON.stringify(jsWatch?.value ?? null));
        jsWs.close();
      } finally {
        await jsApp.close();
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (/ENOENT|spawn python|not recognized/i.test(msg)) {
      console.log('SKIP  end-to-end (python unavailable)');
    } else {
      check('app: end-to-end ran', false, msg);
    }
  } finally {
    await app?.close();
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
