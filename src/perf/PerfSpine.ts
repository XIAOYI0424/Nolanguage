import { ulid } from '../util/ulid.js';
import { performance } from 'node:perf_hooks';
import type { Kernel } from '../kernel/types.js';
import { CommandBusImpl } from '../kernel/CommandBus.js';
import { EventBusImpl } from '../kernel/EventBus.js';
import { ServiceRegistryImpl } from '../kernel/ServiceRegistry.js';
import { LiveMetrics } from './LiveMetrics.js';
import { PerfStore } from './PerfStore.js';
import type {
  PerfEnvelope, PerfMetric, PerfEvent, PerfRecord, PerfResourceScope, PerfEnvironment,
} from './types.js';
import type { CorrelationBus } from '../correlation/CorrelationBus.js';
import type { Span } from './Tracer.js';
import { TracerImpl } from './Tracer.js';

export interface PerfSpineOptions {
  hotCapacity?: number;
  slowThresholdMs?: number;
  env?: PerfEnvironment;
  correlation?: CorrelationBus;
}

/**
 * Performance spine (Stage 1): auto-instrumentation of the three buses.
 *  - Command bus  -> command.latency.{id} metrics + slow-path capture
 *  - Event bus    -> event.emit.duration / event.throughput
 *  - Service reg. -> service.activate.{id} metrics
 * All records share the correlation skeleton (gitCommit / configHash / traceId).
 */
export class PerfSpine {
  readonly metrics = new LiveMetrics(1000);
  private store: PerfStore;
  private slowThresholdMs: number;
  private slowSpans: Span[] = [];
  private env?: PerfEnvironment;
  private correlation?: CorrelationBus;
  private kernel?: Kernel;
  /** Live taps: every accepted PerfRecord, used by the warm-tier sink. */
  private taps: ((record: PerfRecord) => void)[] = [];

  constructor(opts: PerfSpineOptions = {}) {
    this.store = new PerfStore(opts.hotCapacity ?? 20_000);
    this.slowThresholdMs = opts.slowThresholdMs ?? 100;
    this.env = opts.env;
    this.correlation = opts.correlation;
  }

  /**
   * Register a live tap for every PerfRecord entering the hot store. Returns a
   * disposer. Tap failures never propagate to the producer.
   */
  addTap(fn: (record: PerfRecord) => void): () => void {
    this.taps.push(fn);
    return () => {
      const i = this.taps.indexOf(fn);
      if (i >= 0) this.taps.splice(i, 1);
    };
  }

  /** Push into the hot store + notify taps. */
  private emit(record: PerfRecord): void {
    this.store.push(record);
    for (const tap of this.taps) {
      try {
        tap(record);
      } catch {
        // Taps are best-effort.
      }
    }
  }

  install(kernel: Kernel): void {
    this.kernel = kernel;

    kernel.commands.use(async (ctx, next) => {
      const t0 = performance.now();
      const span = kernel.tracer.startSpan('command.execute', { attributes: { commandId: ctx.id } });
      try {
        const result = await next(ctx.args);
        const dur = performance.now() - t0;
        this.recordCommand(ctx.id, dur, 'ok', span.traceId);
        this.detectSlow(span, dur, ctx.id);
        return result;
      } catch (err) {
        const dur = performance.now() - t0;
        this.recordCommand(ctx.id, dur, 'error', span.traceId);
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end({ durationMs: performance.now() - t0 });
      }
    });

    (kernel.events as EventBusImpl).observe((event, dur, count) => {
      this.emit(this.envelope('kernel', {
        type: 'event', category: 'event', name: event, status: 'ok', duration: dur,
      } as PerfEvent));
      this.metrics.record('event.emit.duration', dur);
      this.metrics.record('event.throughput', (count / Math.max(dur, 0.001)) * 1000);
    });

    (kernel.services as ServiceRegistryImpl).setActivationObserver((id, ms, ok) => {
      this.emit(this.envelope('kernel', {
        type: 'metric', name: `service.activate.${id}`, value: ms, unit: 'ms',
      } as PerfMetric));
      this.metrics.record(`service.activate.${id}`, ms);
      this.metrics.record('service.activate', ms);
    });
  }

  private envelope(scope: PerfResourceScope, extra: Partial<PerfRecord>): PerfRecord {
    const base: PerfEnvelope = {
      id: ulid(),
      timestamp: Date.now(),
      resource: { scope },
      scope: {},
      correlation: {
        gitCommit: this.correlation?.gitCommit(),
        configHash: this.correlation?.configHash(),
        traceId: extra.traceId,
      },
      environment: this.env as PerfEnvironment,
    };
    return { ...base, ...extra } as PerfRecord;
  }

  private recordCommand(id: string, dur: number, status: 'ok' | 'error', traceId?: string): void {
    void status;
    this.emit(this.envelope('kernel', {
      type: 'metric', name: `command.latency.${id}`, value: dur, unit: 'ms', traceId,
    } as PerfMetric));
    this.metrics.record(`command.latency.${id}`, dur);
    this.metrics.record('command.latency', dur);
  }

  private detectSlow(span: Span, dur: number, id: string): void {
    if (dur < this.slowThresholdMs) return;
    this.slowSpans.push(span);
    // Broadcast for the dev panel (Stage 2): slow paths are pushed the instant
    // they happen (spec 十: 慢路径立即捕获).
    void this.kernel?.events.emit('perf:slowPath', {
      id: span.id,
      traceId: span.traceId,
      name: span.name,
      duration: dur,
      commandId: id,
      at: Date.now(),
    });
    this.kernel?.logger
      .forComponent('perf.spine')
      .warn('Slow command detected', {
        commandId: id,
        durationMs: Math.round(dur * 100) / 100,
        thresholdMs: this.slowThresholdMs,
      });
  }

  recentPerf(limit = 100): PerfRecord[] {
    return this.store.recent(limit);
  }

  slowPaths(): Span[] {
    return this.slowSpans;
  }

  /**
   * Record a metric that is **correlated** with the trace skeleton: it lands in
   * the live-metrics window (for the panel) *and* as a `PerfMetric` envelope in
   * the hot store carrying traceId / scope / languageId, so a log record's
   * traceId can be cross-queried against perf records (spec 二十二).
   */
  recordMetric(
    name: string,
    value: number,
    opts: {
      unit?: string;
      traceId?: string;
      scope?: PerfResourceScope;
      languageId?: string;
      extensionId?: string;
      fileUri?: string;
      line?: number;
    } = {},
  ): void {
    this.metrics.record(name, value);
    const env = this.envelope(opts.scope ?? 'kernel', {
      type: 'metric',
      name,
      value,
      unit: opts.unit ?? 'ms',
      traceId: opts.traceId,
    } as PerfMetric);
    env.resource.languageId = opts.languageId ?? env.resource.languageId;
    env.resource.extensionId = opts.extensionId ?? env.resource.extensionId;
    env.scope.fileUri = opts.fileUri ?? env.scope.fileUri;
    env.scope.line = opts.line ?? env.scope.line;
    this.emit(env);
  }

  /** Public slow-path check for non-command work (e.g. RPC roundtrips). */
  checkSlow(name: string, durationMs: number, attributes: Record<string, unknown> = {}): boolean {
    if (durationMs < this.slowThresholdMs) return false;
    const span = (this.kernel?.tracer ?? new TracerImpl()).startSpan(name, { attributes });
    span.end();
    // The span's own lifetime is ~0; record the *measured* duration instead so
    // the slow-path panel shows the real cost.
    span.duration = durationMs;
    span.endTime = span.startTime + durationMs;
    this.slowSpans.push(span);
    void this.kernel?.events.emit('perf:slowPath', {
      id: span.id,
      traceId: span.traceId,
      name,
      duration: durationMs,
      commandId: attributes.commandId as string | undefined,
      at: Date.now(),
    });
    return true;
  }

  get thresholdMs(): number {
    return this.slowThresholdMs;
  }
}
