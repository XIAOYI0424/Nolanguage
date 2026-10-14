/**
 * HostLogCollector — the child-side log sink (spec 18.2).
 *
 * An extension logs through `ctx.log`, which is *not* the kernel logger (that
 * object lives in another process). Instead records are buffered here and
 * pushed to the kernel in batches over the RPC connection:
 *
 *   - flush when the batch holds `batchSize` records (default 64), or
 *   - every `flushIntervalMs` (default 1000), or
 *   - immediately when `flush()` is called (shutdown, before a crash).
 *
 * Batching is the whole point: an extension that logs a thousand lines must
 * cost one write to the pipe, not a thousand.
 */
import { LogLevel } from '../log/LogLevel.js';
import type { SerializedLog } from './protocol.js';

export interface HostLogCollectorOptions {
  extensionId: string;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Called with the batch; feeds the RPC connection in HostRunner. */
  push: (records: SerializedLog[]) => void;
}

function toError(e: unknown): SerializedLog['error'] | undefined {
  if (!(e instanceof Error)) return undefined;
  return { type: e.name, message: e.message, stack: e.stack ?? '' };
}

export class HostLogCollector {
  private buffer: SerializedLog[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private traceId?: string;
  private spanId?: string;
  private dropped = 0;

  constructor(private opts: HostLogCollectorOptions) {
    this.batchSize = Math.max(1, opts.batchSize ?? 64);
    this.flushIntervalMs = Math.max(50, opts.flushIntervalMs ?? 1000);
  }

  /** Extension code never calls this; the runner manages the lifecycle. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
  }

  /** Attach the caller's trace id (spec: correlation skeleton, 一屏可见). */
  withTrace(traceId?: string, spanId?: string): this {
    this.traceId = traceId;
    this.spanId = spanId;
    return this;
  }

  private record(level: LogLevel, message: string, fields?: Record<string, unknown>, error?: unknown): void {
    // A hard cap keeps a runaway extension from exhausting memory: the oldest
    // non-error records are dropped rather than the host being OOM-killed.
    if (this.buffer.length >= this.batchSize * 16) {
      const idx = this.buffer.findIndex((r) => r.level < LogLevel.WARN);
      this.buffer.splice(idx >= 0 ? idx : 0, 1);
      this.dropped++;
    }
    this.buffer.push({
      level,
      message,
      timestamp: Date.now() * 1_000_000,
      fields: fields ?? {},
      traceId: this.traceId,
      spanId: this.spanId,
      error: toError(error),
    });
    if (this.buffer.length >= this.batchSize) this.flush();
  }

  trace(message: string, fields?: Record<string, unknown>): void { this.record(LogLevel.TRACE, message, fields); }
  debug(message: string, fields?: Record<string, unknown>): void { this.record(LogLevel.DEBUG, message, fields); }
  info(message: string, fields?: Record<string, unknown>): void { this.record(LogLevel.INFO, message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void { this.record(LogLevel.WARN, message, fields); }
  error(message: string, fields?: Record<string, unknown>, error?: unknown): void {
    this.record(LogLevel.ERROR, message, fields, error);
  }

  /** Push whatever is buffered now. */
  flush(): void {
    if (!this.buffer.length) return;
    const batch = this.buffer;
    this.buffer = [];
    if (this.dropped > 0) {
      batch.unshift({
        level: LogLevel.WARN,
        message: `log batch overflow — ${this.dropped} record(s) dropped by the host`,
        timestamp: Date.now() * 1_000_000,
        fields: { dropped: this.dropped },
      });
      this.dropped = 0;
    }
    this.opts.push(batch);
  }

  /** Records waiting to be pushed (tests / status). */
  get pending(): number {
    return this.buffer.length;
  }
}
