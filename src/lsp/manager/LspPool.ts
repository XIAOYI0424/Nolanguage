/**
 * One server per (plugin, project root), and never two for the same tree.
 *
 * ## Root convergence
 *
 * A Maven reactor has `pom.xml` at the root and modules below it. If each module
 * got its own jdtls, a five-module project would spawn five JVMs at ~400 MB each
 * — the exact failure the spec calls "process explosion". So when a new root is
 * *inside* an existing root, the existing client is reused: jdtls already has
 * the module imported, because it imported the reactor.
 *
 * The reverse is not true. A client rooted at `module-a` knows nothing about the
 * parent, so a request for the parent must get a new client.
 *
 * ## Why `acquire` is synchronous
 *
 * Starting a server takes seconds; deciding *which* server is a map lookup. Doing
 * the lookup synchronously means there is no window in which two requests can
 * both decide to spawn, and no lock is needed at all — Node's single thread is
 * the lock. The spawn itself is fire-and-forget (`ManagedLsp.ready()`), so two
 * languages cold-start in parallel and neither blocks the other.
 */
import { resolve as resolvePath, sep } from 'node:path';
import type { Kernel } from '../../kernel/Kernel.js';
import type { CacheValidator } from './CacheValidator.js';
import type { DiagnosticsBuffer } from './DiagnosticsBuffer.js';
import { ManagedLsp } from './ManagedLsp.js';
import type { Scheduler } from './Scheduler.js';
import { poolKey, type LanguagePlugin } from './types.js';

/** Path containment, case-insensitive on Windows (NTFS is). */
export function containsRoot(parent: string, child: string): boolean {
  const norm = (p: string): string => {
    const r = resolvePath(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const p = norm(parent);
  const c = norm(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

export interface PoolDeps {
  kernel: Kernel;
  scheduler: Scheduler;
  buffer: DiagnosticsBuffer;
  cache: CacheValidator;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  onStart?: (info: { ok: boolean; startMs: number }) => void;
  onCache?: (rebuilt: boolean) => void;
  onFallback?: () => void;
}

export interface Acquired {
  entry: ManagedLsp;
  /** An entry for this exact root already existed. */
  reused: boolean;
  /** An entry for a *parent* root was reused instead of spawning. */
  converged: boolean;
}

export class LspPool {
  private entries = new Map<string, ManagedLsp>();

  constructor(private readonly deps: PoolDeps) {}

  acquire(plugin: LanguagePlugin, root: string): Acquired {
    const key = poolKey({ pluginId: plugin.id, root });
    const exact = this.entries.get(key);
    if (exact) {
      exact.touch();
      return { entry: exact, reused: true, converged: false };
    }

    for (const entry of this.entries.values()) {
      if (entry.plugin.id !== plugin.id) continue;
      if (containsRoot(entry.root, root)) {
        entry.touch();
        this.deps.log?.(`${plugin.id}: reusing server rooted at ${entry.root} for ${root}`, { converged: true });
        return { entry, reused: true, converged: true };
      }
    }

    const entry = new ManagedLsp({
      kernel: this.deps.kernel,
      plugin,
      root,
      scheduler: this.deps.scheduler,
      buffer: this.deps.buffer,
      cache: this.deps.cache,
      ...(this.deps.log ? { log: this.deps.log } : {}),
      ...(this.deps.onStart ? { onStart: this.deps.onStart } : {}),
      ...(this.deps.onCache ? { onCache: this.deps.onCache } : {}),
      ...(this.deps.onFallback ? { onFallback: this.deps.onFallback } : {}),
    });
    this.entries.set(key, entry);
    return { entry, reused: false, converged: false };
  }

  find(pluginId: string, root?: string): ManagedLsp | undefined {
    if (root !== undefined) {
      const exact = this.entries.get(poolKey({ pluginId, root }));
      if (exact) return exact;
    }
    for (const entry of this.entries.values()) {
      if (entry.plugin.id !== pluginId) continue;
      if (root === undefined || containsRoot(entry.root, root)) return entry;
    }
    return undefined;
  }

  all(): ManagedLsp[] {
    return [...this.entries.values()];
  }

  /** Entries with a live server — what an aggregated request can ask. */
  live(): ManagedLsp[] {
    return this.all().filter((e) => e.isRunning);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Forward `$/cancelRequest` to whichever entry issued `id`. */
  cancel(id: number): boolean {
    for (const entry of this.entries.values()) {
      if (entry.cancelRequest(id)) return true;
    }
    return false;
  }

  /**
   * Stop servers that have been idle past their plugin's TTL.
   *
   * The TTL is per plugin because the cost is per server: a JVM start is 40 s and
   * 400 MB, a tsserver start is 250 ms. Reaping both on the same schedule either
   * wastes memory or throws away work.
   */
  reap(now = Date.now()): string[] {
    const stopped: string[] = [];
    for (const [key, entry] of this.entries) {
      const ttl = entry.plugin.idleTtlMs();
      if (!(ttl > 0)) continue;
      if (now - entry.describe().idleMs < ttl) continue;
      this.entries.delete(key);
      stopped.push(key);
      void entry.stop().catch(() => undefined);
    }
    return stopped;
  }

  /** Remove every entry for a plugin, stopping the servers. */
  drop(pluginId: string): number {
    let n = 0;
    for (const [key, entry] of this.entries) {
      if (entry.plugin.id !== pluginId) continue;
      this.entries.delete(key);
      void entry.stop().catch(() => undefined);
      n++;
    }
    return n;
  }

  async close(): Promise<void> {
    const entries = this.all();
    this.entries.clear();
    await Promise.all(entries.map((e) => e.stop().catch(() => undefined)));
  }
}
