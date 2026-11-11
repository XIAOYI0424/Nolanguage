/**
 * Correlation fields a record can carry.
 *
 * Owned by the correlation slice: the bus produces them, and everything that
 * records them (logs, perf records) points here. It lives at the bottom of the
 * graph on purpose — a vocabulary file with no imports, so any layer may use it
 * without creating an edge upward.
 */
export interface LogCorrelation {
  gitCommit?: string;
  gitBranch?: string;
  configHash?: string;
  sessionId?: string;
  requestId?: string;
  userId?: string;
  traceId?: string;
}
