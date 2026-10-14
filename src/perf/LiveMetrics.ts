export interface MetricSummary {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Sliding-window metric aggregator. Keeps the last `maxSamples` values per
 * metric name and computes percentiles on demand (used for live P95 panels).
 */
export class LiveMetrics {
  private windows = new Map<string, number[]>();
  private readonly maxSamples: number;

  constructor(maxSamples = 1000) {
    this.maxSamples = maxSamples;
  }

  record(name: string, value: number): void {
    let arr = this.windows.get(name);
    if (!arr) {
      arr = [];
      this.windows.set(name, arr);
    }
    arr.push(value);
    if (arr.length > this.maxSamples) arr.shift();
  }

  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
  }

  summary(name: string): MetricSummary | undefined {
    const arr = this.windows.get(name);
    if (!arr || arr.length === 0) return undefined;
    const sum = arr.reduce((a, b) => a + b, 0);
    return {
      count: arr.length,
      min: Math.min(...arr),
      max: Math.max(...arr),
      avg: sum / arr.length,
      p50: this.percentile(arr, 50),
      p95: this.percentile(arr, 95),
      p99: this.percentile(arr, 99),
    };
  }

  names(): string[] {
    return [...this.windows.keys()];
  }

  /** Snapshot every metric window as a `name -> summary` map (baseline capture). */
  summaries(): Record<string, MetricSummary> {
    const out: Record<string, MetricSummary> = {};
    for (const name of this.windows.keys()) {
      const s = this.summary(name);
      if (s) out[name] = s;
    }
    return out;
  }

  /**
   * Drop one window, or every window when `name` is omitted. Used after a
   * baseline checkpoint so the next baseline measures a fresh interval
   * (spec 十: 每次 Git commit 创建基线，与上一基线对比).
   */
  clear(name?: string): void {
    if (name === undefined) this.windows.clear();
    else this.windows.delete(name);
  }
}
