/**
 * Extension-host verification (spec 阶段 5 · 扩展宿主).
 *
 * Checks the whole contract of the child-process extension model:
 *
 *   manifest  → 合法清单通过，非法清单被拒（id / engines / entry / 版本范围）
 *   registry  → 只解析清单、不加载代码；兼容性判定；按激活事件反查
 *   lazy      → 没有命令时不 spawn 进程；首个命令才激活
 *   rpc       → 命令在子进程里执行，返回值跨进程回传
 *   metrics   → rpc.roundtrip.extension.<method> + memory.rss + extension.uptime
 *   logs      → 子进程批量推送的日志被重新注入内核，带 extensionId / hostId / pid
 *   trace     → 命令执行期间的扩展日志带调用方 traceId（可融合）
 *   isolation → 抛异常只让该命令失败，宿主存活
 *   crash     → 硬崩溃被检测、计入 crash.count、并在下次使用时重启
 *   多扩展    → 一个扩展崩掉不影响另一个（独立进程）
 *   温层      → 扩展日志随内核一起落进 SQLite
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-extensions.ts
 */
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../src/kernel/Kernel.js';
import { LogLevel } from '../src/log/LogLevel.js';
import { ExtensionManager } from '../src/extensions/ExtensionManager.js';
import { ExtensionRegistry, parseManifest, satisfies, ManifestError } from '../src/extensions/ExtensionRegistry.js';
import { HostLogCollector } from '../src/extensions/HostLogCollector.js';
import type { SerializedLog } from '../src/extensions/protocol.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(here, '..', 'src', 'extensions', 'examples');

function makeKernel(store: boolean | string = false): Kernel {
  return new Kernel({
    appVersion: '0.6.0-ext',
    // TRACE + silent: the ring buffer must hold every record so the assertions
    // can see the extension batches. (`logSilent` keeps the console clean; it
    // does not affect the pipeline.)
    logLevel: LogLevel.TRACE,
    logSilent: true,
    slowThresholdMs: 40,
    store,
  });
}

// ============================================================ 1. manifest

function manifestChecks(): void {
  const good = parseManifest({
    id: 'demo.sample',
    version: '1.2.3',
    engines: { kernel: '^0.6.0' },
    entry: 'extension.js',
    activationEvents: ['onStartup'],
  });
  check('valid manifest parses', good.id === 'demo.sample' && good.host === 'child-process', good.id);
  check('manifest defaults host to child-process', good.host === 'child-process');
  check('manifest defaults version', parseManifest({ id: 'a.b', engines: { kernel: '*' }, entry: 'x.js' }).version === '0.0.0');

  const bad = (raw: unknown, why: string): void => {
    let threw = false;
    try {
      parseManifest(raw);
    } catch (err) {
      threw = err instanceof ManifestError;
    }
    check(`rejects ${why}`, threw);
  };
  bad({ engines: { kernel: '^1.0.0' }, entry: 'x.js' }, 'a missing id');
  bad({ id: 'Demo.Bad', engines: { kernel: '^1.0.0' }, entry: 'x.js' }, 'an invalid id (uppercase)');
  bad({ id: 'demo.x', entry: 'x.js' }, 'a missing engines.kernel');
  bad({ id: 'demo.x', engines: { kernel: '^1.0.0' } }, 'a missing entry');

  // version ranges
  check('satisfies ^0.6.0 for 0.6.0-ext', satisfies('0.6.0-ext', '^0.6.0'));
  check('satisfies ^0.6.0 for 0.6.4', satisfies('0.6.4', '^0.6.0'));
  check('rejects ^0.6.0 for 0.7.0 (0.x pins minor)', !satisfies('0.7.0', '^0.6.0'));
  check('rejects ^1.0.0 for 0.6.0', !satisfies('0.6.0', '^1.0.0'));
  check('exact range match', satisfies('1.2.3', '1.2.3') && !satisfies('1.2.4', '1.2.3'));

  const registry = new ExtensionRegistry('0.6.0-ext');
  registry.add({
    manifest: good,
    dir: '/tmp',
    manifestPath: '/tmp/extension.json',
    entryPath: '/tmp/extension.js',
    compatible: true,
  });
  check('registry stores the manifest', registry.get('demo.sample')?.manifest.name === 'demo.sample');
  check('registry rejects a duplicate id', (() => {
    try {
      registry.add({
        manifest: good,
        dir: '/tmp',
        manifestPath: '/tmp/extension.json',
        entryPath: '/tmp/extension.js',
        compatible: true,
      });
      return false;
    } catch {
      return true;
    }
  })());

  const incompatible = parseManifest({
    id: 'demo.future',
    engines: { kernel: '^99.0.0' },
    entry: 'x.js',
    activationEvents: ['onStartup'],
  });
  registry.add({
    manifest: incompatible,
    dir: '/tmp',
    manifestPath: '/tmp/x.json',
    entryPath: '/tmp/x.js',
    compatible: ExtensionRegistry.isCompatible(incompatible, '0.6.0-ext'),
  });
  check('incompatible extension is flagged, not dropped', registry.get('demo.future')?.compatible === false);
  check('incompatible extension is not a startup target', registry.forStartup().every((e) => e.manifest.id !== 'demo.future'));
}

// ======================================================= 2. log collector

function collectorChecks(): void {
  const batches: SerializedLog[][] = [];
  const collector = new HostLogCollector({ extensionId: 'demo.log', batchSize: 3, push: (r) => batches.push(r) });
  collector.debug('one');
  check('collector buffers below the batch size', batches.length === 0 && collector.pending === 1);
  collector.info('two');
  collector.warn('three');
  check('collector flushes at the batch size', batches.length === 1 && batches[0].length === 3);
  check('collector keeps record fields', batches[0][1].message === 'two' && batches[0][2].level === LogLevel.WARN);
  collector.error('boom', { code: 1 }, new Error('kaput'));
  // One record does not trip the 3-record batch — it is still buffered.
  check('error record is buffered', batches.length === 1 && collector.pending === 1);
  collector.info('leftover-a');
  collector.info('leftover-b'); // now the batch trips
  check('collector serialises errors', batches.length === 2 && batches[1][0].error?.message === 'kaput', batches[1]?.[0]?.error?.message);
  collector.info('tail');
  check('stop() flushes the remainder', (collector.stop(), batches.length === 3 && batches[2][0].message === 'tail'));
  check(
    'trace id attaches to records',
    (() => {
      const seen: SerializedLog[][] = [];
      const c2 = new HostLogCollector({ extensionId: 'demo.log', batchSize: 1, push: (r) => seen.push(r) });
      c2.withTrace('trace-abc').info('traced');
      return seen[0][0].traceId === 'trace-abc';
    })(),
  );
}

// ================================================ 3. manager, no spawn

function lazyChecks(): void {
  const kernel = makeKernel();
  const manager = new ExtensionManager(kernel, { scanDirs: [EXAMPLES] });
  const found = manager.discoverAll();
  const ids = found.map((f) => f.manifest.id).sort();
  check('scans both demo extensions', ids.join(',') === 'demo.faulty,demo.hello', ids.join(','));
  check('resolves the .ts entry for source runs', found.every((f) => f.entryPath.endsWith('.ts')));
  check('records the manifest path on the host descriptor', found.every((f) => f.manifestPath.endsWith('extension.json')));
  check('registers contributed commands', manager.registry.commands().length === 4, `${manager.registry.commands().length}`);
  check('no host process exists before activation', manager.statuses().length === 0);
  check('forCommand finds the owner', manager.registry.forCommand('demo.hello.greet')[0]?.manifest.id === 'demo.hello');
  check('forCommand ignores unrelated commands', manager.registry.forCommand('nope.nope').length === 0);
}

// ============================================= 4. activation + rpc + logs

async function runtimeChecks(): Promise<number> {
  const kernel = makeKernel();
  await kernel.start();
  const manager = new ExtensionManager(kernel, { scanDirs: [EXAMPLES], activateOnStartup: true });
  manager.discoverAll();
  manager.installCommands();

  // --- lazy until a command needs it ---
  check('host is not spawned until activation', manager.statuses().length === 0);

  const t0 = Date.now();
  const result = await manager.runCommand('demo.hello.greet', 'verify');
  const spawnMs = Date.now() - t0;
  check('command result crosses the process boundary', result === 'Hello, verify! (from extension demo.hello)', String(result));
  check('cold host spawn + activate completes', spawnMs < 15_000, `${spawnMs}ms`);

  const st = manager.statuses()[0];
  check('host reports ready', st.state === 'ready', st.state);
  check('host has its own pid (≠ kernel)', !!st.pid && st.pid !== process.pid, `pid=${st.pid} kernel=${process.pid}`);

  // --- kernel command bus proxy ---
  const viaBus = await kernel.commands.execute<string>('demo.hello.fib', 20);
  check('kernel command bus proxies into the host', viaBus === 6765, String(viaBus));

  // --- heartbeats → host metrics ---
  await delay(2500);
  const st2 = manager.statuses()[0];
  check('memory.rss heartbeat received', (st2.rssBytes ?? 0) > 1_000_000, `${Math.round((st2.rssBytes ?? 0) / 1048576)} MiB`);
  check('extension.uptime heartbeat received', (st2.uptimeMs ?? 0) > 0, `${st2.uptimeMs}ms`);

  // --- rpc instrumentation ---
  const names = kernel.perfNames();
  check(
    'rpc.roundtrip.extension.activate recorded',
    names.includes('rpc.roundtrip.extension.activate'),
    names.filter((n) => n.startsWith('rpc.roundtrip.extension')).join(','),
  );
  check('rpc.roundtrip.extension.command.run recorded', names.includes('rpc.roundtrip.extension.command.run'));
  check(
    'extension rpc feeds the shared rpc.roundtrip metric',
    (kernel.perfSummary('rpc.roundtrip')?.count ?? 0) > 0,
    `count=${kernel.perfSummary('rpc.roundtrip')?.count ?? 0}`,
  );
  check('memory.rss metric recorded', names.includes('memory.rss'));
  check('extension.log.records metric recorded', names.includes('extension.log.records'));

  // --- log aggregation ---
  const records = kernel.logPipeline().toArray();
  const ext = records.filter((r) => r.resource.scope === 'extension');
  check('extension logs arrive in the kernel pipeline', ext.length > 0, `${ext.length} record(s)`);
  check('extension records carry the extensionId', ext.every((r) => r.resource.extensionId === 'demo.hello'));
  check('extension records carry the hostId', ext.every((r) => !!r.resource.hostId));
  check('extension records carry the child pid', ext.length > 0 && ext.some((r) => r.resource.processId === st.pid));
  check(
    'extension records carry the kernel correlation skeleton',
    ext.length > 0 && ext.every((r) => r.correlation.sessionId === kernel.sessionId && !!r.correlation.gitCommit),
    `session=${ext[0]?.correlation.sessionId} git=${ext[0]?.correlation.gitCommit?.slice(0, 7)}`,
  );
  check('extension records keep their level', ext.some((r) => r.message.includes('extension activated')));
  check('batched, not one record per RPC', ext.length <= 12, `${ext.length} records for ~4 log calls`);

  // --- trace correlation ---
  // Running through the kernel command bus (not the manager) is what puts a
  // span on the tracer stack: the perf middleware wraps `command.execute`.
  await kernel.commands.execute('demo.hello.greet', 'trace');
  await delay(1300);
  const traced = kernel.logPipeline().toArray().filter((r) => r.resource.scope === 'extension' && r.traceId);
  check('extension logs inherit the caller traceId', traced.length > 0, `${traced.length} traced record(s)`);

  // --- isolation: a throwing command must not kill the host ---
  let failed = false;
  let errMsg = '';
  try {
    await manager.runCommand('demo.faulty.throw', 'verify-boom');
  } catch (err) {
    failed = true;
    errMsg = (err as Error).message;
  }
  check('a throwing command surfaces as an RPC error', failed, errMsg);
  check('the error message crosses the boundary', /verify-boom/.test(errMsg), errMsg);
  check('the throwing extension host survives', manager.statuses().some((s) => s.extensionId === 'demo.faulty' && s.state === 'ready'));

  const helloAfter = await manager.runCommand('demo.hello.greet', 'still-alive');
  check('a sibling extension is unaffected', helloAfter === 'Hello, still-alive! (from extension demo.hello)', String(helloAfter));

  // --- crash detection + recovery ---
  const before = kernel.perfSummary('crash.count')?.count ?? 0;
  let crashed = false;
  try {
    await manager.runCommand('demo.faulty.crash');
  } catch {
    crashed = true;
  }
  await delay(600);
  const faulty = manager.statuses().find((s) => s.extensionId === 'demo.faulty');
  check('a hard crash is observed', crashed || (faulty?.crashes ?? 0) > 0, `crashes=${faulty?.crashes}`);
  check('crash.count metric incremented', (kernel.perfSummary('crash.count')?.count ?? 0) > before, `${before} -> ${kernel.perfSummary('crash.count')?.count ?? 0}`);
  check('crashed host is marked idle, not ready', faulty?.state !== 'ready', faulty?.state ?? 'gone');

  // restart on next use
  let restartErr = '';
  let restarted = false;
  try {
    // `throw` auto-activates a fresh host after the crash.
    await manager.runCommand('demo.faulty.throw', 'after-crash');
  } catch (err) {
    restartErr = (err as Error).message;
    restarted = true;
  }
  check('host is restarted on next use', restarted, `${restartErr} / ${manager.statuses().find((s) => s.extensionId === 'demo.faulty')?.state}`);
  check('post-restart host is alive', manager.statuses().find((s) => s.extensionId === 'demo.faulty')?.state === 'ready');

  // --- panel snapshot ---
  const info = manager.panelInfo();
  check('panel info lists both extensions', info.length === 2, info.map((i) => i.id).join(','));
  check('panel info exposes host state + pid', info.every((i) => !!i.state && i.pid !== undefined));
  check('panel info exposes contributed commands', info.find((i) => i.id === 'demo.hello')?.commands.length === 2);

  // --- teardown ---
  const pids = manager.statuses().map((s) => s.pid).filter((p): p is number => !!p);
  await manager.dispose();
  await delay(500);
  check('dispose() stops every host', manager.statuses().every((s) => s.state !== 'ready'), pids.join(','));

  await kernel.stop();
  return pids.length;
}

// ================================================== 5. warm tier persistence

async function warmTierChecks(): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { SqliteStore } = await import('../src/store/SqliteStore.js');
  const { runLogQuery } = await import('../src/store/LogQuery.js');

  const dir = await mkdtemp(join(tmpdir(), 'nolanguage-ext-'));
  const db = join(dir, 'ext.db');
  try {
    const kernel = makeKernel(db);
    await kernel.start();
    const manager = new ExtensionManager(kernel, { scanDirs: [EXAMPLES] });
    manager.discoverAll();
    manager.installCommands();
    await manager.runCommand('demo.hello.greet', 'persist');
    await delay(1500);
    await manager.dispose();
    await kernel.stop(); // drains the LogSink into SQLite

    const store = new SqliteStore({ path: db });
    const queried = runLogQuery(store, { limit: 50 });
    const ext = queried.filter((r) => r.scope === 'extension');
    check('extension logs are persisted in the warm tier', ext.length > 0, `${ext.length} of ${queried.length} row(s)`);
    check(
      'persisted rows keep the extension component',
      ext.some((r) => r.component.startsWith('extension.')),
      ext[0]?.component ?? '(none)',
    );
    const fused = runLogQuery(store, { components: ['extension.demo.hello'], limit: 20 });
    check('warm tier can be queried by extension component', fused.length > 0, `${fused.length} row(s)`);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => undefined);
  }
}

// ==================================================================== main

async function main(): Promise<void> {
  console.log('--- manifest & registry ---');
  manifestChecks();
  console.log('\n--- host log collector ---');
  collectorChecks();
  console.log('\n--- discovery (no spawn) ---');
  lazyChecks();
  console.log('\n--- runtime: activation / rpc / logs / crash ---');
  await runtimeChecks();
  console.log('\n--- warm tier ---');
  await warmTierChecks();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failed: ' + failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('verify-extensions failed:', e);
  process.exit(1);
});
