export type PerfResourceScope =
  | 'kernel' | 'extension' | 'language-server'
  | 'execution' | 'user-code' | 'ai';

export interface PerfResource {
  scope: PerfResourceScope;
  languageId?: string;
  extensionId?: string;
  processId?: number;
}

export interface PerfScope {
  workspaceId?: string;
  fileUri?: string;
  line?: number;
  symbol?: string;
  stack?: string;
}

export interface PerfCorrelation {
  gitCommit?: string;
  configHash?: string;
  sessionId?: string;
  benchmarkId?: string;
  traceId?: string;
}

export interface PerfEnvironment {
  os: string;
  arch: string;
  cpuModel?: string;
  cpuCores?: number;
  memoryTotal?: number;
  runtimeVersion?: string;
}

export interface PerfEnvelope {
  id: string;
  traceId?: string;
  parentId?: string;
  timestamp: number;
  duration?: number;
  resource: PerfResource;
  scope: PerfScope;
  correlation: PerfCorrelation;
  environment: PerfEnvironment;
}

export type PerfEvent = PerfEnvelope & {
  type: 'event';
  category: string;
  name: string;
  status: 'ok' | 'error' | 'running';
};
export type PerfSample = PerfEnvelope & {
  type: 'sample';
  profileType: string;
  value: number;
  stack: string;
};
export type PerfMetric = PerfEnvelope & {
  type: 'metric';
  name: string;
  value: number;
  unit: string;
};

export type PerfRecord = PerfEvent | PerfSample | PerfMetric;

/**
 * One span: what a timed operation looks like once it is over.
 *
 * Lives in this zero-import vocabulary file rather than in `Tracer.ts`
 * because the logger records spans too — keeping it here lets `log` point
 * down at a shape instead of sideways at the perf slice.
 */
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

/**
 * Aggregates for one metric over one window.
 *
 * A record shape, so it lives in the vocabulary file: the store persists it
 * and the perf layer computes it, and neither should own it.
 */
export interface MetricSummary {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}
