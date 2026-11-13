/**
 * ExecService — the execution-plane facade the IDE and (later) the AI MCP
 * tools talk to (spec §七: execution exposed as `code.run` / `sandbox.create`
 * / `sandbox.reset`).
 *
 * It owns a `SandboxPool` (the warm-worker pool) and, for Go, a `GoRunner`
 * whose session dirs persist between runs. Every method lands on the two
 * spines: `sandbox.run` latency metrics + `sandbox.warm.hit` / `sandbox.cold.start`
 * counters, and `SandboxLogCollector` turns worker output into `user-code`
 * records correlated by `sessionId`.
 */
import { GoRunner } from '../go/GoRunner.js';
import type { Kernel } from '../kernel/Kernel.js';
import { SandboxPool } from './SandboxPool.js';
import type {
  SandboxCreateResult,
  SandboxLanguage,
  SandboxPoolOptions,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxSessionInfo,
} from './types.js';

export class ExecService {
  readonly pool: SandboxPool;
  private goRunner?: GoRunner;

  constructor(
    private kernel: Kernel,
    opts: SandboxPoolOptions = {},
  ) {
    this.goRunner = new GoRunner(kernel, opts.goBin);
    this.pool = new SandboxPool(kernel, opts, this.goRunner);
  }

  /** Register the execution-plane commands on the kernel command bus. */
  registerCommands(): void {
    const c = this.kernel.commands;
    c.register(
      'sandbox.create',
      (languageId: SandboxLanguage, sessionId?: string) => this.create(languageId, sessionId),
      { title: 'Create a sandbox execution session', category: 'execution' },
    );
    c.register(
      'sandbox.run',
      (opts: SandboxRunOptions) => this.run(opts),
      { title: 'Run code in a sandbox session', category: 'execution' },
    );
    c.register(
      'sandbox.reset',
      (sessionId: string) => this.reset(sessionId),
      { title: 'Reset a sandbox session (dispose worker + state)', category: 'execution' },
    );
    c.register(
      'sandbox.list',
      () => this.list(),
      { title: 'List active sandbox sessions', category: 'execution' },
    );
    // AI-native alias (spec: `code.run` MCP tool). Same surface, friendlier name.
    c.register(
      'code.run',
      (opts: SandboxRunOptions) => this.run(opts),
      { title: 'Run code (AI agent tool)', category: 'execution' },
    );
  }

  async create(languageId: SandboxLanguage, sessionId?: string): Promise<SandboxCreateResult> {
    const ephemeral = sessionId == null;
    const sid = sessionId ?? `sb-${Math.random().toString(36).slice(2, 12)}`;
    const created = await this.pool.createSession(languageId, sid, ephemeral);
    return { sessionId: sid, languageId, warm: created.warm };
  }

  run(opts: SandboxRunOptions): Promise<SandboxRunResult> {
    this.kernel.logger
      .forExecution('sandbox.run', opts.sessionId ?? '?')
      .debug('Run requested', { languageId: opts.languageId, sessionId: opts.sessionId });
    return this.pool.run(opts);
  }

  reset(sessionId: string): Promise<boolean> {
    return this.pool.reset(sessionId);
  }

  list(): SandboxSessionInfo[] {
    return this.pool.list();
  }

  async close(): Promise<void> {
    await this.pool.close();
    await this.goRunner?.close();
  }
}
