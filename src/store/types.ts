import type { MetricSummary } from '../perf/types.js';

/**
 * One stored baseline row.
 *
 * Owned by the store because it is a *persisted shape*: the schema and the
 * row type must change together. `perf` reads and writes it, but it does not
 * own it — that used to make `store` depend on `perf` for a type it defines.
 */
export interface BaselineRecord {
  id: string;
  gitCommit: string;
  gitBranch?: string;
  configHash?: string;
  sessionId?: string;
  createdAt: number;
  appVersion?: string;
  /** Free-form name for this checkpoint (e.g. `commit 4f2a1b9`). */
  label?: string;
  /** Why the checkpoint was taken: `initial` | `git-commit` | `manual` | … */
  reason?: string;
  metrics: Record<string, MetricSummary>;
}
