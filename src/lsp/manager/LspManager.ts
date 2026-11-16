/**
 * The manager: thin by construction.
 *
 * It owns five things — routing, pooling, scheduling, cache validation and the
 * fallback decision — and no language knowledge. Every `if` about a specific
 * language lives in a manifest; every server-specific detail lives in a plugin.
 *
 * What it deliberately does *not* do: parse source, understand a build system,
 * or own a protocol implementation. `LspClient` speaks LSP, `ManagedLsp` adds
 * pooling and fallback, and this file decides *which* `ManagedLsp` a request
 * goes to.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Kernel } from '../../kernel/Kernel.js';
import type { SymbolInformation } from '../navigation.js';
import { unsupported, supported, type NavResult } from '../navigation.js';
import { CacheValidator } from './CacheValidator.js';
import { DiagnosticsBuffer } from './DiagnosticsBuffer.js';
import { LspPool, containsRoot } from './LspPool.js';
import { ManagedLsp } from './ManagedLsp.js';
import { PluginRegistry } from './PluginRegistry.js';
import { Scheduler } from './Scheduler.js';
import { ContentHashStrategy, GitDiffStrategy, resolveDirty, headCommit } from './strategies.js';
import type { DirtyReport, IndexMetadata, LanguagePlugin, ManagerStats } from './types.js';

export interface ManagerOptions {
  kernel: Kernel;
  /** `<home>`; index metadata lives under `<home>/index`. */
  home: string;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /** Background reap cadence. 0 disables the timer (tests drive it manually). */
  reapIntervalMs?: number;
  /** Dirty-file count that turns "incremental" into "rebuild" advice. */
  dirtyThreshold?: number;
}

export interface DirtyOutcome extends DirtyReport {
  large: boolean;
  threshold: number;
  /** Advice for the UI; empty when the change is small enough to apply. */
  hint?: string;
}

export interface SyncOutcome {
  changed: string[];
  skipped: string[];
}

export class LspManager {
  readonly registry = new PluginRegistry();
  private readonly pool: LspPool;
  private readonly scheduler: Scheduler;
  private readonly buffer = new DiagnosticsBuffer();
  private readonly cache: CacheValidator;
  private readonly strategies = { git: new GitDiffStrategy(), hash: new ContentHashStrategy() };
  private readonly dirtyThreshold: number;
  private readonly log?: (message: string, meta?: Record<string, unknown>) => void;
  private readonly counters = {
    starts: 0,
    startFailures: 0,
    reused: 0,
    converged: 0,
    reaped: 0,
    fallbacks: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  private reaper?: NodeJS.Timeout;
  /** Set right after the pool exists; the scheduler's cancel hook reads it. */
  private poolRef?: LspPool;

  constructor(private readonly opts: ManagerOptions) {
    this.log = opts.log;
    this.dirtyThreshold = opts.dirtyThreshold ?? 200;
    this.cache = new CacheValidator(join(opts.home, 'index'));
    // The scheduler needs the pool to resolve an id back to its connection, and
    // the pool needs the scheduler. The reference breaks the cycle: a request id
    // is only unique within one connection, so the lookup must be dynamic.
    this.scheduler = new Scheduler((id) => this.poolRef?.cancel(id) ?? false);
    this.pool = new LspPool({
      kernel: opts.kernel,
      scheduler: this.scheduler,
      buffer: this.buffer,
      cache: this.cache,
      ...(this.log ? { log: this.log } : {}),
      onStart: (info) => {
        if (info.ok) this.counters.starts++;
        else this.counters.startFailures++;
      },
      onCache: (rebuilt) => {
        if (rebuilt) this.counters.cacheMisses++;
        else this.counters.cacheHits++;
      },
      onFallback: () => {
        this.counters.fallbacks++;
      },
    });

    this.poolRef = this.pool;

    const interval = opts.reapIntervalMs ?? 60_000;
    if (interval > 0) {
      this.reaper = setInterval(() => this.reapNow(), interval);
      this.reaper.unref?.();
    }
  }

  register(plugin: LanguagePlugin): void {
    this.registry.register(plugin);
    this.cache.reset(plugin.id);
  }

  unregister(id: string): void {
    this.registry.unregister(id);
    this.cache.reset(id);
  }

  has(id: string): boolean {
    return !!this.registry.get(id);
  }

  pluginFor(file: string): LanguagePlugin | undefined {
    return this.registry.route(file);
  }

  plugins(): LanguagePlugin[] {
    return this.registry.all();
  }

  /** The pooled entry for a plugin, created on demand. Never spawns. */
  acquire(pluginId: string, root: string): ManagedLsp | undefined {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return undefined;
    const got = this.pool.acquire(plugin, root);
    if (got.converged) this.counters.converged++;
    else if (got.reused) this.counters.reused++;
    return got.entry;
  }

  entry(pluginId: string, root?: string): ManagedLsp | undefined {
    return this.pool.find(pluginId, root);
  }

  /**
   * Files changed since the last index, plus whether applying them is sensible.
   *
   * The plugin chooses the strategy; the manager owns the *chain* (git, then
   * content stamps) because that is generic policy, not language knowledge.
   */
  async dirty(pluginId: string, root: string, threshold = this.dirtyThreshold): Promise<DirtyOutcome | undefined> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return undefined;
    const strategy = plugin.incremental();
    const meta = await this.cache.ensure(plugin, root).catch(() => undefined);
    let report: DirtyReport;
    if (!strategy) {
      report = { files: [], source: 'none', reason: 'this plugin declares no incremental strategy' };
    } else if (strategy.kind === 'git-diff') {
      report = await resolveDirty(this.strategies, root, meta?.metadata);
    } else {
      report = await strategy.dirtyFiles(root, meta?.metadata);
    }
    const large = strategy ? strategy.isLargeChange(report, threshold) : false;
    return {
      ...report,
      large,
      threshold,
      ...(large
        ? { hint: `${report.files.length} files changed (> ${threshold}) — a full index rebuild is recommended` }
        : {}),
    };
  }

  /**
   * Re-read the dirty files that this entry holds open and `didChange` only them.
   *
   * Files that are not open are skipped on purpose: the server reads those from
   * disk itself, and sending `didChange` for a document it never received a
   * `didOpen` for is a protocol error, not an optimisation.
   */
  async syncDirty(pluginId: string, root: string): Promise<SyncOutcome> {
    const entry = this.pool.find(pluginId, root);
    if (!entry) return { changed: [], skipped: [] };
    const report = await this.dirty(pluginId, root);
    if (!report) return { changed: [], skipped: [] };
    const open = new Set(entry.openDocuments());
    const changed: string[] = [];
    const skipped: string[] = [];
    for (const rel of report.files) {
      const abs = join(root, rel);
      const uri = pathToFileURL(abs).href;
      if (!open.has(uri)) {
        skipped.push(rel);
        continue;
      }
      const text = await readFile(abs, 'utf8').catch(() => undefined);
      if (text === undefined) {
        skipped.push(rel);
        continue;
      }
      entry.changeDocument(uri, text);
      changed.push(rel);
    }
    return { changed, skipped };
  }

  /**
   * `workspace/symbol` across every *running* server.
   *
   * Only running ones: a symbol search must not spawn eight servers, and the
   * alternative — searching just one — would return a misleadingly partial list.
   */
  async symbols(query: string, limit = 500): Promise<NavResult<SymbolInformation[]>> {
    const live = this.pool.live();
    if (!live.length) return unsupported('no language server is running');
    const results = await Promise.all(
      live.map((entry) => entry.workspaceSymbols(query).catch(() => unsupported<SymbolInformation[]>('request failed'))),
    );
    const seen = new Set<string>();
    const merged: SymbolInformation[] = [];
    let anySupported = false;
    let firstReason = '';
    for (const r of results) {
      if (!r.ok) {
        firstReason ||= r.reason;
        continue;
      }
      anySupported = true;
      for (const s of r.value) {
        const k = `${s.uri}|${s.line}|${s.name}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (merged.length >= limit) break;
        merged.push(s);
      }
    }
    if (!anySupported) return unsupported(firstReason || 'no server answered');
    return supported(merged);
  }

  /** What the persisted index looks like for a plugin, and whether it is usable. */
  async cacheState(pluginId: string): Promise<(IndexMetadata & { valid: boolean; reason: string }) | undefined> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return undefined;
    const meta = await this.cache.load(pluginId);
    const verdict = this.cache.validate(plugin, meta);
    if (!meta) return undefined;
    return { ...meta, valid: verdict.valid, reason: verdict.reason };
  }

  /**
   * Stop and forget every server for a plugin.
   *
   * Needed by "restart the language server": a pooled entry that was stopped is
   * still in the pool, and the next acquire would hand back a dead client. The
   * cache memo is cleared too, so the next start re-validates the index instead
   * of trusting a decision made before the server changed.
   */
  async release(pluginId: string): Promise<number> {
    const removed = this.pool.drop(pluginId);
    this.cache.reset(pluginId);
    return removed;
  }

  /** Stop idle servers now. Returns the pool keys that were reaped. */
  reapNow(now = Date.now()): string[] {
    const reaped = this.pool.reap(now);
    this.counters.reaped += reaped.length;
    return reaped;
  }

  bufferStats(): ReturnType<DiagnosticsBuffer['stats']> {
    return this.buffer.stats();
  }

  stats(): ManagerStats {
    const s = this.scheduler.stats();
    return {
      starts: this.counters.starts,
      startFailures: this.counters.startFailures,
      reused: this.counters.reused,
      converged: this.counters.converged,
      reaped: this.counters.reaped,
      cancelled: s.cancelled,
      deduped: s.deduped,
      staleDropped: s.staleDropped,
      fallbacks: this.counters.fallbacks,
      cacheHits: this.counters.cacheHits,
      cacheMisses: this.counters.cacheMisses,
      live: this.pool.live().length,
    };
  }

  /** Entries, for the status bar and the integration tests. */
  entries(): ManagedLsp[] {
    return this.pool.all();
  }

  /** HEAD of a checkout, or null — used when stamping an index. */
  headCommit(root: string): Promise<string | null> {
    return headCommit(root);
  }

  /** True when `child` is inside `parent` — the root-convergence predicate. */
  static containsRoot = containsRoot;

  async close(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    await this.pool.close();
  }
}
