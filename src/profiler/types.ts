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

export interface ProfileResult {
  languageId: ProfilerLanguage;
  /** Which backend produced the samples. */
  source: 'cProfile' | 'pprof';
  /** Wall-clock time of the profiled run, ms. */
  wallMs: number;
  /** Total functions observed (before topN clipping). */
  sampleCount: number;
  hotspots: ProfileHotspot[];
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
