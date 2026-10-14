import { LOG_LEVEL_NAMES, LogLevel } from '../log/LogLevel.js';
import type { SqliteStore } from './SqliteStore.js';
import type { LogEntry } from './LogQuery.js';
import { hydrateLogRow } from './LogQuery.js';

/**
 * Perf / log fusion (Stage 6 · 基线系统, spec 二十二).
 *
 * LogRecord and PerfEnvelope share the correlation skeleton — traceId /
 * gitCommit / configHash / sessionId / fileUri — so either side can be used to
 * pull up the other. This module exposes the cross-queries.
 */

export interface PerfRow {
  id: string;
  timestamp: number;
  type: string;
  name: string | null;
  value: number | null;
  unit: string | null;
  duration: number | null;
  status: string | null;
  category: string | null;
  profile_type: string | null;
  stack: string | null;
  trace_id: string | null;
  parent_id: string | null;
  scope: string | null;
  language_id: string | null;
  extension_id: string | null;
  process_id: number | null;
  workspace_id: string | null;
  file_uri: string | null;
  line: number | null;
  symbol: string | null;
  git_commit: string | null;
  config_hash: string | null;
  session_id: string | null;
  environment_json: string | null;
}

/** One point on the merged timeline. */
export interface FusionEntry {
  kind: 'log' | 'perf';
  at: number;
  label: string;
  level?: string;
  durationMs?: number;
  id: string;
  traceId?: string;
  raw: LogEntry | PerfRow;
}

export interface FusionResult {
  key: { kind: 'traceId' | 'gitCommit' | 'sessionId' | 'fileUri'; value: string };
  logs: LogEntry[];
  perf: PerfRow[];
  /** Logs + perf records interleaved, ordered by time. */
  timeline: FusionEntry[];
  correlation: {
    gitCommits: string[];
    configHashes: string[];
    sessionIds: string[];
    traceIds: string[];
  };
}

export type FusionKey = 'traceId' | 'gitCommit' | 'sessionId' | 'fileUri';

const LOG_COLUMN: Record<FusionKey, string> = {
  traceId: 'trace_id',
  gitCommit: 'git_commit',
  sessionId: 'session_id',
  fileUri: 'file_uri',
};

const PERF_COLUMN: Record<FusionKey, string> = {
  traceId: 'trace_id',
  gitCommit: 'git_commit',
  sessionId: 'session_id',
  fileUri: 'file_uri',
};

/**
 * Cross-query logs and perf records that share one correlation key.
 *
 * @param limitPerSide cap applied to each side independently (default 500).
 */
export function fuse(
  store: SqliteStore,
  key: FusionKey,
  value: string,
  limitPerSide = 500,
): FusionResult {
  const logs = store
    .raw<Record<string, unknown>>(
      `SELECT * FROM log_record WHERE ${LOG_COLUMN[key]} = ? ORDER BY timestamp ASC LIMIT ?`,
      [value, limitPerSide],
    )
    .map((r) => hydrateLogRow(r as never));

  const perf = store.raw<PerfRow>(
    `SELECT * FROM perf_record WHERE ${PERF_COLUMN[key]} = ? ORDER BY timestamp ASC LIMIT ?`,
    [value, limitPerSide],
  );

  const timeline: FusionEntry[] = [];
  for (const l of logs) {
    timeline.push({
      kind: 'log',
      at: l.timeMs,
      label: l.message,
      level: l.levelName,
      id: l.id,
      traceId: l.trace_id ?? undefined,
      raw: l,
    });
  }
  for (const p of perf) {
    timeline.push({
      kind: 'perf',
      at: p.timestamp,
      label: p.name ?? p.type,
      durationMs: p.duration ?? p.value ?? undefined,
      id: p.id,
      traceId: p.trace_id ?? undefined,
      raw: p,
    });
  }
  timeline.sort((a, b) => a.at - b.at || (a.kind === 'log' ? -1 : 1));

  const uniq = (values: Array<string | null>): string[] =>
    [...new Set(values.filter((v): v is string => !!v))];

  return {
    key: { kind: key, value },
    logs,
    perf,
    timeline,
    correlation: {
      gitCommits: uniq([
        ...logs.map((l) => l.git_commit),
        ...perf.map((p) => p.git_commit),
      ]),
      configHashes: uniq([
        ...logs.map((l) => l.config_hash),
        ...perf.map((p) => p.config_hash),
      ]),
      sessionIds: uniq([
        ...logs.map((l) => l.session_id),
        ...perf.map((p) => p.session_id),
      ]),
      traceIds: uniq([
        ...logs.map((l) => l.trace_id),
        ...perf.map((p) => p.trace_id),
      ]),
    },
  };
}

export const fuseByTrace = (store: SqliteStore, traceId: string, limit?: number) =>
  fuse(store, 'traceId', traceId, limit);
export const fuseByCommit = (store: SqliteStore, commit: string, limit?: number) =>
  fuse(store, 'gitCommit', commit, limit);
export const fuseBySession = (store: SqliteStore, sessionId: string, limit?: number) =>
  fuse(store, 'sessionId', sessionId, limit);
export const fuseByFile = (store: SqliteStore, fileUri: string, limit?: number) =>
  fuse(store, 'fileUri', fileUri, limit);

/**
 * Perf metrics recorded under one trace, reduced to `name -> latest value`.
 * This is the "the slow path is right next to the log that explains it" view.
 */
export function perfMetricsForTrace(
  store: SqliteStore,
  traceId: string,
): Array<{ name: string; value: number; unit: string | null }> {
  const rows = store.raw<{ name: string | null; value: number | null; unit: string | null }>(
    `SELECT name, value, unit FROM perf_record
     WHERE trace_id = ? AND type = 'metric' AND name IS NOT NULL
     ORDER BY timestamp ASC`,
    [traceId],
  );
  const latest = new Map<string, { name: string; value: number; unit: string | null }>();
  for (const r of rows) {
    if (!r.name || r.value === null) continue;
    latest.set(r.name, { name: r.name, value: Number(r.value), unit: r.unit ?? null });
  }
  return [...latest.values()];
}

/**
 * Business code can emit METRIC-level logs (spec 二十二:
 * `logger.metric('cache.hit_rate', 0.85, { cache: 'parser' })`). Those arrive as
 * `level = METRIC` log rows; this extracts them as metric samples so they can be
 * fed into the performance pipeline.
 */
export function metricLogs(store: SqliteStore, limit = 200): Array<{
  name: string;
  value: number;
  fields: Record<string, unknown>;
  at: number;
}> {
  const rows = store.raw<{ message: string; fields_json: string; timestamp: number }>(
    'SELECT message, fields_json, timestamp FROM log_record WHERE level = ? ORDER BY timestamp DESC LIMIT ?',
    [LogLevel.METRIC, limit],
  );
  return rows.map((r) => {
    let fields: Record<string, unknown> = {};
    try {
      fields = JSON.parse(r.fields_json) as Record<string, unknown>;
    } catch {
      fields = {};
    }
    return {
      name: r.message,
      value: Number(fields.value ?? 0),
      fields,
      at: Math.round(r.timestamp / 1_000_000),
    };
  });
}

export { LOG_LEVEL_NAMES };
