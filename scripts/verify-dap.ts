/**
 * Phase 6 · DAP runtime verification.
 *
 * debugpy and delve are not installed on this machine, so this suite drives
 * `DapClient` against a purpose-built mock adapter (`scripts/lib/mockDapServer.mjs`)
 * that speaks real framed JSON-RPC. That is the whole point: the client is
 * exercised end to end — handshake, launch, breakpoints, stack, scopes,
 * variables, continue, disconnect — with no external toolchain in the way.
 *
 * What is checked:
 *   1. the full session sequence against the mock,
 *   2. degradation when discovery fails (no adapter => a clear error),
 *   3. the manifest contract for `debug`,
 *   4. a failed launch surfaces as an error, not a hung client.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-dap.ts
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Kernel } from '../src/kernel/Kernel.js';
import { DapClient } from '../src/dap/DapClient.js';
import { resolveDebugAdapter, startDebugSession } from '../src/dap/index.js';
import { LanguageRegistry } from '../src/langs/Registry.js';
import { validateManifest } from '../src/langs/manifest.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const MOCK = resolve('scripts/lib/mockDapServer.mjs').replace(/\\/g, '/');

async function mockManifests(dir: string): Promise<LanguageRegistry> {
  const reg = new LanguageRegistry({ home: dir, extraRoots: [] });
  await reg.scan();
  return reg;
}

// ============================================================ the session

async function testSession(kernel: Kernel): Promise<void> {
  const stopped: Array<{ threadId: number; reason: string }> = [];
  const output: string[] = [];
  const client = new DapClient(
    kernel,
    { command: process.execPath, args: [MOCK], adapterId: 'mock' },
    { onStopped: (i) => stopped.push(i), onOutput: (t) => output.push(t) },
  );
  const caps = await client.start();
  check('dap: the handshake returns capabilities', caps.supportsConfigurationDoneRequest === true, JSON.stringify(caps).slice(0, 80));
  check('dap: the adapter is ready', client.ready === true);

  const bp = await client.setBreakpoints('main.mock', [7]);
  const bpList = (bp as { breakpoints?: Array<{ verified: boolean }> }).breakpoints ?? [];
  check('dap: setBreakpoints reports verified breakpoints', bpList.length === 1 && bpList[0].verified === true, JSON.stringify(bpList));

  const frames = await client.stackTrace();
  check('dap: stackTrace returns frames, innermost first', frames.length === 2 && frames[0].name === 'main', frames.map((f) => f.name).join(','));
  check('dap: a frame carries file and line', frames[0].file === 'main.mock' && frames[0].line === 7, JSON.stringify(frames[0]));

  const scopes = await client.scopes(frames[0].id);
  check('dap: scopes resolve for a frame', scopes.length === 1 && scopes[0].name === 'Locals', JSON.stringify(scopes));
  const vars = await client.variables(scopes[0].variablesReference);
  check('dap: variables resolve inside a scope', vars.length === 2 && vars[0].name === 'counter', vars.map((v) => v.name).join(','));

  check('dap: the stopped event reached the handler', stopped.length >= 1 && stopped[0].reason === 'entry', JSON.stringify(stopped[0] ?? {}));
  void output;

  await client.continue_();
  // The `terminated` event arrives on the adapter's stdout, so it may still be
  // in flight when `continue` resolves.
  let terminated = client.current.terminated;
  for (let i = 0; i < 40 && !terminated; i++) {
    await new Promise((r) => setTimeout(r, 25));
    terminated = client.current.terminated;
  }
  check('dap: continuing runs to termination', terminated === true, String(terminated));
  await client.stop();
  check('dap: a finished session reports not ready', client.ready === false);
}

// ============================================================ degradation

async function testDegradation(kernel: Kernel): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nl-dap-'));
  const pluginDir = join(dir, 'nodebug@1.0.0');
  await rm(pluginDir, { recursive: true, force: true }).catch(() => undefined);
  await (await import('node:fs/promises')).mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, 'manifest.json'),
    JSON.stringify({
      id: 'nodebug',
      displayName: 'No Debug',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      order: 95,
      file: { extensions: ['nd'], defaultExt: 'nd' },
      // No `debug` block at all.
    }),
    'utf8',
  );
  const reg = await mockManifests(dir);
  await reg.install(pluginDir);
  const m = reg.get('nodebug')!;
  check('dap: a language without a debug block resolves to nothing', resolveDebugAdapter(m) === undefined);

  const withDebug = JSON.parse(JSON.stringify(reg.get('nodebug'))) as Record<string, unknown>;
  (withDebug.debug as Record<string, unknown>) = {
    adapter: 'nosuchadapter',
    discovery: { commands: ['definitely-not-installed-nl'] },
    serverName: 'nosuch',
    degradedNote: 'nosuch not installed - debugging is unavailable for No Debug',
  };
  const resolved = resolveDebugAdapter(withDebug as never)!;
  check('dap: an unavailable adapter reports available=false', resolved.available === false);
  check('dap: the degraded note comes from the manifest', resolved.degradedNote.includes('nosuch not installed'), resolved.degradedNote);

  let msg = '';
  try {
    await startDebugSession(kernel, withDebug as never);
  } catch (err) {
    msg = (err as Error).message;
  }
  check('dap: starting a session without an adapter fails loudly', msg.includes('nosuch not installed'), msg);

  // The mock works when it is named explicitly, so the failure above is the
  // manifest's, not the client's.
  const working = JSON.parse(JSON.stringify(withDebug)) as Record<string, unknown>;
  (working.debug as Record<string, unknown>).command = [process.execPath, MOCK];
  (working.debug as Record<string, unknown>).discovery = { commands: [] };
  const ok = resolveDebugAdapter(working as never)!;
  check('dap: an absolute command resolves without discovery', ok.available === true && ok.command === process.execPath, String(ok.command));
  check('dap: the adapter receives the manifest args too', ok.args.join(' ').includes('mockDapServer'), ok.args.join(' '));

  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function testLaunchFailure(kernel: Kernel): Promise<void> {
  const client = new DapClient(kernel, { command: process.execPath, args: [MOCK, '--fail'], adapterId: 'mock' });
  let msg = '';
  try {
    await client.start();
  } catch (err) {
    msg = (err as Error).message;
  }
  check('dap: a refused launch surfaces as an error, not a hang', /RPC error -32000|mock launch refused/.test(msg), msg);
  check('dap: a failed launch leaves the client not ready', client.ready === false);
  await client.stop().catch(() => undefined);
}

// ============================================================ the contract

async function testContract(): Promise<void> {
  const base = JSON.parse(await (await import('node:fs/promises')).readFile(resolve('builtin/python@1.0.0/manifest.json'), 'utf8')) as Record<string, unknown>;
  check('contract: the python plugin declares debug + dap-free manifest', validateManifest(base).ok === true);
  const bad = JSON.parse(JSON.stringify(base));
  (bad.debug as Record<string, unknown>).type = 7;
  const v = validateManifest(bad);
  check('contract: a non-string debug field is left alone but the block is accepted', v.ok === true);
  const broken = JSON.parse(JSON.stringify(base));
  broken.debug = { discovery: { commands: 'gopls' } };
  const v2 = validateManifest(broken);
  check('contract: a non-array debug.discovery is rejected', !v2.ok && v2.issues.some((i) => i.field === 'debug.discovery.commands'), JSON.stringify(v2.issues));
}

// ======================================================================= driver

async function main(): Promise<void> {
  const kernel = new Kernel({ logSilent: true });
  await kernel.start();
  try {
    console.log('— session —');
    await testSession(kernel);
    console.log('— degradation —');
    await testDegradation(kernel);
    console.log('— launch failure —');
    await testLaunchFailure(kernel);
    console.log('— contract —');
    await testContract();
  } finally {
    await kernel.stop().catch(() => undefined);
  }
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} checks passed (${failed} failed)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
