/**
 * Stage 11 — attribution: turn "it feels slower" into "this function, this
 * commit, this confidence".
 *
 * Four pieces, each doing one job:
 *
 *   cusumChangePoint  *where* did the series shift? (no distribution assumed)
 *   welchT            *is* the shift real? (unequal variance, two-sided p)
 *   cohensD           *how big* is it? (p alone lies at large n)
 *   bisectSuspects    *which change* caused it? (good/bad probe, O(log n))
 *
 * `attribute()` glues them into one verdict. Everything is pure: the numbers
 * are the product, so they are testable without a clock, a process, or a repo.
 *
 * Deliberate limits, stated so callers do not over-read the result:
 *   - the p-value assumes roughly independent samples; a perf series sampled
 *     every 100 ms is autocorrelated, so p is optimistic. That is why the
 *     verdict also requires an effect size and why `confidence` is capped.
 *   - CUSUM needs a stable reference segment; the first `minSegment` samples
 *     are used as that reference, so a change in the very first samples is
 *     invisible by construction.
 */

/** Two-sided p-value for Student's t with `df` degrees of freedom. */
export function tTestPValue(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  const x = df / (df + t * t);
  return clamp01(incompleteBeta(df / 2, 0.5, x));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Continued fraction for the incomplete beta (Lentz's method). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-10) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;
  return x < (a + 1) / (a + b + 2)
    ? front * betaContinuedFraction(a, b, x)
    : 1 - (Math.exp(Math.log(1 - x) * b + Math.log(x) * a - lnBeta) / b) * betaContinuedFraction(b, a, 1 - x);
}

/** Lanczos approximation — accurate enough for the df values we see. */
export function lnGamma(z: number): number {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (n−1). */
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (xs.length - 1);
}

export interface WelchResult {
  t: number;
  df: number;
  p: number;
  meanA: number;
  meanB: number;
}

/**
 * Welch's t-test — the unequal-variance version, which is the honest default
 * for latency (the variance changes with the mean).
 */
export function welchT(a: number[], b: number[]): WelchResult | null {
  if (a.length < 2 || b.length < 2) return null;
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const denom = Math.sqrt(va + vb);
  const meanA = mean(a);
  const meanB = mean(b);
  if (denom === 0) {
    // Both samples are perfectly constant: identical means are a tie, anything
    // else is an infinite t (a real, if degenerate, difference).
    if (meanA === meanB) return { t: 0, df: 1, p: 1, meanA, meanB };
    return { t: Math.sign(meanB - meanA) * Infinity, df: 1, p: 0, meanA, meanB };
  }
  const t = (meanB - meanA) / denom;
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  return { t, df, p: tTestPValue(t, df), meanA, meanB };
}

export type EffectMagnitude = 'negligible' | 'small' | 'medium' | 'large';

export interface CohensResult {
  /** Signed: positive means B is slower than A. */
  d: number;
  magnitude: EffectMagnitude;
}

/** Cohen's d with pooled standard deviation. */
export function cohensD(a: number[], b: number[]): CohensResult | null {
  if (a.length < 2 || b.length < 2) return null;
  const sa = variance(a);
  const sb = variance(b);
  const pooled = Math.sqrt(((a.length - 1) * sa + (b.length - 1) * sb) / (a.length + b.length - 2));
  const delta = mean(b) - mean(a);
  if (pooled === 0) {
    return { d: delta === 0 ? 0 : Math.sign(delta) * 3, magnitude: delta === 0 ? 'negligible' : 'large' };
  }
  const d = delta / pooled;
  const mag: EffectMagnitude = Math.abs(d) < 0.2 ? 'negligible' : Math.abs(d) < 0.5 ? 'small' : Math.abs(d) < 0.8 ? 'medium' : 'large';
  return { d, magnitude: mag };
}

export interface CusumOptions {
  /** Reference allowance, in standard deviations. 0.5 detects a 1σ shift. */
  k?: number;
  /** Decision threshold, in standard deviations. */
  h?: number;
  /** Samples used as the stable reference. */
  minSegment?: number;
}

export interface ChangePoint {
  /** Index of the first sample after the shift. */
  index: number;
  direction: 'up' | 'down';
  /** Peak cumulative sum when the alarm fired. */
  score: number;
  /** Reference mean and sd the shift was measured against. */
  referenceMean: number;
  referenceSd: number;
}

/**
 * Two-sided CUSUM change-point detector.
 *
 * Reference = the first `minSegment` samples; both an upward and a downward
 * accumulator run from there, and the first crossing wins. Returns `null` when
 * the series never crosses — which is the common, healthy case.
 */
export function cusumChangePoint(values: number[], opts: CusumOptions = {}): ChangePoint | null {
  const k = opts.k ?? 0.5;
  const h = opts.h ?? 5;
  const minSegment = Math.max(3, opts.minSegment ?? Math.min(20, Math.floor(values.length / 3) || 3));
  if (values.length < minSegment + 2) return null;

  const ref = values.slice(0, minSegment);
  const refMean = mean(ref);
  const refSd = Math.sqrt(variance(ref)) || 0;
  // A flat reference has no scale: fall back to 1 % of the level, so a shift in
  // a constant series is still detectable.
  const scale = refSd > 0 ? refSd : Math.max(1e-9, Math.abs(refMean) * 0.01);

  let up = 0;
  let down = 0;
  for (let i = minSegment; i < values.length; i++) {
    const z = (values[i] - refMean) / scale;
    up = Math.max(0, up + z - k);
    down = Math.max(0, down - z - k);
    if (up > h) return { index: i, direction: 'up', score: up, referenceMean: refMean, referenceSd: scale };
    if (down > h) return { index: i, direction: 'down', score: down, referenceMean: refMean, referenceSd: scale };
  }
  return null;
}

export type Verdict = 'regression' | 'improvement' | 'no-change' | 'insufficient-data';

export interface AttributionInput {
  /** Baseline samples (same unit, same operation). */
  before: number[];
  /** Current samples. */
  after: number[];
  /** Optional full series, used to locate the change point. */
  series?: number[];
}

export interface AttributionResult {
  verdict: Verdict;
  /** 0..1; capped at 0.99 because the samples are never truly independent. */
  confidence: number;
  /** Relative change of the means, e.g. +0.42 for 42 % slower. */
  relativeChange?: number;
  pValue?: number;
  t?: number;
  df?: number;
  effectSize?: number;
  magnitude?: EffectMagnitude;
  changePoint?: ChangePoint;
  /** Plain sentence for the UI; never the only thing shown. */
  summary: string;
}

const MIN_SAMPLES = 5;
/** p above this is not evidence of anything. */
const ALPHA = 0.05;
/** Below this the difference is too small to act on, whatever p says. */
const MIN_EFFECT = 0.2;

/**
 * Combine the three statistics into one verdict.
 *
 * The rule is intentionally conservative: a change is only called when it is
 * *significant* (p < 0.05), *material* (|d| ≥ 0.2) and *consistent in sign*.
 * With thousands of samples p is almost always tiny, so p alone would report a
 * regression on every run.
 */
export function attribute(input: AttributionInput): AttributionResult {
  const { before, after } = input;
  if (before.length < MIN_SAMPLES || after.length < MIN_SAMPLES) {
    return {
      verdict: 'insufficient-data',
      confidence: 0,
      summary: `need at least ${MIN_SAMPLES} samples per side (have ${before.length} / ${after.length})`,
    };
  }

  const welch = welchT(before, after);
  const cohen = cohensD(before, after);
  if (!welch || !cohen) {
    return { verdict: 'insufficient-data', confidence: 0, summary: 'not enough variance information' };
  }

  const changePoint = input.series && input.series.length >= MIN_SAMPLES * 2 ? cusumChangePoint(input.series) : null;
  const relativeChange = welch.meanA === 0 ? undefined : (welch.meanB - welch.meanA) / welch.meanA;
  const material = Math.abs(cohen.d) >= MIN_EFFECT;
  const significant = welch.p < ALPHA;
  const slower = welch.meanB > welch.meanA;

  // Confidence blends "how unlikely under the null" with "how big": a huge p
  // and a tiny effect is a shrug, a tiny p and a big effect is a finding.
  const significance = 1 - Math.min(1, welch.p);
  const weight = Math.min(1, Math.abs(cohen.d) / 1.2);
  const confidence = Math.min(0.99, significance * (0.55 + 0.45 * weight));

  const base = {
    confidence: round(confidence, 3),
    relativeChange: relativeChange === undefined ? undefined : round(relativeChange, 4),
    pValue: round(welch.p, 6),
    t: round(welch.t, 3),
    df: round(welch.df, 2),
    effectSize: round(cohen.d, 3),
    magnitude: cohen.magnitude,
    ...(changePoint ? { changePoint } : {}),
  };

  if (!significant || !material) {
    return {
      ...base,
      verdict: 'no-change',
      summary: `no material change (p=${fmt(welch.p)}, d=${fmt(cohen.d)})`,
    };
  }

  const pct = relativeChange === undefined ? '?' : `${(Math.abs(relativeChange) * 100).toFixed(1)}%`;
  return {
    ...base,
    verdict: slower ? 'regression' : 'improvement',
    summary: slower
      ? `${pct} slower (p=${fmt(welch.p)}, d=${fmt(cohen.d)}, ${cohen.magnitude})`
      : `${pct} faster (p=${fmt(welch.p)}, d=${fmt(cohen.d)}, ${cohen.magnitude})`,
  };
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  return Math.abs(v) < 0.001 ? v.toExponential(1) : v.toFixed(3);
}

function round(v: number, digits: number): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export type ProbeOutcome = 'good' | 'bad' | 'unknown';

export interface BisectResult<T> {
  /** First candidate that probes bad; `undefined` when none did. */
  suspect?: T;
  /** Candidates known to be good / bad at the end. */
  lastGood?: T;
  lastBad?: T;
  /** Probes performed, oldest first — the audit trail. */
  probes: Array<{ candidate: T; outcome: ProbeOutcome }>;
  /** True when an `unknown` forced a linear scan. */
  degraded: boolean;
}

/**
 * Binary-search the candidate list (oldest → newest) for the first bad one.
 *
 * Assumes monotonicity — once bad, stays bad — which is what a perf regression
 * across commits usually looks like. `unknown` (a commit that will not build)
 * is not guessed at: the search degrades to a linear walk from the last known
 * good commit, so the answer is still sound, just slower.
 */
export async function bisectSuspects<T>(
  candidates: T[],
  probe: (candidate: T) => Promise<ProbeOutcome>,
  opts: { maxProbes?: number } = {},
): Promise<BisectResult<T>> {
  const probes: Array<{ candidate: T; outcome: ProbeOutcome }> = [];
  const maxProbes = opts.maxProbes ?? 32;
  if (!candidates.length) return { probes, degraded: false };

  const record = async (i: number): Promise<ProbeOutcome> => {
    if (probes.length >= maxProbes) return 'unknown';
    const outcome = await probe(candidates[i]);
    probes.push({ candidate: candidates[i], outcome });
    return outcome;
  };

  // Find a bad end first: walk from the newest backwards until something is bad.
  let hi = candidates.length - 1;
  let badFound = false;
  for (let i = hi; i >= 0 && probes.length < maxProbes; i--) {
    const outcome = await record(i);
    if (outcome === 'bad') {
      hi = i;
      badFound = true;
      break;
    }
    if (outcome === 'good') break;
  }
  if (!badFound) return { probes, degraded: false };

  let lo = -1; // -1 means "before the first candidate", i.e. the baseline
  let degraded = false;
  while (hi - lo > 1 && probes.length < maxProbes) {
    const mid = Math.floor((lo + hi) / 2);
    const outcome = await record(mid);
    if (outcome === 'bad') hi = mid;
    else if (outcome === 'good') lo = mid;
    else {
      // Unknown: fall back to a linear scan from lo+1.
      degraded = true;
      let found = -1;
      for (let i = lo + 1; i < hi && probes.length < maxProbes; i++) {
        if ((await record(i)) === 'bad') {
          found = i;
          break;
        }
      }
      if (found !== -1) hi = found;
      break;
    }
  }

  return {
    suspect: candidates[hi],
    lastGood: lo >= 0 ? candidates[lo] : undefined,
    lastBad: candidates[hi],
    probes,
    degraded,
  };
}
