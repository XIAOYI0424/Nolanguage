/**
 * Stage 10 · Profiler verification (user-code performance).
 *
 *   1. Python adapter — real cProfile over a snippet with a known hot
 *      function: hotspots are found, cumulative time is > 0, output is
 *      captured, a raising snippet reports an error instead of throwing, and
 *      topN clips the list. Metrics land on the perf spine.
 *   2. Go adapter — real runtime/pprof + `go tool pprof -top`; SKIP when the
 *      toolchain is absent (never FAIL on a missing optional tool).
 *   3. Command bus — `profiler.python` / `profiler.profile` are executable.
 *   4. Backend — the live server answers `profile` with `profileResult`.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-profiler.ts
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RawWsClient } from './lib/RawWsClient.js';
import { Kernel } from '../src/kernel/Kernel.js';
import { PythonProfiler } from '../src/profiler/PythonProfiler.js';
import { GoProfiler } from '../src/profiler/GoProfiler.js';
import { ProfilerService } from '../src/profiler/ProfilerService.js';

const PORT = Number(process.env.VERIFY_PORT ?? 7519);

const results: { name: string; ok: boolean; detail: string; skipped?: boolean }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name: string, detail = ''): void {
  results.push({ name, ok: true, detail, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

const PY_HOT = [
  'def hot(n):',
  '    s = 0',
  '    for i in range(n):',
  '        s += i * i',
  '    return s',
  '',
  'print("result", hot(300000))',
].join('\n');

// ============================================================ Python adapter

async function testPython(kernel: Kernel): Promise<void> {
  const profiler = new PythonProfiler(kernel);
  const r = await profiler.profile({ languageId: 'python', code: PY_HOT });
  check('python: profiling succeeds', r.ok, r.error ?? '');
  check('python: backend is cProfile', r.source === 'cProfile', r.source);
  check('python: hotspots are found', r.hotspots.length > 0, `${r.hotspots.length} functions`);
  const hot = r.hotspots.find((h) => h.name === 'hot');
  check('python: the hot function is identified', !!hot, hot ? `cum=${hot.cumtimeMs}ms` : 'not found');
  check('python: cumulative time is positive', !!hot && hot.cumtimeMs > 0, hot ? `${hot.cumtimeMs}ms` : '-');
  check('python: program output is captured', /result\s+\d{6,}/.test(r.stdout), r.stdout.trim().slice(0, 40));

  // topN clips
  const clipped = await profiler.profile({ languageId: 'python', code: PY_HOT, topN: 3 });
  check('python: topN clips the hotspot list', clipped.hotspots.length <= 3, `${clipped.hotspots.length}`);

  // a raising snippet is reported, not thrown
  const bad = await profiler.profile({ languageId: 'python', code: 'raise ValueError("boom")\n' });
  check('python: a raising snippet reports an error', bad.ok === false && !!bad.error, (bad.error ?? '').split('\n').pop() ?? '');

  // metrics landed on the spine
  const names = kernel.perfNames();
  check('python: profiler.run metric is recorded', names.includes('profiler.run'), names.filter((n) => n.startsWith('profiler.')).join(','));
  check('python: profiler.samples metric is recorded', names.includes('profiler.samples'));
}

// ================================================================ Go adapter

async function testGo(kernel: Kernel): Promise<void> {
  const go = new GoProfiler(kernel);
  if (!go.available) {
    skip('go: profiler adapter', 'Go toolchain not installed on this machine');
    skip('go: hotspots are found', 'Go toolchain not installed');
    return;
  }
  const code = [
    'package main',
    '',
    'import "fmt"',
    '',
    'func work() int {',
    '    s := 0',
    '    for i := 0; i < 60000000; i++ {',
    '        s += i % 7',
    '    }',
    '    return s',
    '}',
    '',
    'func main() {',
    '    fmt.Println("result", work())',
    '}',
  ].join('\n');
  const r = await go.profile({ languageId: 'go', code, timeoutMs: 90_000 });
  check('go: profiling runs without throwing', r.source === 'pprof', r.error ?? '');
  if (r.skipped) {
    skip('go: hotspots are found', r.skipReason ?? 'skipped');
    return;
  }
  check('go: hotspots are found', r.hotspots.length > 0, `${r.hotspots.length} functions`);
  check('go: the work function is identified', r.hotspots.some((h) => /work|userMain/.test(h.name)), r.hotspots[0]?.name ?? 'none');
}

// ============================================================== command bus

async function testCommands(kernel: Kernel): Promise<void> {
  const svc = new ProfilerService(kernel);
  svc.registerCommands();
  check('commands: profiler.profile is registered', kernel.commands.has('profiler.profile'));
  check('commands: profiler.python is registered', kernel.commands.has('profiler.python'));
  check('commands: profiler.go is registered', kernel.commands.has('profiler.go'));
  const r = await kernel.commands.execute<{ hotspots: unknown[]; source: string }>('profiler.python', PY_HOT);
  check('commands: profiler.python executes and returns hotspots', r.source === 'cProfile' && r.hotspots.length > 0, `${r.hotspots.length}`);
}

// ================================================================= backend

async function testBackend(): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--experimental-loader',
      './resolve-loader.mjs',
      'src/panel/server.ts',
    ],
    {
      env: { ...process.env, PANEL_PORT: String(PORT), PANEL_NO_DEMO: '1', PANEL_NO_STORE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverOut = '';
  child.stdout.on('data', (d) => (serverOut += d.toString()));
  child.stderr.on('data', (d) => (serverOut += d.toString()));

  let client: RawWsClient | undefined;
  let failed = false;
  try {
    await waitForHttp(PORT, 25_000);
    client = new RawWsClient(PORT);
    await client.ready;
    await client.waitFor('hello', 8000);
    client.clearReceived();
    client.send({ kind: 'profile', language: 'python', code: PY_HOT });
    const res = (await client.waitFor('profileResult', 30_000)) as {
      ok?: boolean;
      source?: string;
      hotspots?: Array<{ name: string; cumtimeMs: number }>;
      sampleCount?: number;
    } | undefined;
    check('backend: profile returns a result', !!res, '');
    check('backend: profile result is ok', res?.ok === true, String(res?.ok));
    check('backend: profile result carries hotspots', (res?.hotspots?.length ?? 0) > 0, `${res?.hotspots?.length ?? 0}`);
    check('backend: profile result names the hot function', (res?.hotspots ?? []).some((h) => h.name === 'hot'));
  } catch (e) {
    failed = true;
    check('backend: integration completed without a crash', false, (e as Error).message);
    if (serverOut) console.log(serverOut.slice(-800));
  } finally {
    if (client) try { client.close(); } catch { /* ignore */ }
    child.kill('SIGTERM');
  }
  if (failed) throw new Error('backend integration failed');
}

async function waitForHttp(port: number, ms: number): Promise<unknown> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error('server did not start');
    await delay(150);
  }
}

// ================================================================= driver

async function main(): Promise<void> {
  const kernel = new Kernel({ logSilent: true });
  await kernel.start();
  try {
    console.log('— python adapter —');
    await testPython(kernel);
    console.log('— go adapter —');
    await testGo(kernel);
    console.log('— command bus —');
    await testCommands(kernel);
  } finally {
    await kernel.stop().catch(() => undefined);
  }
  console.log('— backend integration —');
  await testBackend();

  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  const total = results.length;
  console.log(`\n${passed}/${total} checks passed (${skipped} skipped, ${failed} failed)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
