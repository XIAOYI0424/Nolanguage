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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DebugSession } from '../src/debugtool/session.js';
import { renderDebugHtml } from '../src/debugtool/ui.js';
import { startDebugApp, languageOf } from '../src/debugtool/main.js';

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

// ------------------------------------------------------------ 3. the app

check('language: .py is observable', languageOf('a.py') === 'python');
check('language: .js is refused for now, not silently attached', languageOf('a.js') === null);

const sample = join(root, 'debugtool', 'samples', 'py', 'app.py');
if (!existsSync(sample)) {
  console.log('SKIP  end-to-end (sample missing)');
} else {
  let app: Awaited<ReturnType<typeof startDebugApp>> | undefined;
  try {
    app = await startDebugApp({ script: sample, port: 0, hz: 10, quiet: true, args: ['80'] });
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
    const watchDeadline = Date.now() + 5000;
    let watched: { ok?: boolean; value?: { v?: string } } | undefined;
    while (Date.now() < watchDeadline && !watched) {
      const v = views[views.length - 1] as Record<string, unknown> | undefined;
      const list = (v?.watches as Array<{ expr: string; ok: boolean; value?: { v?: string } }> | undefined) ?? [];
      watched = list.find((w) => w.expr === 'len(order.items)');
      if (!watched) await sleep(150);
    }
    check('app: a watch added from the page evaluates in the target', watched?.ok === true, JSON.stringify(watched?.value ?? null));
    check('app: the watch value is the real one', watched?.value?.v === '3', String(watched?.value?.v));

    ws.close();
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
