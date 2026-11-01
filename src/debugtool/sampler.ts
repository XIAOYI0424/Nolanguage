/**
 * Turn a stream of stack samples into something a human can read.
 *
 * A 10 Hz sampler produces 600 stacks a minute; drawing them raw is noise. Two
 * derived views cover the questions people actually ask:
 *
 *   foldStacks()    "what is the program doing, ranked?"  — share per stack
 *   detectStalls()  "when did it stop making progress?"   — runs of one stack
 *
 * Both are pure and time-ordered, so they can be tested without a process and
 * recomputed on the client when the page scrolls back in time.
 *
 * The identity of a stack is its **function-name path** (`main>work>step`), not
 * file/line: line numbers move between runs of the same code, and two different
 * lines in one function are the same "place" for the purpose of "where is the
 * time going". File/line are kept on the representative frames for display.
 */
import type { Frame, ThreadState } from './protocol.js';

export interface StackSample {
  at: number;
  tid: number;
  state: ThreadState;
  frames: Frame[];
}

export interface HotStack {
  /** `main>work>step` — also the grouping key. */
  stack: string;
  /** Frames of the most recent sample in this group, for display. */
  frames: Frame[];
  hits: number;
  /** hits / total samples, 0..1. */
  share: number;
  lastAt: number;
  state: ThreadState;
  /** Longest consecutive run of this stack reached the stall threshold. */
  stalled: boolean;
  /** That longest run, in samples (0 when never consecutive). */
  run: number;
}

export interface FoldOptions {
  /** Consecutive samples of one stack that count as a stall (default 5 = 0.5 s at 10 Hz). */
  stallSamples?: number;
  /** Cap on returned groups, hottest first (default 40). */
  maxStacks?: number;
}

/** `main>work>step` for the outermost→innermost path. */
export function stackKey(frames: Frame[]): string {
  if (!frames.length) return '(no stack)';
  return frames.map((f) => f.fn || '?').join('>');
}

/**
 * Group samples by stack, hottest first.
 *
 * `share` is over *all* samples, so a stack at 42 % really is 42 % of the
 * observed wall-clock samples — that is the number a user compares against the
 * flame graph, and it must not be computed over the returned subset.
 */
export function foldStacks(samples: StackSample[], opts: FoldOptions = {}): HotStack[] {
  const stallSamples = Math.max(2, opts.stallSamples ?? 5);
  const maxStacks = Math.max(1, opts.maxStacks ?? 40);
  if (!samples.length) return [];

  const groups = new Map<string, { frames: Frame[]; hits: number; lastAt: number; state: ThreadState }>();
  const runs = new Map<string, { current: number; best: number; prev: string }>();
  let prevKey = '';

  for (const s of samples) {
    const key = stackKey(s.frames);
    const g = groups.get(key);
    if (g) {
      g.hits++;
      if (s.at >= g.lastAt) {
        g.lastAt = s.at;
        g.frames = s.frames;
        g.state = s.state;
      }
    } else {
      groups.set(key, { frames: s.frames, hits: 1, lastAt: s.at, state: s.state });
    }

    // Consecutive-run tracking, per key, in time order.
    const r = runs.get(key) ?? { current: 0, best: 0, prev: '' };
    r.current = key === prevKey ? r.current + 1 : 1;
    if (r.current > r.best) r.best = r.current;
    runs.set(key, r);
    prevKey = key;
  }

  const total = samples.length;
  const out: HotStack[] = [];
  for (const [stack, g] of groups) {
    const best = runs.get(stack)?.best ?? 0;
    out.push({
      stack,
      frames: g.frames,
      hits: g.hits,
      share: g.hits / total,
      lastAt: g.lastAt,
      state: g.state,
      stalled: best >= stallSamples,
      run: best,
    });
  }
  out.sort((a, b) => (b.hits === a.hits ? b.lastAt - a.lastAt : b.hits - a.hits));
  return out.slice(0, maxStacks);
}

export interface Stall {
  stack: string;
  from: number;
  to: number;
  /** Wall-clock length of the run, in ms (0 when samples share a timestamp). */
  durationMs: number;
  samples: number;
  frames: Frame[];
}

/**
 * Runs of one stack long enough to mean "blocked or spinning".
 *
 * Deliberately separate from `foldStacks().stalled`: a stack can be hot overall
 * (many samples spread over a minute) without ever being stuck, and a stall can
 * happen in a stack that is otherwise cold. Conflating them would make both
 * signals lie.
 */
export function detectStalls(samples: StackSample[], stallSamples = 5): Stall[] {
  const threshold = Math.max(2, stallSamples);
  const out: Stall[] = [];
  if (!samples.length) return out;

  let runKey = stackKey(samples[0].frames);
  let runStart = 0;

  const flush = (endExclusive: number): void => {
    const count = endExclusive - runStart;
    if (count >= threshold) {
      const from = samples[runStart].at;
      const to = samples[endExclusive - 1].at;
      out.push({
        stack: runKey,
        from,
        to,
        durationMs: Math.max(0, to - from),
        samples: count,
        frames: samples[endExclusive - 1].frames,
      });
    }
  };

  for (let i = 1; i < samples.length; i++) {
    const key = stackKey(samples[i].frames);
    if (key !== runKey) {
      flush(i);
      runKey = key;
      runStart = i;
    }
  }
  flush(samples.length);
  return out;
}

/** Samples per second, from timestamps — used to show the real rate, not the requested one. */
export function effectiveHz(samples: StackSample[]): number {
  if (samples.length < 2) return 0;
  const span = samples[samples.length - 1].at - samples[0].at;
  if (span <= 0) return 0;
  return ((samples.length - 1) * 1000) / span;
}
