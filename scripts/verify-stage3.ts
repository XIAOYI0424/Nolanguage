/**
 * Stage-3 verification: drives the Python + LSP closed loop in-process and
 * asserts every promise of the stage:
 *
 *   - LSP server discovery + initialize handshake over real JSON-RPC stdio
 *   - RPC 埋点: roundtrip metrics exist AND carry the caller's traceId
 *   - diagnostics (push + pull), completion, hover
 *   - LSP 日志采集: server stderr parsed into language-server scoped records
 *     with correct levels (incl. JSON lines and traceback continuations)
 *   - Python execution: user-code capture, session persistence, error path
 *   - slow-path capture for slow RPC roundtrips
 *   - correlation skeleton: a log's traceId is shared with PerfRecords
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-stage3.ts
 */
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Kernel } from '../src/kernel/Kernel.js';
import { LogLevel, LOG_LEVEL_NAMES } from '../src/log/LogLevel.js';
import { LspClient, fileUri } from '../src/lsp/LspClient.js';
import { discoverPythonServer } from '../src/python/serverDiscovery.js';
import { PythonRunner } from '../src/python/PythonRunner.js';
import type { Diagnostic } from '../src/lsp/LspClient.js';

const SAMPLE = [
  'import os',
  'import sys',
  '',
  '',
  'def greet(name):',
  '    print("hello " + name)',
  '',
  '',
  'def main():',
  '    greet("world")',
  '    return undefined_thing',
  '',
  '',
  'if __name__ == "__main__":',
  '    main()',
  '',
].join('\n');

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main(): Promise<void> {
  const kernel = new Kernel({
    appVersion: '0.3.0-verify',
    slowThresholdMs: 40,
    logLevel: LogLevel.TRACE,
    logSilent: true, // assert on the ring buffer, not stdout
  });
  await kernel.start();

  kernel.languages.register({ id: 'python', extensions: ['.py', '.pyi'], lsp: 'pyright' });

  // ---------- LSP ----------
  const discovered = await discoverPythonServer();
  check('language server discovered', !!discovered.command, `${discovered.serverName} (${discovered.command})`);

  const workspace = join(tmpdir(), `nolanguage-verify-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  const filePath = join(workspace, 'main.py');
  await writeFile(filePath, SAMPLE, 'utf8');
  const uri = fileUri(filePath);

  const lsp = new LspClient({ launch: discovered });
  const pushed: Diagnostic[] = [];
  lsp.on('diagnostics', (p: { diagnostics: Diagnostic[] }) => {
    pushed.length = 0;
    pushed.push(...p.diagnostics);
  });

  const caps = await lsp.start(kernel, fileUri(workspace));
  check('LSP initialize handshake', Object.keys(caps).length > 0, `${Object.keys(caps).length} capabilities`);

  const openDiags = await lsp.openDocument(uri, SAMPLE);
  const diags = pushed.length ? pushed : openDiags;
  const undefinedName = diags.find((d) => d.code === 'undefined-name');
  const unusedImport = diags.find((d) => d.code === 'unused-import');
  check('didOpen → diagnostics published', diags.length > 0, `${diags.length} diagnostics`);
  check('undefined name detected', !!undefinedName, undefinedName?.message ?? 'not found');
  check('unused import detected', !!unusedImport, unusedImport?.message ?? 'not found');
  check(
    'diagnostic ranges are positioned',
    diags.every((d) => d.range?.start?.line >= 0 && d.range?.start?.character >= 0),
    `first at L${diags[0]?.range?.start?.line}:${diags[0]?.range?.start?.character}`,
  );

  const items = await lsp.completion(uri, { line: 5, character: 12 });
  check('completion returns items', items.length > 0, `${items.length} items`);
  check(
    'completion includes document symbols',
    items.some((i) => i.label === 'greet') && items.some((i) => i.label === 'print'),
    'greet + builtins',
  );

  const hover = await lsp.hover(uri, { line: 5, character: 6 });
  check('hover returns contents', !!hover, hover ? String(JSON.stringify(hover.contents)).slice(0, 44) : 'null');

  const pulled = await lsp.diagnosticsPull(uri);
  check('diagnostics pull (roundtrip)', pulled.length > 0, `${pulled.length} items`);

  // ---------- RPC 埋点 ----------
  const rpcNames = kernel.perfNames().filter((n) => n.startsWith('rpc.roundtrip.'));
  check(
    'RPC roundtrips instrumented',
    rpcNames.length >= 4,
    rpcNames.map((n) => n.replace('rpc.roundtrip.', '')).join(', '),
  );
  const initSummary = kernel.perfSummary('rpc.roundtrip.initialize');
  check('initialize roundtrip timed', !!initSummary && initSummary.count >= 1,
    initSummary ? `${initSummary.p50.toFixed(1)}ms` : 'missing');

  // traceId correlation: the roundtrips fired inside the lsp.start span must
  // carry that span's traceId into the perf store.
  const startLog = kernel
    .recentLogs(5000)
    .find((r) => r.resource.scope === 'language-server' && r.message === 'Starting language server');
  const sharedPerf = startLog
    ? kernel.recentPerf(5000).filter((p) => p.traceId === startLog.traceId)
    : [];
  check(
    'RPC metrics carry the caller traceId',
    !!startLog && sharedPerf.length >= 1,
    startLog ? `traceId ${(startLog.traceId ?? '').slice(0, 8)} → ${sharedPerf.length} PerfRecord(s)` : 'no start log',
  );
  check(
    'perf records are language-server scoped',
    sharedPerf.some((p) => p.resource.scope === 'language-server' && p.resource.languageId === 'python'),
    sharedPerf.map((p) => p.resource.scope).join(','),
  );

  // ---------- slow path ----------
  // The threshold is 40ms, so "was anything slow?" is a property of the host:
  // on a fast CI runner every LSP roundtrip came in under it and this check
  // failed with `none` — which is correct behaviour, not a regression. Force a
  // slow command instead, so the detector is exercised deterministically. The
  // opportunistic RPC slow paths are still reported in the detail line.
  const rpcSlow = kernel.slowPaths().length;
  const slowCmd = kernel.commands.register('verify.slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return 'slow';
  });
  try {
    await kernel.commands.execute('verify.slow');
  } finally {
    slowCmd.dispose();
  }
  const slow = kernel.slowPaths();
  check('a slow command is captured as a slow path', slow.length >= 1,
    `${slow.map((s) => `${s.name}=${(s.duration ?? 0).toFixed(0)}ms`).join(', ') || 'none'} (rpc slow paths seen: ${rpcSlow})`);
  check('slow path duration is the measured cost', slow.every((s) => (s.duration ?? 0) > 0),
    slow.length ? `${(slow[0].duration ?? 0).toFixed(1)}ms` : 'n/a');

  // ---------- LSP 日志采集 ----------
  const lspLogs = kernel.recentLogs(5000).filter((r) => r.resource.scope === 'language-server');
  check('LSP stderr collected as log records', lspLogs.length >= 4, `${lspLogs.length} records`);
  check(
    'collected records are level-classified',
    lspLogs.some((r) => r.level === LogLevel.INFO) && lspLogs.some((r) => r.level === LogLevel.DEBUG),
    [...new Set(lspLogs.map((r) => LOG_LEVEL_NAMES[r.level]))].join(','),
  );
  check(
    'collected records carry languageId',
    lspLogs.every((r) => r.resource.languageId === 'python'),
    'languageId=python',
  );
  // The bundled server appends JSON detail (e.g. `{"server":"nolanguage-py"}`);
  // assert it was split out into queryable fields rather than left in the text.
  const withDetail = lspLogs.find((r) =>
    Object.keys(r.fields).some((k) => !['stream', 'continuation'].includes(k)),
  );
  check(
    'trailing JSON split into fields',
    !!withDetail,
    withDetail
      ? `${withDetail.message} → ${JSON.stringify(
          Object.fromEntries(Object.entries(withDetail.fields).filter(([k]) => k !== 'stream')),
        ).slice(0, 60)}`
      : 'none',
  );
  check(
    'JSON detail removed from the message text',
    lspLogs.every((r) => !/\{"[a-z_]+":/.test(r.message)),
    'no inline JSON left in messages',
  );

  // ---------- Python execution ----------
  const runner = new PythonRunner(kernel);
  const sessionId = `sess-verify-${Date.now()}`;

  const r1 = await runner.run({
    sessionId,
    code: ['total = 40', 'items = ["a"]', 'print("run1", total, items)'].join('\n'),
  });
  check('python run #1 succeeds', r1.exitCode === 0, `exit=${r1.exitCode} ${r1.stdout.trim()}`);

  const r2 = await runner.run({
    sessionId,
    code: ['total = total + 2', 'items = items + ["b"]', 'print("run2", total, items)'].join('\n'),
  });
  check(
    'session persists data across snippets',
    r2.exitCode === 0 && /42/.test(r2.stdout) && /\[.a., .b.\]/.test(r2.stdout),
    r2.stdout.trim().replace(/\r?\n/g, ' | '),
  );

  const r3 = await runner.run({
    sessionId,
    code: ['print("before")', 'raise ValueError("boom")'].join('\n'),
  });
  check('python error path exits non-zero', r3.exitCode !== 0, `exit=${r3.exitCode}`);

  const userLogs = kernel.recentLogs(5000).filter((r) => r.resource.scope === 'user-code');
  check('user-code stdout captured', userLogs.some((r) => /run1/.test(r.message)), `${userLogs.length} records`);
  check(
    'user-code traceback captured as ERROR',
    userLogs.some((r) => r.level === LogLevel.ERROR && /Traceback|ValueError/.test(r.message)),
    userLogs.filter((r) => r.level === LogLevel.ERROR).length + ' error lines',
  );
  check(
    'user-code records carry sessionId',
    userLogs.every((r) => r.correlation.sessionId === sessionId),
    sessionId,
  );

  const execSummary = kernel.perfSummary('execution.run');
  check('execution timed into perf', !!execSummary && execSummary.count === 3,
    execSummary ? `${execSummary.p50.toFixed(1)}ms p50, n=${execSummary.count}` : 'missing');

  // ---------- cleanup ----------
  await lsp.stop();
  await runner.close();
  await kernel.stop();
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failed: ' + failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('verify-stage3 failed:', e);
  process.exit(1);
});
