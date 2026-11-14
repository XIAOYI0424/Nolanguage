import type { Kernel } from './types.js';
import { LogPipeline } from '../log/LogPipeline.js';
import { LogFactory } from '../log/LogFactory.js';
import { LogSampler } from '../log/LogSampler.js';
import { ConsoleTransport } from '../log/transports/ConsoleTransport.js';
import { FileTransport } from '../log/transports/FileTransport.js';
import { LogLevel } from '../log/LogLevel.js';
import type { LogEnvironment } from '../log/types.js';
import type { CorrelationBus } from '../correlation/CorrelationBus.js';
import type { Logger } from '../log/Logger.js';

export interface LogSpineOptions {
  level?: LogLevel;
  pretty?: boolean;
  env: LogEnvironment;
  correlation: CorrelationBus;
  /** Enable rate-sampling (prod). Disabled in dev mode for 100% collection. */
  sampling?: boolean;
  /** Skip the console transport entirely (tests / embedded use). */
  silent?: boolean;
  /**
   * NDJSON log file, rotated by size. Opt-in: the packaged desktop sets it, the
   * verification suites do not (they must not write into the user's app data).
   */
  filePath?: string;
  /** Level kept by the file transport. Defaults to INFO: the ring has TRACE. */
  fileLevel?: LogLevel;
}

/**
 * Log spine (Stage 1): assembles pipeline + factory + console transport,
 * installs the kernel log collector (auto command logging), and exposes flush.
 */
export class LogSpine {
  pipeline!: LogPipeline;
  factory!: LogFactory;
  /** Present only when a file path was supplied. */
  file?: FileTransport;
  private opts: LogSpineOptions;

  constructor(opts: LogSpineOptions) {
    this.opts = opts;
  }

  install(kernel: Kernel): void {
    this.pipeline = new LogPipeline({ minLevel: this.opts.level ?? LogLevel.TRACE });
    if (!this.opts.silent) {
      this.pipeline.addTransport(new ConsoleTransport({ pretty: this.opts.pretty ?? true }));
    }
    if (this.opts.filePath) {
      // A GUI build has no console, and the warm tier can be read-only: this is
      // the only transport that leaves something behind after a crash.
      this.file = new FileTransport({
        path: this.opts.filePath,
        minLevel: this.opts.fileLevel ?? LogLevel.INFO,
        header: {
          version: 1,
          app: this.opts.env.appVersion,
          platform: `${this.opts.env.os}/${this.opts.env.arch}`,
          startedAt: new Date().toISOString(),
          pid: process.pid,
        },
      });
      this.pipeline.addTransport(this.file);
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
    this.file?.close();
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
