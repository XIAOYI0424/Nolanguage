/**
 * Stage-1 verification, dependency-free (mirrors tests/phase1.test.ts, which
 * needs vitest from the network). Covers the three buses, auto-instrumentation
 * and the log spine's ring buffer.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-stage1.ts
 */
import { Kernel } from '../src/kernel/Kernel.js';
import { LogLevel } from '../src/log/LogLevel.js';
import { RingBuffer } from '../src/perf/RingBuffer.js';
import { LogSampler } from '../src/log/LogSampler.js';
import { levelFromName } from '../src/log/LogLevel.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main(): Promise<void> {
  // ---------- command bus ----------
  {
    const k = new Kernel({ logSilent: true });
    await k.start();
    k.commands.register('add', (a, b) => (a as number) + (b as number));
    check('command bus registers and executes', (await k.commands.execute<number>('add', 2, 3)) === 5, '2+3=5');

    k.commands.use(async (_ctx, next) => ((await next([10, 20])) as number) * 2);
    k.commands.register('add2', (a, b) => (a as number) + (b as number));
    check('command middleware wraps args/result', (await k.commands.execute<number>('add2', 0, 0)) === 60, '(10+20)*2=60');

    let threw = false;
    try {
      await k.commands.execute('nope');
    } catch {
      threw = true;
    }
    check('unknown command rejects', threw, 'Command not found');

    let dup = false;
    try {
      k.commands.register('add', () => 1);
    } catch {
      dup = true;
    }
    check('duplicate command rejected', dup);
    check('command list exposes metadata', k.commands.list().length >= 2, `${k.commands.list().length} commands`);
    await k.stop();
  }

  // ---------- event bus ----------
  {
    const k = new Kernel({ logSilent: true });
    await k.start();
    let got: unknown;
    k.events.on('e', (p) => { got = p; });
    await k.events.emit('e', 42);
    check('event bus delivers payload', got === 42);

    let n = 0;
    k.events.once('once', () => { n++; });
    await k.events.emit('once');
    await k.events.emit('once');
    check('once handler fires exactly once', n === 1, `n=${n}`);

    const d = k.events.on('t', () => { n += 100; });
    d.dispose();
    await k.events.emit('t');
    check('disposed handler is not called', n === 1, `n=${n}`);
    await k.stop();
  }

  // ---------- service registry ----------
  {
    const k = new Kernel({ logSilent: true });
    await k.start();
    const obj = {};
    k.services.register('s', () => obj);
    check('service registry caches singletons', k.services.consume('s') === obj && k.services.consume('s') === obj);
    check('service registry reports has()', k.services.has('s') && !k.services.has('nope'));

    let calls = 0;
    k.services.register('t', () => ({ n: ++calls }), { lifecycle: 'transient' });
    k.services.consume('t');
    k.services.consume('t');
    check('transient services re-create', calls === 2, `factory calls=${calls}`);
    await k.stop();
  }

  // ---------- auto-instrumentation ----------
  {
    const k = new Kernel({ logSilent: true, slowThresholdMs: 10 });
    await k.start();
    k.commands.register('noop', () => 1);
    for (let i = 0; i < 5; i++) await k.commands.execute('noop');
    const s = k.perfSummary('command.latency');
    check('command latency auto-instrumented', !!s && s.count === 5, s ? `n=${s.count}` : 'missing');

    k.services.register('svc', () => ({}));
    k.services.consume('svc');
    const a = k.perfSummary('service.activate');
    check('service activation auto-instrumented', !!a && a.count === 1, a ? `n=${a.count}` : 'missing');

    await k.events.emit('evt', {});
    k.events.on('evt2', () => undefined);
    await k.events.emit('evt2');
    const ev = k.perfSummary('event.emit.duration');
    check('event emit auto-instrumented', !!ev && ev.count >= 1, ev ? `n=${ev.count}` : 'missing');

    k.commands.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 1;
    });
    await k.commands.execute('slow');
    const slow = k.slowPaths();
    check('slow command captured as a slow path', slow.length > 0,
      slow.map((x) => `${x.name}=${(x.duration ?? 0).toFixed(1)}ms`).join(','));
    check('slow path shares a traceId', slow.every((x) => !!x.traceId), slow[0]?.traceId.slice(0, 8) ?? '');
    check('perf records are stored', k.recentPerf(100).length > 0, `${k.recentPerf(100).length} records`);
    await k.stop();
  }

  // ---------- log spine ----------
  {
    const k = new Kernel({ logSilent: true });
    await k.start();
    k.logger.root().info('hello test');
    const recs = k.recentLogs(10);
    check('logs reach the ring buffer', recs.some((r) => r.message === 'hello test' && r.level === LogLevel.INFO));

    const rec = recs.find((r) => r.message === 'hello test')!;
    check('log records carry the environment', !!rec.environment.os && !!rec.environment.appVersion, rec.environment.arch);
    check('log records carry correlation keys', 'configHash' in rec.correlation, Object.keys(rec.correlation).join(','));
    check('log timestamp is nanosecond-scale', rec.timestamp > 1e15, `${rec.timestamp}`);

    const child = k.logger.forComponent('a.b').withContext({ sessionId: 'S1' });
    child.warn('scoped');
    const scoped = k.recentLogs(10).find((r) => r.message === 'scoped')!;
    check('withContext merges correlation', scoped.correlation.sessionId === 'S1');
    check('forComponent sets the component', scoped.resource.component === 'a.b');

    k.logger.forComponent('c').error('boom', {}, new Error('kaboom'));
    const errRec = k.recentLogs(10).find((r) => r.message === 'boom')!;
    check('errors capture type/message/stack', errRec.error?.type === 'Error' && !!errRec.error?.stack, errRec.error?.message);

    k.logger.forComponent('m').metric('cache.hit', 0.85);
    const metric = k.recentLogs(10).find((r) => r.message === 'cache.hit')!;
    check('metric logs are tagged for the perf pipeline',
      metric.level === LogLevel.METRIC && !!metric.tags?.includes('metric'), metric.tags?.join(',') ?? '');
    await k.stop();
  }

  // ---------- ring buffer ----------
  {
    const rb = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((v) => rb.push(v));
    check('ring buffer overwrites oldest', JSON.stringify(rb.toArray()) === '[3,4,5]', JSON.stringify(rb.toArray()));
    check('ring buffer reports full', rb.isFull && rb.size === 3);
    rb.clear();
    check('ring buffer clears', rb.size === 0 && rb.toArray().length === 0);
  }

  // ---------- level helpers ----------
  {
    check('levelFromName is case-insensitive', levelFromName('warn') === LogLevel.WARN && levelFromName('ERROR') === LogLevel.ERROR);
    check('levelFromName maps aliases', levelFromName('warning') === LogLevel.WARN && levelFromName('critical') === LogLevel.FATAL);
    check('levelFromName returns numbers', typeof levelFromName('info') === 'number' && levelFromName('info') === LogLevel.INFO);
    check('unknown level falls back to INFO', levelFromName('nonsense') === LogLevel.INFO);
  }

  // ---------- sampler ----------
  {
    const dev = new LogSampler({ enabled: false });
    const traceRec = {
      id: 'x', timestamp: 0, level: LogLevel.TRACE, message: 'm',
      resource: { scope: 'kernel', component: 'c' }, scope: {}, correlation: {},
      environment: { os: '', arch: '', appVersion: '' }, fields: {},
    } as never;
    check('dev-mode sampler keeps everything', dev.keep(traceRec));

    const prod = new LogSampler({ levelRates: { [LogLevel.TRACE]: 0 } });
    check('prod sampler drops TRACE at rate 0', !prod.keep(traceRec));
    const errRec = { ...(traceRec as object), level: LogLevel.ERROR } as never;
    check('prod sampler always keeps ERROR', prod.keep(errRec));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failed: ' + failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('verify-stage1 failed:', e);
  process.exit(1);
});
