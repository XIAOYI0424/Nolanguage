import type {
  Kernel as IKernel, CommandBus, EventBus, ServiceRegistry,
  ViewRegistry, LanguageRegistry, Configuration, LoggerFactory, ViewContribution,
  LanguageContribution, Disposable,
} from './types.js';
import { CommandBusImpl } from './CommandBus.js';
import { EventBusImpl } from './EventBus.js';
import { ServiceRegistryImpl } from './ServiceRegistry.js';
import { TracerImpl } from '../perf/Tracer.js';
import type { Tracer } from '../perf/Tracer.js';
import { CorrelationBus } from '../correlation/CorrelationBus.js';
import { PerfSpine } from '../perf/PerfSpine.js';
import { LogSpine } from './LogSpine.js';
import { detectEnvironment } from '../util/env.js';
import type { LogEnvironment } from '../util/env.js';
import { LogLevel } from '../log/LogLevel.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { LogSink } from '../store/LogSink.js';
import { BaselineStore } from '../perf/BaselineStore.js';
import type { BaselineThresholds } from '../perf/BaselineStore.js';
import { AutoBaseline } from '../perf/AutoBaseline.js';
import { runLogQuery } from '../store/LogQuery.js';
import { fuseByTrace, fuseByCommit } from '../store/Fusion.js';
import type { LogEntry, LogQuery } from '../store/LogQuery.js';
import type { FusionResult } from '../store/Fusion.js';
import type { LogRecord } from '../log/types.js';

// ---------------- Minimal stubs for later phases ----------------

class ViewRegistryImpl implements ViewRegistry {
  private map = new Map<string, ViewContribution[]>();
  register(v: ViewContribution): Disposable {
    const arr = this.map.get(v.slot) ?? [];
    arr.push(v);
    this.map.set(v.slot, arr);
    return { dispose: () => { const a = this.map.get(v.slot); if (a) this.map.set(v.slot, a.filter((x) => x !== v)); } };
  }
  get(slot: string): ViewContribution[] { return this.map.get(slot) ?? []; }
  slots(): string[] { return [...this.map.keys()]; }
}

class LanguageRegistryImpl implements LanguageRegistry {
  private map = new Map<string, LanguageContribution>();
  register(l: LanguageContribution): Disposable {
    this.map.set(l.id, l);
    return { dispose: () => { this.map.delete(l.id); } };
  }
  get(id: string): LanguageContribution | undefined { return this.map.get(id); }
  all(): LanguageContribution[] { return [...this.map.values()]; }
}

class ConfigScopeImpl {
  private data: Record<string, unknown> = {};
  get<T = unknown>(key: string, def?: T): T {
    return (key in this.data ? this.data[key] : def) as T;
  }
  set(key: string, value: unknown): void { this.data[key] = value; }
  all(): Record<string, unknown> { return { ...this.data }; }
}
class ConfigurationImpl implements Configuration {
  private ext = new Map<string, ConfigScopeImpl>();
  forExtension(id: string): ConfigScopeImpl {
    let s = this.ext.get(id);
    if (!s) { s = new ConfigScopeImpl(); this.ext.set(id, s); }
    return s;
  }
  forWorkspace(): ConfigScopeImpl { return this.forExtension('__workspace__'); }
}

// ---------------- Kernel ----------------

export interface KernelOptions {
  appVersion?: string;
  hotCapacity?: number;
  slowThresholdMs?: number;
  logLevel?: LogLevel;
  logPretty?: boolean;
  /** Suppress the console transport (tests, embedded use, panel-only runs). */
  logSilent?: boolean;
  /**
   * Dev mode (spec 十): 100% collection — disables log rate-sampling so TRACE /
   * DEBUG records all reach the ring buffer and the panel. Defaults to true.
   */
  devMode?: boolean;
  /**
   * SQLite warm tier (spec 十三 / 二十). Accepts a ready-made `SqliteStore`,
   * `true` to open the default database, a **database path**, or `false` to
   * keep everything in memory. Defaults to **false** so tests stay isolated;
   * hosts that want persistence (the panel server, the demo) opt in explicitly
   * — `process.env.NOLANGUAGE_DB` is exactly that "path or true" case.
   */
  store?: SqliteStore | boolean | string;
  /** Path for the auto-created store; defaults to `<cwd>/.nolanguage/telemetry.db`. */
  dbPath?: string;
  /** Warm-tier flush cadence in ms (spec 20.2: 5 s). */
  sinkFlushMs?: number;
  /** Warm-tier batch size in records (spec 20.2: 512). */
  sinkBatchSize?: number;
  /**
   * Auto-baseline (spec 十): snapshot the live metrics on every git commit
   * change and compare with the previous baseline. Defaults to true when a
   * store is active.
   */
  autoBaseline?: boolean;
  /** Clear the live metric windows after each baseline checkpoint. */
  resetMetricsOnBaseline?: boolean;
  /** Regression / improvement thresholds for baseline comparison. */
  baselineThresholds?: BaselineThresholds;
  /** Stable session id stamped on every record (spec 二十二). */
  sessionId?: string;
}

/**
 * Micro-kernel (Stage 1): wires the three buses + performance spine + log spine.
 * `start()` performs deferred installation so startup only parses the skeleton.
 */
export class Kernel implements IKernel {
  commands: CommandBus;
  events: EventBus;
  services: ServiceRegistry;
  views: ViewRegistry;
  languages: LanguageRegistry;
  configuration: Configuration;
  tracer: Tracer;
  correlation: CorrelationBus;
  logger!: LoggerFactory;

  readonly env: LogEnvironment;
  readonly appVersion: string;
  readonly sessionId: string;
  private perf: PerfSpine;
  private log: LogSpine;
  private started = false;

  // Stage 6 · warm tier + baselines (all optional, see KernelOptions.store).
  private opts: KernelOptions;
  store?: SqliteStore;
  sink?: LogSink;
  baselines?: BaselineStore;
  baseline?: AutoBaseline;
  private storeRequested: boolean;
  /** True when *this* kernel opened the store, so `stop()` may close it. */
  private ownsStore = false;

  constructor(opts: KernelOptions = {}) {
    this.opts = opts;
    this.appVersion = opts.appVersion ?? '0.1.0';
    this.env = detectEnvironment(this.appVersion);
    this.sessionId = opts.sessionId ?? `kernel-${Date.now().toString(36)}`;
    this.correlation = new CorrelationBus({ sessionId: this.sessionId });
    this.tracer = new TracerImpl();
    this.commands = new CommandBusImpl();
    this.events = new EventBusImpl();
    this.services = new ServiceRegistryImpl();
    (this.services as ServiceRegistryImpl).attach(this);
    this.views = new ViewRegistryImpl();
    this.languages = new LanguageRegistryImpl();
    this.configuration = new ConfigurationImpl();
    this.perf = new PerfSpine({
      hotCapacity: opts.hotCapacity ?? 20_000,
      slowThresholdMs: opts.slowThresholdMs ?? 100,
      env: this.env,
      correlation: this.correlation,
    });
    this.log = new LogSpine({
      level: opts.logLevel ?? LogLevel.TRACE,
      pretty: opts.logPretty ?? true,
      env: this.env,
      correlation: this.correlation,
      sampling: !(opts.devMode ?? true),
      silent: opts.logSilent ?? false,
    });
    this.storeRequested = opts.store !== false && opts.store !== undefined;
  }

  async start(): Promise<void> {
    if (this.started) return;
    // Resolve the real git commit *before* the spines install, otherwise every
    // record carries `gitCommit: 'unknown'` (the spines cache it once).
    await this.correlation.prime();
    this.perf.install(this);
    this.log.install(this);
    this.attachStore();
    this.started = true;
    this.logger.root().info('Kernel started', {
      appVersion: this.appVersion,
      os: this.env.os,
      arch: this.env.arch,
      cpuCores: this.env.cpuCores,
      gitCommit: this.correlation.gitCommit(),
      gitBranch: this.correlation.gitBranch(),
      gitDirty: this.correlation.gitDirty(),
      store: this.store ? this.store.path : 'disabled',
    });
    await this.events.emit('kernel:started', { appVersion: this.appVersion });
    this.baseline?.start();
  }

  /**
   * Stage 6: attach the SQLite warm tier. Degrades to memory-only (with a
   * warning log) when the database cannot be opened — telemetry must never be
   * the reason a kernel fails to start.
   */
  private attachStore(): void {
    if (!this.storeRequested) return;
    try {
      this.store =
        this.opts.store instanceof SqliteStore
          ? this.opts.store
          : (() => {
              this.ownsStore = true;
              return new SqliteStore({
                path: typeof this.opts.store === 'string' ? this.opts.store : this.opts.dbPath,
              });
            })();
    } catch (err) {
      this.storeRequested = false;
      this.logger.forComponent('store').warn('SQLite warm tier unavailable — memory only', {
        error: (err as Error).message,
      });
      return;
    }

    this.sink = new LogSink({
      store: this.store,
      flushIntervalMs: this.opts.sinkFlushMs ?? 5_000,
      batchSize: this.opts.sinkBatchSize ?? 512,
    });
    this.log.pipeline.addTransport(this.sink);
    this.perf.addTap((r) => this.sink?.writePerf(r));

    this.baselines = new BaselineStore(this.store, this.opts.baselineThresholds);
    if (this.opts.autoBaseline !== false) {
      this.baseline = new AutoBaseline({
        baselines: this.baselines,
        metrics: this.perf.metrics,
        correlation: this.correlation,
        appVersion: this.appVersion,
        emit: (event, payload) => {
          void this.events.emit(event, payload);
        },
        log: this.logger.forComponent('perf.baseline'),
        resetOnCheckpoint: this.opts.resetMetricsOnBaseline ?? false,
      });
    }
  }

  async stop(): Promise<void> {
    await this.events.emit('kernel:stopping');
    // Final baseline for whatever work happened since the last checkpoint.
    if (this.baseline && this.perf.metrics.names().length > 0) {
      try {
        await this.baseline.checkpoint('shutdown');
      } catch {
        // A failing baseline must not block shutdown.
      }
    }
    this.baseline?.stop();
    await this.log.flush(); // drains the sink into SQLite
    await this.sink?.close();
    await this.log.flush();
    // Only close a store this kernel opened; a host-provided instance belongs
    // to the host and may outlive the kernel.
    if (this.ownsStore) {
      this.store?.close();
      this.store = undefined;
    }
    this.started = false;
  }

  // ---- Perf accessors ----
  perfMetrics() { return this.perf.metrics; }
  recentPerf(limit = 100) { return this.perf.recentPerf(limit); }
  slowPaths() { return this.perf.slowPaths(); }
  perfSummary(name: string) { return this.perf.metrics.summary(name); }
  perfNames() { return this.perf.metrics.names(); }

  /** Record a trace-correlated metric (lands in both live metrics and the store). */
  perfMetric(
    name: string,
    value: number,
    opts?: Parameters<PerfSpine['recordMetric']>[2],
  ) {
    this.perf.recordMetric(name, value, opts);
  }

  /** Run the slow-path check for non-command work (RPC roundtrips, LSP calls). */
  checkSlow(name: string, durationMs: number, attributes?: Record<string, unknown>) {
    return this.perf.checkSlow(name, durationMs, attributes);
  }

  get slowThresholdMs() { return this.perf.thresholdMs; }

  // ---- Log accessors ----
  recentLogs(limit = 100) { return this.log.pipeline.toArray().slice(-limit); }
  logPipeline() { return this.log.pipeline; }

  /** Live tap for log records (used by the Stage-2 dev panel). */
  onLogRecord(fn: (record: import('../log/types.js').LogRecord) => void): () => void {
    return this.log.pipeline.addTap(fn);
  }

  // ---- Stage 6 · warm tier + baselines ----

  /** The active SqliteStore, or undefined when persistence is off. */
  sqliteStore(): SqliteStore | undefined {
    return this.store;
  }

  /** Warm-tier sink counters (queue depth, writes, failures, drops). */
  sinkStats() {
    return this.sink?.getStats();
  }

  /** Structured query over the warm tier; falls back to the hot ring buffer. */
  queryLogs(q: LogQuery): LogEntry[] {
    if (this.store) return runLogQuery(this.store, q);
    // Memory-only mode: apply the same query to the live ring buffer.
    const pattern = q.messagePattern;
    let entries = this.log.pipeline.toArray().slice().reverse();
    if (q.traceId) entries = entries.filter((r) => r.traceId === q.traceId);
    if (q.components?.length) entries = entries.filter((r) => q.components!.includes(r.resource.component));
    if (q.minLevel !== undefined) entries = entries.filter((r) => r.level === q.minLevel || (q.minLevel! <= 5 && r.level >= q.minLevel! && r.level <= 5));
    if (q.messageContains) entries = entries.filter((r) => r.message.includes(q.messageContains!));
    if (pattern) entries = entries.filter((r) => pattern.test(r.message));
    const offset = q.offset ?? 0;
    return entries.slice(offset, offset + (q.limit ?? 200)) as unknown as LogEntry[];
  }

  /** Perf/log fusion by shared correlation key (spec 二十二). */
  fuseTrace(traceId: string): FusionResult | undefined {
    return this.store ? fuseByTrace(this.store, traceId) : undefined;
  }

  fuseCommit(gitCommit: string): FusionResult | undefined {
    return this.store ? fuseByCommit(this.store, gitCommit) : undefined;
  }

  /** Take a baseline now (spec 十); no-op when the store is off. */
  checkpointBaseline(reason = 'manual') {
    return this.baseline?.checkpoint(reason);
  }

  /** Last baseline comparison result, if one was produced. */
  baselineComparison() {
    return this.baseline?.lastComparison;
  }
}
