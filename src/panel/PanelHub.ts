/**
 * PanelHub (Stage 2): the bridge between the kernel's perf/log spines and any
 * number of connected panel clients.
 *
 * Responsibilities:
 *  - Snapshot on connect (metrics / slow paths / recent logs) — late joiners
 *    immediately see current state, no need to wait for the next tick.
 *  - Periodic digest push (default 1Hz, spec 十: "1Hz 推送") with metric deltas.
 *  - Live event push: every slow path and every WARN+ log is forwarded the
 *    moment it happens (spec: "慢路径立即捕获" / "实时日志").
 *  - Apply client filter commands back onto the log pipeline.
 *
 * The hub is transport-agnostic: it only knows how to `send(payload)` to a
 * sink. The WebSocket server (panel/server.ts) registers a sink per socket.
 */
import { LogLevel, LOG_LEVEL_NAMES, LOG_LEVEL_VALUES } from '../log/LogLevel.js';
import type { LogRecord } from '../log/types.js';
import type { MetricSummary } from '../perf/LiveMetrics.js';
import type { PerfRecord } from '../perf/types.js';
import type { Kernel } from '../kernel/Kernel.js';
import type { Disposable } from '../kernel/types.js';
import type { ExtensionPanelInfo } from '../extensions/ExtensionManager.js';
import type { FsEntry, FsFile } from './FsService.js';
import { LOG_DIGEST_MAX, sliceDigest } from './log-digest.js';

export type PanelLevelName =
  | 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'AUDIT' | 'METRIC';

/** A connected client. `send` must never throw. */
export interface PanelSink {
  id: number;
  send(payload: PanelServerMessage): void;
}

export interface PanelFilter {
  minLevel: LogLevel;
  components?: string[];
  messagePattern?: string;
}

export interface PanelHubOptions {
  /** Digest push interval in ms (1Hz in dev mode, spec 十). */
  pushIntervalMs?: number;
  /** Slow-path broadcast should not flood; cap per digest window. */
  maxSlowPerTick?: number;
}

// -------- wire protocol (server -> client) --------
/** Wire shapes for the navigation results (already normalised by `lsp/navigation`). */
export interface NavLocation {
  uri: string;
  line: number;
  character: number;
}
export interface NavEdit {
  uri: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  newText: string;
}
export interface NavAction {
  title: string;
  kind?: string;
  edits?: NavEdit[];
}
export interface NavSymbol {
  name: string;
  kind: string;
  uri: string;
  line: number;
  containerName?: string;
}

export type PanelServerMessage =
  | {
      kind: 'hello';
      appVersion: string;
      os: string;
      arch: string;
      pushIntervalMs: number;
      levels: Record<string, number>;
      commands: { id: string; title?: string }[];
    }
  | {
      kind: 'metrics';
      at: number;
      tick: number;
      metrics: Record<string, MetricSummary>;
      perfSummary: { total: number; byType: Record<string, number> };
      // Named sparkline series (last N digest values) per metric.
      series: Record<string, number[]>;
    }
  | { kind: 'slow'; at: number; spans: SlowEntry[] }
  | { kind: 'log'; at: number; records: ClientLogRecord[] }
  | { kind: 'logReset'; at: number }
  | { kind: 'filter'; filter: { minLevel: number; components?: string[]; pattern?: string } }
  // ---- IDE (editor) messages ----
  | { kind: 'workspace'; status: WorkspaceStatus; samples: Array<{ id: string; name: string }> }
  | { kind: 'runStart'; runId: string; sessionId: string }
  | {
      kind: 'runResult';
      runId: string;
      sessionId: string;
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      stdoutTruncated?: boolean;
      stderrTruncated?: boolean;
      logLinesTruncated?: boolean;
      durationMs: number;
      timedOut: boolean;
      logLines: number;
    }
  | {
      kind: 'diagnostics';
      uri: string;
      items: IdeProblem[];
      errors: number;
      warnings: number;
      fromLsp: boolean;
    }
  | { kind: 'completion'; requestId: number; items: Array<{ label: string; kind?: number; detail?: string }> }
  | { kind: 'hover'; requestId: number; hover: unknown }
  // ---- navigation (the five LSP requests) ----
  // `unsupported` is carried on every result: "no results" and "this server
  // cannot do that" look identical otherwise, and the panel has to say which.
  | { kind: 'definitionResult'; requestId: number; locations: NavLocation[]; unsupported?: string }
  | { kind: 'referencesResult'; requestId: number; locations: NavLocation[]; truncated?: boolean; unsupported?: string }
  | { kind: 'renameResult'; requestId: number; edits: NavEdit[]; unsupported?: string }
  | { kind: 'codeActionResult'; requestId: number; actions: NavAction[]; unsupported?: string }
  | { kind: 'workspaceSymbolResult'; requestId: number; symbols: NavSymbol[]; truncated?: boolean; unsupported?: string }
  | { kind: 'session'; sessionId: string; reset: boolean }
  | { kind: 'error'; message: string }
  // ---- Project explorer (file system) ----
  | { kind: 'fsRoot'; reqId: number; root: string; name: string }
  | { kind: 'fsListing'; reqId: number; path: string; entries: FsEntry[]; truncated?: boolean }
  | { kind: 'fsFile'; reqId: number; file: FsFile }
  | { kind: 'fsSaved'; reqId: number; path: string; mtime: number; size: number }
  | {
      kind: 'fsChanged';
      reqId: number;
      op: 'create' | 'rename' | 'delete';
      path: string;
      /** Rename only: the previous path, so open tabs can be remapped. */
      from?: string;
      /** Absent for a delete. */
      entry?: FsEntry;
    }
  | { kind: 'fsError'; reqId: number; path?: string; message: string; code: string }
  // ---- Extension host (Stage 2 · 面板接入) ----
  | { kind: 'extensions'; at: number; extensions: ExtensionPanelInfo[] }
  | {
      kind: 'extension';
      at: number;
      event: 'activated' | 'crashed' | 'deactivated';
      extensionId: string;
      hostId?: string;
    }
  | { kind: 'extensionResult'; reqId: number; ok: boolean; result?: unknown; error?: string }
  // ---- Terminal (PyCharm shell) ----
  | { kind: 'termResult'; cmd: string; stdout: string; stderr: string; code: number | null; ms: number }
  // ---- interactive execution (Run / Terminal) ----
  | { kind: 'runOut'; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'runInput'; text: string }
  | { kind: 'termOut'; text: string; stream: 'stdout' | 'stderr' }
  | { kind: 'termInput'; text: string };

/** A diagnostic shaped for the IDE's Problems list. */
export interface IdeProblem {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  severity: number;
  severityName: string;
  message: string;
  code?: string | number;
  source?: string;
}

/** Workspace/LSP summary shown in the IDE status bar. */
export interface WorkspaceStatus {
  bufferPath: string;
  pythonBin: string;
  sessions: number;
  lsp: {
    available: boolean;
    running: boolean;
    serverName: string;
    capabilities: number;
    logRecords: number;
    error?: string;
  };
}

export interface SlowEntry {
  spanId: string;
  traceId: string;
  name: string;
  durationMs: number;
  commandId?: string;
  at: number;
}

export interface ClientLogRecord {
  id: string;
  ts: number; // epoch ms
  level: number;
  levelName: string;
  component: string;
  scope: string;
  message: string;
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  fileUri?: string;
  fields?: Record<string, unknown>;
  errorType?: string;
  errorMessage?: string;
  tags?: string[];
}

const SERIES_LEN = 60;

export class PanelHub {
  readonly startedAt = Date.now();
  private clients = new Map<number, PanelSink>();
  private nextClientId = 1;
  private timer?: ReturnType<typeof setInterval>;
  private tick = 0;

  /** Raw metric digest history for sparklines, keyed by metric name. */
  private series = new Map<string, number[]>();
  /** Last-seen metric sample ts per name, to compute deltas without window shrink bias. */
  private lastSeen = new Map<string, number>();
  /** Log records already broadcast to clients (cursor into the ring buffer). */
  private logCursor = 0;
  private slowBuffer: SlowEntry[] = [];
  private opts: Required<PanelHubOptions>;
  // Two shapes come back from the kernel: `EventBus.on` returns a `Disposable`
  // object, `Kernel.onLogRecord` returns a bare unsubscribe function.
  private unsubscribe: Array<Disposable | (() => void)> = [];

  constructor(
    private kernel: Kernel,
    opts: PanelHubOptions = {},
  ) {
    this.opts = {
      pushIntervalMs: opts.pushIntervalMs ?? 1000,
      maxSlowPerTick: opts.maxSlowPerTick ?? 50,
    };
  }

  // ---------------- client lifecycle ----------------

  /** Allocate a stable client id (used by the transport when registering sinks). */
  allocateClientId(): number {
    return this.nextClientId++;
  }

  addClient(sink: PanelSink): void {
    this.clients.set(sink.id, sink);
    // A brand-new connection can already be gone (the tab closed between the
    // handshake and this call), so none of the priming sends may throw.
    this.sendTo(sink, {
      kind: 'hello',
      appVersion: this.kernel.appVersion,
      os: this.kernel.env.os,
      arch: this.kernel.env.arch,
      pushIntervalMs: this.opts.pushIntervalMs,
      levels: LOG_LEVEL_VALUES,
      commands: this.kernel.commands.list().map((c) => ({ id: c.id, title: c.title })),
    });
    // Immediate snapshot so the UI is never blank.
    this.sendTo(sink, this.buildMetricsMessage());
    const logs = this.kernel.logPipeline().recent(200);
    this.sendTo(sink, { kind: 'log', at: Date.now(), records: logs.map(toClientLog) });
    this.sendTo(sink, { kind: 'slow', at: Date.now(), spans: this.currentSlowEntries() });
  }

  /** Send to one sink, dropping it if the transport reports it is gone. */
  private sendTo(sink: PanelSink, payload: PanelServerMessage): void {
    try {
      sink.send(payload);
    } catch {
      this.clients.delete(sink.id);
    }
  }

  removeClient(id: number): void {
    this.clients.delete(id);
  }

  /**
   * Broadcast an arbitrary server message (used to surface extension host
   * lifecycle events to every connected panel client).
   */
  push(payload: PanelServerMessage): void {
    this.broadcast(payload);
  }

  clientCount(): number {
    return this.clients.size;
  }

  // ---------------- lifecycle hooks ----------------

  /** Subscribe to live kernel signals (slow paths + WARN+ logs). */
  install(): void {
    // Slow paths arrive as a bus event emitted by the perf spine.
    this.unsubscribe.push(
      this.kernel.events.on('perf:slowPath', (payload) => {
        const span = payload as {
          id: string; traceId: string; name: string;
          duration?: number; commandId?: string;
        };
        const entry: SlowEntry = {
          spanId: span.id,
          traceId: span.traceId,
          name: span.name,
          durationMs: span.duration ?? 0,
          commandId: span.commandId,
          at: Date.now(),
        };
        this.slowBuffer.push(entry);
        if (this.slowBuffer.length > 500) this.slowBuffer.splice(0, this.slowBuffer.length - 500);
        this.broadcast({ kind: 'slow', at: Date.now(), spans: [entry] });
      }),
    );
    // Log records come through the pipeline tap (all accepted records).
    this.unsubscribe.push(
      this.kernel.onLogRecord((r) => {
        // Live-forward only WARN+ (lower levels ride the digest) to avoid flooding.
        if (r.level < LogLevel.WARN) return;
        this.broadcast({ kind: 'log', at: Date.now(), records: [toClientLog(r)] });
      }),
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.digestTick(), this.opts.pushIntervalMs);
    // Don't hold the process open just for the panel timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const off of this.unsubscribe) {
      if (typeof off === 'function') off();
      else off.dispose();
    }
    this.unsubscribe = [];
  }

  // ---------------- digest ----------------

  private digestTick(): void {
    this.tick++;
    if (this.clients.size === 0) return;
    // Flush slow paths that were buffered but not yet individual-broadcast.
    if (this.slowBuffer.length) {
      const pending = this.slowBuffer.slice(-this.opts.maxSlowPerTick);
      this.broadcast({ kind: 'slow', at: Date.now(), spans: pending });
    }
    this.broadcast(this.buildMetricsMessage());
    this.pushNewLogs();
  }

  private buildMetricsMessage(): PanelServerMessage {
    const metrics = this.kernel.perfMetrics();
    const names = this.kernel.perfNames();
    const out: Record<string, MetricSummary> = {};
    for (const n of names) {
      const s = metrics.summary(n);
      if (!s) continue;
      out[n] = s;
      let arr = this.series.get(n);
      if (!arr) {
        arr = [];
        this.series.set(n, arr);
      }
      // Delta-since-last-tick for sparklines (fairer than cumulative mean).
      const prev = this.lastSeen.get(n) ?? 0;
      const delta = s.count - prev;
      this.lastSeen.set(n, s.count);
      arr.push(delta >= 0 ? s.avg : 0);
      if (arr.length > SERIES_LEN) arr.shift();
    }
    const recent = this.kernel.recentPerf(1000);
    const byType: Record<string, number> = {};
    for (const r of recent) byType[r.type] = (byType[r.type] ?? 0) + 1;
    const series: Record<string, number[]> = {};
    for (const [k, v] of this.series) series[k] = v;
    return {
      kind: 'metrics',
      at: Date.now(),
      tick: this.tick,
      metrics: out,
      perfSummary: { total: recent.length, byType },
      series,
    };
  }

  private pushNewLogs(): void {
    const all = this.kernel.logPipeline().toArray();
    if (all.length < this.logCursor) this.logCursor = 0; // ring was cleared
    const fresh = all.slice(this.logCursor);
    this.logCursor = all.length;
    if (!fresh.length) return;
    // Digest carries TRACE..WARN; WARN+ already went out live. Sending them
    // again is harmless for the UI (dedup by id) and guarantees no gaps.
    //
    // The frame is capped, and the cursor still moves past everything — so the
    // records above the cap are gone. That is acceptable (a burst must not stall
    // the socket) but it must not be *silent*: `dropped` lets the panel say
    // "…412 条已跳过" instead of showing an unexplained jump in the timeline.
    const digest = sliceDigest(fresh, LOG_DIGEST_MAX);
    this.broadcast({
      kind: 'log',
      at: Date.now(),
      records: digest.records.map(toClientLog),
      ...(digest.dropped ? { dropped: digest.dropped } : {}),
    });
  }

  private currentSlowEntries(): SlowEntry[] {
    return this.kernel.slowPaths().slice(-50).map((s) => ({
      spanId: s.id,
      traceId: s.traceId,
      name: s.name,
      durationMs: s.duration ?? 0,
      commandId: s.attributes?.commandId as string | undefined,
      at: Date.now(),
    }));
  }

  // ---------------- client commands ----------------

  applyFilter(filter: PanelFilter): void {
    const pipeline = this.kernel.logPipeline();
    pipeline.setMinLevel(filter.minLevel);
    // Component allow-list is enforced by the pipeline itself, so the filter
    // genuinely reduces what reaches the ring buffer and the transports.
    pipeline.setComponents(filter.components);
    if (filter.messagePattern) {
      try {
        pipeline.setMessagePattern(new RegExp(filter.messagePattern, 'i'));
      } catch {
        this.kernel.logger.root().warn('Panel filter: invalid regex', { pattern: filter.messagePattern });
      }
    } else {
      pipeline.setMessagePattern(undefined);
    }
    this.kernel.logger.root().info('Panel filter applied', {
      minLevel: filter.minLevel,
      components: filter.components?.length ? filter.components.join(',') : '(all)',
      pattern: filter.messagePattern || '(none)',
    });
    this.broadcast({
      kind: 'filter',
      filter: { minLevel: filter.minLevel, components: filter.components, pattern: filter.messagePattern },
    });
  }

  clearLogs(): void {
    this.kernel.logPipeline().clear();
    this.logCursor = 0;
    this.broadcast({ kind: 'logReset', at: Date.now() });
  }

  // ---------------- low-level ----------------

  private broadcast(payload: PanelServerMessage): void {
    if (this.clients.size === 0) return;
    for (const c of this.clients.values()) {
      try {
        c.send(payload);
      } catch {
        this.clients.delete(c.id);
      }
    }
  }
}

export function toClientLog(r: LogRecord): ClientLogRecord {
  return {
    id: r.id,
    ts: Math.round(r.timestamp / 1_000_000),
    level: r.level,
    levelName: LOG_LEVEL_NAMES[r.level] ?? 'INFO',
    component: r.resource.component,
    scope: r.resource.scope,
    message: r.message,
    traceId: r.traceId,
    spanId: r.spanId,
    sessionId: r.correlation.sessionId,
    fileUri: r.scope.fileUri,
    fields: Object.keys(r.fields).length ? r.fields : undefined,
    errorType: r.error?.type,
    errorMessage: r.error?.message,
    tags: r.tags,
  };
}
