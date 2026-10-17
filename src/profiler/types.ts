/**
 * Profiler adapter (Stage 10 · 用户代码性能).
 *
 * The `/perf` page already measures the *platform* (kernel latency, RPC, LSP).
 * This module measures the *user's code* — the missing half of "性能监测".
 *
 * Zero-dependency, offline:
 *   - Python → stdlib `cProfile` + `pstats` (no py-spy needed; py-spy is only
 *     an optional accelerator).
 *   - Go     → `runtime/pprof` CPU profile + `go tool pprof -top` text parse.
 *
 * Both adapters return a normalised hotspot list so the UI (and, later, the
 * attribution engine in stage 11) can treat languages uniformly.
 */

/**
 * Language id as seen by the profiler.
 *
 * This used to be a union (`'python' | 'go'`), which forced every caller to
 * know the language set — the exact coupling Phase 6 removed. It is a string
 * now: `ProfilerService` validates it against the manifests at call time and
 * fails loudly, which is both more correct and more extensible than a union.
 */
export type ProfilerLanguage = string;

export interface ProfileOptions {
  languageId: ProfilerLanguage;
  code: string;
  /** Hard timeout in ms (covers build + run for Go). */
  timeoutMs?: number;
  /** How many hotspots to keep (sorted by cumulative time). */
  topN?: number;
}

export interface ProfileHotspot {
  /** Function name as the runtime reports it. */
  name: string;
  /** Source file (may be `<profile>` for a snippet). */
  file: string;
  /** 1-based line, 0 when unknown. */
  line: number;
  /** Number of calls (primitive + recursive). */
  calls: number;
  /** Time spent in the function body (excludes callees), ms. */
  tottimeMs: number;
  /** Time spent in the function including callees, ms. */
  cumtimeMs: number;
}

/**
 * A node in the call tree, used to render a flamegraph.
 *
 * `selfMs` is the time spent in the function body only (excludes callees);
 * `totalMs` is the time including callees. A frame's `totalMs` is the width of
 * its flamegraph rectangle; the `children` widths sum to (at most) it. The
 * tree is built by the adapters (Python from cProfile's caller graph, Go from
 * a synthesised root over the flat `-top` rows) and normalised into this shape
 * so the UI treats every language identically.
 */
export interface ProfileFrame {
  name: string;
  file: string;
  line: number;
  selfMs: number;
  totalMs: number;
  calls: number;
  children: ProfileFrame[];
}

export interface ProfileResult {
  languageId: ProfilerLanguage;
  /** Which backend produced the samples. */
  source: 'cProfile' | 'pprof';
  /** Wall-clock time of the profiled run, ms. */
  wallMs: number;
  /** Total functions observed (before topN clipping). */
  sampleCount: number;
  hotspots: ProfileHotspot[];
  /**
   * Call tree for flamegraph rendering (may be empty when the adapter cannot
   * derive a hierarchy — e.g. a flat summary). Always append-only for the UI:
   * a missing tree just hides the graph and keeps the hotspots table.
   */
  flame?: ProfileFrame[];
  /** Captured program output. */
  stdout: string;
  stderr: string;
  ok: boolean;
  error?: string | null;
  binary: string;
  /** True when the profiler itself could not run (missing toolchain etc.). */
  skipped?: boolean;
  /** Why it was skipped. */
  skipReason?: string;
}
