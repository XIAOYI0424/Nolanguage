/**
 * Wire protocol between the kernel process and an extension host child
 * process (spec 16.2 · 多进程汇聚模型 + 18.2 · HostLogCollector).
 *
 * The transport is JSON-RPC 2.0 over stdio with LSP-style framing — the same
 * `JsonRpcConnection` the language servers use, so the host gets the same
 * instrumentation (`rpc.roundtrip.extension.<method>`) for free.
 *
 *   parent → child (requests)   activate / deactivate / command.run / ping
 *   child → parent (notif.)     extension.ready · extension.log.batch
 *                               extension.heartbeat · extension.deactivated
 */
import type { LogLevel } from '../log/LogLevel.js';
import type { LogError } from '../log/types.js';

/** One log record as it travels between processes (JSON-safe). */
export interface SerializedLog {
  level: LogLevel;
  message: string;
  timestamp: number; // ns
  fields?: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
  error?: LogError;
}

/** A batch of records — the child never sends them one by one. */
export interface LogBatchParams {
  extensionId: string;
  records: SerializedLog[];
}

export interface HeartbeatParams {
  extensionId: string;
  rssBytes: number;
  uptimeMs: number;
  active: boolean;
}

export interface ReadyParams {
  extensionId: string;
  pid: number;
}

export interface ActivateParams {
  extensionId: string;
  entryPath: string;
  kernelVersion: string;
  sessionId: string;
}

export interface CommandRunParams {
  id: string;
  args: unknown[];
  /** Trace id of the caller's span, so extension logs can be fused. */
  traceId?: string;
}

export const PROTOCOL = {
  ready: 'extension.ready',
  logBatch: 'extension.log.batch',
  heartbeat: 'extension.heartbeat',
  deactivated: 'extension.deactivated',
  activate: 'activate',
  deactivate: 'deactivate',
  commandRun: 'command.run',
  ping: 'ping',
} as const;

/** Host child states, as the parent sees them. */
export type HostState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'crashed';
