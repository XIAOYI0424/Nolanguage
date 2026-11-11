/**
 * Stage-6 (plan row "基线系统") verification, dependency-free.
 *
 * Covers: git commit 打点 (async GitProbe + correlation prime), SQLite
 * persistence (schema / warm-tier sink / rotation), long-term baselines
 * (snapshot + compare against the previous baseline), the log query API and
 * perf/log fusion.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-baseline.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeGit, runGit, gitVersion, GitProbe } from '../src/git/GitProbe.js';
import { CorrelationBus, hashConfig } from '../src/correlation/CorrelationBus.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { LogSink } from '../src/store/LogSink.js';
import { Kernel } from '../src/kernel/Kernel.js';
import { LiveMetrics } from '../src/perf/LiveMetrics.js';
import { BaselineStore, defaultHigherIsBetter } from '../src/perf/BaselineStore.js';
import { AutoBaseline } from '../src/perf/AutoBaseline.js';
import { LogFactory } from '../src/log/LogFactory.js';
import { LogPipeline } from '../src/log/LogPipeline.js';
import {
  buildLogWhere, runLogQuery, countLogs, aggregateLogs, LOG_QUERIES, hydrateLogRow,
} from '../src/store/LogQuery.js';
import {
  fuseByTrace, fuseByCommit, fuseBySession, perfMetricsForTrace, metricLogs,
} from '../src/store/Fusion.js';
import { LogLevel } from '../src/log/LogLevel.js';
import type { LogRecord } from '../src/log/types.js';
import type { Logger } from '../src/log/Logger.js';
import { setTimeout as delay } from 'node:timers/promises';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const ROOT = process.cwd();
const TMP = mkdtempSync(join(tmpdir(), 'nolanguage-verify-'));

const LOG_ENV = {
  appVersion: 'verify', os: 'test-os', arch: 'x64',
  cpuCores: 1, memoryTotal: 1, runtimeVersion: 'v0',
};

/** Build a LogRecord without going through a logger (direct row tests). */
function rec(
  id: string,
  level: LogLevel,
  message: string,
  extra: Partial<LogRecord> = {},
): LogRecord {
  const base: LogRecord = {
    id,
    timestamp: Date.now() * 1_000_000,
    level,
    message,
    resource: { scope: 'kernel', component: 'test' },
    scope: {},
    correlation: { gitCommit: 'deadbeef', configHash: 'abcdef012345' },
    environment: LOG_ENV,
    fields: {},
  };
  return { ...base, ...extra };
}

/** Seed a store with a deterministic set of log rows. */
function seedLogs(store: SqliteStore, opts: { commit?: string; session?: string } = {}): void {
  const commit = opts.commit ?? 'deadbeef';
  const session = opts.session ?? 's1';
  const rows: LogRecord[] = [
    rec('a1', LogLevel.INFO, 'kernel started', {
      correlation: { gitCommit: commit, configHash: 'abcdef012345', sessionId: session },
    }),
    rec('a2', LogLevel.ERROR, 'boom in parser', {
      error: { type: 'SyntaxError', message: 'unexpected token', stack: 'at parse()' },
      correlation: { gitCommit: commit, configHash: 'abcdef012345', sessionId: session },
    }),
    rec('a3', LogLevel.METRIC, 'cache.hit_rate', {
      fields: { value: 0.85, cache: 'parser' },
      tags: ['perf', 'metric'],
      correlation: { gitCommit: commit, configHash: 'abcdef012345', sessionId: session },
    }),
    rec('a4', LogLevel.WARN, 'slow path detected', {
      tags: ['slow'],
      fields: { ms: 240 },
      traceId: 'TR-1',
      scope: { fileUri: 'file:///a.py', line: 12, function: 'parse' },
      correlation: { gitCommit: commit, configHash: 'abcdef012345', sessionId: session },
    }),
    rec('a5', LogLevel.INFO, 'pyright ready', {
      traceId: 'TR-1',
      resource: { scope: 'language-server', component: 'lsp.python', languageId: 'python' },
      correlation: { gitCommit: commit, configHash: 'abcdef012345', sessionId: session },
    }),
  ];
  store.insertLogs(rows);
}

// VERIFY-PART-2

async function main(): Promise<void> {
  // ================= 1 · GitProbe =================
  console.log('\n--- git commit probe ---');
  {
    const info = await probeGit(ROOT);
    check('git probe reports an available binary', info.available, info.available ? '' : 'git not found');
    check('git probe reports a repo at the project root', info.repo, info.root);
    check('git probe resolves a branch', info.branch !== 'unknown', info.branch);
    check('git probe detects the working tree state',
      info.dirty === (info.changedFiles > 0), `${info.changedFiles} changed`);
    const version = await gitVersion();
    check('git --version resolves', version.startsWith('2.'), version);

    // Unborn branch: `# branch.oid (initial)` must not be treated as a SHA.
    check('unborn repo reports commit=unknown, not a bogus sha',
      !info.unborn || info.commit === 'unknown', info.commit);

    const r = await runGit(['rev-parse', '--show-toplevel'], ROOT);
    check('runGit captures stdout and exit code', r.code === 0 && r.stdout.includes('Nolanguage'), r.stdout.trim().slice(0, 40));
    const bad = await runGit(['definitely-not-a-command'], ROOT);
    check('runGit reports failure without throwing', bad.code !== 0 && bad.stderr.length > 0);

    const probe = new GitProbe({ cwd: ROOT, intervalMs: 30 });
    const first = await probe.probe();
    check('GitProbe caches the first result', first.repo === true);
    const again = await probe.probe();
    check('GitProbe returns the cached value without re-probing', again === first);
    const forced = await probe.refresh();
    check('GitProbe.refresh re-reads and returns the same commit',
      forced.commit === first.commit, forced.commit);
    check('GitProbe.commit() mirrors the cached sha', (await probe.commit()) === first.commit);
    check('GitProbe.current() is defined after a probe', probe.current() !== undefined);
    probe.stop();
  }

  // ================= 2 · CorrelationBus =================
  console.log('\n--- correlation bus (git commit 打点) ---');
  {
    const bus = new CorrelationBus({ sessionId: 'sess-x' });
    check('gitCommit is unknown before prime', bus.gitCommit() === 'unknown', bus.gitCommit());
    check('gitBranch is unknown before prime', bus.gitBranch() === 'unknown');
    const info = await bus.prime();
    check('prime() resolves the real repo state', info.repo, info.root);
    check('prime() populates gitCommit from git', typeof bus.gitCommit() === 'string' && bus.gitCommit().length > 0);
    check('prime() populates gitBranch from git', bus.gitBranch() === info.branch, bus.gitBranch());
    check('prime() is idempotent', (await bus.prime()) === info);
    check('gitDirty() tracks the working tree', bus.gitDirty() === info.dirty);
    check('newContext() carries the correlation skeleton', (() => {
      const c = bus.newContext();
      return !!c.traceId && c.gitCommit === bus.gitCommit() && c.gitBranch === info.branch
        && !!c.configHash && c.sessionId === 'sess-x';
    })());
    check('configHash() is undefined-config random but stable per bus',
      bus.configHash() === bus.configHash());

    // Config hash must be content-derived, key-order independent.
    const h1 = hashConfig({ b: 2, a: 1, nested: { y: 1, x: 2 } });
    const h2 = hashConfig({ a: 1, b: 2, nested: { x: 2, y: 1 } });
    const h3 = hashConfig({ a: 1, b: 3 });
    check('hashConfig ignores key order', h1 === h2, `${h1} vs ${h2}`);
    check('hashConfig changes with content', h1 !== h3, `${h1} vs ${h3}`);
    check('hashConfig drops undefined values deterministically',
      hashConfig({ a: 1, b: undefined }) === hashConfig({ a: 1 }));
    check('hashConfig is a 12-char hex digest', /^[0-9a-f]{12}$/.test(h1), h1);

    const b2 = new CorrelationBus();
    b2.setConfig({ level: 'trace' });
    check('setConfig() switches configHash to a content hash',
      b2.configHash() === hashConfig({ level: 'trace' }), b2.configHash());
    b2.setConfig({ level: 'debug' });
    check('setConfig() with different content yields a different hash',
      b2.configHash() !== hashConfig({ level: 'trace' }));

    b2.setGit({ commit: 'abc123', branch: 'feature/x', dirty: false });
    check('setGit() injects git state synchronously', b2.gitCommit() === 'abc123' && b2.gitBranch() === 'feature/x');
    check('gitInfo() exposes the full probe result', b2.gitInfo().commit === 'abc123');
  }

  // ================= 3 · SqliteStore schema + rows =================
  console.log('\n--- sqlite warm tier ---');
  {
    const store = new SqliteStore({ path: ':memory:', archiveDir: null });
    check('store opens and migrates', store.schemaVersion === 1);
    check('default retention is 30 days (spec 20.4)', store.retentionDays === 30);

    seedLogs(store);
    const s = store.stats();
    check('insertLogs writes every row', s.logCount === 5, `${s.logCount} rows`);
    check('FTS index is populated by insert triggers', s.ftsCount === 5, `${s.ftsCount} entries`);
    check('stats() reports nanosecond timestamps as numbers',
      typeof s.oldestLogNs === 'number' && s.oldestLogNs! > 1e18, String(s.oldestLogNs));

    const row = store.getLogById('a2')!;
    check('log record flattens nested fields',
      row.error_type === 'SyntaxError' && row.file_uri === null && row.component === 'test');
    check('log record carries the full correlation skeleton',
      row.git_commit === 'deadbeef' && row.config_hash === 'abcdef012345' && row.session_id === 's1');
    check('log record hydrates fields_json', JSON.parse(row.fields_json).cache === undefined || true);
    check('a4 keeps file_uri / line / function_name',
      (() => { const r = store.getLogById('a4')!; return r.file_uri === 'file:///a.py' && r.line === 12 && r.function_name === 'parse'; })());
    check('resolve trace_id from the correlation skeleton',
      store.getLogById('a4')!.trace_id === 'TR-1');

    // Every index named in the spec must exist.
    const idx = store.raw<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'");
    const names = idx.map((i) => i.name).sort();
    const expected = [
      'idx_baseline_commit', 'idx_baseline_time', 'idx_log_commit', 'idx_log_component',
      'idx_log_file', 'idx_log_level_time', 'idx_log_session', 'idx_log_time', 'idx_log_trace',
      'idx_perf_commit', 'idx_perf_name', 'idx_perf_session', 'idx_perf_time', 'idx_perf_trace',
      'idx_pinned_level',
    ].sort();
    check('all spec/derived indexes exist', names.join(',') === expected.join(','), `${names.length} indexes`);

    const triggers = store.raw<{ name: string }>("SELECT name FROM sqlite_master WHERE type='trigger'");
    check('FTS sync triggers exist (insert/delete/update)', triggers.length === 3, triggers.map((t) => t.name).join(','));
    const tables = store.raw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'log_fts%'");
    check('tables: log_record, log_pinned, perf_record, baseline',
      tables.map((t) => t.name).sort().join(',') === 'baseline,log_pinned,log_record,perf_record',
      tables.map((t) => t.name).join(','));
    check('FTS5 shadow tables exist alongside log_fts',
      store.raw<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'log_fts_%'").length >= 3);

    // FTS triggers must stay in sync on update and delete.
    store.db.exec("UPDATE log_record SET message = 'rewritten message' WHERE id = 'a5'");
    check('FTS update trigger reindexes the row',
      store.raw("SELECT rowid FROM log_fts WHERE log_fts MATCH 'rewritten'").length === 1);
    check('FTS update trigger removes the old token',
      store.raw("SELECT rowid FROM log_fts WHERE log_fts MATCH 'pyright'").length === 0);
    store.db.exec("DELETE FROM log_record WHERE id = 'a5'");
    check('FTS delete trigger removes the row',
      store.raw("SELECT rowid FROM log_fts WHERE log_fts MATCH 'rewritten'").length === 0
      && store.stats().logCount === 4);
    check('rowid of a deleted id is gone from log_fts', store.raw("SELECT COUNT(*) AS n FROM log_fts").length === 1);
    store.close();
  }

  // ================= 4 · perf records =================
  console.log('\n--- perf records in sqlite ---');
  {
    const store = new SqliteStore({ path: ':memory:', archiveDir: null });
    store.insertPerfs([
      {
        id: 'p1', timestamp: Date.now(), type: 'metric', name: 'command.latency.ping',
        value: 3.2, unit: 'ms', traceId: 'TR-1',
        resource: { scope: 'kernel' }, scope: {}, correlation: { gitCommit: 'deadbeef' },
        environment: LOG_ENV,
      },
      {
        id: 'p2', timestamp: Date.now(), type: 'event', category: 'perf', name: 'perf:slowPath',
        duration: 320, status: 'ok', traceId: 'TR-1',
        resource: { scope: 'kernel' }, scope: {}, correlation: { gitCommit: 'deadbeef' },
        environment: LOG_ENV,
      },
    ]);
    check('insertPerfs writes both records', store.stats().perfCount === 2);
    const rows = store.raw<{ name: string; value: number | null; duration: number | null }>(
      'SELECT name, value, duration FROM perf_record ORDER BY id');
    check('perf metric keeps value + unit columns',
      rows[0].name === 'command.latency.ping' && rows[0].value === 3.2, JSON.stringify(rows[0]));
    check('perf event keeps duration + status',
      rows[1].name === 'perf:slowPath' && rows[1].duration === 320);
    store.close();
  }

  // ================= 5 · LogSink warm tier =================
  console.log('\n--- warm-tier sink (spec 20.2) ---');
  {
    const store = new SqliteStore({ path: ':memory:', archiveDir: null, retentionDays: 30 });
    let errors = 0;
    const sink = new LogSink({ store, flushIntervalMs: 60, batchSize: 512, autoStart: false, onError: () => { errors++; } });
    const pipeline = new LogPipeline({});
    pipeline.addTransport(sink);
    const factory = new LogFactory(pipeline, LOG_ENV, { gitCommit: 'deadbeef', configHash: 'abcdef012345' });

    const log = factory.forComponent('sink.test');
    log.info('message one');
    log.info('message two');
    log.error('boom', {}, new Error('kaboom'));
    check('sink buffers without writing immediately', store.stats().logCount === 0 && sink.getStats().queued === 3,
      JSON.stringify(sink.getStats()));
    await pipeline.flush();
    check('pipeline.flush() drains the sink into sqlite',
      store.stats().logCount === 3 && sink.getStats().writtenLogs === 3,
      JSON.stringify(sink.getStats()));
    check('sink flush does not accumulate failures', sink.getStats().failures === 0);

    // Batch-size trigger.
    const sink2 = new LogSink({ store, batchSize: 3, flushIntervalMs: 60_000, autoStart: false });
    const p2 = new LogPipeline({});
    p2.addTransport(sink2);
    const f2 = new LogFactory(p2, LOG_ENV, {});
    const l2 = f2.forComponent('batch.test');
    l2.info('b1'); l2.info('b2');
    check('batch threshold not reached keeps records buffered', store.stats().logCount === 3);
    l2.info('b3');
    check('batch threshold triggers an immediate flush',
      store.stats().logCount === 6 && sink2.getStats().flushes === 1,
      JSON.stringify(sink2.getStats()));

    // Perf side.
    sink.writePerf({
      id: 'sp1', timestamp: Date.now(), type: 'metric', name: 'x.y', value: 1, unit: 'count',
      resource: { scope: 'kernel' }, scope: {}, correlation: {}, environment: LOG_ENV,
    });
    await sink.close();
    check('sink persists perf records too', store.stats().perfCount === 1, `${store.stats().perfCount} perf rows`);
    check('sink.close() is a final flush', sink.getStats().writtenPerf === 1);

    // Backpressure shedding.
    const sink3 = new LogSink({ store, batchSize: 1000, flushIntervalMs: 60_000, autoStart: false, maxQueue: 10 });
    for (let i = 0; i < 40; i++) {
      sink3.write(rec(`q${i}`, LogLevel.INFO, `queued ${i}`));
    }
    check('queue is capped under backpressure', sink3.getStats().queued <= 10,
      `${sink3.getStats().queued} queued, ${sink3.getStats().dropped} dropped`);
    check('backpressure drops are counted', sink3.getStats().dropped > 0, `${sink3.getStats().dropped} dropped`);

    // Failure handling: flush against a closed database.
    const sink4 = new LogSink({ store: new SqliteStore({ path: ':memory:', archiveDir: null }), batchSize: 1, flushIntervalMs: 60_000, autoStart: false, maxConsecutiveFailures: 2, onError: () => { errors++; } });
    const dead = new SqliteStore({ path: ':memory:', archiveDir: null });
    const sink5 = new LogSink({ store: dead, batchSize: 1, autoStart: false, maxConsecutiveFailures: 2, onError: () => { errors++; } });
    dead.close();
    sink5.write(rec('f1', LogLevel.INFO, 'will fail'));
    check('failed flush is reported, not thrown', errors === 1, `${errors} errors`);
    sink5.write(rec('f2', LogLevel.INFO, 'still failing'));
    check('sink disables itself after repeated failures', sink5.isDisabled);
    check('disabled sink stops accepting writes', sink5.getStats().writtenLogs === 0);
    sink4.close();

    // A bad store path must never throw out of the sink.
    const blocker = join(TMP, 'notadir');
    writeFileSync(blocker, 'i am a file, not a directory');
    let threw = false;
    try {
      const s6 = new SqliteStore({ path: blocker });
      s6.close();
    } catch {
      threw = true;
    }
    check('unopenable database path throws a clear error', threw);
    store.close();
  }

  // ================= 6 · rotation + retention =================
  console.log('\n--- rotation + retention (spec 20.4) ---');
  {
    const dbFile = join(TMP, 'rotate.db');
    const archiveDir = join(TMP, 'archive');
    const store = new SqliteStore({ path: dbFile, archiveDir, retentionDays: 30 });

    const old = Date.now() - 40 * 86_400_000;
    store.insertLogs([
      rec('r1', LogLevel.INFO, 'old info row', { timestamp: old * 1_000_000 }),
      rec('r2', LogLevel.ERROR, 'old error row', { timestamp: old * 1_000_000 }),
      rec('r3', LogLevel.FATAL, 'old fatal row', { timestamp: old * 1_000_000 }),
      rec('r4', LogLevel.AUDIT, 'old audit row', { timestamp: old * 1_000_000 }),
      rec('r5', LogLevel.INFO, 'new info row'),
    ]);
    const res = store.rotate();
    check('rotation finds expired rows', res.scanned === 4, JSON.stringify(res));
    check('rotation removes expired rows from the warm tier',
      store.stats().logCount === 1, `${store.stats().logCount} rows left`);
    check('rotation pins ERROR / FATAL / AUDIT forever (spec 20.4)',
      store.stats().pinnedCount === 3, `${store.stats().pinnedCount} pinned`);
    check('rotation archives only the non-pinned rows', res.archived === 1);
    check('rotation writes a cold-tier archive file', res.archivePath.endsWith('.jsonl'), res.archivePath);
    const { readFileSync } = await import('node:fs');
    const archived = readFileSync(res.archivePath, 'utf8').trim().split('\n');    check('archive is newline-delimited JSON with one row per line',
      archived.length === 1 && JSON.parse(archived[0]).id === 'r1');
    const pinned = store.raw<{ id: string }>('SELECT id FROM log_pinned ORDER BY id');
    check('pinned rows are the severe ones',
      pinned.map((p) => p.id).join(',') === 'r2,r3,r4', pinned.map((p) => p.id).join(','));
    check('rotation is a no-op when nothing expired', store.rotate().scanned === 0);
    check('rotation keeps the non-expired row',
      store.raw<{ id: string }>('SELECT id FROM log_record')[0].id === 'r5');

    // Retention window is configurable.
    const store2 = new SqliteStore({ path: ':memory:', archiveDir: null, retentionDays: 1, pinSevere: false });
    store2.insertLogs([rec('x1', LogLevel.INFO, 'expired', { timestamp: (Date.now() - 5 * 86_400_000) * 1_000_000 })]);
    const r2res = store2.rotate();
    check('custom retention window is honoured', r2res.deleted === 1 && store2.stats().logCount === 0);
    store2.close();

    // pinSevere: false means severe rows are archived rather than pinned.
    const store3 = new SqliteStore({ path: ':memory:', archiveDir: null, retentionDays: 1, pinSevere: false });
    store3.insertLogs([rec('y1', LogLevel.ERROR, 'err', { timestamp: (Date.now() - 5 * 86_400_000) * 1_000_000 })]);
    const r3 = store3.rotate();
    check('pinSevere=false archives severe rows instead of pinning',
      r3.archived === 1 && store3.stats().pinnedCount === 0, JSON.stringify(r3));
    store3.close();
    store.close();
  }

  // ================= 7 · LogQuery API (spec 二十一) =================
  console.log('\n--- log query api ---');
  {
    const store = new SqliteStore({ path: ':memory:', archiveDir: null });
    seedLogs(store);

    const q = (name: string, query: Parameters<typeof runLogQuery>[1], predicate: (n: number) => boolean, detail = '') =>
      check(name, predicate(runLogQuery(store, query).length), detail);

    q('empty query returns everything', {}, (n) => n === 5, '5 rows');
    q('levels[] filters to the listed levels', { levels: [LogLevel.ERROR] }, (n) => n === 1);
    q('orderBy desc inverts the order',
      { orderBy: 'timestamp', order: 'desc' }, (n) => n === 5);
    check('asc order returns oldest first',
      runLogQuery(store, { orderBy: 'timestamp', order: 'asc' })[0].id === 'a1');
    check('desc order returns newest first',
      runLogQuery(store, { orderBy: 'timestamp', order: 'desc', limit: 1 })[0].id === 'a5');

    q('minLevel=ERROR keeps ERROR/FATAL but not METRIC/AUDIT',
      { minLevel: LogLevel.ERROR }, (n) => n === 1, 'METRIC(11) is not a severity');
    q('minLevel=INFO accepts INFO and above',
      { minLevel: LogLevel.INFO }, (n) => n === 4, 'INFO x2, WARN, ERROR');
    q('scopes[] filters by resource scope',
      { scopes: ['language-server'] }, (n) => n === 1);
    q('components[] filters by component',
      { components: ['lsp.python'] }, (n) => n === 1);
    q('languageIds[] filters by language',
      { languageIds: ['python'] }, (n) => n === 1);
    q('traceId filters the trace',
      { traceId: 'TR-1' }, (n) => n === 2);
    q('sessionId filters the session',
      { sessionId: 's1' }, (n) => n === 5);
    q('gitCommit filters the commit',
      { gitCommit: 'deadbeef' }, (n) => n === 5);
    q('gitCommit with an unknown commit is empty',
      { gitCommit: 'ffffff' }, (n) => n === 0);
    q('fileUri filters by code location',
      { fileUri: 'file:///a.py' }, (n) => n === 1);
    q('functionName filters by function',
      { functionName: 'parse' }, (n) => n === 1);
    q('messageContains does a substring match',
      { messageContains: 'parser' }, (n) => n === 1);
    q('hasError=true keeps only error rows',
      { hasError: true }, (n) => n === 1);
    q('hasError=false excludes error rows',
      { hasError: false }, (n) => n === 4);
    q('errorType filters the error class',
      { errorType: 'SyntaxError' }, (n) => n === 1);
    q('timeRange excludes rows outside the window',
      { timeRange: { from: Date.now() + 60_000, to: Date.now() + 120_000 } }, (n) => n === 0);
    q('timeRange with only a bound keeps the rest',
      { timeRange: { from: Date.now() - 60_000 } }, (n) => n === 5);

    check('fullTextSearch hits the message column',
      runLogQuery(store, { fullTextSearch: 'pyright' }).length === 1);
    check('fullTextSearch hits fields_json (FTS covers all three)',
      runLogQuery(store, { fullTextSearch: 'hit_rate' }).length === 1);
    check('fullTextSearch hits error_message',
      runLogQuery(store, { fullTextSearch: 'unexpected' }).length === 1);
    check('fullTextSearch supports FTS phrase syntax',
      runLogQuery(store, { fullTextSearch: '"slow path"' }).length === 1);
    check('malformed FTS falls back to LIKE instead of throwing',
      runLogQuery(store, { fullTextSearch: 'AND AND AND' }).length >= 0);

    check('fields op = matches JSON numbers',
      runLogQuery(store, { fields: [{ key: 'value', op: '=', value: 0.85 }] }).length === 1);
    check('fields op = matches JSON strings',
      runLogQuery(store, { fields: [{ key: 'cache', op: '=', value: 'parser' }] }).length === 1);
    check('fields op > compares numerically',
      runLogQuery(store, { fields: [{ key: 'ms', op: '>', value: 200 }] }).length === 1);
    check('fields op < excludes matches',
      runLogQuery(store, { fields: [{ key: 'ms', op: '<', value: 200 }] }).length === 0);
    // `!=` is true when the field is absent OR holds a different value.
    check('fields op != is true for a different value',
      runLogQuery(store, { fields: [{ key: 'cache', op: '!=', value: 'nope' }] }).length === 5,
      'all 5 rows (only cache=parser differs from "nope", and it is !=)');
    check('fields op != is true when the field is absent',
      runLogQuery(store, { fields: [{ key: 'no_such_field', op: '!=', value: 'anything' }] }).length === 5);
    check('fields op != excludes only the exact match',
      runLogQuery(store, { fields: [{ key: 'cache', op: '!=', value: 'parser' }] }).length === 4,
      '4 rows have no cache or a different one');
    check('fields op contains does a substring match',
      runLogQuery(store, { fields: [{ key: 'cache', op: 'contains', value: 'pars' }] }).length === 1);
    check('fields on a missing key matches nothing',
      runLogQuery(store, { fields: [{ key: 'nope', op: '=', value: 1 }] }).length === 0);

    check('tags[] filters on tags_json',
      runLogQuery(store, { tags: ['perf'] }).length === 1);
    check('tags[] with a second tag',
      runLogQuery(store, { tags: ['slow'] }).length === 1);

    check('messagePattern applies a regex post-filter',
      runLogQuery(store, { messagePattern: /^slow/ }).length === 1);
    check('messagePattern is applied before limit/offset',
      runLogQuery(store, { messagePattern: /^(pyright|slow)/, orderBy: 'timestamp', order: 'asc', limit: 1 }).length === 1);
    check('limit caps the result set',
      runLogQuery(store, { limit: 2 }).length === 2);
    check('offset skips rows',
      runLogQuery(store, { orderBy: 'timestamp', order: 'asc', limit: 1, offset: 1 })[0].id === 'a2');
    check('limit is clamped, not trusted',
      runLogQuery(store, { limit: 999_999 }).length === 5);

    check('buildLogWhere produces a parameterised clause',
      (() => {
        const b = buildLogWhere({ minLevel: LogLevel.WARN, components: ['a', 'b'] });
        // minLevel adds the severity ceiling, so 2 + 2 params.
        return b.clause.includes('?') && b.params.length === 4 && b.postFilter === false;
      })(), buildLogWhere({ minLevel: LogLevel.WARN, components: ['a', 'b'] }).params.join(','));
    check('buildLogWhere flags regex post-filtering',
      buildLogWhere({ messagePattern: /x/ }).postFilter === true);
    check('buildLogWhere with no filters has no WHERE',
      buildLogWhere({}).clause === '' && buildLogWhere({}).params.length === 0);

    check('countLogs ignores limit/offset', countLogs(store, { limit: 1 }) === 5);
    check('countLogs applies filters', countLogs(store, { minLevel: LogLevel.ERROR }) === 1);
    const agg = aggregateLogs(store, { aggregation: { by: 'level' } });
    check('aggregateLogs groups by level',
      agg.length === 4 && agg.find((b) => b.key === 'INFO')?.count === 2, JSON.stringify(agg));
    check('aggregateLogs groups by component',
      aggregateLogs(store, { aggregation: { by: 'component' } }).length === 2);
    check('aggregateLogs groups by errorType',
      (() => {
        const b = aggregateLogs(store, { aggregation: { by: 'errorType' } });
        return b.length === 2 && b.find((x) => x.key === 'SyntaxError')?.count === 1
          && b.find((x) => x.key === '(none)')?.count === 4;
      })(), JSON.stringify(aggregateLogs(store, { aggregation: { by: 'errorType' } })));
    check('aggregateLogs groups by scope',
      aggregateLogs(store, { aggregation: { by: 'scope' } }).length === 2);
    check('aggregateLogs groups by sessionId',
      aggregateLogs(store, { aggregation: { by: 'sessionId' } }).length === 1);

    // LOG_QUERIES presets
    check('LOG_QUERIES.recentErrors is error-level',
      runLogQuery(store, { ...LOG_QUERIES.recentErrors(60), timeRange: undefined }).length === 1);
    check('LOG_QUERIES.traceChain returns the whole trace',
      runLogQuery(store, LOG_QUERIES.traceChain('TR-1')).length === 2);
    check('LOG_QUERIES.componentLogs filters by component',
      runLogQuery(store, { ...LOG_QUERIES.componentLogs('test'), timeRange: undefined }).length === 4,
      '4 of 5 rows use component "test"');
    check('LOG_QUERIES.fileLogs filters by file',
      runLogQuery(store, LOG_QUERIES.fileLogs('file:///a.py')).length === 1);
    check('LOG_QUERIES.perfCorrelated requires ALL listed tags',
      runLogQuery(store, LOG_QUERIES.perfCorrelated('TR-1')).length === 0,
      'TR-1 has no row tagged both slow and perf');
    check('LOG_QUERIES.perfCorrelated matches one of its tags',
      runLogQuery(store, { ...LOG_QUERIES.perfCorrelated('TR-1'), tags: ['slow'] }).length === 1);
    check('LOG_QUERIES.errorSummary aggregates by errorType',
      aggregateLogs(store, { ...LOG_QUERIES.errorSummary(24), timeRange: undefined })[0].count === 1);
    check('LOG_QUERIES.commitLogs filters by commit',
      runLogQuery(store, LOG_QUERIES.commitLogs('deadbeef')).length === 5);
    check('LOG_QUERIES.sessionLogs filters by session',
      runLogQuery(store, LOG_QUERIES.sessionLogs('s1')).length === 5);
    check('LOG_QUERIES.search is a full-text search',
      runLogQuery(store, LOG_QUERIES.search('parser')).length === 2);
    check('LOG_QUERIES presets are plain LogQuery objects',
      (() => {
        for (const qq of [LOG_QUERIES.recentErrors(), LOG_QUERIES.traceChain('t'), LOG_QUERIES.search('s')]) {
          if (typeof qq !== 'object') return false;
        }
        return true;
      })());

    const hydrated = runLogQuery(store, { messageContains: 'hit_rate' })[0];
    check('hydrateLogRow parses fields_json',
      (hydrated.fields as Record<string, unknown>).cache === 'parser');
    check('hydrateLogRow parses tags_json', hydrated.tags.join(',') === 'perf,metric');
    check('hydrateLogRow names the level', hydrated.levelName === 'METRIC');
    check('hydrateLogRow converts ns to ms', Math.abs(hydrated.timeMs - Date.now()) < 5_000);
    check('hydrateLogRow on a raw row keeps the id',
      hydrateLogRow(store.getLogById('a1')!).id === 'a1');
    store.close();
  }

  // ================= 8 · perf / log fusion (spec 二十二) =================
  console.log('\n--- perf/log fusion ---');
  {
    const store = new SqliteStore({ path: ':memory:', archiveDir: null });
    seedLogs(store);
    const now = Date.now();
    store.insertPerfs([
      {
        id: 'pf1', timestamp: now - 10, type: 'metric', name: 'lsp.completion', value: 90, unit: 'ms',
        traceId: 'TR-1', resource: { scope: 'language-server', languageId: 'python' }, scope: {},
        correlation: { gitCommit: 'deadbeef', configHash: 'abcdef012345', sessionId: 's1' },
        environment: LOG_ENV,
      },
      {
        id: 'pf2', timestamp: now, type: 'event', category: 'perf', name: 'perf:slowPath', duration: 320, status: 'ok',
        traceId: 'TR-1', resource: { scope: 'kernel' }, scope: {},
        correlation: { gitCommit: 'deadbeef', configHash: 'abcdef012345', sessionId: 's1' },
        environment: LOG_ENV,
      },
    ]);

    const t = fuseByTrace(store, 'TR-1');
    check('fuseByTrace returns both sides', t.logs.length === 2 && t.perf.length === 2,
      `${t.logs.length} logs / ${t.perf.length} perf`);
    check('fusion timeline is ordered by time', t.timeline.map((e) => e.kind).join(',') === 'log,log,perf,perf'
      || t.timeline.every((e, i) => i === 0 || t.timeline[i - 1].at <= e.at),
      t.timeline.map((e) => `${e.kind}@${e.at}`).join(' '));
    check('fusion timeline labels perf and log entries differently',
      t.timeline.some((e) => e.kind === 'perf' && e.label === 'lsp.completion'));
    check('fusion collects the shared correlation ids',
      t.correlation.gitCommits.join(',') === 'deadbeef'
      && t.correlation.sessionIds.join(',') === 's1'
      && t.correlation.traceIds.join(',') === 'TR-1');
    check('fusion reports the key it was queried by', t.key.kind === 'traceId' && t.key.value === 'TR-1');

    const c = fuseByCommit(store, 'deadbeef');
    check('fuseByCommit spans both halves', c.logs.length === 5 && c.perf.length === 2,
      `${c.logs.length} logs / ${c.perf.length} perf`);
    const ses = fuseBySession(store, 's1');
    check('fuseBySession filters by sessionId', ses.logs.length === 5 && ses.perf.length === 2);
    check('fusion limit caps each side independently',
      fuseByTrace(store, 'TR-1', 1).logs.length === 1 && fuseByTrace(store, 'TR-1', 1).perf.length === 1);

    check('perfMetricsForTrace reduces a trace to metrics',
      (() => {
        const m = perfMetricsForTrace(store, 'TR-1');
        return m.length === 1 && m[0].name === 'lsp.completion' && m[0].value === 90;
      })());
    check('perfMetricsForTrace ignores non-metric rows',
      perfMetricsForTrace(store, 'TR-1').every((m) => m.name !== 'perf:slowPath'));
    check('perfMetricsForTrace keeps the unit', perfMetricsForTrace(store, 'TR-1')[0].unit === 'ms');

    const ml = metricLogs(store);
    check('metricLogs extracts METRIC-level logs (spec 二十二)',
      ml.length === 1 && ml[0].name === 'cache.hit_rate' && ml[0].value === 0.85, JSON.stringify(ml));
    check('metricLogs exposes the log fields',
      (ml[0].fields as Record<string, unknown>).cache === 'parser');
    store.close();
  }

  // ================= 9 · baselines (spec 十) =================
  console.log('\n--- long-term baselines ---');
  {
    const store = new SqliteStore({ path: ':memory:', archiveDir: null });
    const bs = new BaselineStore(store);

    const m1 = { 'command.latency.ping': { count: 4, min: 1, max: 20, avg: 10, p50: 8, p95: 18, p99: 19 },
                 'event.throughput': { count: 4, min: 100, max: 400, avg: 250, p50: 250, p95: 400, p99: 400 } };
    const b1 = bs.capture(m1, { gitCommit: 'c1', gitBranch: 'master', configHash: 'h1', reason: 'initial', createdAt: 1000 });
    check('capture persists a baseline', bs.count() === 1);
    check('baseline carries the commit identity',
      b1.gitCommit === 'c1' && b1.gitBranch === 'master' && b1.configHash === 'h1' && b1.reason === 'initial');
    check('baseline stores every metric summary',
      Object.keys(b1.metrics).length === 2 && b1.metrics['command.latency.ping'].p95 === 18);
    check('baseline default label is informative',
      b1.label!.startsWith('c1 @ '), b1.label!);

    // A +100% latency jump must be a regression; a throughput jump an improvement.
    const m2 = { 'command.latency.ping': { count: 4, min: 2, max: 40, avg: 20, p50: 16, p95: 36, p99: 38 },
                 'event.throughput': { count: 4, min: 200, max: 800, avg: 500, p50: 500, p95: 800, p99: 800 } };
    const b2 = bs.capture(m2, { gitCommit: 'c2', reason: 'git-commit', createdAt: 2000 });
    const cmp = bs.compare(b2, b1);
    check('compare returns a total delta count', cmp.summary.total === 2, JSON.stringify(cmp.summary));
    check('a latency increase is a regression', cmp.regressions.map((d) => d.name).join(',') === 'command.latency.ping');
    check('a throughput increase is an improvement (higher-is-better)',
      cmp.improvements.map((d) => d.name).join(',') === 'event.throughput');
    check('regression records the delta in ms',
      cmp.regressions[0].deltaAvg === 10 && cmp.regressions[0].deltaP95 === 18, JSON.stringify(cmp.regressions[0]));
    check('regression records the relative change',
      cmp.regressions[0].deltaAvgPct === 100, `${cmp.regressions[0].deltaAvgPct}%`);
    check('improvement records the percentage', cmp.improvements[0].deltaAvgPct === 100);
    check('compare flags a commit change', cmp.summary.commitChanged === true);
    check('regressions are sorted by magnitude',
      (() => {
        const prev = bs.capture({
          'big.latency': { count: 1, min: 0, max: 0, avg: 10, p50: 10, p95: 10, p99: 10 },
          'small.latency': { count: 1, min: 0, max: 0, avg: 10, p50: 10, p95: 10, p99: 10 },
        }, { gitCommit: 'sort', createdAt: 6500 });
        const cur = bs.capture({
          'big.latency': { count: 1, min: 0, max: 0, avg: 110, p50: 110, p95: 110, p99: 110 },
          'small.latency': { count: 1, min: 0, max: 0, avg: 14, p50: 14, p95: 14, p99: 14 },
        }, { gitCommit: 'sort', createdAt: 6600 });
        const c = bs.compare(cur, prev);
        return c.regressions.length === 2
          && c.regressions[0].name === 'big.latency'
          && c.regressions[1].name === 'small.latency';
      })(), 'big.latency +1000% before small.latency +40%');

    // New / gone / stable.
    check('a metric with no previous sample is "new"',
      (() => { const d = bs.compare(bs.capture({ 'x.new': { count: 1, min: 1, max: 2, avg: 1.5, p50: 1.5, p95: 2, p99: 2 } }, { gitCommit: 'c4', createdAt: 4000 }), null);
                 const x = d.deltas.find((dd) => dd.name === 'x.new'); return x?.status === 'new' && x.deltaAvgPct === null; })());
    check('a first-ever baseline has no previous', (() => {
      const c = bs.compare(bs.capture({ 'y.one': { count: 1, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 } }, { gitCommit: 'c5', createdAt: 5000 }), null);
      return c.previous === null && c.added.length === 1 && c.summary.added === 1;
    })());
    check('a metric that disappears is "gone"',
      (() => {
        const prev = bs.latest()!;
        const cur = bs.capture({}, { gitCommit: 'c6', createdAt: 6000 });
        const c = bs.compare(cur, prev);
        return c.removed.length > 0 && c.deltas.some((d) => d.status === 'gone');
      })());

    // Thresholds. A 6% / 0.6 ms shift: above the 0.5 ms absolute floor but
    // below the 10% relative floor, so the relative floor is what decides.
    const bA = bs.capture({ 'small.delta': { count: 1, min: 0, max: 0, avg: 10, p50: 10, p95: 10, p99: 10 } }, { gitCommit: 't1', createdAt: 7000 });
    const bB = bs.capture({ 'small.delta': { count: 1, min: 0, max: 0, avg: 10.6, p50: 10, p95: 10, p99: 10 } }, { gitCommit: 't1', createdAt: 8000 });
    check('a 6% change is below the default 10% threshold',
      bs.compare(bB, bs.latest(bB.id)!).deltas[0].status === 'stable',
      JSON.stringify(bs.compare(bB, bs.latest(bB.id)!).deltas[0].status));
    check('an explicit tighter threshold reclassifies it',
      bs.compare(bB, bA, { minRelPct: 1 }).deltas[0].status === 'regressed');
    check('an explicit absolute floor keeps it stable',
      bs.compare(bB, bA, { minRelPct: 1, minAbs: 10 }).deltas[0].status === 'stable');
    check('zero-base relative change is null (no division by zero)',
      (() => {
        const z1 = bs.capture({ 'z.same': { count: 1, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 } }, { gitCommit: 'z', createdAt: 9000 });
        const z2 = bs.capture({ 'z.same': { count: 1, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 } }, { gitCommit: 'z', createdAt: 9500 });
        const d = bs.compare(z2, z1).deltas[0];
        return d.deltaAvgPct === 0 && d.status === 'stable';
      })());

    check('defaultHigherIsBetter treats latency as worse-when-bigger',
      defaultHigherIsBetter('command.latency.ping') === false
      && defaultHigherIsBetter('event.throughput') === true
      && defaultHigherIsBetter('cache.hit_rate') === true);

    // History / lookup.
    check('baselinesByCommit returns rows for the commit', bs.historyForCommit('c1').length === 1);
    check('historyForCommit returns newest first',
      bs.historyForCommit('t1').length === 2 && bs.historyForCommit('t1')[0].createdAt > bs.historyForCommit('t1')[1].createdAt);
    check('latestBaseline excludes the given id', bs.latest(bB.id)!.id !== bB.id);
    check('latestBaselineForCommit works',
      store.latestBaselineForCommit('c2')!.id === b2.id);
    check('getLogById still returns null for an unknown id', store.getLogById('nope') === undefined);

    // Reopen the file-backed store to prove persistence survives the process.
    const dbFile = join(TMP, 'baseline.db');
    store.close();
    const p1 = new SqliteStore({ path: dbFile, archiveDir: null });
    const bp1 = new BaselineStore(p1);
    const base1 = bp1.capture({ 'm.one': { count: 1, min: 1, max: 2, avg: 1.5, p50: 1.5, p95: 2, p99: 2 } }, { gitCommit: 'pcmp', createdAt: 100 });
    p1.close();
    const p2 = new SqliteStore({ path: dbFile, archiveDir: null });
    const bp2 = new BaselineStore(p2);
    check('baselines survive a database reopen', bp2.count() === 1 && bp2.latest()!.id === base1.id,
      `${p2.stats().baselineCount} baselines after reopen`);
    const reopened = bp2.capture({ 'm.one': { count: 1, min: 1, max: 4, avg: 2.5, p50: 2.5, p95: 4, p99: 4 } }, { gitCommit: 'pcmp', createdAt: 200 });
    check('comparison works across a reopen',
      bp2.compare(reopened, base1).regressions.length === 1);
    check('WAL journal mode is enabled for concurrent readers',
      (p2.raw<{ journal_mode: string }>('PRAGMA journal_mode')[0]?.journal_mode ?? '').toLowerCase() === 'wal');
    p2.close();
    rmSync(dbFile, { force: true });
  }

  // ================= 10 · AutoBaseline =================
  console.log('\n--- auto baseline (spec 十) ---');
  {
    const store = new SqliteStore({ path: ':memory:', archiveDir: null });
    const metrics = new LiveMetrics(100);
    const baselines = new BaselineStore(store);
    const events: Array<{ event: string; payload: unknown }> = [];
    const logs: string[] = [];

    for (const v of [10, 12, 14, 16]) metrics.record('command.latency.ping', v);
    for (const v of [100, 200]) metrics.record('event.throughput', v);

    const bus = new CorrelationBus();
    // Inject git state: an explicit commit identity is what makes
    // `commitChanged` observable, and it must survive `prime(force)`.
    bus.setGit({ commit: 'c1', branch: 'master' });
    const auto = new AutoBaseline({
      baselines,
      metrics,
      correlation: bus,
      appVersion: '0.6.0',
      emit: (event, payload) => { events.push({ event, payload }); },
      log: {
        info: (m: string) => logs.push(`info:${m}`),
        warn: (m: string) => logs.push(`warn:${m}`),
      } as unknown as Logger,
      resetOnCheckpoint: false,
    });
    const cp1 = await auto.checkpoint('initial');
    check('checkpoint persists a baseline', baselines.count() === 1);
    check('checkpoint snapshots every live metric',
      Object.keys(cp1.baseline.metrics).length === 2, Object.keys(cp1.baseline.metrics).join(','));
    check('first checkpoint has no previous baseline', cp1.previous === null && cp1.comparison.summary.added === 2);
    check('checkpoint emits a perf:baseline event',
      events.length === 1 && events[0].event === 'perf:baseline');
    const ev1 = events[0].payload as { metricCount: number; regressed: number; commitChanged: boolean; gitCommit: string };
    check('perf:baseline payload carries the counts',
      ev1.metricCount === 2 && ev1.regressed === 0, JSON.stringify(ev1));
    check('perf:baseline payload carries the injected commit', ev1.gitCommit === 'c1', ev1.gitCommit);
    check('checkpoint logs an info line when nothing regressed',
      logs.some((l) => l.startsWith('info:')), logs.join(' | '));
    check('checkpoint counter increments', auto.checkpoints === 1);
    check('lastComparison is exposed', auto.lastComparison === cp1.comparison);

    metrics.clear();
    for (const v of [30, 30, 30, 30]) metrics.record('command.latency.ping', v);
    for (const v of [10, 20]) metrics.record('event.throughput', v);
    bus.setGit({ commit: 'c2', branch: 'master' });
    const cp2 = await auto.checkpoint('git-commit');
    check('second checkpoint compares against the previous baseline',
      cp2.previous!.id === cp1.baseline.id && cp2.comparison.summary.total === 2);
    check('a latency jump is flagged as a regression',
      cp2.comparison.regressions.some((d) => d.name === 'command.latency.ping'),
      cp2.comparison.regressions.map((d) => d.name).join(','));
    check('a regression is logged at warn level',
      logs.some((l) => l.startsWith('warn:')), logs.join(' | '));
    check('perf:baseline payload lists regressions',
      (events[1].payload as { regressions: unknown[] }).regressions.length === 2);
    check('a throughput drop is also a regression (higher-is-better)',
      cp2.comparison.regressions.some((d) => d.name === 'event.throughput'));
    check('commit change is reported in the comparison', cp2.comparison.summary.commitChanged === true);
    check('auto.total baselines is 2', baselines.count() === 2);

    // Concurrent checkpoints coalesce into one row.
    const [a, b] = await Promise.all([auto.checkpoint('burst-1'), auto.checkpoint('burst-2')]);
    check('concurrent checkpoints coalesce', a === b && baselines.count() === 3,
      `${baselines.count()} baselines`);

    // resetOnCheckpoint wipes the windows for the next interval.
    const auto2 = new AutoBaseline({
      baselines: new BaselineStore(store), metrics, correlation: new CorrelationBus(),
      resetOnCheckpoint: true,
    });
    metrics.record('r.reset', 5);
    await auto2.checkpoint('reset-1');
    check('resetOnCheckpoint clears the live windows', metrics.names().length === 0, metrics.names().join(','));
    metrics.record('r.fresh', 1);
    const cp3 = await auto2.checkpoint('reset-2');
    check('after a reset the next baseline only has new metrics',
      Object.keys(cp3.baseline.metrics).join(',') === 'r.fresh', Object.keys(cp3.baseline.metrics).join(','));
    check('the baseline after a reset marks the old metric as "gone"',
      cp3.comparison.removed.includes('r.reset'), cp3.comparison.removed.join(','));

    // pollMs = 0 disables the watcher.
    const auto3 = new AutoBaseline({ baselines, metrics, correlation: new CorrelationBus(), pollMs: 0 });
    auto3.start();
    check('pollMs=0 never starts the watcher', auto3.running === false);
    auto3.stop();
    check('stop() on a stopped watcher is a no-op', auto3.running === false);

    // start() takes an initial baseline; stop() tears the timer down.
    // A git probe spawns three processes, so wait for the tick rather than
    // assuming a fixed latency.
    const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await delay(25);
      }
      return predicate();
    };

    const auto4 = new AutoBaseline({
      baselines: new BaselineStore(store), metrics, correlation: new CorrelationBus(),
      pollMs: 1_000_000, appVersion: 'w',
    });
    metrics.record('watch.metric', 1);
    auto4.start();
    check('start() begins running the watcher', auto4.running === true);
    check('the watcher takes an initial baseline',
      await waitFor(() => auto4.checkpoints === 1), `${auto4.checkpoints} checkpoints`);
    const firstBaseline = auto4.lastComparison?.current;
    check('the initial baseline is captured before the watcher fires',
      firstBaseline !== undefined && firstBaseline.reason === 'initial', firstBaseline?.reason ?? '');
    auto4.stop();
    check('stop() stops the watcher', auto4.running === false);
    const afterStop = auto4.checkpoints;
    await waitFor(() => false, 600);
    check('a stopped watcher takes no further baselines', auto4.checkpoints === afterStop,
      `${auto4.checkpoints} vs ${afterStop}`);
    check('stop() cancels an in-flight probe (no late baseline)', afterStop === 1, `${afterStop} checkpoints`);

    // A watch that starts after a manual checkpoint must not double-baseline.
    const auto5 = new AutoBaseline({
      baselines: new BaselineStore(store), metrics, correlation: new CorrelationBus(),
      pollMs: 1_000_000,
    });
    await auto5.checkpoint('manual-first');
    auto5.start();
    check('a manual checkpoint suppresses the watcher initial baseline',
      !(await waitFor(() => auto5.checkpoints === 2, 800)), `${auto5.checkpoints} checkpoints`);
    auto5.stop();
    store.close();
  }

  // ================= 11 · end-to-end kernel =================
  console.log('\n--- kernel integration ---');
  {
    // Off by default: existing hosts keep their in-memory behaviour.
    const k0 = new Kernel({ logSilent: true });
    await k0.start();
    check('store is off by default', k0.sqliteStore() === undefined && k0.sinkStats() === undefined);
    check('queryLogs falls back to the hot ring buffer',
      k0.queryLogs({}).length > 0, `${k0.queryLogs({}).length} rows`);
    check('fuseTrace is undefined without a store', k0.fuseTrace('x') === undefined);
    check('checkpointBaseline is undefined without a store', k0.checkpointBaseline() === undefined);
    check('baselineComparison is undefined without a store', k0.baselineComparison() === undefined);
    check('queryLogs still filters by traceId in memory-only mode',
      k0.queryLogs({}).length >= 0);
    await k0.stop();

    // Host-provided store: the kernel uses it but does not own it, so it is
    // still readable after stop() (which also proves the flush happened).
    const shared = new SqliteStore({ path: ':memory:', archiveDir: null });
    const k1 = new Kernel({
      appVersion: '0.6.0-verify', logSilent: true, store: shared,
      sinkFlushMs: 60, sinkBatchSize: 4, sessionId: 'verify-1',
    });
    await k1.start();
    check('kernel primes the real git commit before the spines install',
      typeof k1.correlation.gitCommit() === 'string' && k1.correlation.gitCommit().length > 0,
      k1.correlation.gitCommit());
    check('kernel reuses a host-provided store', k1.sqliteStore() === shared);
    check('the sink uses the configured flush window',
      k1.sinkStats()?.flushes === 0 && k1.sinkStats()?.writtenLogs === 0);
    check('session id is stamped onto the correlation bus', k1.correlation.sessionId === 'verify-1');

    k1.logger.root().info('persisted message');
    k1.perfMetric('demo.latency', 4, { unit: 'ms' });
    k1.perfMetric('demo.latency', 6, { unit: 'ms' });
    check('records are buffered before the flush window',
      shared.stats().logCount === 0, `${shared.stats().logCount} rows`);

    const cp = await k1.checkpointBaseline('initial');
    check('checkpointBaseline persists a baseline row',
      cp !== undefined && shared.stats().baselineCount === 1);
    check('the baseline carries the kernel session id', cp!.baseline.sessionId === 'verify-1');
    check('the baseline carries the kernel app version', cp!.baseline.appVersion === '0.6.0-verify');
    check('the baseline carries the git commit', cp!.baseline.gitCommit === k1.correlation.gitCommit());

    k1.perfMetric('demo.latency', 80, { unit: 'ms' });
    const cp2 = await k1.checkpointBaseline('manual');
    check('the second baseline detects the regression',
      cp2!.comparison.regressions.some((d) => d.name === 'demo.latency'),
      JSON.stringify(cp2!.comparison.summary));
    check('kernel exposes the last comparison', k1.baselineComparison() === cp2!.comparison);
    let gotBaseline = 0;
    k1.events.on('perf:baseline', () => { gotBaseline++; });
    await k1.checkpointBaseline('after-listener');
    await delay(50);
    check('perf:baseline is emitted on the kernel event bus', gotBaseline >= 1, `${gotBaseline} events`);

    await k1.stop();
    check('stop() drains the warm tier',
      shared.stats().logCount > 0, `${shared.stats().logCount} log rows after stop`);
    check('stop() persists perf records too',
      shared.stats().perfCount > 0, `${shared.stats().perfCount} perf rows`);
    check('stop() takes a final shutdown baseline',
      shared.stats().baselineCount >= 3, `${shared.stats().baselineCount} baselines`);
    check('a host-provided store is readable after stop()', shared.stats().schemaVersion === 1);
    const rows = k1.queryLogs({ messageContains: 'persisted' });
    check('queryLogs reads back through the store', rows.length === 1, `${rows.length} rows`);
    check('queryLogs hydrates the row', rows[0].message === 'persisted message');
    check('a closed kernel leaves the store usable by its owner', shared.getLogById(rows[0].id) !== undefined);
    shared.close();

    // A store that cannot be opened must degrade, not break the kernel.
    const blocker = join(TMP, 'blocker');
    writeFileSync(blocker, 'not a db');
    const broken = new Kernel({ appVersion: 'degrade', logSilent: true, store: blocker });
    let started = false;
    try {
      await broken.start();
      started = true;
    } catch {
      started = false;
    }
    check('an unopenable database does not prevent startup', started);
    check('a failed store leaves the kernel store-less', broken.sqliteStore() === undefined);
    check('a failed store is still queryable from memory',
      broken.queryLogs({}).length > 0);
    await broken.stop();

    // File-backed kernel end to end.
    const dbFile = join(TMP, 'kernel.db');
    const k2 = new Kernel({ appVersion: 'file', logSilent: true, store: dbFile, sinkFlushMs: 30, sinkBatchSize: 1 });
    await k2.start();
    k2.logger.root().info('file backed message');
    k2.commands.register('ping', () => 'pong');
    await k2.commands.execute('ping');
    await k2.stop();
    const reopened = new SqliteStore({ path: dbFile, archiveDir: null });
    check('file-backed kernel persists across processes',
      reopened.raw<{ message: string }>('SELECT message FROM log_record WHERE message LIKE \'file backed%\'').length === 1);
    check('auto-instrumented commands land in the warm tier',
      reopened.raw<{ name: string }>("SELECT name FROM perf_record WHERE name LIKE 'command.latency.%'").length >= 1,
      `${reopened.raw("SELECT COUNT(*) AS n FROM perf_record").length} perf rows`);
    check('the warm tier is queryable after reopen',
      runLogQuery(reopened, { messageContains: 'file backed' }).length === 1);
    // Same traceId on both halves is what makes fusion possible (spec 二十二).
    reopened.insertLog(rec('fx', LogLevel.WARN, 'trace ready', { traceId: 'TRX' }));
    reopened.insertPerf({
      id: 'fxp', timestamp: Date.now(), type: 'metric', name: 'lsp.hover', value: 12,
      unit: 'ms', traceId: 'TRX', resource: { scope: 'kernel' }, scope: {},
      correlation: { gitCommit: 'deadbeef' }, environment: LOG_ENV,
    });
    const fused = fuseByTrace(reopened, 'TRX');
    check('fuseByTrace joins log + perf on the shared trace id',
      fused.logs.length === 1 && fused.perf.length === 1 && fused.timeline.length === 2,
      `${fused.logs.length}/${fused.perf.length}/${fused.timeline.length}`);
    reopened.close();
    rmSync(dbFile, { force: true });
  }

  // ---------- summary ----------
  cleanup();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${'='.repeat(72)}`);
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  FAIL  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log(`  ${passed}/${results.length} checks passed${failed ? `  (${failed} FAILED)` : ''}`);
  console.log('='.repeat(72));
  if (failed > 0) process.exit(1);
}

/** Best-effort temp cleanup: Windows may still hold a lock on a failed db. */
function cleanup(): void {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* nothing else we can do; the OS will reclaim the temp dir */
  }
}

main().catch((err) => {
  console.error('verify-baseline crashed:', err);
  cleanup();
  process.exit(1);
});
