/**
 * How long a client may ask a single run to take.
 *
 * The `run` message accepts `timeoutMs` so the caller can bound a snippet —
 * that is what the `profile` message already did, and `WorkspaceService.run`
 * already honoured. The handler simply never forwarded it, so a client-supplied
 * timeout was silently replaced by the manifest default (15 s for Python). An
 * ignored parameter is worse than a missing one: the caller believes the run is
 * bounded and it is not.
 *
 * Two bounds, both learned from what `Number()` does to bad input:
 *
 *   - `Number('abc')` is `NaN`, and `setTimeout(NaN)` fires immediately — a
 *     typo would kill every run the instant it started.
 *   - `Number(-1)` / `0` also fire immediately, which reads as "this program
 *     crashed" rather than "you passed a silly timeout".
 *   - A huge value (a stray `1e9`) pins a worker for days.
 *
 * So an unusable value falls back to the manifest default (return `undefined`),
 * and a usable one is clamped into a range where it means something. Deliberately
 * pure: no process, no clock, so the unit tests can pin the edges.
 */

/** Below this, a run is being aborted before it could plausibly start. */
export const RUN_TIMEOUT_MIN_MS = 500;

/** Above this, a "timeout" stops protecting anything (10 minutes). */
export const RUN_TIMEOUT_MAX_MS = 10 * 60_000;

/**
 * Normalise a client-supplied run timeout.
 *
 * @param raw whatever arrived on the wire (`msg.timeoutMs`).
 * @returns a millisecond budget inside [MIN, MAX], or `undefined` to mean
 *          "not specified — use the language manifest's default".
 */
export function boundedRunTimeout(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  // `true`/`false` and arrays coerce to numbers in surprising ways; only a
  // number or a numeric string is a timeout.
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(RUN_TIMEOUT_MAX_MS, Math.max(RUN_TIMEOUT_MIN_MS, Math.round(n)));
}
