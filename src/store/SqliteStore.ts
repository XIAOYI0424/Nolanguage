import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { LogLevel } from '../log/LogLevel.js';
import type { LogRecord } from '../log/types.js';
import type { PerfRecord } from '../perf/types.js';
import type { BaselineRecord } from '../perf/BaselineStore.js';

/**
 * SQLite warm tier (Stage 6 · 基线系统, spec 20.3 / 20.4 / 十三).
 *
 *   hot (memory ring buffer)  →  warm (SQLite, 30 days)  →  cold (archive files)
 *
 * Zero third-party dependencies: `node:sqlite` is a Node built-in (DatabaseSync
 * + FTS5 + json1 are all available). The cold tier is pluggable — see
 * `Archiver` — because Parquet would require a native dependency, which the
 * lightweight constraint (spec 三十六) forbids. The default archiver writes
 * newline-delimited JSON, one file per day, which is the same partitioning
 * scheme with a different column encoding.
 */

export const SCHEMA_VERSION = 1;

export interface Archiver {
  /** Persist `rows` and return a human-readable location, or '' when skipped. */
  archive(rows: LogRow[], now: number): string;
}

export interface SqliteStoreOptions {
  /** `:memory:` for tests; otherwise a file path. */
  path?: string;
  /** Warm-tier retention in days (spec 20.4: 30). */
  retentionDays?: number;
  /** Directory for rotated-out rows. `null` disables archiving. */
  archiveDir?: string | null;
  /**
   * Keep ERROR / FATAL / AUDIT rows forever in their own tables (spec 20.4).
   * When true, rotation copies them into `log_pinned` before deleting.
   */
  pinSevere?: boolean;
  /** Custom cold-tier writer; defaults to `JsonlArchiver`. */
  archiver?: Archiver;
}

export interface LogRow {
  id: string;
  timestamp: number;
  level: number;
  message: string;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  scope: string;
  component: string | null;
  extension_id: string | null;
  language_id: string | null;
  process_id: number | null;
  host_id: string | null;
  workspace_id: string | null;
  file_uri: string | null;
  line: number | null;
  function_name: string | null;
  git_commit: string | null;
  config_hash: string | null;
  session_id: string | null;
  request_id: string | null;
  fields_json: string;
  error_type: string | null;
  error_message: string | null;
  error_stack: string | null;
  tags_json: string | null;
}

/** Rows removed from the warm tier that must survive in `log_pinned`. */
const PINNED_LEVELS = [LogLevel.ERROR, LogLevel.FATAL, LogLevel.AUDIT];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS log_record (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  level INTEGER NOT NULL,
  message TEXT NOT NULL,
  trace_id TEXT, span_id TEXT, parent_span_id TEXT,
  scope TEXT NOT NULL, component TEXT,
  extension_id TEXT, language_id TEXT,
  process_id INTEGER, host_id TEXT,
  workspace_id TEXT, file_uri TEXT, line INTEGER, function_name TEXT,
  git_commit TEXT, config_hash TEXT, session_id TEXT, request_id TEXT,
  fields_json JSON,
  error_type TEXT, error_message TEXT, error_stack TEXT,
  tags_json JSON
);
CREATE INDEX IF NOT EXISTS idx_log_time       ON log_record(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_log_level_time ON log_record(level, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_log_component  ON log_record(component, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_log_trace      ON log_record(trace_id);
CREATE INDEX IF NOT EXISTS idx_log_commit     ON log_record(git_commit);
CREATE INDEX IF NOT EXISTS idx_log_file       ON log_record(file_uri, line);
CREATE INDEX IF NOT EXISTS idx_log_session    ON log_record(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS log_fts USING fts5(
  message, fields_json, error_message,
  content='log_record', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS log_record_ai AFTER INSERT ON log_record BEGIN
  INSERT INTO log_fts(rowid, message, fields_json, error_message)
  VALUES (new.rowid, new.message, new.fields_json, new.error_message);
END;
CREATE TRIGGER IF NOT EXISTS log_record_ad AFTER DELETE ON log_record BEGIN
  INSERT INTO log_fts(log_fts, rowid, message, fields_json, error_message)
  VALUES ('delete', old.rowid, old.message, old.fields_json, old.error_message);
END;
CREATE TRIGGER IF NOT EXISTS log_record_au AFTER UPDATE ON log_record BEGIN
  INSERT INTO log_fts(log_fts, rowid, message, fields_json, error_message)
  VALUES ('delete', old.rowid, old.message, old.fields_json, old.error_message);
  INSERT INTO log_fts(rowid, message, fields_json, error_message)
  VALUES (new.rowid, new.message, new.fields_json, new.error_message);
END;

-- Severity-pinned rows survive rotation (spec 20.4: FATAL/ERROR/AUDIT 永久保留).
CREATE TABLE IF NOT EXISTS log_pinned (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  level INTEGER NOT NULL,
  message TEXT NOT NULL,
  trace_id TEXT, scope TEXT, component TEXT, session_id TEXT, git_commit TEXT,
  fields_json JSON, error_type TEXT, error_message TEXT, error_stack TEXT,
  tags_json JSON,
  pinned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pinned_level ON log_pinned(level, timestamp DESC);

-- Performance records: the perf half of the fusion skeleton (spec 二十二).
CREATE TABLE IF NOT EXISTS perf_record (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT, value REAL, unit TEXT, duration REAL, status TEXT,
  category TEXT, profile_type TEXT, stack TEXT,
  trace_id TEXT, parent_id TEXT,
  scope TEXT, language_id TEXT, extension_id TEXT, process_id INTEGER,
  workspace_id TEXT, file_uri TEXT, line INTEGER, symbol TEXT,
  git_commit TEXT, config_hash TEXT, session_id TEXT,
  environment_json JSON
);
CREATE INDEX IF NOT EXISTS idx_perf_time   ON perf_record(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_perf_name   ON perf_record(name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_perf_trace  ON perf_record(trace_id);
CREATE INDEX IF NOT EXISTS idx_perf_commit ON perf_record(git_commit);
CREATE INDEX IF NOT EXISTS idx_perf_session ON perf_record(session_id);

-- Long-term metric baselines, one row per (commit, checkpoint) (spec 十).
CREATE TABLE IF NOT EXISTS baseline (
  id TEXT PRIMARY KEY,
  git_commit TEXT NOT NULL,
  git_branch TEXT,
  config_hash TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  app_version TEXT,
  label TEXT,
  reason TEXT,
  metrics_json JSON NOT NULL,
  metric_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_baseline_commit ON baseline(git_commit, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_baseline_time   ON baseline(created_at DESC);
`;

/** Default cold tier: one newline-delimited JSON file per day. */
export class JsonlArchiver implements Archiver {
  constructor(private dir: string) {}

  archive(rows: LogRow[], now: number): string {
    if (!rows.length) return '';
    const day = new Date(now).toISOString().slice(0, 10);
    const file = join(this.dir, `${day}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return file;
  }
}

export class SqliteStore {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly retentionDays: number;
  private readonly archiveDir: string | null;
  private readonly archiver?: Archiver;
  private readonly pinSevere: boolean;
  private closed = false;
  private readonly cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(opts: SqliteStoreOptions = {}) {
    this.path = opts.path ?? defaultDbPath();
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.retentionDays = opts.retentionDays ?? 30;
    this.archiveDir = opts.archiveDir === undefined ? defaultArchiveDir(this.path) : opts.archiveDir;
    this.pinSevere = opts.pinSevere ?? true;
    this.archiver =
      opts.archiver ??
      (this.archiveDir ? new JsonlArchiver(this.archiveDir) : undefined);
    this.migrate();
  }

  /** Create tables/indexes/triggers and stamp `user_version`. */
  migrate(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
    // Wait rather than fail when another process holds the write lock
    // (e.g. two IDE servers against the same telemetry database).
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA_SQL);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  get schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  // ---------------- statement helpers ----------------

  /**
   * Prepare (and cache) a statement with BigInt reads enabled.
   *
   * Nanosecond timestamps exceed `Number.MAX_SAFE_INTEGER`, and node:sqlite
   * throws `ERR_OUT_OF_RANGE` for any 64-bit integer it cannot represent as a
   * JS number. Reading as BigInt and down-converting in `rows()` keeps the
   * full ns precision on disk while returning usable JS values.
   */
  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      s.setReadBigInts(true);
      this.cache.set(sql, s);
    }
    return s;
  }

  private rows<T>(sql: string, params: SqlValue[] = []): T[] {
    return (this.stmt(sql).all(...params) as Record<string, unknown>[]).map(normaliseRow) as T[];
  }

  private row<T>(sql: string, params: SqlValue[] = []): T | undefined {
    const r = this.stmt(sql).get(...params) as Record<string, unknown> | undefined;
    return r === undefined ? undefined : (normaliseRow(r) as T);
  }

  // ---------------- writes ----------------

  insertLog(record: LogRecord, now = Date.now()): void {
    const row = toLogRow(record, now);
    this.stmt(INSERT_LOG_SQL).run(...LOG_ROW_ORDER.map((k) => row[k]));
  }

  /** Batch insert inside a single transaction (the LogSink flush path). */
  insertLogs(records: LogRecord[]): number {
    if (!records.length) return 0;
    const stmt = this.stmt(INSERT_LOG_SQL);
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        const row = toLogRow(r, now);
        stmt.run(...LOG_ROW_ORDER.map((k) => row[k]));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return records.length;
  }

  insertPerf(record: PerfRecord, now = Date.now()): void {
    this.stmt(INSERT_PERF_SQL).run(...toPerfParams(record, now));
  }

  insertPerfs(records: PerfRecord[]): number {
    if (!records.length) return 0;
    const stmt = this.stmt(INSERT_PERF_SQL);
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const r of records) stmt.run(...toPerfParams(r, now));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return records.length;
  }

  insertBaseline(record: BaselineRecord): void {
    this.stmt(INSERT_BASELINE_SQL).run(
      record.id,
      record.gitCommit,
      record.gitBranch ?? null,
      record.configHash ?? null,
      record.sessionId ?? null,
      record.createdAt,
      record.appVersion ?? null,
      record.label ?? null,
      record.reason ?? null,
      JSON.stringify(record.metrics),
      Object.keys(record.metrics).length,
    );
  }

  // ---------------- reads ----------------

  /** Raw escape hatch used by the LogQuery translator. */
  raw<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] {
    return this.rows<T>(sql, params);
  }

  getLogById(id: string): LogRow | undefined {
    return this.row<LogRow>('SELECT * FROM log_record WHERE id = ?', [id]);
  }

  baselinesByCommit(commit: string): BaselineRecord[] {
    const rows = this.rows<Record<string, unknown>>(
      'SELECT * FROM baseline WHERE git_commit = ? ORDER BY created_at DESC, id DESC',
      [commit],
    );
    return rows.map(rowToBaseline);
  }

  /** Most recent baseline overall, optionally excluding one id. */
  latestBaseline(excludeId?: string): BaselineRecord | undefined {
    return this.baselines(-1, excludeId)[0];
  }

  /** Newest-first baseline rows, with an optional cap. */
  baselines(limit = 100, excludeId?: string): BaselineRecord[] {
    const sql = 'SELECT * FROM baseline ORDER BY created_at DESC, id DESC' + (limit > 0 ? ' LIMIT ?' : '');
    const params = limit > 0 ? [limit] : [];
    const rows = this.rows<Record<string, unknown>>(sql, params);
    return rows.map(rowToBaseline).filter((b) => b.id !== excludeId);
  }

  /** Latest baseline for a specific commit, optionally excluding one id. */
  latestBaselineForCommit(commit: string, excludeId?: string): BaselineRecord | undefined {
    return this.baselinesByCommit(commit).find((b) => b.id !== excludeId);
  }

  // ---------------- stats + rotation ----------------

  stats(): StoreStats {
    const count = (table: string): number => {
      const r = this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      return Number(r?.n ?? 0);
    };
    const range = this.row<{ lo: number | null; hi: number | null }>(
      'SELECT MIN(timestamp) AS lo, MAX(timestamp) AS hi FROM log_record',
    );
    return {
      path: this.path,
      schemaVersion: this.schemaVersion,
      retentionDays: this.retentionDays,
      logCount: count('log_record'),
      perfCount: count('perf_record'),
      baselineCount: count('baseline'),
      pinnedCount: count('log_pinned'),
      ftsCount: count('log_fts'),
      oldestLogNs: range?.lo ?? null,
      newestLogNs: range?.hi ?? null,
    };
  }

  /**
   * Rotation + retention (spec 20.4). Rows older than the retention window are
   * archived to the cold tier and removed from the warm tier — except
   * ERROR/FATAL/AUDIT, which are copied into `log_pinned` and kept forever.
   */
  rotate(now = Date.now()): RotationResult {
    const cutoffNs = (now - this.retentionDays * 86_400_000) * 1_000_000;
    const expired = this.rows<LogRow>(
      'SELECT * FROM log_record WHERE timestamp < ? ORDER BY timestamp ASC',
      [cutoffNs],
    );
    if (!expired.length) return { scanned: 0, archived: 0, pinned: 0, deleted: 0, archivePath: '' };

    let pinned = 0;
    const archiveRows: LogRow[] = [];
    const pinStmt = this.stmt(PIN_LOG_SQL);
    for (const row of expired) {
      if (this.pinSevere && PINNED_LEVELS.includes(row.level as LogLevel)) {
        pinStmt.run(
          row.id, row.timestamp, row.level, row.message, row.trace_id, row.scope, row.component,
          row.session_id, row.git_commit, row.fields_json, row.error_type, row.error_message,
          row.error_stack, row.tags_json, now,
        );
        pinned++;
      } else {
        archiveRows.push(row);
      }
    }

    const archivePath = this.archiver ? this.archiver.archive(archiveRows, now) : '';
    const del = this.stmt('DELETE FROM log_record WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const row of expired) del.run(row.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return {
      scanned: expired.length,
      archived: archiveRows.length,
      pinned,
      deleted: expired.length,
      archivePath,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Already closed / never opened — nothing to do.
    }
  }
}

export interface StoreStats {
  path: string;
  schemaVersion: number;
  retentionDays: number;
  logCount: number;
  perfCount: number;
  baselineCount: number;
  pinnedCount: number;
  ftsCount: number;
  oldestLogNs: number | null;
  newestLogNs: number | null;
}

export interface RotationResult {
  scanned: number;
  archived: number;
  pinned: number;
  deleted: number;
  archivePath: string;
}

export type SqlValue = string | number | null | Uint8Array;

// ---------------- row mapping ----------------

const LOG_COLUMNS = [
  'id', 'timestamp', 'level', 'message',
  'trace_id', 'span_id', 'parent_span_id',
  'scope', 'component', 'extension_id', 'language_id', 'process_id', 'host_id',
  'workspace_id', 'file_uri', 'line', 'function_name',
  'git_commit', 'config_hash', 'session_id', 'request_id',
  'fields_json', 'error_type', 'error_message', 'error_stack', 'tags_json',
] as const;

const LOG_ROW_ORDER: readonly (keyof LogRow)[] = LOG_COLUMNS;

const INSERT_LOG_SQL =
  `INSERT OR REPLACE INTO log_record (${LOG_COLUMNS.join(', ')})\n` +
  `VALUES (${LOG_COLUMNS.map(() => '?').join(', ')})`;

/** LogRecord (nested, ns timestamps) → flat SQLite row. */
export function toLogRow(r: LogRecord, now = Date.now()): LogRow {
  return {
    id: r.id,
    timestamp: r.timestamp ?? now * 1_000_000,
    level: r.level,
    message: r.message,
    trace_id: r.traceId ?? r.correlation?.traceId ?? null,
    span_id: r.spanId ?? null,
    parent_span_id: r.parentSpanId ?? null,
    scope: r.resource?.scope ?? 'kernel',
    component: r.resource?.component ?? null,
    extension_id: r.resource?.extensionId ?? null,
    language_id: r.resource?.languageId ?? null,
    process_id: r.resource?.processId ?? process.pid,
    host_id: r.resource?.hostId ?? hostId(),
    workspace_id: r.scope?.workspaceId ?? null,
    file_uri: r.scope?.fileUri ?? null,
    line: r.scope?.line ?? null,
    function_name: r.scope?.function ?? null,
    git_commit: r.correlation?.gitCommit ?? null,
    config_hash: r.correlation?.configHash ?? null,
    session_id: r.correlation?.sessionId ?? null,
    request_id: r.correlation?.requestId ?? null,
    fields_json: safeJson(r.fields ?? {}),
    error_type: r.error?.type ?? null,
    error_message: r.error?.message ?? null,
    error_stack: r.error?.stack ?? null,
    tags_json: r.tags && r.tags.length ? safeJson(r.tags) : null,
  };
}

const PERF_COLUMNS = [
  'id', 'timestamp', 'type', 'name', 'value', 'unit', 'duration', 'status',
  'category', 'profile_type', 'stack',
  'trace_id', 'parent_id',
  'scope', 'language_id', 'extension_id', 'process_id',
  'workspace_id', 'file_uri', 'line', 'symbol',
  'git_commit', 'config_hash', 'session_id', 'environment_json',
] as const;

const INSERT_PERF_SQL =
  `INSERT OR REPLACE INTO perf_record (${PERF_COLUMNS.join(', ')})\n` +
  `VALUES (${PERF_COLUMNS.map(() => '?').join(', ')})`;

function toPerfParams(r: PerfRecord, now = Date.now()): SqlValue[] {
  const any = r as Record<string, unknown>;
  return [
    r.id,
    r.timestamp ?? now,
    any.type as string,
    (any.name as string) ?? null,
    num(any.value),
    (any.unit as string) ?? null,
    num(any.duration),
    (any.status as string) ?? null,
    (any.category as string) ?? null,
    (any.profileType as string) ?? null,
    (any.stack as string) ?? null,
    r.traceId ?? null,
    (r.parentId as string) ?? null,
    r.resource?.scope ?? null,
    r.resource?.languageId ?? null,
    r.resource?.extensionId ?? null,
    r.resource?.processId ?? process.pid,
    r.scope?.workspaceId ?? null,
    r.scope?.fileUri ?? null,
    r.scope?.line ?? null,
    r.scope?.symbol ?? null,
    r.correlation?.gitCommit ?? null,
    r.correlation?.configHash ?? null,
    r.correlation?.sessionId ?? null,
    safeJson(r.environment ?? {}),
  ];
}

const INSERT_BASELINE_SQL =
  `INSERT OR REPLACE INTO baseline
   (id, git_commit, git_branch, config_hash, session_id, created_at,
    app_version, label, reason, metrics_json, metric_count)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

const PIN_LOG_SQL =
  `INSERT OR REPLACE INTO log_pinned
   (id, timestamp, level, message, trace_id, scope, component, session_id, git_commit,
    fields_json, error_type, error_message, error_stack, tags_json, pinned_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** Convert BigInt columns (timestamps, counts) back into JS numbers. */
function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'bigint') row[k] = Number(v);
  }
  return row;
}

function rowToBaseline(row: Record<string, unknown>): BaselineRecord {
  return {
    id: String(row.id),
    gitCommit: String(row.git_commit ?? 'unknown'),
    gitBranch: (row.git_branch as string) ?? undefined,
    configHash: (row.config_hash as string) ?? undefined,
    sessionId: (row.session_id as string) ?? undefined,
    createdAt: Number(row.created_at ?? 0),
    appVersion: (row.app_version as string) ?? undefined,
    label: (row.label as string) ?? undefined,
    reason: (row.reason as string) ?? undefined,
    metrics: JSON.parse(String(row.metrics_json ?? '{}')),
  };
}

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '{}';
  } catch {
    return '{}';
  }
}

let cachedHostId: string | undefined;
function hostId(): string {
  if (cachedHostId === undefined) cachedHostId = os.hostname() || 'unknown';
  return cachedHostId;
}

function defaultDbPath(): string {
  if (process.env.NOLANGUAGE_DB) return process.env.NOLANGUAGE_DB;
  // Packaged build: keep telemetry next to the executable instead of whatever
  // directory Explorer happened to open from.
  if (process.env.NOLANGUAGE_PACKAGED === '1') {
    return join(dirname(process.execPath), '.nolanguage', 'telemetry.db');
  }
  return join(process.cwd(), '.nolanguage', 'telemetry.db');
}

function defaultArchiveDir(dbPath: string): string | null {
  if (dbPath === ':memory:') return null;
  return join(dirname(dbPath), 'archive');
}
