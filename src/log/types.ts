import { LogLevel } from './LogLevel.js';
import type { LogResourceScope, LogCorrelation } from '../kernel/types.js';
import type { PerfEnvironment } from '../perf/types.js';

/** LogEnvironment = PerfEnvironment + required appVersion. */
export interface LogEnvironment extends PerfEnvironment {
  appVersion: string;
}

export interface LogResource {
  scope: LogResourceScope;
  component: string;
  extensionId?: string;
  languageId?: string;
  processId?: number;
  hostId?: string;
  threadId?: string;
}

export interface LogCodeScope {
  workspaceId?: string;
  fileUri?: string;
  line?: number;
  column?: number;
  function?: string;
}

export interface LogError {
  type: string;
  message: string;
  stack: string;
  code?: string;
  cause?: LogError;
}

export interface LogRecord {
  id: string; // ULID，时间有序
  timestamp: number; // 纳秒精度
  level: LogLevel;
  message: string;

  traceId?: string;
  spanId?: string;
  parentSpanId?: string;

  resource: LogResource;

  scope: LogCodeScope;

  correlation: LogCorrelation;

  environment: LogEnvironment;

  fields: Record<string, unknown>;

  error?: LogError;

  tags?: string[];
  sampled?: boolean;
}
