/**
 * Demo surface for the Stage-2 panel: commands, events and services that give
 * the live metrics something real to measure. Kept separate from server.ts so
 * the panel can run with `PANEL_NO_DEMO=1` against a bare kernel.
 */
import type { Kernel } from '../kernel/Kernel.js';
import { LogLevel } from '../log/LogLevel.js';

export interface DemoHandle {
  /** Register everything; returns the traffic driver. */
  stop(): void;
}

export function startDemo(kernel: Kernel): DemoHandle {
  const log = kernel.logger.root();
  const disposables: { dispose(): void }[] = [];

  // ---- services (auto service.activate timing) ----
  kernel.services.register('config', () => ({
    theme: 'Light',
    language: 'Python',
    devMode: true,
  }));
  kernel.services.register('workspaceIndex', () => {
    const files = new Map<string, { symbols: string[] }>();
    for (let i = 0; i < 250; i++) files.set(`src/mod${i}.py`, { symbols: [`fn${i}`, `Cls${i}`] });
    return { files, size: () => files.size };
  });

  // ---- commands ----
  kernel.commands.register('math.add', (a: unknown, b: unknown) => (a as number) + (b as number), {
    title: 'Add two numbers',
    category: 'Demo',
  });

  kernel.commands.register(
    'index.workspace',
    async () => {
      const idx = kernel.services.consume<{ size(): number }>('workspaceIndex');
      await sleep(8 + Math.random() * 25);
      log.info('Workspace indexed', { files: idx.size(), durationMs: 20 });
      return idx.size();
    },
    { title: 'Index workspace', category: 'Demo' },
  );

  kernel.commands.register(
    'lsp.completion',
    async () => {
      const span = kernel.tracer.startSpan('lsp.pyright.completion');
      const ms = 40 + Math.random() * 90;
      await sleep(ms);
      span.end();
      kernel.perfMetrics().record('lsp.completion', ms);
      if (ms > 100) {
        kernel.logger
          .forComponent('lsp.pyright')
          .warn('Slow completion', { durationMs: Math.round(ms), file: 'src/main.py' });
      }
      return { items: Math.floor(Math.random() * 40) };
    },
    { title: 'Request completion', category: 'LSP' },
  );

  kernel.commands.register(
    'lsp.diagnostic',
    async () => {
      const ms = 80 + Math.random() * 380;
      await sleep(ms);
      kernel.perfMetrics().record('lsp.diagnostic', ms);
      if (ms > 300) {
        kernel.logger
          .forComponent('lsp.pyright')
          .warn('Slow diagnostics pass', { durationMs: Math.round(ms) });
      }
      return { errors: Math.floor(Math.random() * 3) };
    },
    { title: 'Run diagnostics', category: 'LSP' },
  );

  kernel.commands.register(
    'io.slowTask',
    async () => {
      await sleep(150 + Math.random() * 120);
      return 'done';
    },
    { title: 'Deliberately slow task', category: 'Demo' },
  );

  kernel.commands.register(
    'cache.query',
    () => {
      const hit = Math.random() < 0.7;
      kernel.logger.forComponent('kernel.cache').debug('Cache lookup', { hit });
      return hit ? 'value' : null;
    },
    { title: 'Query cache', category: 'Demo' },
  );

  kernel.commands.register(
    'boom',
    () => {
      throw new Error('kaboom: intentional failure for the panel');
    },
    { title: 'Throw an error', category: 'Demo' },
  );

  kernel.commands.register(
    'kernel.report',
    () => {
      const metrics = kernel.perfNames().map((n) => ({ name: n, summary: kernel.perfSummary(n) }));
      const slow = kernel.slowPaths().length;
      log.info('Kernel report generated', { metrics: metrics.length, slowPaths: slow });
      return { metrics, slowPaths: slow, logs: kernel.recentLogs(1000).length };
    },
    { title: 'Generate kernel report', category: 'Demo' },
  );

  // ---- events ----
  disposables.push(
    kernel.events.on('user.login', (p: unknown) => {
      log.info('User logged in', { user: (p as { user?: string })?.user });
    }),
  );
  disposables.push(
    kernel.events.on('editor.save', (p: unknown) => {
      const f = (p as { file?: string })?.file ?? 'untitled';
      log.info('File saved', { file: f });
      if (Math.random() < 0.2) {
        log.warn('Autosave conflict detected', { file: f });
      }
    }),
  );

  return {
    stop() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Continuous background traffic so the panel is never empty. */
export function startTraffic(kernel: Kernel, intervalMs = 900): { stop(): void } {
  const log = kernel.logger.forComponent('demo.traffic');
  let n = 0;
  const timer = setInterval(async () => {
    n++;
    try {
      const pick = n % 5;
      if (pick === 0) await kernel.commands.execute('lsp.completion');
      else if (pick === 1) await kernel.commands.execute('lsp.diagnostic');
      else if (pick === 2) await kernel.commands.execute('cache.query');
      else if (pick === 3) await kernel.commands.execute('index.workspace');
      else await kernel.commands.execute('math.add', n, 1);

      if (n % 7 === 0) await kernel.events.emit('editor.save', { file: `src/mod${n}.py` });
      if (n % 11 === 0) await kernel.events.emit('user.login', { user: 'alice' });
      if (n % 13 === 0) log.debug('Heartbeat', { tick: n });
      if (n % 29 === 0) {
        try {
          await kernel.commands.execute('boom');
        } catch {
          /* expected */
        }
      }
      if (n % 17 === 0) await kernel.commands.execute('io.slowTask');
    } catch {
      /* keep the demo alive */
    }
  }, intervalMs);
  timer.unref?.();
  log.info('Demo traffic started', { intervalMs });
  return {
    stop() {
      clearInterval(timer);
      log.info('Demo traffic stopped', { ticks: n });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
