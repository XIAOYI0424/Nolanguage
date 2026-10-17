/**
 * ProfilerService — the façade for user-code profiling (Stage 10).
 *
 * Dispatches to the per-language adapter and registers the `profiler.*`
 * commands on the kernel command bus, so the IDE (WS) and, later, the AI MCP
 * tools can profile a snippet the same way.
 */
import type { Kernel } from '../kernel/Kernel.js';
import { PythonProfiler } from './PythonProfiler.js';
import { GoProfiler } from './GoProfiler.js';
import type { ProfileOptions, ProfileResult, ProfilerLanguage } from './types.js';

export class ProfilerService {
  readonly python: PythonProfiler;
  readonly go: GoProfiler;
  /**
   * Adapters by language id.
   *
   * The profiler is the last component still keyed by language name: each
   * adapter wraps a *tool* (cProfile, pprof), and which tool applies is exactly
   * what a manifest will declare in Phase 6 (`profiler.adapter`). Until then
   * this map is the single place that knows the set, so callers ask
   * `supports()` instead of comparing ids themselves.
   */
  private readonly adapters: Record<ProfilerLanguage, { profile(o: ProfileOptions): Promise<ProfileResult> }>;

  constructor(private kernel: Kernel, opts: { pythonBin?: string; goBin?: string } = {}) {
    this.python = new PythonProfiler(kernel, opts.pythonBin);
    this.go = new GoProfiler(kernel, opts.goBin);
    this.adapters = { python: this.python, go: this.go };
  }

  /** Languages with a profiling adapter. */
  languages(): ProfilerLanguage[] {
    return Object.keys(this.adapters) as ProfilerLanguage[];
  }

  /** True when this façade can profile the language. */
  supports(languageId: string): languageId is ProfilerLanguage {
    return Object.prototype.hasOwnProperty.call(this.adapters, languageId);
  }

  /** Language to assume when the caller did not name a usable one. */
  defaultLanguage(): ProfilerLanguage {
    return this.languages()[0] ?? 'python';
  }

  profile(opts: ProfileOptions): Promise<ProfileResult> {
    const adapter = this.adapters[opts.languageId] ?? this.python;
    return adapter.profile(opts);
  }

  registerCommands(): void {
    const c = this.kernel.commands;
    c.register('profiler.profile', (opts: ProfileOptions) => this.profile(opts), {
      title: 'Profile a code snippet (user-code hotspots)',
      category: 'profiler',
    });
    c.register(
      'profiler.python',
      (code: string, opts?: { timeoutMs?: number; topN?: number }) =>
        this.profile({ languageId: 'python', code, ...(opts ?? {}) }),
      { title: 'Profile Python code', category: 'profiler' },
    );
    c.register(
      'profiler.go',
      (code: string, opts?: { timeoutMs?: number; topN?: number }) =>
        this.profile({ languageId: 'go', code, ...(opts ?? {}) }),
      { title: 'Profile Go code', category: 'profiler' },
    );
  }
}
