// Test functions are supplied by the active Vitest collector (see globals in vitest.config.ts).
import { Kernel } from '../src/kernel/Kernel';
import { LogLevel } from '../src/log/LogLevel';

describe('Stage 1 minimal kernel', () => {
  let kernel: Kernel;
  beforeEach(() => { kernel = new Kernel(); });

  it('command bus registers and executes', async () => {
    await kernel.start();
    kernel.commands.register('add', (a, b) => (a as number) + (b as number));
    expect(await kernel.commands.execute<number>('add', 2, 3)).toBe(5);
  });

  it('command middleware can transform args/result', async () => {
    await kernel.start();
    kernel.commands.use(async (_ctx, next) => {
      const r = await next([10, 20]);
      return (r as number) * 2;
    });
    kernel.commands.register('add', (a, b) => (a as number) + (b as number));
    expect(await kernel.commands.execute<number>('add', 0, 0)).toBe(60);
  });

  it('event bus delivers to handlers', async () => {
    await kernel.start();
    let got: unknown;
    kernel.events.on('e', (p) => { got = p; });
    await kernel.events.emit('e', 42);
    expect(got).toBe(42);
  });

  it('once handler fires only once', async () => {
    await kernel.start();
    let n = 0;
    kernel.events.once('e', () => { n++; });
    await kernel.events.emit('e');
    await kernel.events.emit('e');
    expect(n).toBe(1);
  });

  it('service registry returns a singleton', () => {
    const obj = {};
    kernel.services.register('s', () => obj);
    expect(kernel.services.consume('s')).toBe(obj);
    expect(kernel.services.consume('s')).toBe(obj);
  });

  it('auto-instruments command latency', async () => {
    await kernel.start();
    kernel.commands.register('noop', () => 1);
    for (let i = 0; i < 5; i++) await kernel.commands.execute('noop');
    const s = kernel.perfSummary('command.latency');
    expect(s).toBeDefined();
    expect(s!.count).toBe(5);
  });

  it('auto-instruments service activation', async () => {
    await kernel.start();
    kernel.services.register('svc', () => ({}));
    kernel.services.consume('svc');
    const s = kernel.perfSummary('service.activate');
    expect(s).toBeDefined();
    expect(s!.count).toBe(1);
  });

  it('logs are written to console transport and ring buffer', async () => {
    await kernel.start();
    kernel.logger.root().info('hello test');
    const recs = kernel.recentLogs(10);
    expect(recs.some((r) => r.message === 'hello test' && r.level === LogLevel.INFO)).toBe(true);
  });

  it('captures slow commands as slow paths', async () => {
    const k = new Kernel({ slowThresholdMs: 10 });
    await k.start();
    k.commands.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 1;
    });
    await k.commands.execute('slow');
    expect(k.slowPaths().length).toBeGreaterThan(0);
  });
});
