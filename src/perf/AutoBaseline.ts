import type { CorrelationBus } from '../correlation/CorrelationBus.js';
import type { GitInfo } from '../git/GitProbe.js';
import type { LiveMetrics } from './LiveMetrics.js';
import { BaselineStore, fmtPct } from './BaselineStore.js';
import type { BaselineComparison, BaselineRecord } from './BaselineStore.js';
import type { Logger } from '../log/Logger.js';

/**
 * Auto-baseline orchestrator (Stage 6 · 基线系统, spec 十).
 *
 * "自动基线：每次 Git commit 创建基线，与上一基线对比"
 *
 * Wires three pieces together:
 *   GitProbe (async, polls for commit changes)
 *     → LiveMetrics snapshot
 *     → BaselineStore (persist to SQLite + compare with the previous baseline)
 *     → `perf:baseline` event + structured log
 */

export interface AutoBaselineOptions {
  baselines: BaselineStore;
  metrics: LiveMetrics;
  correlation: CorrelationBus;
  appVersion?: string;
  /** Sink for the `perf:baseline` event (usually `kernel.events.emit`). */
  emit?: (event: string, payload: unknown) => void;
  log?: Logger;
  /**
   * Clear the live metric windows after each checkpoint. `false` (default)
   * keeps baselines cumulative — each one describes the whole session so far.
   * Set `true` for per-interval baselines where each row covers only the work
   * done since the previous commit.
   */
  resetOnCheckpoint?: boolean;
  /** Git poll interval in ms (default 15 s); `0` disables the automatic watch. */
  pollMs?: number;
}

export interface BaselineCheckpoint {
  baseline: BaselineRecord;
  previous: BaselineRecord | null;
  comparison: BaselineComparison;
  commitChanged: boolean;
}

export interface BaselineEvent {
  id: string;
  gitCommit: string;
  gitBranch?: string;
  reason: string;
  metricCount: number;
  regressed: number;
  improved: number;
  stable: number;
  added: number;
  removed: number;
  commitChanged: boolean;
  previousId?: string;
  previousCommit?: string;
  regressions: Array<{
    name: string;
    deltaAvg: number | null;
    deltaAvgPct: number | null;
    previousAvg: number;
    currentAvg: number;
  }>;
  at: number;
}

export class AutoBaseline {
  private readonly baselines: BaselineStore;
  private readonly metrics: LiveMetrics;
  private readonly correlation: CorrelationBus;
  private readonly appVersion?: string;
  private readonly emit?: (event: string, payload: unknown) => void;
  private readonly log?: Logger;
  private readonly resetOnCheckpoint: boolean;
  private readonly pollMs: number;

  private stopWatch?: () => void;
  private count = 0;
  private last?: BaselineComparison;
  private pending?: Promise<BaselineCheckpoint>;

  constructor(opts: AutoBaselineOptions) {
    this.baselines = opts.baselines;
    this.metrics = opts.metrics;
    this.correlation = opts.correlation;
    this.appVersion = opts.appVersion;
    this.emit = opts.emit;
    this.log = opts.log;
    this.resetOnCheckpoint = opts.resetOnCheckpoint ?? false;
    this.pollMs = opts.pollMs ?? 15_000;
  }

  get checkpoints(): number {
    return this.count;
  }

  get lastComparison(): BaselineComparison | undefined {
    return this.last;
  }

  get running(): boolean {
    return !!this.stopWatch;
  }

  /**
   * Take a baseline now: refresh git state, snapshot the live metrics, persist
   * the baseline and compare it with the previous one.
   *
   * Concurrent calls are coalesced so a burst of triggers produces one row.
   */
  async checkpoint(reason = 'manual', observedGit?: GitInfo): Promise<BaselineCheckpoint> {
    if (this.pending) return this.pending;
    const p = this.runCheckpoint(reason, observedGit).finally(() => { this.pending = undefined; });
    this.pending = p;
    return p;
  }

  private async runCheckpoint(reason: string, observedGit?: GitInfo): Promise<BaselineCheckpoint> {
    const git = observedGit
      ? await this.correlation.prime(false, observedGit)
      : await this.correlation.prime(true);

    const baseline = this.baselines.capture(this.metrics.summaries(), {
      gitCommit: git.commit,
      gitBranch: git.branch,
      configHash: this.correlation.configHash(),
      sessionId: this.correlation.sessionId,
      appVersion: this.appVersion,
      reason,
      label: git.unborn ? `uncommitted (${git.branch})` : `${git.shortCommit} ${git.subject}`.trim(),
    });

    const previous = this.baselines.latest(baseline.id) ?? null;
    const comparison = this.baselines.compare(baseline, previous);
    this.last = comparison;
    this.count++;

    if (this.resetOnCheckpoint) this.metrics.clear();

    const payload: BaselineEvent = {
      id: baseline.id,
      gitCommit: baseline.gitCommit,
      gitBranch: baseline.gitBranch,
      reason,
      metricCount: Object.keys(baseline.metrics).length,
      regressed: comparison.summary.regressed,
      improved: comparison.summary.improved,
      stable: comparison.summary.stable,
      added: comparison.summary.added,
      removed: comparison.summary.removed,
      commitChanged: comparison.summary.commitChanged,
      previousId: previous?.id,
      previousCommit: previous?.gitCommit,
      regressions: comparison.regressions.slice(0, 5).map((d) => ({
        name: d.name,
        deltaAvg: d.deltaAvg,
        deltaAvgPct: d.deltaAvgPct,
        previousAvg: d.previous?.avg ?? 0,
        currentAvg: d.current?.avg ?? 0,
      })),
      at: baseline.createdAt,
    };
    this.emit?.('perf:baseline', payload);

    if (this.log) {
      const detail = {
        baselineId: baseline.id,
        gitCommit: baseline.gitCommit,
        reason,
        metrics: payload.metricCount,
        regressions: payload.regressed,
        improvements: payload.improved,
        commitChanged: payload.commitChanged,
      };
      if (comparison.regressions.length) {
        const top = comparison.regressions[0];
        this.log.warn(
          `Baseline ${payload.regressed} regression(s): ${top.name} ${fmtPct(top.deltaAvgPct)}`,
          { ...detail, worstMetric: top.name, worstDeltaPct: top.deltaAvgPct },
        );
      } else {
        this.log.info('Baseline captured', detail);
      }
    }

    return {
      baseline,
      previous,
      comparison,
      commitChanged: comparison.summary.commitChanged,
    };
  }

  /**
   * Start watching for git commit changes. The first observation produces an
   * `initial` baseline unless a checkpoint was already taken.
   */
  start(): void {
    if (this.stopWatch || this.pollMs <= 0) return;
    this.stopWatch = this.correlation.probe.watch((info, previous) => {
      if (previous === undefined && this.count > 0) return;
      const reason = previous === undefined ? 'initial' : 'git-commit';
      // The watcher already performed the full probe; feed that observation
      // directly into the checkpoint instead of spawning Git again.
      void this.checkpoint(reason, info).catch(() => {
        // A failed checkpoint must not kill the poll loop.
      });
    });
  }

  stop(): void {
    this.stopWatch?.();
    this.stopWatch = undefined;
  }
}
