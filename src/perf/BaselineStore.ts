import { ulid } from '../util/ulid.js';
import type { MetricSummary } from './LiveMetrics.js';
import type { LiveMetrics } from './LiveMetrics.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { BaselineRecord } from '../store/types.js';

export type { BaselineRecord } from '../store/types.js';

/**
 * Long-term metric baselines (Stage 6 · 基线系统, spec 十).
 *
 * "每次 Git commit 创建基线，与上一基线对比" — every checkpoint snapshots the
 * live metric windows into a row keyed by the current git commit, then compares
 * it against the previous baseline to surface regressions.
 */


export type DeltaStatus = 'new' | 'gone' | 'regressed' | 'improved' | 'stable';

export interface MetricDelta {
  name: string;
  previous: MetricSummary | null;
  current: MetricSummary | null;
  status: DeltaStatus;
  /** current.avg - previous.avg (ms or whatever unit the metric uses). */
  deltaAvg: number | null;
  /** Relative change in percent; `null` when there is no comparable previous. */
  deltaAvgPct: number | null;
  deltaP95: number | null;
  deltaP95Pct: number | null;
  /** Ranking weight — the absolute relative change. */
  score: number;
}

export interface BaselineComparison {
  current: BaselineRecord;
  previous: BaselineRecord | null;
  deltas: MetricDelta[];
  regressions: MetricDelta[];
  improvements: MetricDelta[];
  added: string[];
  removed: string[];
  summary: {
    total: number;
    regressed: number;
    improved: number;
    stable: number;
    added: number;
    removed: number;
    commitChanged: boolean;
  };
}

export interface BaselineThresholds {
  /** Minimum relative change (%) for a delta to count as a real shift. */
  minRelPct?: number;
  /** Minimum absolute change for a delta to count as a real shift. */
  minAbs?: number;
  /** Predicate for metrics where a larger value is an improvement. */
  higherIsBetter?: (name: string) => boolean;
}

const DEFAULT_THRESHOLDS: Required<Omit<BaselineThresholds, 'higherIsBetter'>> = {
  minRelPct: 10,
  minAbs: 0.5,
};

/** Metrics where bigger is better (throughput / rate / hit ratio). */
export function defaultHigherIsBetter(name: string): boolean {
  return /throughput|hit_rate|hitratio|\.hits?$|success|coverage/i.test(name);
}

export interface CaptureMeta {
  gitCommit?: string;
  gitBranch?: string;
  configHash?: string;
  sessionId?: string;
  appVersion?: string;
  label?: string;
  reason?: string;
  createdAt?: number;
}

export interface BaselineStoreOptions extends BaselineThresholds {}

/**
 * Persists and compares metric baselines. Pure logic lives in `snapshot()` /
 * `compare()`; SQLite I/O is confined to `capture()` / `history()`.
 */
export class BaselineStore {
  private readonly minRelPct: number;
  private readonly minAbs: number;
  private readonly higherIsBetter: (name: string) => boolean;

  constructor(private store: SqliteStore, opts: BaselineStoreOptions = {}) {
    this.minRelPct = opts.minRelPct ?? DEFAULT_THRESHOLDS.minRelPct;
    this.minAbs = opts.minAbs ?? DEFAULT_THRESHOLDS.minAbs;
    this.higherIsBetter = opts.higherIsBetter ?? defaultHigherIsBetter;
  }

  /** Build a baseline record from a metric map — no persistence. */
  snapshot(metrics: Record<string, MetricSummary>, meta: CaptureMeta = {}): BaselineRecord {
    const createdAt = meta.createdAt ?? Date.now();
    const gitCommit = meta.gitCommit ?? 'unknown';
    return {
      id: ulid(createdAt),
      gitCommit,
      gitBranch: meta.gitBranch,
      configHash: meta.configHash,
      sessionId: meta.sessionId,
      createdAt,
      appVersion: meta.appVersion,
      label: meta.label ?? defaultLabel(gitCommit, createdAt),
      reason: meta.reason ?? 'manual',
      metrics: cloneMetrics(metrics),
    };
  }

  /** Snapshot the live metric windows without persisting. */
  captureFrom(live: LiveMetrics, meta: CaptureMeta = {}): BaselineRecord {
    return this.snapshot(live.summaries(), meta);
  }

  /** Snapshot + persist. Returns the stored record. */
  capture(metrics: Record<string, MetricSummary>, meta: CaptureMeta = {}): BaselineRecord {
    const record = this.snapshot(metrics, meta);
    this.store.insertBaseline(record);
    return record;
  }

  /** Snapshot the live windows + persist. */
  captureLive(live: LiveMetrics, meta: CaptureMeta = {}): BaselineRecord {
    return this.capture(live.summaries(), meta);
  }

  /** Compare `current` against `previous` (null previous → everything is `new`). */
  compare(
    current: BaselineRecord,
    previous: BaselineRecord | null,
    thresholds: BaselineThresholds = {},
  ): BaselineComparison {
    const minRelPct = thresholds.minRelPct ?? this.minRelPct;
    const minAbs = thresholds.minAbs ?? this.minAbs;
    const higherIsBetter = thresholds.higherIsBetter ?? this.higherIsBetter;

    const names = new Set<string>([
      ...Object.keys(current.metrics),
      ...Object.keys(previous?.metrics ?? {}),
    ]);

    const deltas: MetricDelta[] = [];
    const added: string[] = [];
    const removed: string[] = [];

    for (const name of [...names].sort()) {
      const cur = current.metrics[name] ?? null;
      const prev = previous?.metrics[name] ?? null;

      if (!prev) {
        added.push(name);
        deltas.push({
          name, previous: null, current: cur, status: 'new',
          deltaAvg: null, deltaAvgPct: null, deltaP95: null, deltaP95Pct: null, score: 0,
        });
        continue;
      }
      if (!cur) {
        removed.push(name);
        deltas.push({
          name, previous: prev, current: null, status: 'gone',
          deltaAvg: null, deltaAvgPct: null, deltaP95: null, deltaP95Pct: null, score: 0,
        });
        continue;
      }

      const deltaAvg = cur.avg - prev.avg;
      const deltaP95 = cur.p95 - prev.p95;
      const deltaAvgPct = relPct(prev.avg, deltaAvg);
      const deltaP95Pct = relPct(prev.p95, deltaP95);
      const score = Math.abs(deltaAvgPct ?? 0);

      const significant =
        Math.abs(deltaAvg) >= minAbs && Math.abs(deltaAvgPct ?? 0) >= minRelPct;

      let status: DeltaStatus = 'stable';
      if (significant) {
        const better = higherIsBetter(name) ? deltaAvg > 0 : deltaAvg < 0;
        status = better ? 'improved' : 'regressed';
      }

      deltas.push({
        name, previous: prev, current: cur, status,
        deltaAvg, deltaAvgPct, deltaP95, deltaP95Pct, score,
      });
    }

    const regressions = deltas
      .filter((d) => d.status === 'regressed')
      .sort((a, b) => b.score - a.score);
    const improvements = deltas
      .filter((d) => d.status === 'improved')
      .sort((a, b) => b.score - a.score);

    return {
      current,
      previous,
      deltas,
      regressions,
      improvements,
      added,
      removed,
      summary: {
        total: deltas.length,
        regressed: regressions.length,
        improved: improvements.length,
        stable: deltas.filter((d) => d.status === 'stable').length,
        added: added.length,
        removed: removed.length,
        commitChanged: !!previous && previous.gitCommit !== current.gitCommit,
      },
    };
  }

  /** All baselines for a commit, newest first. */
  historyForCommit(commit: string): BaselineRecord[] {
    return this.store.baselinesByCommit(commit);
  }

  /** All baselines, newest first (capped at 500 by default). */
  history(limit = 500): BaselineRecord[] {
    return this.store.baselines(limit);
  }

  /** Most recent baseline overall, optionally excluding one id. */
  latest(excludeId?: string): BaselineRecord | undefined {
    return this.store.latestBaseline(excludeId);
  }

  /** Number of persisted baselines. */
  count(): number {
    return this.store.stats().baselineCount;
  }
}

function relPct(base: number, delta: number): number | null {
  if (base === 0) return delta === 0 ? 0 : null;
  return (delta / base) * 100;
}

function cloneMetrics(m: Record<string, MetricSummary>): Record<string, MetricSummary> {
  const out: Record<string, MetricSummary> = {};
  for (const [k, v] of Object.entries(m)) out[k] = { ...v };
  return out;
}

function defaultLabel(commit: string, at: number): string {
  const short = commit === 'unknown' ? 'uncommitted' : commit.slice(0, 7);
  return `${short} @ ${new Date(at).toISOString()}`;
}

/** Round a delta percentage for display. */
export function fmtPct(p: number | null): string {
  if (p === null) return 'n/a';
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(1)}%`;
}
