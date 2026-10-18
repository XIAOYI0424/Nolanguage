import type { Kernel } from '../kernel/types.js';
import { LogPipeline } from './LogPipeline.js';
import { LogFactory } from './LogFactory.js';
import { LogSampler } from './LogSampler.js';
import { ConsoleTransport } from './transports/ConsoleTransport.js';
import { LogLevel } from './LogLevel.js';
import type { LogEnvironment } from './types.js';
import type { CorrelationBus } from '../correlation/CorrelationBus.js';
import type { Logger } from './Logger.js';

export interface LogSpineOptions {
  level?: LogLevel;
  pretty?: boolean;
  env: LogEnvironment;
  correlation: CorrelationBus;
  /** Enable rate-sampling (prod). Disabled in dev mode for 100% collection. */
  sampling?: boolean;
  /** Skip the console transport entirely (tests / embedded use). */
  silent?: boolean;
}

/**
 * Log spine (Stage 1): assembles pipeline + factory + console transport,
 * installs the kernel log collector (auto command logging), and exposes flush.
 */
export class LogSpine {
  pipeline!: LogPipeline;
  factory!: LogFactory;
  private opts: LogSpineOptions;

  constructor(opts: LogSpineOptions) {
    this.opts = opts;
  }

  install(kernel: Kernel): void {
    this.pipeline = new LogPipeline({ minLevel: this.opts.level ?? LogLevel.TRACE });
    if (!this.opts.silent) {
      this.pipeline.addTransport(new ConsoleTransport({ pretty: this.opts.pretty ?? true }));
    }
    // Dev mode keeps every record; prod applies rate-sampling + dedup.
    if (this.opts.sampling === false) this.pipeline.setSampler(new LogSampler({ enabled: false }));

    const baseCorrelation = {
      gitCommit: this.opts.correlation.gitCommit(),
      configHash: this.opts.correlation.configHash(),
    };
    this.factory = new LogFactory(this.pipeline, this.opts.env, baseCorrelation);
    kernel.logger = this.factory;

    new KernelLogCollector().install(kernel);
  }

  async flush(): Promise<void> {
    await this.pipeline.flush();
  }
}

/** Built-in collector: wraps every command with a span and logs start/done/error. */
class KernelLogCollector {
  install(kernel: Kernel): void {
    kernel.commands.use(async (ctx, next) => {
      const span = kernel.tracer.startSpan('command', { attributes: { name: ctx.id } });
      const log: Logger = kernel.logger.forComponent('kernel.command-bus').span(span);
      log.trace(`Command ${ctx.id} started`);
      try {
        const result = await next(ctx.args);
        log.trace(`Command ${ctx.id} done`);
        return result;
      } catch (err) {
        log.error(`Command ${ctx.id} failed`, {}, err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
