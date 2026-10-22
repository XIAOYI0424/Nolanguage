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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const configPath = join(dir, 'mcp.json');
  await writeFile(serverPath, FIXTURE, 'utf8');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          fixture: { command: process.execPath, args: [serverPath], description: 'Test fixture' },
          broken: { command: 'nolanguage-definitely-not-a-binary', args: [] },
          off: { command: process.execPath, args: [serverPath], disabled: true },
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
    check('mcp: config lists every declared server', before.servers.length === 3, before.servers.map((s) => s.id).join(','));
    check('mcp: servers start idle', before.servers.every((s) => s.status === 'idle' || s.status === 'disabled'));
    check('mcp: a disabled entry is marked', before.servers.some((s) => s.id === 'off' && s.status === 'disabled'));

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
