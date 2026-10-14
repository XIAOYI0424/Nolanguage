import { LogLevel, LOG_LEVEL_NAMES, levelFromName } from '../log/LogLevel.js';
import type { SqliteStore, LogRow, SqlValue } from './SqliteStore.js';

/**
 * Log query API (Stage 6 · 基线系统, spec 二十一).
 *
 * Structured queries over the warm tier, translated to SQLite. Time bounds are
 * **epoch milliseconds** (what `Date.now()` returns); log rows store nanoseconds,
 * so the translator scales on the way in.
 */

export type FieldOp = '=' | '!=' | '>' | '<' | 'contains';

export interface LogFieldFilter {
  key: string;
  op: FieldOp;
  value: unknown;
}

export interface LogQuery {
  /** Epoch milliseconds. */
  timeRange?: { from?: number; to?: number };
  levels?: LogLevel[];
  minLevel?: LogLevel;
  scopes?: string[];
  components?: string[];
  languageIds?: string[];
  extensionIds?: string[];
  traceId?: string;
  sessionId?: string;
  gitCommit?: string;
  requestId?: string;
  fileUri?: string;
  functionName?: string;
  messageContains?: string;
  /** Applied in JS after the SQL pass (SQLite has no regex engine). */
  messagePattern?: RegExp;
  /** Raw FTS5 MATCH expression against message / fields / error_message. */
  fullTextSearch?: string;
  fields?: LogFieldFilter[];
  tags?: string[];
  hasError?: boolean;
  errorType?: string;
  orderBy?: 'timestamp' | 'level';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** Group counts instead of returning rows (used by `aggregateLogs`). */
  aggregation?: { by: 'level' | 'component' | 'scope' | 'errorType' | 'sessionId' };
}

export interface LogAggregationBucket {
  key: string;
  count: number;
}

/** Safety cap for queries that must be filtered in JS before paging. */
const JS_FILTER_SCAN_CAP = 50_000;

// ---------------- presets (spec 二十一) ----------------

export const LOG_QUERIES = {
  /** Errors and worse in the last N minutes. */
  recentErrors: (minutes = 10): LogQuery => ({
    minLevel: LogLevel.ERROR,
    timeRange: { from: Date.now() - minutes * 60_000, to: Date.now() },
    orderBy: 'timestamp',
    order: 'desc',
    limit: 100,
  }),

  /** Everything that happened inside one trace, oldest first. */
  traceChain: (traceId: string): LogQuery => ({
    traceId,
    orderBy: 'timestamp',
    order: 'asc',
    limit: 1000,
  }),

  /** Recent logs from one component. */
  componentLogs: (component: string, minutes = 10): LogQuery => ({
    components: [component],
    timeRange: { from: Date.now() - minutes * 60_000, to: Date.now() },
    orderBy: 'timestamp',
    order: 'desc',
    limit: 500,
  }),

  /** Logs tied to a source file, newest first. */
  fileLogs: (fileUri: string): LogQuery => ({
    fileUri,
    orderBy: 'timestamp',
    order: 'desc',
    limit: 500,
  }),

  /** The perf-correlated slice of a trace (slow paths + metric logs). */
  perfCorrelated: (traceId: string): LogQuery => ({
    traceId,
    tags: ['slow', 'perf'],
    orderBy: 'timestamp',
    order: 'asc',
    limit: 500,
  }),

  /** Error counts by type over the last N hours. */
  errorSummary: (hours = 24): LogQuery => ({
    minLevel: LogLevel.ERROR,
    timeRange: { from: Date.now() - hours * 3_600_000, to: Date.now() },
    aggregation: { by: 'errorType' },
  }),

  /** Everything recorded against one git commit (spec 十 baseline context). */
  commitLogs: (gitCommit: string): LogQuery => ({
    gitCommit,
    orderBy: 'timestamp',
    order: 'asc',
    limit: 2000,
  }),

  /** Everything recorded in one execution session. */
  sessionLogs: (sessionId: string): LogQuery => ({
    sessionId,
    orderBy: 'timestamp',
    order: 'asc',
    limit: 2000,
  }),

  /** Free-text search across message / fields / error text. */
  search: (text: string, limit = 200): LogQuery => ({
    fullTextSearch: text,
    orderBy: 'timestamp',
    order: 'desc',
    limit,
  }),
} as const;

// ---------------- SQL translation ----------------

export interface BuiltWhere {
  clause: string;
  params: SqlValue[];
  /** True when paging must happen in JS (regex post-filter). */
  postFilter: boolean;
}

export interface BuiltQuery extends BuiltWhere {
  sql: string;
}

function jsonPath(key: string): string {
  return `'$."${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"'`;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** Translate the filter half of a `LogQuery` into a parameterised WHERE clause. */
export function buildLogWhere(q: LogQuery): BuiltWhere {
  const where: string[] = [];
  const params: SqlValue[] = [];
  let postFilter = false;

  if (q.timeRange?.from !== undefined) {
    where.push('timestamp >= ?');
    params.push(Math.round(q.timeRange.from * 1_000_000));
  }
  if (q.timeRange?.to !== undefined) {
    where.push('timestamp <= ?');
    params.push(Math.round(q.timeRange.to * 1_000_000));
  }
  if (q.minLevel !== undefined) {
    where.push('level >= ?');
    params.push(q.minLevel);
    // AUDIT (10) and METRIC (11) sit above FATAL numerically but are orthogonal
    // categories, not severities — so "ERROR and worse" must not sweep them in.
    if (q.minLevel <= LogLevel.FATAL) {
      where.push('level <= ?');
      params.push(LogLevel.FATAL);
    }
  }
  if (q.levels?.length) {
    where.push(`level IN (${placeholders(q.levels.length)})`);
    params.push(...q.levels);
  }
  for (const [col, values] of [
    ['scope', q.scopes],
    ['component', q.components],
    ['language_id', q.languageIds],
    ['extension_id', q.extensionIds],
  ] as Array<[string, string[] | undefined]>) {
    if (values?.length) {
      where.push(`${col} IN (${placeholders(values.length)})`);
      params.push(...values);
    }
  }
  for (const [col, value] of [
    ['trace_id', q.traceId],
    ['session_id', q.sessionId],
    ['git_commit', q.gitCommit],
    ['request_id', q.requestId],
    ['file_uri', q.fileUri],
    ['function_name', q.functionName],
    ['error_type', q.errorType],
  ] as Array<[string, string | undefined]>) {
    if (value !== undefined) {
      where.push(`${col} = ?`);
      params.push(value);
    }
  }
  if (q.messageContains) {
    where.push('message LIKE ?');
    params.push(`%${q.messageContains}%`);
  }
  if (q.hasError === true) where.push('error_type IS NOT NULL');
  if (q.hasError === false) where.push('error_type IS NULL');

  for (const t of q.tags ?? []) {
    where.push('tags_json LIKE ?');
    params.push(`%"${t}"%`);
  }

  for (const f of q.fields ?? []) {
    const path = jsonPath(f.key);
    switch (f.op) {
      case '=':
        where.push(`json_extract(fields_json, ${path}) = ?`);
        params.push(bind(f.value));
        break;
      case '!=':
        // Absent counts as "not equal", matching the intuitive reading.
        where.push(`(json_extract(fields_json, ${path}) IS NULL OR json_extract(fields_json, ${path}) <> ?)`);
        params.push(bind(f.value));
        break;
      case '>':
        where.push(`json_extract(fields_json, ${path}) > ?`);
        params.push(bind(f.value));
        break;
      case '<':
        where.push(`json_extract(fields_json, ${path}) < ?`);
        params.push(bind(f.value));
        break;
      case 'contains':
        where.push(`CAST(json_extract(fields_json, ${path}) AS TEXT) LIKE ?`);
        params.push(`%${String(f.value)}%`);
        break;
    }
  }

  if (q.fullTextSearch) {
    // FTS5 MATCH against the external-content table; join back on rowid.
    where.push('rowid IN (SELECT rowid FROM log_fts WHERE log_fts MATCH ?)');
    params.push(q.fullTextSearch);
  }

  if (q.messagePattern) postFilter = true;

  return {
    clause: where.length ? ` WHERE ${where.join(' AND ')}` : '',
    params,
    postFilter,
  };
}

/** Translate a `LogQuery` into parameterised SQL over `log_record`. */
export function buildLogQuery(q: LogQuery, table = 'log_record'): BuiltQuery {
  const { clause, params, postFilter } = buildLogWhere(q);
  const orderCol = q.orderBy === 'level' ? 'level' : 'timestamp';
  const direction = (q.order ?? 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const all = [...params];
  // `rowid` is the insertion-order tiebreaker: records minted in the same
  // millisecond share a nanosecond timestamp, so the sort must be total.
  let sql = `SELECT * FROM ${table}${clause} ORDER BY ${orderCol} ${direction}, rowid ${direction}`;
  if (!postFilter) {
    sql += ' LIMIT ? OFFSET ?';
    all.push(clampLimit(q.limit), Math.max(0, q.offset ?? 0));
  } else {
    // A JS post-filter needs the full candidate set before paging.
    sql += ' LIMIT ?';
    all.push(JS_FILTER_SCAN_CAP);
  }

  return { sql, params: all, postFilter, clause };
}

function clampLimit(limit?: number): number {
  if (limit === undefined) return 200;
  return Math.max(0, Math.min(50_000, Math.floor(limit)));
}

function bind(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

// ---------------- execution ----------------

/** Hydrated log row: raw columns plus parsed `fields` / `tags`. */
export interface LogEntry extends LogRow {
  fields: Record<string, unknown>;
  tags: string[];
  levelName: string;
  /** Timestamp converted from nanoseconds to epoch ms. */
  timeMs: number;
}

export function hydrateLogRow(row: LogRow): LogEntry {
  return {
    ...row,
    fields: parseJson(row.fields_json, {}),
    tags: parseJson<string[]>(row.tags_json ?? '[]', []),
    levelName: LOG_LEVEL_NAMES[row.level as LogLevel] ?? String(row.level),
    timeMs: Math.round(row.timestamp / 1_000_000),
  };
}

/** Run a query against the warm tier. Returns hydrated entries. */
export function runLogQuery(store: SqliteStore, q: LogQuery): LogEntry[] {
  const built = buildLogQuery(q);
  let rows: LogRow[];
  try {
    rows = store.raw<LogRow>(built.sql, built.params);
  } catch (err) {
    // A malformed FTS5 expression must not blow up the caller — degrade to LIKE.
    if (q.fullTextSearch) {
      const fallback = buildLogQuery({ ...q, fullTextSearch: undefined, messageContains: q.fullTextSearch });
      rows = store.raw<LogRow>(fallback.sql, fallback.params);
    } else {
      throw err;
    }
  }

  let entries = rows.map(hydrateLogRow);
  if (q.messagePattern) {
    const re = q.messagePattern;
    entries = entries.filter((e) => re.test(e.message));
    const offset = Math.max(0, q.offset ?? 0);
    entries = entries.slice(offset, offset + clampLimit(q.limit));
  }
  return entries;
}

/** Row count for a query (ignores limit/offset). */
export function countLogs(store: SqliteStore, q: LogQuery): number {
  const { clause, params } = buildLogWhere({ ...q, limit: undefined, offset: undefined });
  const row = store.raw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM log_record${clause}`,
    params,
  )[0];
  return Number(row?.n ?? 0);
}

/** Group counts for a query (spec 二十一 `errorSummary`). */
export function aggregateLogs(store: SqliteStore, q: LogQuery): LogAggregationBucket[] {
  const by = q.aggregation?.by ?? 'level';
  const column =
    by === 'component' ? 'component'
    : by === 'scope' ? 'scope'
    : by === 'errorType' ? 'error_type'
    : by === 'sessionId' ? 'session_id'
    : 'level';

  const { clause, params } = buildLogWhere({ ...q, limit: undefined, offset: undefined });
  const rows = store.raw<{ key: unknown; n: number }>(
    `SELECT ${column} AS key, COUNT(*) AS n FROM log_record${clause}` +
      ` GROUP BY ${column} ORDER BY n DESC`,
    params,
  );
  return rows.map((r) => ({
    key:
      column === 'level'
        ? LOG_LEVEL_NAMES[Number(r.key) as LogLevel] ?? String(r.key)
        : String(r.key ?? '(none)'),
    count: Number(r.n ?? 0),
  }));
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    const v = JSON.parse(text);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** Convenience: build a query from level names instead of the enum. */
export function levelsFromNames(names: string[]): LogLevel[] {
  return names.map((n) => levelFromName(n));
}
