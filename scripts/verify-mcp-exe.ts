/**
 * The MCP panel inside the *packaged* binary.
 *
 * `verify-mcp.ts` drives `McpManager` directly. That covers the protocol, but
 * not the path a user actually takes: mcp.json -> the exe -> the sidebar. This
 * suite closes that gap by talking to the shipped binary over the same
 * WebSocket the panel uses, with a config that exercises every card state:
 *
 *   demo        a working server (handshake, tools, calls, a tool-level error)
 *   broken      dies on start, so the card must show the exit code + stderr
 *   picky       `disabled: true`, so connect must refuse
 *   slowGood    answers initialize after 2s, budget 8000 -> connects
 *   slowBad     same server, budget 1000 -> fails at the budget
 *
 * Then a second launch with no config at all, to check `mcpInitConfig` writes
 * the starter file the panel offers.
 *
 * Everything is local: the servers are small .cjs fixtures written at runtime,
 * so this needs no network and no real MCP package. Skipped when the exe has
 * not been built (`requiresExe`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawWsClient, type WsMessage } from './lib/RawWsClient.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXE = join(ROOT, 'dist', 'Nolanguage.exe');
const SANDBOX = join(ROOT, '.tmp', 'verify-mcp-exe');

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** A working MCP stdio server: echo / add / fail / slow. */
const SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const text = (v) => ({ content: [{ type: 'text', text: String(v) }] });
rl.on('line', (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  if (!req || req.id == null) return;
  const ok = (r) => send({ jsonrpc: '2.0', id: req.id, result: r });
  const bad = (message) => send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message } });
  if (req.method === 'initialize') {
    return ok({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'exe-demo', version: '1.0.0' } });
  }
  if (req.method === 'tools/list') {
    return ok({ tools: [
      { name: 'echo', description: 'Echo the text', inputSchema: { type: 'object' } },
      { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object' } },
      { name: 'fail', description: 'Always errors', inputSchema: { type: 'object' } },
      { name: 'slow', description: 'Answers late', inputSchema: { type: 'object' } },
    ] });
  }
  if (req.method === 'tools/call') {
    const a = (req.params && req.params.arguments) || {};
    if (req.params.name === 'echo') return ok(text(a.text));
    if (req.params.name === 'add') return ok(text((a.a || 0) + (a.b || 0)));
    if (req.params.name === 'fail') return bad('tool exploded on purpose');
    if (req.params.name === 'slow') return setTimeout(() => ok(text('slow done')), Math.max(0, a.ms || 1000));
    return bad('unknown tool ' + req.params.name);
  }
  return bad('unknown method ' + req.method);
});
`;

/** The same protocol, but `initialize` is answered late — a cold `npx`. */
const SLOW = `
const delay = Number(process.argv[2] || 2000);
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  if (!req || req.id == null) return;
  const ok = (r) => send({ jsonrpc: '2.0', id: req.id, result: r });
  if (req.method === 'initialize') {
    return setTimeout(() => ok({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'exe-slow', version: '1.0.0' } }), delay);
  }
  if (req.method === 'tools/list') return ok({ tools: [{ name: 'echo', description: 'late but alive', inputSchema: { type: 'object' } }] });
  return ok({ content: [{ type: 'text', text: 'late' }] });
});
`;

interface App {
  child: ChildProcess;
  port: number;
  logs: string[];
}

function launch(port: number, configPath: string, home: string, tmp: string): App {
  const logs: string[] = [];
  const child = spawn(EXE, ['--no-open'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NOLANGUAGE_NO_BROWSER: '1',
      NOLANGUAGE_HOME: home,
      NOLANGUAGE_MCP_CONFIG: configPath,
      PANEL_PORT: String(port),
      TMP: tmp,
      TEMP: tmp,
      TMPDIR: tmp,
    },
  });
  child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));
  return { child, port, logs };
}

async function health(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, (r) => {
      r.resume();
      r.on('end', () => resolve((r.statusCode ?? 0) === 200));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5_000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function waitUp(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await health(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function stop(app: App): Promise<void> {
  app.child.kill();
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 15_000);
    app.child.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

type ServerView = { id: string; status: string; error: string; tools: Array<{ name: string }> };
type McpFrame = WsMessage & { configPath?: string; configExists?: boolean; servers?: ServerView[] };
const find = (f: McpFrame | undefined, id: string): ServerView | undefined => (f?.servers ?? []).find((s) => s.id === id);

/**
 * Wait for a frame, and fail fast if the app is gone.
 *
 * A silent wait is the worst failure mode this suite can have: one missed frame
 * makes every later check time out, and the summary then says fourteen things
 * broke when in truth the process died once. So when a wait comes up empty,
 * ask /health — if the exe is down, print its tail and throw with the reason.
 */
async function frame(
  ws: RawWsClient,
  app: App,
  kind: string,
  ms: number,
  pred?: (m: WsMessage) => boolean,
): Promise<WsMessage | undefined> {
  const got = pred ? await ws.waitForWhere(kind, pred, ms) : await ws.waitFor(kind, ms);
  if (!got && !(await health(app.port))) {
    console.log('\n--- the packaged exe stopped answering; last log lines ---');
    console.log(app.logs.join('').split('\n').slice(-30).join('\n'));
    throw new Error(`the packaged exe died while waiting for ${kind}`);
  }
  return got;
}

function rmSafe(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 });
  } catch {
    /* best effort */
  }
}

/** The config the first launch runs against. */
function writeConfig(configPath: string, serverPath: string, slowPath: string): void {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          demo: { command: process.execPath, args: [serverPath], description: 'a working server' },
          broken: {
            command: process.execPath,
            args: ['-e', "console.error('exe-demo: cannot start'); process.exit(3)"],
            description: 'dies on start',
          },
          picky: { command: process.execPath, args: [serverPath], disabled: true, description: 'switched off' },
          slowGood: { command: process.execPath, args: [slowPath, '2000'], timeoutMs: 8000 },
          slowBad: { command: process.execPath, args: [slowPath, '2000'], timeoutMs: 1000 },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function withConfig(): Promise<void> {
  const home = join(SANDBOX, 'home-a');
  const tmp = join(SANDBOX, 'temp-a');
  const configPath = join(SANDBOX, 'mcp-a.json');
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const serverPath = join(SANDBOX, 'server.cjs');
  const slowPath = join(SANDBOX, 'slow.cjs');
  writeFileSync(serverPath, SERVER, 'utf8');
  writeFileSync(slowPath, SLOW, 'utf8');
  writeConfig(configPath, serverPath, slowPath);

  const PORT = 7431;
  const app = launch(PORT, configPath, home, tmp);
  try {
    check('the packaged exe starts with an MCP config', await waitUp(PORT, 90_000), `port ${PORT}`);
    if (!(await health(PORT))) {
      console.log(app.logs.join('').slice(-1500));
      return;
    }

    const ws = new RawWsClient(PORT);
    try {
      await ws.ready;

      // ---- the panel's first paint ----
      ws.send({ kind: 'mcpList' });
      const listed = (await frame(ws, app, 'mcp', 20_000)) as McpFrame | undefined;
      check('mcpList answers with the config it read', listed?.configPath === configPath, String(listed?.configPath));
      check('every declared server is on the panel', (listed?.servers ?? []).length === 5, (listed?.servers ?? []).map((s) => s.id).join(','));
      check('a server starts idle', find(listed, 'demo')?.status === 'idle', String(find(listed, 'demo')?.status));
      check('a disabled server is marked disabled', find(listed, 'picky')?.status === 'disabled', String(find(listed, 'picky')?.status));

      // ---- connect + tools ----
      ws.clearReceived();
      ws.send({ kind: 'mcpConnect', id: 'demo' });
      const ready = (await frame(ws, app, 'mcp', 20_000, (m) => find(m as McpFrame, 'demo')?.status === 'ready')) as McpFrame | undefined;
      const demo = find(ready, 'demo');
      check('connect completes the handshake', demo?.status === 'ready', String(demo?.status));
      check('the tools are cached on the card', (demo?.tools ?? []).length === 4, (demo?.tools ?? []).map((t) => t.name).join(','));

      // ---- calls ----
      ws.clearReceived();
      ws.send({ kind: 'mcpCall', id: 'demo', tool: 'echo', args: { text: 'through the exe' } });
      const echo = (await frame(ws, app, 'mcpCallResult', 20_000)) as
        | { ok?: boolean; result?: { content?: Array<{ text?: string }> } }
        | undefined;
      check('a tool call round-trips through the exe', echo?.ok === true && echo?.result?.content?.[0]?.text === 'through the exe', String(echo?.result?.content?.[0]?.text));

      ws.clearReceived();
      ws.send({ kind: 'mcpCall', id: 'demo', tool: 'add', args: { a: 40, b: 2 } });
      const add = (await frame(ws, app, 'mcpCallResult', 20_000)) as { result?: { content?: Array<{ text?: string }> } } | undefined;
      check('arguments reach the tool', add?.result?.content?.[0]?.text === '42', String(add?.result?.content?.[0]?.text));

      ws.clearReceived();
      ws.send({ kind: 'mcpCall', id: 'demo', tool: 'fail', args: {} });
      const failed = (await frame(ws, app, 'mcpCallResult', 20_000)) as { ok?: boolean; error?: string } | undefined;
      check('a tool error surfaces as ok:false', failed?.ok === false && /exploded/.test(failed?.error ?? ''), failed?.error ?? '(none)');

      // a per-call budget still wins over the server default
      ws.clearReceived();
      const t0 = Date.now();
      ws.send({ kind: 'mcpCall', id: 'demo', tool: 'slow', args: { ms: 5000 }, timeoutMs: 1200 });
      const slow = (await frame(ws, app, 'mcpCallResult', 20_000)) as { ok?: boolean; error?: string } | undefined;
      const slowMs = Date.now() - t0;
      check('a call timeout is enforced', slow?.ok === false && /timed out/i.test(slow?.error ?? ''), `${slowMs}ms ${slow?.error ?? ''}`);
      check('the timeout fires near the budget', slowMs < 4000, `${slowMs}ms`);

      // ---- failure cards ----
      ws.clearReceived();
      ws.send({ kind: 'mcpConnect', id: 'broken' });
      const brokenErr = (await frame(ws, app, 'mcpError', 20_000)) as { error?: string } | undefined;
      check('a server that dies on start reports the exit', /exited/i.test(brokenErr?.error ?? ''), brokenErr?.error ?? '(none)');
      check('the card carries the server stderr', /cannot start/.test(brokenErr?.error ?? ''), brokenErr?.error ?? '');
      const brokenCard = (await frame(ws, app, 'mcp', 15_000, (m) => find(m as McpFrame, 'broken')?.status === 'error')) as McpFrame | undefined;
      check('the broken server is marked error', find(brokenCard, 'broken')?.status === 'error', String(find(brokenCard, 'broken')?.status));

      ws.clearReceived();
      ws.send({ kind: 'mcpConnect', id: 'picky' });
      const pickyErr = (await frame(ws, app, 'mcpError', 15_000)) as { error?: string } | undefined;
      check('a disabled server refuses to connect', /disabled/i.test(pickyErr?.error ?? ''), pickyErr?.error ?? '(none)');

      ws.clearReceived();
      ws.send({ kind: 'mcpCall', id: 'nope', tool: 'echo', args: {} });
      const unknown = (await frame(ws, app, 'mcpCallResult', 15_000)) as { ok?: boolean; error?: string } | undefined;
      check('an unknown server id is refused', unknown?.ok === false && /unknown MCP server/i.test(unknown?.error ?? ''), unknown?.error ?? '');

      // ---- per-server timeoutMs, read from mcp.json by the exe ----
      ws.clearReceived();
      const t1 = Date.now();
      ws.send({ kind: 'mcpConnect', id: 'slowGood' });
      const generous = (await frame(ws, app, 'mcp', 30_000, (m) => find(m as McpFrame, 'slowGood')?.status === 'ready')) as McpFrame | undefined;
      const generousMs = Date.now() - t1;
      check('a generous timeoutMs lets a slow server connect', find(generous, 'slowGood')?.status === 'ready', `${generousMs}ms`);
      check('the slow connect really waited for the server', generousMs > 1500, `${generousMs}ms (server answers at 2000ms)`);

      ws.clearReceived();
      ws.send({ kind: 'mcpConnect', id: 'slowBad' });
      const tightErr = (await frame(ws, app, 'mcpError', 30_000)) as { error?: string } | undefined;
      check('a tight timeoutMs fails at that budget', /timed out after 1000ms/.test(tightErr?.error ?? ''), tightErr?.error ?? '(none)');

      // ---- lifecycle ----
      ws.clearReceived();
      ws.send({ kind: 'mcpDisconnect', id: 'demo' });
      const idle = (await frame(ws, app, 'mcp', 20_000, (m) => find(m as McpFrame, 'demo')?.status === 'idle')) as McpFrame | undefined;
      check('disconnect returns the card to idle', find(idle, 'demo')?.status === 'idle', String(find(idle, 'demo')?.status));
      check('disconnect clears the tool list', (find(idle, 'demo')?.tools ?? []).length === 0, 'empty');

      ws.clearReceived();
      ws.send({ kind: 'mcpCall', id: 'demo', tool: 'add', args: { a: 1, b: 1 } });
      const back = (await frame(ws, app, 'mcpCallResult', 30_000)) as { ok?: boolean; result?: { content?: Array<{ text?: string }> } } | undefined;
      check('a call reconnects a disconnected server', back?.ok === true && back?.result?.content?.[0]?.text === '2', `ok=${back?.ok}`);

      ws.clearReceived();
      ws.send({ kind: 'mcpReload' });
      const reloaded = (await frame(ws, app, 'mcp', 20_000)) as McpFrame | undefined;
      check('reload re-reads the config', (reloaded?.servers ?? []).length === 5, `${(reloaded?.servers ?? []).length} server(s)`);
    } finally {
      ws.close();
    }
  } finally {
    await stop(app);
  }
}

async function withEmptyConfig(): Promise<void> {
  const home = join(SANDBOX, 'home-b');
  const tmp = join(SANDBOX, 'temp-b');
  const configPath = join(SANDBOX, 'mcp-b.json');
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  rmSafe(configPath);

  const PORT = 7432;
  const app = launch(PORT, configPath, home, tmp);
  try {
    check('the exe starts with no MCP config', await waitUp(PORT, 90_000), `port ${PORT}`);
    if (!(await health(PORT))) return;

    const ws = new RawWsClient(PORT);
    try {
      await ws.ready;
      ws.send({ kind: 'mcpList' });
      const empty = (await frame(ws, app, 'mcp', 20_000)) as McpFrame | undefined;
      check('a missing config is not an error', empty?.configExists === false && !empty?.configError, `exists=${empty?.configExists}`);
      check('no servers without a config', (empty?.servers ?? []).length === 0, String((empty?.servers ?? []).length));

      ws.clearReceived();
      ws.send({ kind: 'mcpInitConfig' });
      const seeded = (await frame(ws, app, 'mcp', 20_000)) as McpFrame | undefined;
      check('mcpInitConfig writes the starter file', empty?.configExists === false && seeded?.configExists === true, configPath);
      const starter = (seeded?.servers ?? [])[0];
      check('the starter server ships disabled', starter?.status === 'disabled', `${starter?.id} ${starter?.status}`);
      const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers?: Record<string, { disabled?: boolean }> };
      check('the shipped example is disabled on disk', onDisk.mcpServers?.filesystem?.disabled === true, String(onDisk.mcpServers?.filesystem?.disabled));
    } finally {
      ws.close();
    }
  } finally {
    await stop(app);
  }
}

async function main(): Promise<void> {
  rmSafe(SANDBOX);
  mkdirSync(SANDBOX, { recursive: true });
  try {
    await withConfig();
    await withEmptyConfig();
  } catch (err) {
    // A dead app (or a fixture that never answers) aborts the run; report it as
    // one failure with the reason, not as every later check timing out.
    const message = (err as Error).message;
    console.log(`\nABORTED: ${message}`);
    results.push({ name: 'the suite ran to completion', ok: false, detail: message });
  } finally {
    rmSafe(SANDBOX);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log('failed: ' + results.filter((r) => !r.ok).map((r) => r.name).join('; '));
    process.exitCode = 1;
  }
}

await main();
