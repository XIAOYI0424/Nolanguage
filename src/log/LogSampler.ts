import { LogLevel } from './LogLevel.js';
import type { LogRecord } from './types.js';

export interface SamplerOptions {
  levelRates?: Partial<Record<LogLevel, number>>;
  dedupWindowMs?: number;
  dedupMax?: number;
  /**
   * When false, nothing is sampled or deduped — every record is kept. This is
   * the dev-mode behaviour (spec 十: "Dev Mode：100% 采集").
   */
  enabled?: boolean;
}

/**
 * Adaptive sampler (spec 19.2). ERROR+ always kept; low-value levels sampled
 * by rate; identical (component:message) bursts deduped within a window.
 * Disabled entirely in dev mode so nothing is lost.
 */
export class LogSampler {
  private levelRates: Record<number, number>;
  private dedupWindowMs: number;
  private dedupMax: number;
  private enabled: boolean;
  private dedup = new Map<string, { count: number; ts: number }>();

  constructor(opts: SamplerOptions = {}) {
    this.levelRates = {
      [LogLevel.TRACE]: 0.01,
      [LogLevel.DEBUG]: 0.1,
      [LogLevel.INFO]: 1.0,
      [LogLevel.WARN]: 1.0,
      [LogLevel.ERROR]: 1.0,
      [LogLevel.FATAL]: 1.0,
      [LogLevel.AUDIT]: 1.0,
      [LogLevel.METRIC]: 1.0,
      ...(opts.levelRates ?? {}),
    };
    this.dedupWindowMs = opts.dedupWindowMs ?? 1000;
    this.dedupMax = opts.dedupMax ?? 10;
    this.enabled = opts.enabled ?? true;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  keep(r: LogRecord): boolean {
    if (!this.enabled) return true;
    if (r.level >= LogLevel.ERROR) return true;
    const key = `${r.resource.component}:${r.message}`;
    const now = Date.now();
    const e = this.dedup.get(key);
    if (e && now - e.ts < this.dedupWindowMs) {
      if (e.count >= this.dedupMax) return false;
      e.count++;
    } else {
      this.dedup.set(key, { count: 1, ts: now });
    }
    const rate = this.levelRates[r.level] ?? 1;
    if (rate >= 1) return true;
    return Math.random() < rate;
  }
}
