/**
 * Turning "how long were servers idle" into a TTL.
 *
 * A TTL is a trade: keep a server resident (memory) against paying its restart
 * cost again (seconds of a user's attention). Neither side is guessable, so the
 * manager logs both — this is the arithmetic that turns those logs into an
 * answer. It is pure on purpose: the distribution is the part worth testing, and
 * the script that reads the log should not also be the thing that decides what
 * the numbers mean.
 */

export interface IdleSummary {
  /** How many reuses were observed. */
  count: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
  /** Share of reuses that came back within `windowMs`, 0..1. */
  shareWithin: (windowMs: number) => number;
}

const EMPTY: IdleSummary = {
  count: 0,
  medianMs: 0,
  p90Ms: 0,
  maxMs: 0,
  shareWithin: () => 0,
};

/** Nearest-rank percentile: no interpolation, so every answer is a real sample. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarizeIdle(values: number[]): IdleSummary {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!clean.length) return EMPTY;
  return {
    count: clean.length,
    medianMs: percentile(clean, 50),
    p90Ms: percentile(clean, 90),
    maxMs: clean[clean.length - 1],
    shareWithin: (windowMs: number) => clean.filter((v) => v <= windowMs).length / clean.length,
  };
}

/**
 * What the data says about a TTL.
 *
 * The rule is deliberately conservative: a TTL is only too long if the server
 * sat idle long enough that a restart would have been cheaper than the memory.
 * With no samples the answer is "keep the default" — inventing a number from
 * zero observations is how a TTL becomes folklore.
 */
export type TtlVerdict = 'no-data' | 'ttl-is-generous' | 'ttl-is-tight';

export function judgeTtl(summary: IdleSummary, ttlMs: number): TtlVerdict {
  if (!summary.count) return 'no-data';
  // If most reuses arrive well inside the TTL, the TTL is doing its job (the
  // server was still there when it was needed). If they cluster *near* it, the
  // TTL is cutting restarts close and should be longer.
  return summary.shareWithin(ttlMs * 0.8) >= 0.8 ? 'ttl-is-generous' : 'ttl-is-tight';
}
