/**
 * Stage-3 closed loop demo (spec 阶段 3: 单语言闭环 · Python + pyright).
 *
 *  写代码 → LSP 诊断/补全 → 运行 → 日志/性能可见
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs src/python/run.ts
 * Env: PYTHON_BIN to override the interpreter; STAGE3_KEEP=1 to skip shutdown.
 *
 * It exercises, in order:
 *  1. language contribution registration (python),
 *  2. LSP server discovery + initialize handshake (pyright, else bundled server),
 *  3. didOpen → pushed diagnostics (with RPC 埋点 on every roundtrip),
 *  4. completion + hover (real roundtrips, timed),
 *  5. LSP 日志采集 — server stderr/stdout parsed into structured records,
 *  6. Python execution with user-code output capture + session persistence,
 *  7. a combined report: perf P95 table + log breakdown + trace correlation.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Kernel } from '../kernel/Kernel.js';
import { LogLevel, LOG_LEVEL_NAMES } from '../log/LogLevel.js';
import { LspClient, discoverPythonServer, fallbackServerSpec, fileUri } from '../lsp/LspClient.js';
import { PythonRunner } from './PythonRunner.js';
import type { Diagnostic } from '../lsp/LspClient.js';

const SAMPLE = `import os
import sys


def greet(name):
    message = "hello " + name
    print(message)
    return message


def main():
    greet("world")
    return undefined_thing


if __name__ == "__main__":
    main()
`;

async function main(): Promise<void> {
  const kernel = new Kernel({
    appVersion: '0.3.0-stage3',
    slowThresholdMs: 60,
    logLevel: LogLevel.TRACE,
    logPretty: true,
  });
  await kernel.start();
  const log = kernel.logger.root();
  log.info('Stage 3 closed loop starting', { python: process.env.PYTHON_BIN ?? 'python' });

  // ---- 1. language contribution ----
  kernel.languages.register({
    id: 'python',
    extensions: ['.py', '.pyi'],
    lsp: 'pyright',
    dap: 'debugpy',
    profiler: 'py-spy',
  });

  // ---- 2. LSP: discover + start ----
  const discovered = await discoverPythonServer();
  const usingFallback = discovered.serverName === 'nolanguage-py';
  if (usingFallback) {
    log.warn('pyright not found on PATH — using the bundled LSP fallback server', {
      fallback: fallbackServerSpec(process.env.PYTHON_BIN ?? 'python').args.join(' '),
    });
  } else {
    log.info('pyright found', { command: discovered.command });
  }

  const workspace = join(tmpdir(), 'nolanguage-stage3');
  await mkdir(workspace, { recursive: true });
  const filePath = join(workspace, 'main.py');
  await writeFile(filePath, SAMPLE, 'utf8');
  const uri = fileUri(filePath);

  const lsp = new LspClient({ launch: discovered, slowDiagnosticMs: 300 });
  const diagnosticsSeen: Diagnostic[] = [];
  lsp.on('diagnostics', (p: { uri: string; diagnostics: Diagnostic[] }) => {
    diagnosticsSeen.length = 0;
    diagnosticsSeen.push(...p.diagnostics);
  });

  const caps = await lsp.start(kernel, fileUri(workspace));
  log.info('LSP capabilities negotiated', { count: Object.keys(caps).length });

  // ---- 3. didOpen → diagnostics ----
  const diags = await lsp.openDocument(uri, SAMPLE);
  const fromPush = diagnosticsSeen.length ? diagnosticsSeen : diags;
  const errors = fromPush.filter((d) => d.severity === 1);
  const warns = fromPush.filter((d) => d.severity === 2);
  log.info('Diagnostics collected', {
    total: fromPush.length,
    errors: errors.length,
    warnings: warns.length,
    file: uri,
  });

  // ---- 4. completion + hover (timed roundtrips) ----
  const line5 = 4; // inside greet()
  const items = await lsp.completion(uri, { line: line5, character: 12 });
  log.info('Completion returned', { items: items.length });

  const hover = await lsp.hover(uri, { line: 6, character: 4 });
  log.info('Hover resolved', {
    hasContents: !!hover,
    preview: hover ? previewHover(hover) : undefined,
  });

  // Explicit pull request (also a timed roundtrip).
  const pulled = await lsp.diagnosticsPull(uri);
  log.info('Diagnostics pulled', { total: pulled.length });

  // ---- 5. LSP log collection stats ----
  const lspStats = lsp.logStats;
  log.info('LSP log collection summary', {
    stream: 'stderr',
    lines: lspStats?.lines ?? 0,
    records: lspStats?.records ?? 0,
    byLevel: lspStats?.byLevel,
  });

  // ---- 6. Python execution with session persistence ----
  const runner = new PythonRunner(kernel);
  const sessionId = 'sess-stage3';

  const run1 = await runner.run({
    sessionId,
    code: [
      'counter = 0',
      'items = []',
      'def bump():',
      '    global counter',
      '    counter += 1',
      '    items.append(counter)',
      '    return counter',
      'print("first run, counter =", bump(), "items =", items)',
    ].join('\n'),
  });
  log.info('Run #1 complete', {
    exitCode: run1.exitCode,
    durationMs: Math.round(run1.durationMs),
    stdout: run1.stdout.trim(),
  });

  const run2 = await runner.run({
    sessionId,
    code: [
      '# second snippet: `counter`/`items` were persisted from run #1, so the',
      '# session shares *data* across snippets (functions are re-declared).',
      'def bump():',
      '    global counter',
      '    counter += 1',
      '    items.append(counter)',
      '    return counter',
      'print("second run, counter =", bump(), "items =", items)',
      'print("shared state works:", items == [1, 2])',
    ].join('\n'),
  });
  log.info('Run #2 complete (session reuse)', {
    exitCode: run2.exitCode,
    stdout: run2.stdout.trim(),
  });

  const run3 = await runner.run({
    sessionId,
    code: ['print("about to fail")', 'raise ValueError("intentional stage-3 failure")'].join('\n'),
  });
  log.info('Run #3 complete (error path)', {
    exitCode: run3.exitCode,
    stderrHasTraceback: /Traceback/.test(run3.stderr),
  });

  // ---- 7. combined report ----
  printReport(kernel);

  if (process.env.STAGE3_KEEP === '1') {
    log.info('STAGE3_KEEP=1 — leaving the language server running');
    return;
  }

  await lsp.stop();
  await runner.close();
  await kernel.stop();
  log.info('Stage 3 closed loop complete');
}

function previewHover(h: { contents: unknown }): string {
  const c = h.contents;
  if (typeof c === 'string') return c.slice(0, 60);
  if (Array.isArray(c)) return String(c[0]).slice(0, 60);
  if (c && typeof c === 'object' && 'value' in c) return String((c as { value: string }).value).slice(0, 60);
  return '';
}

function printReport(kernel: Kernel): void {
  const out = process.stdout;
  out.write('\n' + '='.repeat(78) + '\n');
  out.write('  STAGE 3 REPORT · RPC 埋点 + LSP 日志采集 + 执行闭环\n');
  out.write('='.repeat(78) + '\n');

  // --- perf (RPC roundtrips + execution) ---
  out.write('\n[ RPC roundtrips — auto-instrumented ]\n');
  const rpcNames = kernel.perfNames().filter((n) => n.startsWith('rpc.roundtrip.'));
  if (!rpcNames.length) out.write('  (none)\n');
  for (const n of rpcNames.sort()) {
    const s = kernel.perfSummary(n);
    if (!s) continue;
    out.write(
      `  ${n.replace('rpc.roundtrip.', '').padEnd(30)} ` +
        `p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms n=${s.count}\n`,
    );
  }

  out.write('\n[ LSP + execution metrics ]\n');
  for (const n of ['lsp.start', 'lsp.completion', 'lsp.hover', 'lsp.diagnostic', 'execution.run']) {
    const s = kernel.perfSummary(n);
    if (!s) continue;
    out.write(
      `  ${n.padEnd(30)} p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms n=${s.count}\n`,
    );
  }

  // --- slow paths ---
  const slow = kernel.slowPaths();
  out.write(`\n[ Slow paths captured ]  ${slow.length}\n`);
  for (const s of slow.slice(-8)) {
    out.write(`  ${s.name.padEnd(26)} ${(s.duration ?? 0).toFixed(1)}ms  trace=${s.traceId.slice(0, 8)}\n`);
  }

  // --- logs by scope ---
  const logs = kernel.recentLogs(5000);
  const byScope = new Map<string, number>();
  const byLevel = new Map<string, number>();
  for (const r of logs) {
    byScope.set(r.resource.scope, (byScope.get(r.resource.scope) ?? 0) + 1);
    const name = LOG_LEVEL_NAMES[r.level];
    byLevel.set(name, (byLevel.get(name) ?? 0) + 1);
  }
  out.write('\n[ Logs by scope ]\n');
  for (const [scope, n] of [...byScope.entries()].sort()) {
    out.write(`  ${scope.padEnd(20)} ${n}\n`);
  }
  out.write('\n[ Logs by level ]\n');
  for (const [lvl, n] of [...byLevel.entries()].sort()) {
    out.write(`  ${lvl.padEnd(8)} ${n}\n`);
  }

  // --- language-server records (the LSP log collection proof) ---
  const lspLogs = logs.filter((r) => r.resource.scope === 'language-server');
  out.write(`\n[ LSP log records collected ]  ${lspLogs.length}\n`);
  for (const r of lspLogs.slice(-10)) {
    out.write(
      `  ${LOG_LEVEL_NAMES[r.level].padEnd(6)} ${r.resource.component.padEnd(20)} ${r.message.slice(0, 60)}\n`,
    );
  }

  // --- user-code records ---
  const userLogs = logs.filter((r) => r.resource.scope === 'user-code');
  out.write(`\n[ User-code records captured ]  ${userLogs.length}\n`);
  for (const r of userLogs.slice(-8)) {
    out.write(
      `  ${LOG_LEVEL_NAMES[r.level].padEnd(6)} ${(r.correlation.sessionId ?? '-').padEnd(14)} ${r.message.slice(0, 56)}\n`,
    );
  }

  // --- correlation proof: same traceId across log + perf ---
  const withTrace = logs.find((r) => r.traceId && r.resource.scope === 'language-server');
  if (withTrace) {
    const perfHit = kernel.recentPerf(2000).filter((p) => p.traceId === withTrace.traceId);
    out.write('\n[ Correlation skeleton ]\n');
    out.write(`  traceId ${withTrace.traceId}\n`);
    out.write(`    log:  ${withTrace.resource.component} — ${withTrace.message.slice(0, 50)}\n`);
    out.write(`    perf: ${perfHit.length} PerfRecord(s) share this traceId\n`);
  }
  out.write('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
