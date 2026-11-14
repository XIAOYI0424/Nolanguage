/**
 * How many records one `log` digest frame may carry.
 *
 * The panel forwards logs in frames rather than per record — a TRACE-heavy
 * second would otherwise be thousands of tiny WebSocket messages. The frame is
 * capped so one burst cannot stall the socket.
 *
 * The cap used to be applied by silently slicing the tail and advancing the
 * cursor past the rest, which meant a burst **permanently deleted** records with
 * no trace anywhere: the panel just showed a gap. That is how a test lost the
 * record it was looking for while every count still looked plausible. The cap is
 * fine; losing records quietly is not. `sliceDigest` reports the number it had
 * to leave out, and the panel renders that as a visible marker.
 */
export const LOG_DIGEST_MAX = 300;

export interface LogDigest<T> {
  /** The newest `max` records — the ones worth showing. */
  records: T[];
  /** How many older records in this burst were left out. */
  dropped: number;
}

/**
 * Take at most `max` records from the end of a burst.
 *
 * Newest-first, because a log panel is read backwards: the most recent lines are
 * the ones that explain what just happened. The count of what was skipped is
 * returned rather than discarded.
 */
export function sliceDigest<T>(fresh: readonly T[], max: number = LOG_DIGEST_MAX): LogDigest<T> {
  if (max <= 0) return { records: [], dropped: fresh.length };
  if (fresh.length <= max) return { records: [...fresh], dropped: 0 };
  return { records: fresh.slice(fresh.length - max), dropped: fresh.length - max };
}
