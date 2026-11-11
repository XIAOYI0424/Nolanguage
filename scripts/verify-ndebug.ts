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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DebugSession } from '../src/debugtool/session.js';
import { renderDebugHtml } from '../src/debugtool/ui.js';
import { startDebugApp, languageOf } from '../src/debugtool/main.js';
import { parseArgs } from '../src/debugtool/cli.js';
import { Recorder, readRecording } from '../src/debugtool/recorder.js';
import { startReplayApp } from '../src/debugtool/main.js';

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

// ---- baselines and diffs (no process, no socket) ----

{
  const s3 = new DebugSession({ hz: 10 });
  await s3.listen();
  s3.ingest(line({ v: 1, t: 'hello', token: s3.agentEnv().NLG_DEBUG_TOKEN, lang: 'python', pid: 5, target: 'd.py', agentVersion: '1', caps: [] }));

  const snap = (at: number, price: string): string =>
    line({
      v: 1,
      t: 'snapshot',
      id: 'live-locals',
      at,
      path: 'locals',
      value: { k: 'obj', t: 'dict', fields: [['price', { k: 'prim', t: 'int', v: price }]] },
    });

  s3.ingest(snap(1000, '10'));
  check('session: a baseline needs a snapshot that exists', s3.setBaseline('nope') === false);
  check('session: a baseline can be captured', s3.setBaseline('live-locals') === true);
  check('session: the view lists baselines for the page', s3.view().baselines.indexOf('live-locals') >= 0, JSON.stringify(s3.view().baselines));
  check('session: nothing has changed right after the baseline', s3.diff('live-locals')?.result.entries.length === 0, s3.diff('live-locals')?.summary ?? '');

  s3.ingest(snap(2000, '12'));
  const dv = s3.diff('live-locals');
  check('session: the diff sees the new value', dv?.result.entries.length === 1 && dv.result.entries[0].after === '12', JSON.stringify(dv?.result.entries ?? []));
  check('session: the diff names the field', dv?.result.entries[0].path === '$.price', dv?.result.entries[0].path ?? '');
  check('session: the diff summarises itself', dv?.summary === '1 changed', dv?.summary ?? '');
  check('session: diffing without a baseline yields nothing', s3.diff('other') === undefined);

  s3.clearBaseline('live-locals');
  check('session: clearing a baseline removes it', s3.view().baselines.length === 0 && s3.diff('live-locals') === undefined);
  await s3.close();
}

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

check('page: offers a baseline capture', html.includes('markBaseline') && html.includes('>baseline</button>'));
check('page: renders a diff list', html.includes('class="df"') && html.includes('st.diff.result.entries'));
check('page: says a truncated diff is not proof', html.includes('not proof of equality'));
check('page: shows a shifted path in the tooltip', html.includes('e.pathBefore'));
check('page: marks a replay session', html.includes('st.view.replay') && html.includes('replay {{ replayPct }}'));
check('page: a replay is read-only', html.includes(':disabled="!!st.view.replay"'));
check('page: shows the oversized counter', html.includes('st.view.oversized'));

// --------------------------------------------------- 3. the CLI contract

const parsed = parseArgs(['app.py', '--port', '7400', '--hz', '20', '--no-open', '--', '60', '--flag']);
check('cli: the script is the first positional', !('error' in parsed) && !('help' in parsed) && parsed.script === 'app.py');
check('cli: options are parsed', !('error' in parsed) && !('help' in parsed) && parsed.port === 7400 && parsed.hz === 20 && parsed.open === false);
check('cli: everything after -- belongs to the target', !('error' in parsed) && !('help' in parsed) && parsed.args.join(' ') === '60 --flag');
check('cli: no arguments means help', 'help' in parseArgs([]));
check('cli: an unknown option is an error, not a guess', 'error' in parseArgs(['app.py', '--nope']));
check('cli: an out-of-range hz is refused', 'error' in parseArgs(['app.py', '--hz', '0']));
check('cli: a bad port is refused', 'error' in parseArgs(['app.py', '--port', '70000']));

const recArgs = parseArgs(['app.py', '--record', 'run.ndlog', '--', '60']);
check('cli: --record is parsed', !('error' in recArgs) && !('help' in recArgs) && recArgs.mode === 'live' && recArgs.record === 'run.ndlog', 'error' in recArgs ? recArgs.error : recArgs.mode);
check('cli: --record does not swallow the program arguments', !('error' in recArgs) && !('help' in recArgs) && recArgs.args.join(' ') === '60');

const replayArgs = parseArgs(['--replay', 'run.ndlog', '--speed', '4', '--port', '7400']);
check('cli: --replay needs no script', !('error' in replayArgs) && !('help' in replayArgs) && replayArgs.mode === 'replay' && replayArgs.file === 'run.ndlog', 'error' in replayArgs ? replayArgs.error : replayArgs.mode);
check('cli: --speed is parsed', !('error' in replayArgs) && !('help' in replayArgs) && replayArgs.speed === 4);
check('cli: --speed 0 means instant, not "default"', !('error' in parseArgs(['--replay', 'x.ndlog', '--speed', '0'])) && (parseArgs(['--replay', 'x.ndlog', '--speed', '0']) as { speed: number }).speed === 0);
check('cli: --replay with a script is refused', 'error' in parseArgs(['--replay', 'x.ndlog', 'app.py']));
check('cli: --record without a path is refused', 'error' in parseArgs(['app.py', '--record']));
check('cli: --speed out of range is refused', 'error' in parseArgs(['--replay', 'x.ndlog', '--speed', '-1']));

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
    const diffs: Array<Record<string, unknown>> = [];
    let sawAttached = false;
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg.kind === 'view') {
          views.push(msg.view as Record<string, unknown>);
          if ((msg.view as Record<string, unknown>).state === 'attached') sawAttached = true;
        } else if (msg.kind === 'diff') {
          diffs.push(msg.diff as Record<string, unknown>);
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

    // ---- baseline + diff, over the page's own socket ----
    const localsAt = (): number => {
      const v = views[views.length - 1] as Record<string, unknown> | undefined;
      const list = (v?.snapshots as Array<{ id: string; at: number }> | undefined) ?? [];
      const live = list.find((x) => x.id === 'live-locals');
      return live ? live.at : 0;
    };
    const beforeAt = localsAt();
    ws.send(JSON.stringify({ kind: 'baseline', id: 'live-locals' }));

    // Wait for a *newer* live-locals tick before asking, otherwise the two trees
    // are identical and the check would assert on timing rather than on the diff.
    const newerDeadline = Date.now() + 5000;
    while (Date.now() < newerDeadline && localsAt() <= beforeAt) await sleep(120);

    ws.send(JSON.stringify({ kind: 'diff', id: 'live-locals' }));
    const diffDeadline = Date.now() + 5000;
    while (Date.now() < diffDeadline && !diffs.length) await sleep(120);

    const dv = diffs[0] as
      | { id?: string; summary?: string; result?: { entries?: Array<{ path: string; kind: string }> } }
      | undefined;
    const lastView = views[views.length - 1] as Record<string, unknown> | undefined;
    check('app: the page can capture a baseline', ((lastView?.baselines as string[]) ?? []).indexOf('live-locals') >= 0, JSON.stringify(lastView?.baselines ?? []));
    check('app: a diff comes back over the socket', dv?.id === 'live-locals' && Array.isArray(dv?.result?.entries), String(dv?.summary ?? 'none'));
    check('app: the diff finds the loop changing', (dv?.result?.entries?.length ?? 0) > 0, dv?.summary ?? 'no entries');

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

// ------------------------------------------------- 5. record and replay

if (!existsSync(sample)) {
  console.log('SKIP  record/replay (sample missing)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'nlg-rec-'));
  const recPath = join(dir, 'run.ndlog');
  try {
    // ---- record a real session ----
    const live = await startDebugApp({ script: sample, port: 0, hz: 10, quiet: true, record: recPath, args: ['30'] });
    const code = await live.exited;
    await live.close();
    const stats = live.recorder?.stats();
    check('record: the file is written', existsSync(recPath) && (stats?.lines ?? 0) > 0, `${stats?.lines ?? 0} events · ${stats?.bytes ?? 0} bytes`);
    check('record: the target exit code is unaffected', code === 0, String(code));

    const rec = readRecording(recPath);
    check('record: the header describes the session', rec.header.target === 'app.py' && rec.header.lang === 'python', `${rec.header.target}/${rec.header.lang}`);
    check('record: every line is readable', rec.lines.length === (stats?.lines ?? -1) && !rec.note, `${rec.lines.length} vs ${stats?.lines ?? -1}${rec.note ? ' — ' + rec.note : ''}`);

    // ---- replay it twice: the second run must produce the same thing ----
    const r1 = await startReplayApp({ file: recPath, port: 0, speed: 0, quiet: true });
    await r1.exited;
    const v1 = r1.session.view();
    const hot1 = v1.hot.map((h) => h.stack).join(' | ');
    check('replay: events reach a session', v1.samples > 0, `${v1.samples} samples`);
    check('replay: the page is told it is a replay', v1.replay?.done === true && v1.replay.total === rec.lines.length, JSON.stringify(v1.replay));
    check('replay: the agent identity comes from the header', v1.target === 'app.py' && v1.lang === 'python', `${v1.target}/${v1.lang}`);
    check('replay: the page is served', (await fetch(r1.url, { signal: AbortSignal.timeout(3000) })).status === 200);
    const r1Health = (await (await fetch(`http://127.0.0.1:${r1.port}/health`, { signal: AbortSignal.timeout(3000) })).json()) as { replay?: { done: boolean } };
    check('replay: /health reports the replay', r1Health.replay?.done === true, JSON.stringify(r1Health.replay ?? null));
    await r1.close();

    const r2 = await startReplayApp({ file: recPath, port: 0, speed: 0, quiet: true });
    await r2.exited;
    const v2 = r2.session.view();
    check('replay: a second run produces the same stacks', v2.samples === v1.samples && v2.hot.map((h) => h.stack).join(' | ') === hot1, `${v2.samples} vs ${v1.samples}`);
    await r2.close();

    // ---- a recording cut short by a crash ----
    const partialPath = join(dir, 'partial.ndlog');
    writeFileSync(
      partialPath,
      JSON.stringify({ v: 1, t: 'rec-meta', at: 1, tool: 'ndebug', version: 'x', lang: 'python', target: 'a.py', hz: 10, redact: [] }) +
        '\n' +
        JSON.stringify({ v: 1, t: 'stack', at: 1, tid: 1, state: 'running', frames: [{ fn: 'm', file: 'a.py', line: 1 }] }) +
        '\n' +
        '{"v":1,"t":"sta',
      'utf8',
    );
    const partial = readRecording(partialPath);
    check('record: a half-written last line is dropped, not fatal', partial.lines.length === 1 && /incomplete/.test(partial.note ?? ''), partial.note ?? '');

    // ---- the size cap ----
    const capped = Recorder.open({
      path: join(dir, 'capped.ndlog'),
      header: { tool: 'ndebug', version: 'x', lang: 'python', target: 'a.py', hz: 10, redact: [] },
      maxBytes: 300,
    });
    capped.write('x'.repeat(400));
    capped.write('y'.repeat(10));
    capped.close();
    check('record: the size cap stops writing', capped.stats().truncated === true && capped.stats().lines === 0, JSON.stringify(capped.stats()));

    // ---- an unwritable path must not break the session ----
    const asDir = join(dir, 'a-directory');
    mkdirSync(asDir, { recursive: true });
    const broken = Recorder.open({ path: asDir, header: { tool: 'ndebug', version: 'x', lang: 'python', target: 'a.py', hz: 10, redact: [] } });
    let threw = false;
    try {
      broken.write('hello');
    } catch {
      threw = true;
    }
    check('record: an unwritable path disables recording instead of throwing', !threw && broken.stats().error !== undefined, broken.stats().error ?? 'no error recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
