/**
 * Profiler adapters — the registry Phase 6 was waiting for.
 *
 * A plugin declares *which tool* to use (`profiler.adapter: "cProfile"`), not
 * how to use it: the tool is a capability the platform registers, the way
 * `runtimes/` registers five run capabilities. That is what keeps the profiler
 * out of the language-id business — `ProfilerService` no longer has a
 * `languageId === 'go'` branch anywhere, and a Rust plugin that wants
 * `perf`/`valgrind` gets it by writing one line in its manifest.
 *
 * An unknown adapter id is a loud failure, never a silent fallback to Python:
 * a profiled benchmark with the wrong profiler is worse than no benchmark.
 */
import type { Kernel } from '../kernel/Kernel.js';
import { PythonProfiler } from './PythonProfiler.js';
import { GoProfiler } from './GoProfiler.js';
import type { ProfileOptions, ProfileResult } from './types.js';

/** What every adapter must expose. */
export interface ProfilerAdapter {
  id: string;
  /** Human label for the UI (`cProfile`, `Go pprof`). */
  displayName: string;
  /** True when the toolchain the adapter needs is available. */
  available: boolean;
  /** Path the adapter will run, for `status()`. */
  binary: string;
  profile(options: ProfileOptions): Promise<ProfileResult>;
}

export interface AdapterFactoryOptions {
  kernel: Kernel;
  pythonBin?: string;
  goBin?: string;
}

export type AdapterFactory = (opts: AdapterFactoryOptions) => ProfilerAdapter;

export class ProfilerAdapterNotFoundError extends Error {
  constructor(
    readonly adapterId: string,
    readonly languageId: string,
  ) {
    super(
      `no profiler adapter registered for "${adapterId}" (required by language "${languageId}"); ` +
        `register it with ProfilerAdapterRegistry.register("${adapterId}", …) or fix the manifest`,
    );
    this.name = 'ProfilerAdapterNotFoundError';
  }
}

export class ProfilerAdapterRegistry {
  private factories = new Map<string, AdapterFactory>();
  private built = new Map<string, ProfilerAdapter>();

  constructor(private opts: AdapterFactoryOptions = { kernel: undefined as unknown as Kernel }) {}

  register(id: string, factory: AdapterFactory): void {
    this.factories.set(id, factory);
    this.built.delete(id); // A re-registration must replace the cached adapter.
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  /** Ids the substrate knows how to build (the official ones first). */
  list(): string[] {
    return [...this.factories.keys()].sort();
  }

  /** Build (or reuse) an adapter. Throws for an unknown id. */
  get(id: string): ProfilerAdapter {
    const cached = this.built.get(id);
    if (cached) return cached;
    const factory = this.factories.get(id);
    if (!factory) throw new ProfilerAdapterNotFoundError(id, '?');
    const adapter = factory(this.opts);
    this.built.set(id, adapter);
    return adapter;
  }
}

/** The adapters the platform ships. Everything else is a plugin's problem. */
export function defaultProfilerAdapters(kernel: Kernel): ProfilerAdapterRegistry {
  const registry = new ProfilerAdapterRegistry({ kernel });
  registry.register('cProfile', ({ kernel: k, pythonBin }) => {
    const p = new PythonProfiler(k, pythonBin);
    return {
      id: 'cProfile',
      displayName: 'Python cProfile',
      available: p.available,
      binary: p.binary,
      profile: (o) => p.profile(o),
    };
  });
  registry.register('pprof', ({ kernel: k, goBin }) => {
    const g = new GoProfiler(k, goBin);
    return {
      id: 'pprof',
      displayName: 'Go runtime/pprof',
      available: g.available,
      binary: g.binary,
      profile: (o) => g.profile(o),
    };
  });
  return registry;
}
