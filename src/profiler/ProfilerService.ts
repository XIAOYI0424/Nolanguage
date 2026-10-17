/**
 * ProfilerService — the façade for user-code profiling (Stage 10).
 *
 * **Phase 6 made this language-agnostic.** It used to carry a
 * `languageId === 'go'` dispatch and two convenience commands named after the
 * only two languages that happened to have adapters. Now:
 *
 *   - a plugin declares which *tool* to use (`profiler.adapter: "cProfile"`);
 *   - the platform registers the tools it can build (`adapters.ts`);
 *   - this class resolves one against the other and fails loudly otherwise.
 *
 * Adding Rust + `perf` means a manifest line and one registered adapter — no
 * change here, and no language-id `if` anywhere in it.
 */
import type { Kernel } from '../kernel/Kernel.js';
import type { LanguageManifest } from '../langs/manifest.js';
import { PythonProfiler } from './PythonProfiler.js';
import { GoProfiler } from './GoProfiler.js';
import {
  defaultProfilerAdapters,
  ProfilerAdapterNotFoundError,
  type ProfilerAdapter,
  type ProfilerAdapterRegistry,
} from './adapters.js';
import type { ProfileOptions, ProfileResult } from './types.js';

export interface ProfilerServiceOptions {
  /** Binary overrides for the shipped adapters (tests, odd toolchains). */
  pythonBin?: string;
  goBin?: string;
  /**
   * Where the language list comes from. The workspace injects itself so the
   * profiler reads manifests rather than being told about languages.
   */
  languages?: () => LanguageManifest[];
}

export class ProfilerService {
  /** The tool registry; a host may register its own adapters on it. */
  readonly adapters: ProfilerAdapterRegistry;
  private manifests: () => LanguageManifest[];

  constructor(private kernel: Kernel, opts: ProfilerServiceOptions = {}) {
    this.adapters = defaultProfilerAdapters(kernel);
    // Re-register with the caller's overrides; an unoverridden build is the one
    // `defaultProfilerAdapters` already made.
    if (opts.pythonBin) {
      this.adapters.register('cProfile', () => pythonAdapter(kernel, opts.pythonBin));
    }
    if (opts.goBin) {
      this.adapters.register('pprof', () => goAdapter(kernel, opts.goBin));
    }
    this.manifests = opts.languages ?? (() => []);
  }

  /** Point the profiler at a language list (the host calls this after init). */
  bindLanguages(list: () => LanguageManifest[]): void {
    this.manifests = list;
  }

  /** Every language that declares a profiler, in manifest order. */
  languages(): LanguageManifest[] {
    return this.manifests()
      .filter((m) => !!m.profiler)
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  }

  /** True when this language has both a declaration and a registered adapter. */
  supports(languageId: string): boolean {
    const m = this.manifestFor(languageId);
    return !!m?.profiler && this.adapters.has(m.profiler.adapter);
  }

  /** The language to assume when the caller did not name a usable one. */
  defaultLanguage(): string {
    return this.languages()[0]?.id ?? '';
  }

  /** The adapter a language resolves to, or `undefined` when it cannot. */
  adapterFor(languageId: string): ProfilerAdapter | undefined {
    const m = this.manifestFor(languageId);
    if (!m?.profiler) return undefined;
    try {
      return this.adapters.get(m.profiler.adapter);
    } catch (err) {
      if (err instanceof ProfilerAdapterNotFoundError) return undefined;
      throw err;
    }
  }

  private manifestFor(languageId: string): LanguageManifest | undefined {
    return this.manifests().find((m) => m.id === languageId);
  }

  /**
   * Profile a snippet.
   *
   * Three distinct failures, all loud: the language is not a plugin, the plugin
   * declares no profiler, or the adapter it names is not registered. None of
   * them silently falls back to another language's profiler — a benchmark
   * measured with the wrong tool is worse than no benchmark.
   */
  async profile(opts: ProfileOptions): Promise<ProfileResult> {
    const m = this.manifestFor(opts.languageId);
    if (!m) throw new Error(`profiler: "${opts.languageId}" is not a language plugin`);
    if (!m.profiler) throw new Error(`profiler: "${opts.languageId}" declares no profiler in its manifest`);
    const adapter = this.adapters.get(m.profiler.adapter);
    return adapter.profile(opts);
  }

  /**
   * Register the command-bus surface: `profiler.profile` plus one
   * `profiler.<languageId>` per language that declares a profiler. The
   * per-language commands are *discovered from the manifests*, not a hardcoded
   * pair of names.
   */
  registerCommands(languages?: LanguageManifest[]): void {
    const c = this.kernel.commands;
    c.register('profiler.profile', (opts: ProfileOptions) => this.profile(opts), {
      title: 'Profile a code snippet (user-code hotspots)',
      category: 'profiler',
    });
    const list = (languages ?? this.languages()).filter((m) => m.profiler && this.adapters.has(m.profiler.adapter));
    for (const m of list) {
      const id = m.id;
      const adapterId = m.profiler!.adapter;
      c.register(
        `profiler.${id}`,
        (code: string, opts?: { timeoutMs?: number; topN?: number }) =>
          this.profile({ languageId: id, code, ...(opts ?? {}) }),
        { title: `Profile ${m.displayName} code (${adapterId})`, category: 'profiler' },
      );
    }
  }

  /** One line per language, for logs and `/health`. */
  describe(): Array<{ languageId: string; adapter: string; available: boolean; binary: string }> {
    return this.languages().map((m) => {
      const a = this.adapterFor(m.id);
      return { languageId: m.id, adapter: m.profiler!.adapter, available: a?.available ?? false, binary: a?.binary ?? '' };
    });
  }
}

function pythonAdapter(kernel: Kernel, pythonBin: string | undefined): ProfilerAdapter {
  const p = new PythonProfiler(kernel, pythonBin);
  return { id: 'cProfile', displayName: 'Python cProfile', available: p.available, binary: p.binary, profile: (o) => p.profile(o) };
}

function goAdapter(kernel: Kernel, goBin: string | undefined): ProfilerAdapter {
  const g = new GoProfiler(kernel, goBin);
  return { id: 'pprof', displayName: 'Go runtime/pprof', available: g.available, binary: g.binary, profile: (o) => g.profile(o) };
}
