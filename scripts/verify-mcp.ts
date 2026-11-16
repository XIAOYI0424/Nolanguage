/**
 * End-to-end check for the MCP client behind the sidebar tool window.
 *
 * Spawns a real (tiny) MCP server over stdio and drives the whole lifecycle:
 * config load -> initialize -> tools/list -> tools/call -> disconnect, plus the
 * two failure modes the UI must render (unknown id, missing binary).
 *
 * Run: node --experimental-loader ./resolve-loader.mjs \
 *        --experimental-transform-types scripts/verify-mcp.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpManager } from '../src/mcp/McpManager.js';

const checks: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** A minimal MCP stdio server: newline-delimited JSON-RPC 2.0. */
const FIXTURE = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || req.id == null) return; // notifications/initialized has no answer
  const ok = (result) => send({ jsonrpc: '2.0', id: req.id, result });
  const fail = (message) => send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message } });
  if (req.method === 'initialize') {
    return ok({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } });
  }
  if (req.method === 'tools/list') {
    return ok({ tools: [
      { name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object' } },
      { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object' } },
    ] });
  }
  if (req.method === 'tools/call') {
    const args = (req.params && req.params.arguments) || {};
    if (req.params.name === 'echo') return ok({ content: [{ type: 'text', text: JSON.stringify(args) }] });
    if (req.params.name === 'add') return ok({ content: [{ type: 'text', text: String((args.a || 0) + (args.b || 0)) }] });
    return fail('unknown tool ' + req.params.name);
  }
  if (req.method === 'tools/list') return ok({ tools: [] });
  return fail('unknown method ' + req.method);
});
`;

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nl-mcp-'));
  const serverPath = join(dir, 'server.cjs');
  const slowPath = join(dir, 'slow.cjs');
  const configPath = join(dir, 'mcp.json');
  await writeFile(serverPath, FIXTURE, 'utf8');
  // The same protocol, but `initialize` is answered late — the shape of a first
  // `npx -y <server>` connect, where the package download eats the budget.
  await writeFile(
    slowPath,
    `
const delay = Number(process.argv[2] || 2000);
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || req.id == null) return;
  const ok = (result) => send({ jsonrpc: '2.0', id: req.id, result });
  if (req.method === 'initialize') {
    return setTimeout(() => ok({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1.0.0' } }), delay);
  }
  if (req.method === 'tools/list') return ok({ tools: [{ name: 'echo', description: 'late but alive', inputSchema: { type: 'object' } }] });
  if (req.method === 'tools/call') return ok({ content: [{ type: 'text', text: 'late' }] });
  return ok({});
});
`,
    'utf8',
  );

  // A `.cmd` shim in its own directory — the exact shape `npx` has on Windows,
  // and the reason a bare command name cannot be spawned directly there
  // (`spawn('npx')` is ENOENT, `spawn('npx.cmd')` is EINVAL). Pointing a server
  // entry at it, with that directory on the child's PATH, is the regression
  // test for `planSpawn`. Skipped off Windows, where the shim means nothing.
  const shimDir = join(dir, 'shim');
  const shimName = process.platform === 'win32' ? 'mcpfixture.cmd' : 'mcpfixture';
  await mkdir(shimDir, { recursive: true });
  await writeFile(
    join(shimDir, shimName),
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${serverPath}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${serverPath}" "$@"\n`,
    'utf8',
  );

  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          fixture: { command: process.execPath, args: [serverPath], description: 'Test fixture' },
          broken: { command: 'nolanguage-definitely-not-a-binary', args: [] },
          off: { command: process.execPath, args: [serverPath], disabled: true },
          shim: {
            command: 'mcpfixture',
            args: [],
            description: 'A bare command name that only exists on PATH',
            env: { PATH: `${shimDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
          },
          // Same late server, three budgets: generous, tight, and too small to
          // be usable (which must clamp up, not become "fail instantly").
          slowGenerous: { command: process.execPath, args: [slowPath, '2000'], timeoutMs: 8000 },
          slowTight: { command: process.execPath, args: [slowPath, '2000'], timeoutMs: 1000 },
          slowTiny: { command: process.execPath, args: [slowPath, '2000'], timeoutMs: 50 },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const mcp = new McpManager({ configPath, timeoutMs: 5000 });
  try {
    await mcp.load();
    const before = mcp.payload();
    check('mcp: config lists every declared server', before.servers.length === 7, before.servers.map((s) => s.id).join(','));
    check('mcp: servers start idle', before.servers.every((s) => s.status === 'idle' || s.status === 'disabled'));
    check('mcp: a disabled entry is marked', before.servers.some((s) => s.id === 'off' && s.status === 'disabled'));

    // A bare name resolved through PATH, launched through the shell shim. This
    // is the case that was dead on Windows: the config form every MCP example
    // uses ("command": "npx") could not be spawned at all.
    //
    // Wrapped, because the failure mode is a rejected connect (ENOENT/EINVAL),
    // and an uncaught rejection would abort the suite instead of printing the
    // one line that says what broke.
    if (process.platform === 'win32') {
      let shimState: { status: string; error: string; tools: Array<{ name: string }> } | undefined;
      let shimError = '';
      try {
        shimState = await mcp.connect('shim');
      } catch (err) {
        shimError = (err as Error).message;
      }
      check(
        'mcp: a bare command name is resolved on PATH',
        shimState?.status === 'ready',
        shimState ? `${shimState.status} ${shimState.error}` : shimError,
      );
      check(
        'mcp: the PATH-resolved server lists tools',
        (shimState?.tools ?? []).map((t) => t.name).join(',') === 'echo,add',
        (shimState?.tools ?? []).map((t) => t.name).join(',') || '(none)',
      );
      if (shimState?.status === 'ready') {
        const viaShim = (await mcp.callTool('shim', 'add', { a: 40, b: 2 })) as { content?: Array<{ text?: string }> };
        check('mcp: a call through the shim round-trips', String(viaShim.content?.[0]?.text) === '42', String(viaShim.content?.[0]?.text));
        await mcp.disconnect('shim');
      }
    }

    // ---------- a per-server handshake budget ----------
    // The default is 12s, which a first `npx -y <server>` can spend entirely on
    // downloading; the failure then reads as "initialize timed out", i.e. as a
    // broken server. `timeoutMs` lets a slow server say so.
    {
      const t0 = Date.now();
      const generous = await mcp.connect('slowGenerous');
      const generousMs = Date.now() - t0;
      check(
        'mcp: a slow server connects within its own budget',
        generous.status === 'ready',
        `${generous.status} in ${generousMs}ms`,
      );
      check('mcp: the slow server still lists its tools', generous.tools.map((t) => t.name).join(',') === 'echo', generous.tools.map((t) => t.name).join(','));
      await mcp.disconnect('slowGenerous');
    }

    {
      let tightError = '';
      const t0 = Date.now();
      try {
        await mcp.connect('slowTight');
      } catch (err) {
        tightError = (err as Error).message;
      }
      const tightMs = Date.now() - t0;
      check('mcp: a too-tight budget fails the handshake', /initialize timed out/.test(tightError), tightError || '(connected)');
      check('mcp: the failure happens at the configured budget', tightMs < 1900, `${tightMs}ms (budget 1000ms, server answers at 2000ms)`);
      check(
        'mcp: a failed handshake becomes an error card',
        mcp.payload().servers.find((s) => s.id === 'slowTight')?.status === 'error',
        String(mcp.payload().servers.find((s) => s.id === 'slowTight')?.status),
      );
    }

    {
      // 50ms is below the floor, so it must be clamped up rather than making
      // every connect fail instantly.
      let tinyError = '';
      try {
        await mcp.connect('slowTiny');
      } catch (err) {
        tinyError = (err as Error).message;
      }
      check('mcp: an unusable budget is clamped, not honoured', /timed out after 1000ms/.test(tinyError), tinyError || '(connected)');
    }

    const state = await mcp.connect('fixture');
    check('mcp: connect performs the initialize handshake', state.status === 'ready' && state.protocolVersion === '2024-11-05', state.protocolVersion ?? '');
    check('mcp: tools/list is cached on the card', state.tools.map((t) => t.name).join(',') === 'echo,add', state.tools.map((t) => t.name).join(','));

    const echoed = (await mcp.callTool('fixture', 'echo', { hello: 'world' })) as { content?: Array<{ text?: string }> };
    check('mcp: tools/call round-trips', JSON.stringify(echoed).indexOf('world') !== -1, JSON.stringify(echoed).slice(0, 60));

    const sum = (await mcp.callTool('fixture', 'add', { a: 2, b: 3 })) as { content?: Array<{ text?: string }> };
    check('mcp: the same pipe serves a second call', String(sum.content?.[0]?.text) === '5', String(sum.content?.[0]?.text));

    await mcp.disconnect('fixture');
    const after = mcp.payload();
    check('mcp: disconnect returns the card to idle', after.servers.find((s) => s.id === 'fixture')?.status === 'idle'
      && (after.servers.find((s) => s.id === 'fixture')?.tools.length ?? -1) === 0);

    let unknown = '';
    try {
      await mcp.connect('nope');
    } catch (err) {
      unknown = (err as Error).message;
    }
    check('mcp: an unknown server id is refused', unknown.indexOf('unknown MCP server') !== -1, unknown);

    let disabled = '';
    try {
      await mcp.connect('off');
    } catch (err) {
      disabled = (err as Error).message;
    }
    check('mcp: a disabled entry refuses to start', disabled.indexOf('disabled') !== -1, disabled);

    let broken = '';
    try {
      await mcp.connect('broken');
    } catch (err) {
      broken = (err as Error).message;
    }
    const brokenCard = mcp.payload().servers.find((s) => s.id === 'broken');
    check('mcp: a missing binary becomes an error card', broken.length > 0 && brokenCard?.status === 'error', broken.slice(0, 60));

    // A second connect on an already-ready server must be a no-op, not a fork.
    await mcp.connect('fixture');
    await mcp.connect('fixture');
    check('mcp: reconnecting an already-ready server is idempotent', mcp.payload().servers.find((s) => s.id === 'fixture')?.status === 'ready');
  } finally {
    await mcp.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();

const failed = checks.filter((c) => !c[1]).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
