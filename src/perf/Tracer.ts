import { ulid } from '../util/ulid.js';
import { performance } from 'node:perf_hooks';

export interface Span {
  id: string;
  parentId?: string;
  traceId: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'ok' | 'error' | 'running';
  attributes: Record<string, unknown>;
  end(attrs?: Record<string, unknown>): Span;
  recordException(err: Error): void;
  setAttribute(key: string, value: unknown): Span;
}

export interface Tracer {
  startSpan(name: string, opts?: {
    parentId?: string;
    traceId?: string;
    attributes?: Record<string, unknown>;
  }): Span;
  currentSpan(): Span | undefined;
}

export interface SpanTracer {
  pop(span: Span): void;
}

export class SpanImpl implements Span {
  id: string;
  parentId?: string;
  traceId: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'ok' | 'error' | 'running' = 'running';
  attributes: Record<string, unknown>;
  error?: { message: string; stack?: string };
  private tracer: SpanTracer;

  constructor(tracer: SpanTracer, init: {
    id: string; traceId: string; parentId?: string; name: string;
    attributes: Record<string, unknown>;
  }) {
    this.tracer = tracer;
    this.id = init.id;
    this.traceId = init.traceId;
    this.parentId = init.parentId;
    this.name = init.name;
    this.attributes = init.attributes;
    this.startTime = performance.now();
  }

  end(attrs?: Record<string, unknown>): Span {
    if (this.endTime !== undefined) return this;
    this.endTime = performance.now();
    this.duration = this.endTime - this.startTime;
    this.status = this.status === 'error' ? 'error' : 'ok';
    if (attrs) Object.assign(this.attributes, attrs);
    this.tracer.pop(this);
    return this;
  }

  recordException(err: Error): void {
    this.status = 'error';
    this.error = { message: err.message, stack: err.stack };
  }

  setAttribute(key: string, value: unknown): Span {
    this.attributes[key] = value;
    return this;
  }
}

export class TracerImpl implements Tracer, SpanTracer {
  private stack: SpanImpl[] = [];

  startSpan(name: string, opts: {
    parentId?: string; traceId?: string; attributes?: Record<string, unknown>;
  } = {}): Span {
    const traceId = opts.traceId ?? this.currentTraceId() ?? ulid();
    const parentId = opts.parentId ?? this.stack[this.stack.length - 1]?.id;
    const span = new SpanImpl(this, {
      id: ulid(),
      traceId,
      parentId,
      name,
      attributes: opts.attributes ?? {},
    });
    this.stack.push(span);
    return span;
  }

  currentSpan(): Span | undefined {
    return this.stack[this.stack.length - 1];
  }

  private currentTraceId(): string | undefined {
    return this.stack[this.stack.length - 1]?.traceId;
  }

  pop(span: Span): void {
    const i = this.stack.indexOf(span as SpanImpl);
    if (i >= 0) this.stack.splice(i, 1);
  }
}
