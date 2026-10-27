/**
 * Stage 11 — attribution engine.
 *
 * The statistics are the product here, so the suite pins known values rather
 * than "it ran": t-distribution p-values against textbook figures, effect-size
 * bands at their boundaries, a CUSUM that must fire on a step and stay silent
 * on a flat line, and a bisect whose probe count must stay logarithmic.
 */
import {
  attribute,
  bisectSuspects,
  cohensD,
  cusumChangePoint,
  tTestPValue,
  welchT,
  type ProbeOutcome,
} from '../src/perf/Attribution.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- t distribution

check('t: t=0 gives p=1', near(tTestPValue(0, 10), 1, 1e-9), String(tTestPValue(0, 10)));
check('t: t=2, df=10 is p≈0.0734', near(tTestPValue(2, 10), 0.0734, 0.002), tTestPValue(2, 10).toFixed(4));
check('t: t=3.169, df=10 is p≈0.01', near(tTestPValue(3.169, 10), 0.01, 0.001), tTestPValue(3.169, 10).toFixed(4));
check('t: t=1.96, df=1e6 is p≈0.05', near(tTestPValue(1.96, 1_000_000), 0.05, 0.001), tTestPValue(1.96, 1e6).toFixed(4));
check('t: p is symmetric in sign', near(tTestPValue(-2, 10), tTestPValue(2, 10), 1e-12));
check('t: degenerate df yields p=1', tTestPValue(2, 0) === 1);

// ---------------------------------------------------------------- welch

const flat = [100, 100, 100, 100, 100];
const shifted = [150, 152, 148, 151, 149];
const welch = welchT(flat, shifted);
check('welch: returns means', !!welch && near(welch.meanA, 100, 1e-9) && near(welch.meanB, 150, 1e-9));
check('welch: a real shift is significant', !!welch && welch.p < 0.01, String(welch?.p.toExponential(2)));
check('welch: t is positive when B is larger', !!welch && welch.t > 0);
check('welch: identical samples give t=0, p=1', (() => {
  const r = welchT(flat, flat);
  return !!r && r.t === 0 && r.p === 1;
})());
check('welch: too few samples return null', welchT([1], [2, 3]) === null);

// ---------------------------------------------------------------- cohen

check('cohen: identical samples are negligible', cohensD(flat, flat)?.magnitude === 'negligible');
const small = cohensD([10, 12, 14, 16, 18], [11, 13, 15, 17, 19]);
check('cohen: d is signed (positive = slower)', !!small && small.d > 0, String(small?.d.toFixed(3)));
const big = cohensD([100, 101, 99, 100, 101], [200, 201, 199, 200, 201]);
check('cohen: a doubling is a large effect', big?.magnitude === 'large', String(big?.d.toFixed(2)));
check('cohen: zero variance still yields a sign', cohensD([1, 1, 1], [2, 2, 2])?.d === 3);
check('cohen: too few samples return null', cohensD([1], [2]) === null);

// ---------------------------------------------------------------- cusum

const step = [...Array(10).fill(100), ...Array(10).fill(200)];
const up = cusumChangePoint(step);
check('cusum: fires on an upward step', !!up && up.direction === 'up', JSON.stringify(up && { i: up.index, d: up.direction }));
check('cusum: locates the step', !!up && up.index >= 10 && up.index <= 11, String(up?.index));
const downStep = [...Array(10).fill(200), ...Array(10).fill(100)];
const down = cusumChangePoint(downStep);
check('cusum: fires on a downward step', !!down && down.direction === 'down', JSON.stringify(down && { i: down.index, d: down.direction }));
check('cusum: a flat series never fires', cusumChangePoint(Array(40).fill(42)) === null);
check('cusum: a noisy stationary series stays silent', (() => {
  // Deterministic pseudo-noise around a constant level.
  const noise = Array.from({ length: 60 }, (_, i) => 100 + 6 * Math.sin(i * 1.7) + 3 * Math.cos(i * 0.9));
  return cusumChangePoint(noise) === null;
})());
check('cusum: a short series returns null', cusumChangePoint([1, 2, 3]) === null);

// ---------------------------------------------------------------- attribute

const before = Array.from({ length: 24 }, (_, i) => 100 + 4 * Math.sin(i));
const after = Array.from({ length: 24 }, (_, i) => 160 + 4 * Math.sin(i));
const reg = attribute({ before, after, series: [...before, ...after] });
check('attribute: slower + significant -> regression', reg.verdict === 'regression', reg.summary);
check('attribute: regression is a large effect', reg.magnitude === 'large', String(reg.effectSize));
check('attribute: confidence is high but capped', reg.confidence > 0.9 && reg.confidence < 1, String(reg.confidence));
check('attribute: relative change is reported', !!reg.relativeChange && near(reg.relativeChange, 0.6, 0.05), String(reg.relativeChange));
check('attribute: a change point is included', !!reg.changePoint && reg.changePoint.direction === 'up');

const imp = attribute({ before: after, after: before });
check('attribute: faster -> improvement', imp.verdict === 'improvement', imp.summary);

const same = attribute({ before, after: before.map((v, i) => v + (i % 2 ? 1 : -1)) });
check('attribute: noise only -> no-change', same.verdict === 'no-change', same.summary);

check(
  'attribute: four samples are not enough',
  attribute({ before: [1, 2, 3, 4], after: [9, 9, 9, 9] }).verdict === 'insufficient-data',
);
check('attribute: summary is human readable', /slower|faster|no material change|need at least/.test(reg.summary + same.summary));

// ---------------------------------------------------------------- bisect

const commits = Array.from({ length: 16 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);
const badFrom = 11; // c11 is the first bad commit
const probes: string[] = [];
const found = await bisectSuspects(commits, async (c) => {
  probes.push(c);
  return Number(c.slice(1)) >= badFrom ? 'bad' : 'good';
});
check('bisect: finds the first bad commit', found.suspect === 'c11', String(found.suspect));
check('bisect: last good is the one before', found.lastGood === 'c10', String(found.lastGood));
check('bisect: probe count stays logarithmic', probes.length <= 6, `${probes.length} probes: ${probes.join(',')}`);

const noneBad = await bisectSuspects(commits, async () => 'good' as ProbeOutcome);
check('bisect: all good -> no suspect', noneBad.suspect === undefined);

const unknownProbes: string[] = [];
const degraded = await bisectSuspects(commits, async (c) => {
  unknownProbes.push(c);
  if (c === 'c10') return 'unknown';
  return Number(c.slice(1)) >= badFrom ? 'bad' : 'good';
});
check('bisect: an unbuildable commit is flagged, not guessed', degraded.degraded === true, JSON.stringify(unknownProbes));
check('bisect: the answer survives an unknown', degraded.suspect === 'c11', String(degraded.suspect));

const empty = await bisectSuspects([], async () => 'bad' as ProbeOutcome);
check('bisect: empty input is safe', empty.suspect === undefined && empty.probes.length === 0);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
