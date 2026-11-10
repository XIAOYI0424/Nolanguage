/**
 * Stage 11 — attribute a metric's shift to a point in time.
 *
 * Samples come from the hot perf ring (the same records the Performance tab
 * shows), so the answer is about *this* session, not a stored baseline.
 */
import type { Kernel } from '../../kernel/Kernel.js';
import { attribute } from '../../perf/Attribution.js';

/**
 * Stage 11 — attribute a metric's shift to a point in time.
 *
 * Samples come from the hot perf ring (the same records the Performance tab
 * shows), so the answer is about *this* session, not a stored baseline. The
 * split defaults to the midpoint of the window; `splitAt` pins it to a moment
 * (a deploy, a commit checkout).
 */
export function handleAttribute(
  kernel: Kernel,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): void {
  const metric = String(msg.metric ?? '');
  const values: number[] = [];
  const times: number[] = [];
  for (const r of kernel.recentPerf(5000)) {
    const v =
      r.type === 'metric'
        ? r.name === metric
          ? r.value
          : undefined
        : r.type === 'sample'
          ? r.profileType === metric
            ? r.value
            : undefined
          : r.name === metric
            ? r.duration
            : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) {
      values.push(v);
      times.push(r.timestamp);
    }
  }

  const splitAt = Number(msg.splitAt);
  let cut = Number.isFinite(splitAt) && splitAt > 0 ? times.findIndex((t) => t >= splitAt) : Math.floor(values.length / 2);
  if (cut <= 0 || cut >= values.length) cut = Math.floor(values.length / 2);

  const result = attribute({
    before: values.slice(0, cut),
    after: values.slice(cut),
    series: values,
  });
  reply({ kind: 'attribution', metric, ...result, samples: { before: cut, after: values.length - cut } });
}
