/**
 * Request scheduling: latest-only for position-sensitive requests, dedupe for
 * identical in-flight ones.
 *
 * ## Why latest-only
 *
 * Completion is asked for on every keystroke. A server that answers in 300 ms
 * will be answering the *second* character while the user is on the fifth, and
 * whichever answer arrives last wins — so a fast reply to an old request
 * overwrites a slow reply to a new one. Two mechanisms fix that, and both are
 * needed:
 *
 * 1. **Cancellation** — tell the server to stop (`$/cancelRequest`), so it does
 *    not spend CPU on an answer nobody wants.
 * 2. **A monotonic sequence per key** — even a cancelled request may answer, and
 *    an answer to sequence N must never overwrite sequence N+1.
 *
 * Lifecycle requests are *not* routed through here: cancelling `shutdown` or
 * `initialize` because the user typed is a protocol violation, not an
 * optimisation. Only the position-sensitive requests use `latest`.
 */

export interface LatestOutcome<T> {
  value?: T;
  /** A newer request for the same key started before this one finished. */
  stale: boolean;
  /** This request was cancelled in flight (`$/cancelRequest` was sent). */
  cancelled: boolean;
}

interface Current {
  seq: number;
  /** Cancels the in-flight request, once its id is known. */
  cancel: () => void;
}

export class Scheduler {
  private seq = new Map<string, number>();
  private current = new Map<string, Current>();
  private inflight = new Map<string, Promise<unknown>>();
  private counters = { cancelled: 0, deduped: 0, staleDropped: 0 };

  /**
   * @param cancelRequest forwards `$/cancelRequest` for an id. Returns false when
   *   the request already answered, which is not an error.
   */
  constructor(private cancelRequest: (id: number) => boolean = () => false) {}

  /**
   * Run `run`, superseding any request already in flight for `key`.
   *
   * `run` receives a hook that reports the request id as soon as the transport
   * assigns it — that is the only moment a cancellation can be aimed at.
   */
  async latest<T>(key: string, run: (onId: (id: number) => void) => Promise<T>): Promise<LatestOutcome<T>> {
    const n = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, n);

    const previous = this.current.get(key);
    if (previous) {
      previous.cancel();
      this.counters.cancelled++;
    }

    let requestId: number | undefined;
    const entry: Current = {
      seq: n,
      cancel: () => {
        if (requestId === undefined) return;
        this.cancelRequest(requestId);
      },
    };
    this.current.set(key, entry);

    try {
      const value = await run((id) => {
        requestId = id;
      });
      if ((this.seq.get(key) ?? 0) !== n) {
        this.counters.staleDropped++;
        return { value, stale: true, cancelled: true };
      }
      return { value, stale: false, cancelled: false };
    } catch (err) {
      // A superseded request usually fails with `-32800` (RequestCancelled).
      // That is the expected outcome of superseding it, not an error to report.
      if ((this.seq.get(key) ?? 0) !== n) {
        this.counters.staleDropped++;
        return { stale: true, cancelled: true };
      }
      if (isCancellation(err)) return { stale: true, cancelled: true };
      throw err;
    } finally {
      if (this.current.get(key) === entry) this.current.delete(key);
    }
  }

  /**
   * Coalesce identical concurrent requests.
   *
   * Two tabs asking for the same completion, or a UI that re-renders while a
   * request is in flight, should cost one round trip — not two.
   */
  dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) {
      this.counters.deduped++;
      return existing;
    }
    const p = run().finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  stats(): { cancelled: number; deduped: number; staleDropped: number; inflight: number } {
    return { ...this.counters, inflight: this.current.size };
  }
}

/** JSON-RPC `RequestCancelled`, the code LSP mandates for `$/cancelRequest`. */
export const REQUEST_CANCELLED = -32800;

function isCancellation(err: unknown): boolean {
  const code = (err as { rpcCode?: number } | null)?.rpcCode;
  return code === REQUEST_CANCELLED;
}
