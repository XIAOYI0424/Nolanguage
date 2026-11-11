import { ulid } from '../util/ulid.js';
import { LogLevel } from './LogLevel.js';
import type {
  LogRecord, LogEnvironment, LogResource, LogCodeScope, LogError,
} from './types.js';
import type { LogCorrelation } from '../correlation/types.js';
import type { LogResourceScope } from './types.js';
import type { Span } from '../perf/types.js';
import type { LogPipeline } from './LogPipeline.js';

export interface Logger {
  trace(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>, error?: Error): void;
  fatal(message: string, fields?: Record<string, unknown>, error?: Error): void;
  metric(name: string, value: number, fields?: Record<string, unknown>): void;
  audit(action: string, actor: string, target: string, result: string): void;
  withContext(ctx: Partial<LogCorrelation>): Logger;
  withScope(scope: Partial<LogCodeScope>): Logger;
  forComponent(name: string): Logger;
  span(span: Span): Logger;
}

interface LoggerBase {
  resourceScope: LogResourceScope;
  component: string;
  extensionId?: string;
  languageId?: string;
  correlation: Partial<LogCorrelation>;
  environment: LogEnvironment;
  codeScope?: Partial<LogCodeScope>;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

/** Logger facade: immutable-chained context (withContext/forComponent/span). */
export class LoggerImpl implements Logger {
  constructor(private base: LoggerBase, private pipeline: LogPipeline) {}

  private toError(e?: Error): LogError | undefined {
    if (!e) return undefined;
    return { type: e.name, message: e.message, stack: e.stack ?? '' };
  }

  private emit(
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
    error?: Error,
    opts?: { tags?: string[] },
  ): void {
    const record: LogRecord = {
      id: ulid(),
      timestamp: Date.now() * 1_000_000, // ms -> ns
      level,
      message,
      traceId: this.base.traceId,
      spanId: this.base.spanId,
      parentSpanId: this.base.parentSpanId,
      resource: {
        scope: this.base.resourceScope,
        component: this.base.component,
        extensionId: this.base.extensionId,
        languageId: this.base.languageId,
      },
      scope: { ...this.base.codeScope },
      correlation: { ...this.base.correlation },
      environment: this.base.environment,
      fields: fields ?? {},
      error: this.toError(error),
      tags: opts?.tags,
    };
    this.pipeline.ingest(record);
  }

  trace(message: string, fields?: Record<string, unknown>): void {
    this.emit(LogLevel.TRACE, message, fields);
  }
  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit(LogLevel.DEBUG, message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.emit(LogLevel.INFO, message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit(LogLevel.WARN, message, fields);
  }
  error(message: string, fields?: Record<string, unknown>, error?: Error): void {
    this.emit(LogLevel.ERROR, message, fields, error);
  }
  fatal(message: string, fields?: Record<string, unknown>, error?: Error): void {
    this.emit(LogLevel.FATAL, message, fields, error);
  }
  metric(name: string, value: number, fields?: Record<string, unknown>): void {
    this.emit(LogLevel.METRIC, name, { ...fields, value }, undefined, { tags: ['perf', 'metric'] });
  }
  audit(action: string, actor: string, target: string, result: string): void {
    this.emit(LogLevel.AUDIT, action, { actor, target, result });
  }

  withContext(ctx: Partial<LogCorrelation>): Logger {
    return new LoggerImpl(
      {
        ...this.base,
        correlation: { ...this.base.correlation, ...ctx },
        // Promote a context traceId to the record's top-level traceId, so
        // `log_record.trace_id` and the correlation skeleton never disagree.
        traceId: ctx.traceId ?? this.base.traceId,
      },
      this.pipeline,
    );
  }

  withScope(scope: Partial<LogCodeScope>): Logger {
    return new LoggerImpl(
      { ...this.base, codeScope: { ...this.base.codeScope, ...scope } },
      this.pipeline,
    );
  }

  forComponent(name: string): Logger {
    return new LoggerImpl({ ...this.base, component: name }, this.pipeline);
  }

  span(span: Span): Logger {
    return new LoggerImpl(
      {
        ...this.base,
        correlation: { ...this.base.correlation, traceId: span.traceId },
        traceId: span.traceId,
        spanId: span.id,
        parentSpanId: span.parentId,
      },
      this.pipeline,
    );
  }
}
