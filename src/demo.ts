import { Kernel } from './kernel/Kernel.js';
import { LogLevel } from './log/LogLevel.js';
import type { Logger } from './log/Logger.js';
import { SqliteStore } from './store/SqliteStore.js';
import { runLogQuery, aggregateLogs } from './store/LogQuery.js';
import { BaselineStore } from './perf/BaselineStore.js';
import type { SqliteStore } from './store/SqliteStore.js';

/**
 * Stage-1 demonstration: three buses + performance spine (auto-instrumentation)
 * + log spine (skeleton + console). Exercises commands, events, services,
 * hierarchical logging, slow-path capture and the perf/log ring buffers.
 */
async function main(): Promise<void> {
  const kernel = new Kernel({
    appVersion: '0.6.0-demo',
    slowThresholdMs: 50,
    // Stage 6 · baseline system: SQLite warm tier + auto-baselines.
    store: process.env.STAGE6_STORE === '0' ? false : (process.env.NOLANGUAGE_DB ?? true),
  });
  await kernel.start();

  const log = kernel.logger.root();

  // ---- 1. Command bus ----
  kernel.commands.register('math.add', (a: unknown, b: unknown) => (a as number) + (b as number), { title: 'Add' });
  kernel.commands.register('config.load', () => kernel.services.consume('config'), { title: 'Load config' });
  kernel.commands.register('io.slowTask', async () => {
    await new Promise((r) => setTimeout(r, 120)); // deliberately slow
    return 'done';
  }, { title: 'Slow task' });
  kernel.commands.register('boom', () => { throw new Error('kaboom'); });

  // ---- 2. Service registry (auto service.activate timing) ----
  kernel.services.register('config', () => ({ theme: 'Darcula', language: 'Python' }));
  kernel.services.register('cache', () => new Map());

  // ---- 3. Event bus ----
  kernel.events.on('user.login', (p: unknown) => {
    log.info('User logged in', { user: (p as { user?: string })?.user });
  });

  // ---- 4. Run business ----
  const sum = await kernel.commands.execute<number>('math.add', 2, 3);
  log.info('Computed sum', { result: sum });

  const cfg = await kernel.commands.execute('config.load');
  log.info('Loaded config', { config: cfg });

  const cache1 = kernel.services.consume('cache');
  const cache2 = kernel.services.consume('cache');
  log.info('Service singleton reuse', { same: cache1 === cache2 });

  // ---- 5. Hierarchical logging + context ----
  const reqLog: Logger = kernel.logger.forComponent('app.request').withContext({ sessionId: 'sess-001' });
  reqLog.debug('Handling request');
  reqLog.warn('Cache miss', { key: 'user:1' });
  reqLog.metric('request.size', 128, { unit: 'bytes' });

  // ---- 6. Events ----
  await kernel.events.emit('user.login', { user: 'alice' });

  // ---- 7. Slow path ----
  const slow = await kernel.commands.execute<string>('io.slowTask');
  log.info('Slow task finished', { result: slow });

  // ---- 8. Error path ----
  try {
    await kernel.commands.execute('boom');
  } catch (e) {
    log.info('Caught expected error', { error: (e as Error).message });
  }

  // ---- 9. Perf summary (P95) ----
  console.log('\n========== PERF SUMMARY (P95) ==========');
  for (const name of kernel.perfNames()) {
    const s = kernel.perfSummary(name);
    if (s) {
      console.log(
        `  ${name.padEnd(28)} p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms ` +
        `p99=${s.p99.toFixed(2)}ms n=${s.count}`,
      );
    }
  }
  const slowPaths = kernel.slowPaths();
  console.log(`\nSlow paths captured: ${slowPaths.length}`);
  for (const sp of slowPaths) {
    console.log(`  span=${sp.name} duration=${(sp.duration ?? 0).toFixed(2)}ms traceId=${sp.traceId.slice(0, 8)}`);
  }

  // ---- 10. Log ring-buffer query ----
  const errors = kernel.recentLogs(200)
    .filter((r) => r.level === LogLevel.ERROR || r.level === LogLevel.FATAL);
  console.log(`\nERROR/FATAL logs in ring buffer: ${errors.length}`);
  for (const r of errors) console.log(`  ${r.level} ${r.resource.component} ${r.message}`);

  // ---- 11. Stage 6: query the warm tier (spec 二十一 / 二十二) ----
  // Reopen the database: stop() closed it, and this also proves the data
  // survived the process boundary — the whole point of the warm tier.
  const dbPath = kernel.sqliteStore()?.path;
  await kernel.stop();
  const warm = dbPath ? new SqliteStore({ path: dbPath, archiveDir: null }) : undefined;
  if (warm) {
    console.log('\n========== WARM TIER (SQLite) ==========');
    const stats = warm.stats();
    console.log(`  database     ${stats.path}`);
    console.log(`  log rows     ${stats.logCount} (fts ${stats.ftsCount}, pinned ${stats.pinnedCount})`);
    console.log(`  perf rows    ${stats.perfCount}`);
    console.log(`  baselines    ${stats.baselineCount}`);
    console.log(`  retention    ${stats.retentionDays} days`);

    const rows = runLogQuery(warm, { orderBy: 'timestamp', order: 'desc', limit: 5 });
    console.log(`\nMost recent warm-tier records (${rows.length} shown):`);
    for (const r of rows) {
      console.log(`  ${r.levelName.padEnd(6)} ${r.component ?? '-'} ${r.message}`);
    }

    const agg = aggregateLogs(warm, { aggregation: { by: 'level' } });
    console.log('\nRecords by level:');
    for (const b of agg) console.log(`  ${b.key.padEnd(7)} ${b.count}`);

    console.log('\nBaselines (spec 十 · 每次 Git commit 创建基线):');
    for (const b of readBaselines(warm)) {
      const deltas = Object.entries(b.metrics)
        .map(([k, v]) => `${k}: avg=${v.avg.toFixed(2)} p95=${v.p95.toFixed(2)}`)
        .slice(0, 3)
        .join('  ');
      console.log(`  ${b.label!.padEnd(30)} [${b.reason}] ${deltas}`);
    }
    warm.close();
  }

  console.log('\nStage-6 demo complete.');
}

/** Re-hydrate baselines for reporting (they live as JSON in SQLite). */
function readBaselines(store: SqliteStore) {
  return new BaselineStore(store).history();
}

main().catch((e) => { console.error(e); process.exit(1); });
