import { LogLevel } from './LogLevel.js';
import type { LogCorrelation } from '../correlation/types.js';
import type { LogEnvironment } from '../util/env.js';
// Re-exported: `log/types` is the log slice's public surface, and the
// definition lives in `util` because that is what builds it.
export type { LogEnvironment } from '../util/env.js';


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

/** What a record says it came from. */
export type LogResourceScope =
  | 'kernel' | 'extension' | 'language-server'
  | 'execution' | 'user-code' | 'ai' | 'markdown';
