import { LogLevel } from '../log/LogLevel.js';
import type { LogTransport } from '../log/LogPipeline.js';
import type { LogRecord } from '../log/types.js';
import type { PerfRecord } from '../perf/types.js';
import type { SqliteStore } from './SqliteStore.js';

/**
 * Warm-tier sink (Stage 6 · 基线系统, spec 20.2).
 *
 *   hot (memory ring buffer) ── every 5 s or 512 records ──▶ warm (SQLite)
 *
 * A `LogTransport` that buffers records in memory and drains them into SQLite
 * in a single transaction per flush. Also accepts PerfRecords so both halves of
 * the correlation skeleton land in the same database (spec 二十二).
 *
 * Failure policy: the sink must never take the application down. Flush errors
 * are counted and reported via `onError`; after `maxConsecutiveFailures` the
 * sink disables itself rather than retrying a broken database forever.
 */

export interface LogSinkOptions {
  store: SqliteStore;
  /** Flush cadence in ms (spec 20.2: 5 s). */
  flushIntervalMs?: number;
  /** Records buffered before an immediate flush (spec 20.2: 512). */
  batchSize?: number;
  /** Hard cap on the in-memory queue; excess low-severity records are dropped. */
  maxQueue?: number;
  /** Sink-side level filter (default TRACE — persist everything). */
  minLevel?: LogLevel;
  /** Persist PerfRecords too (default true). */
  perf?: boolean;
  /** Called once per failed flush. */
  onError?: (err: Error) => void;
  /** Disable the sink after this many consecutive flush failures (default 3). */
  maxConsecutiveFailures?: number;
  /** Start the flush timer immediately (default true). */
  autoStart?: boolean;
}

export interface SinkStats {
  enabled: boolean;
  queued: number;
  queuedPerf: number;
  writtenLogs: number;
  writtenPerf: number;
  dropped: number;
  flushes: number;
  failures: number;
  lastFlushAt: number | null;
  lastError?: string;
}

export class LogSink implements LogTransport {
  private readonly store: SqliteStore;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxQueue: number;
  private readonly minLevel: LogLevel;
  private readonly persistPerf: boolean;
  private readonly onError?: (err: Error) => void;
  private readonly maxConsecutiveFailures: number;

  private queue: LogRecord[] = [];
  private perfQueue: PerfRecord[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private consecutiveFailures = 0;
  private disabled = false;
  private flushing = false;

  private stats: SinkStats = {
    enabled: true,
    queued: 0,
    queuedPerf: 0,
    writtenLogs: 0,
    writtenPerf: 0,
    dropped: 0,
    flushes: 0,
    failures: 0,
    lastFlushAt: null,
  };

  constructor(opts: LogSinkOptions) {
    this.store = opts.store;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5_000;
    this.batchSize = opts.batchSize ?? 512;
    this.maxQueue = opts.maxQueue ?? 20_000;
    this.minLevel = opts.minLevel ?? LogLevel.TRACE;
    this.persistPerf = opts.perf ?? true;
    this.onError = opts.onError;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
    if (opts.autoStart !== false) this.start();
  }

  /** `LogTransport.write` — buffer one record, flushing early at batch size. */
  write(record: LogRecord): void {
    if (this.disabled || record.level < this.minLevel) return;
    if (this.queue.length >= this.maxQueue) this.shed();
    this.queue.push(record);
    this.stats.queued++;
    if (this.queue.length >= this.batchSize) this.flushSync();
  }

  /** Buffer one PerfRecord (wired through `PerfSpine.addTap`). */
  writePerf(record: PerfRecord): void {
    if (this.disabled || !this.persistPerf) return;
    if (this.perfQueue.length >= this.maxQueue) this.perfQueue.shift();
    this.perfQueue.push(record);
    this.stats.queuedPerf++;
    if (this.perfQueue.length >= this.batchSize) this.flushSync();
  }

  /** Drop the oldest non-severe record to make room under backpressure. */
  private shed(): void {
    let idx = -1;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].level < LogLevel.WARN) { idx = i; break; }
    }
    if (idx < 0) idx = 0;
    this.queue.splice(idx, 1);
    this.stats.dropped++;
  }

  /**
   * Drain both queues into SQLite. Never throws — `LogPipeline.flush()` and the
   * interval timer both call this, and neither may crash the host.
   */
  flush(): void {
    if (this.disabled) return;
    if (this.flushing) return; // re-entrancy guard: the timer can fire mid-flush
    if (!this.queue.length && !this.perfQueue.length) return;
    this.flushing = true;
    const logs = this.queue;
    const perfs = this.perfQueue;
    this.queue = [];
    this.perfQueue = [];
    try {
      if (logs.length) this.stats.writtenLogs += this.store.insertLogs(logs);
      if (perfs.length) this.stats.writtenPerf += this.store.insertPerfs(perfs);
      this.stats.flushes++;
      this.stats.lastFlushAt = Date.now();
      this.consecutiveFailures = 0;
    } catch (err) {
      const e = err as Error;
      this.stats.failures++;
      this.stats.lastError = e.message;
      this.consecutiveFailures++;
      // Put the records back so a transient failure is not data loss.
      this.queue = logs.concat(this.queue).slice(-this.maxQueue);
      this.perfQueue = perfs.concat(this.perfQueue).slice(-this.maxQueue);
      this.onError?.(e);
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) this.disable(e);
    } finally {
      this.flushing = false;
    }
    this.syncStats();
  }

  /** Flush from inside `write()` without letting errors escape the pipeline. */
  private flushSync(): void {
    try {
      this.flush();
    } catch {
      // flush() already swallows; this is belt-and-braces.
    }
  }

  private disable(err: Error): void {
    this.disabled = true;
    this.stats.enabled = false;
    this.stop();
    void err;
  }

  start(): void {
    if (this.timer || this.disabled) return;
    this.timer = setInterval(() => this.flushSync(), this.flushIntervalMs);
    // Never keep the process alive just for telemetry flushing.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Final flush + timer teardown. */
  async close(): Promise<void> {
    this.stop();
    this.flush();
    this.syncStats();
  }

  private syncStats(): void {
    this.stats.queued = this.queue.length;
    this.stats.queuedPerf = this.perfQueue.length;
  }

  /** Point-in-time counters (queue depth is refreshed here). */
  getStats(): SinkStats {
    this.syncStats();
    return { ...this.stats };
  }

  get isDisabled(): boolean {
    return this.disabled;
  }
}
