import { RingBuffer } from '../perf/RingBuffer.js';
import { LogSampler } from './LogSampler.js';
import { LogLevel } from './LogLevel.js';
import type { LogRecord } from './types.js';

export interface LogTransport {
  write(record: LogRecord): void;
  flush?(): void | Promise<void>;
}

export interface LogPipelineOptions {
  hotCapacity?: number;
  capacity?: number;
  minLevel?: LogLevel;
  components?: string[];
  messagePattern?: RegExp;
  /** Live tap invoked for every accepted record (dev panel, stage 2). */
  onRecord?: (record: LogRecord, accepted: boolean) => void;
}

/**
 * Log pipeline (spec 19): buffer -> filter -> sample -> route.
 * Hot ring buffer is the in-memory store for the live Logs panel; transports
 * receive each record after filtering/sampling. Includes backpressure control.
 */
export class LogPipeline {
  private ring: RingBuffer<LogRecord>;
  private transports: LogTransport[] = [];
  private sampler: LogSampler;
  private filter: { minLevel: LogLevel; components?: Set<string>; pattern?: RegExp };
  private capacity: number;
  private backpressure = false;
  private resetTimer?: ReturnType<typeof setTimeout>;
  /** Extra live tap (all records, before filtering) — used by the panel hub. */
  private taps: ((record: LogRecord) => void)[] = [];

  constructor(opts: LogPipelineOptions = {}) {
    this.ring = new RingBuffer(opts.hotCapacity ?? 100_000);
    this.capacity = opts.capacity ?? 65_536;
    this.sampler = new LogSampler();
    this.filter = {
      minLevel: opts.minLevel ?? LogLevel.TRACE,
      components: opts.components ? new Set(opts.components) : undefined,
      pattern: opts.messagePattern,
    };
  }

  addTransport(t: LogTransport): this {
    this.transports.push(t);
    return this;
  }

  /**
   * Register a live tap. Taps see **raw accepted records before the ring
   * buffer**, which lets the panel forward high-severity events in real time
   * without waiting for the next digest, and without touching the hot store.
   */
  addTap(fn: (record: LogRecord) => void): () => void {
    this.taps.push(fn);
    return () => {
      const i = this.taps.indexOf(fn);
      if (i >= 0) this.taps.splice(i, 1);
    };
  }

  setMinLevel(l: LogLevel): void {
    this.filter.minLevel = l;
  }

  /** Live filter used by the dev panel (Stage 2). */
  setMessagePattern(pattern?: RegExp): void {
    this.filter.pattern = pattern;
  }

  setComponents(components?: string[]): void {
    this.filter.components = components && components.length ? new Set(components) : undefined;
  }

  currentFilter(): { minLevel: LogLevel; components?: string[]; pattern?: string } {
    return {
      minLevel: this.filter.minLevel,
      components: this.filter.components ? [...this.filter.components] : undefined,
      pattern: this.filter.pattern?.source,
    };
  }

  setSampler(s: LogSampler): void {
    this.sampler = s;
  }

  ingest(r: LogRecord): void {
    if (this.backpressure && r.level < LogLevel.WARN) return;
    if (r.level < this.filter.minLevel) return;
    if (this.filter.components && !this.filter.components.has(r.resource.component)) return;
    if (this.filter.pattern && !this.filter.pattern.test(r.message)) return;
    if (!this.sampler.keep(r)) return;

    this.ring.push(r);
    for (const t of this.transports) {
      try {
        t.write(r);
      } catch {
        // Never let a transport failure crash the application.
      }
    }
    for (const tap of this.taps) {
      try {
        tap(r);
      } catch {
        // Taps are best-effort.
      }
    }

    if (this.ring.size >= this.capacity) {
      this.backpressure = true;
      const kept = this.ring.toArray().filter((x) => x.level >= LogLevel.WARN);
      this.ring.clear();
      for (const x of kept) this.ring.push(x);
      this.resetTimer = setTimeout(() => { this.backpressure = false; }, 5000);
    }
  }

  toArray(): LogRecord[] {
    return this.ring.toArray();
  }

  recent(limit: number): LogRecord[] {
    return this.ring.toArray().slice(-limit);
  }

  clear(): void {
    this.ring.clear();
  }

  async flush(): Promise<void> {
    for (const t of this.transports) {
      if (t.flush) await t.flush();
    }
  }
}
