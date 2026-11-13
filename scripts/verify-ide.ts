/**
 * IDE verification: drives the workspace UI's backend protocol end to end.
 *
 *   run      → executes Python, returns stdout/stderr/exit code
 *   session  → data persists across runs; reset clears it
 *   check    → LSP diagnostics (undefined name, syntax error)
 *   metrics  → execution.run / rpc roundtrips reach the Performance tab
 *   logs     → user-code and language-server records reach the Logs tab
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-ide.ts
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { RawWsClient } from './lib/RawWsClient.js';
import { sampleById } from '../src/panel/samples.js';
import { resolveGoBin, discoverGoServer } from '../src/go/discover.js';

const PORT = Number(process.env.VERIFY_PORT ?? 7510);

const results: { name: string; ok: boolean; detail: string; skipped?: boolean }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/**
 * An optional external tool is absent, so the check could not run. Kept apart
 * from PASS/FAIL so the report neither overstates what was verified nor blames
 * this project for a machine without `gopls`.
 */
function skip(name: string, detail = ''): void {
  results.push({ name, ok: true, detail, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

async function waitForHttp(port: number, ms: number): Promise<unknown> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > ms) throw new Error('server did not start');
    await delay(150);
  }
}

function getRawHttp(port: number, path: string, headers: Record<string, string> = {}): Promise<{ headers: import('node:http').IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
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
      env: {
        ...process.env,
        PANEL_PORT: String(PORT),
        PANEL_SLOW_MS: '40',
        PANEL_NO_DEMO: '1', // deterministic: only our own runs produce metrics
        PANEL_NO_STORE: '1', // tests stay side-effect free (no telemetry db)
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverOut = '';
  child.stdout.on('data', (d) => (serverOut += d.toString()));
  child.stderr.on('data', (d) => (serverOut += d.toString()));

  let client: RawWsClient | undefined;
  try {
    const health = (await waitForHttp(PORT, 25_000)) as {
      appVersion: string;
      workspace: { bufferPath: string; pythonBin: string; lsp: { available: boolean; serverName: string } };
    };
    check('server exposes a workspace', !!health.workspace?.bufferPath, health.appVersion);

    const compressedPage = await getRawHttp(PORT, '/', { 'accept-encoding': 'gzip' });
    const htmlBody = compressedPage.headers['content-encoding'] === 'gzip' ? gunzipSync(compressedPage.body) : compressedPage.body;
    check('IDE page negotiates gzip for its large self-contained HTML', compressedPage.headers['content-encoding'] === 'gzip' && compressedPage.body.length < htmlBody.length * 0.6, `${compressedPage.body.length} / ${htmlBody.length} bytes`);
    check('gzip page contains the IDE shell after decompression', htmlBody.toString('utf8').includes('id="runBtn"'));
    check('HTML compression varies by Accept-Encoding', String(compressedPage.headers.vary || '').includes('Accept-Encoding'));
    const uncompressedPage = await getRawHttp(PORT, '/', { 'accept-encoding': 'gzip;q=0' });
    check('IDE page respects gzip;q=0', uncompressedPage.headers['content-encoding'] !== 'gzip' && uncompressedPage.body.toString('utf8').includes('id="runBtn"'));

    // Only connect once the HTTP endpoint answers, so the socket cannot be
    // refused before the server is listening.
    client = new RawWsClient(PORT);
    await client.ready;
    check('websocket handshake on the IDE route', true, '101 Switching Protocols');

    const hello = await client.waitFor('hello', 8000);
    check('hello frame received', !!hello, String(hello?.appVersion ?? ''));

    const wsMsg = await client.waitFor('workspace', 8000);
    const samples = (wsMsg?.samples ?? []) as Array<{ id: string; name: string; languageId: string; mode: string }>;
    check('workspace frame carries samples', samples.length >= 6, `${samples.length} samples`);
    check(
      'workspace frame carries LSP status',
      !!(wsMsg?.status as { lsp?: unknown })?.lsp,
      health.workspace.lsp.serverName + (health.workspace.lsp.available ? '' : ' (unavailable)'),
    );
    check(
      'sample set includes a demo test per language',
      ['python', 'go'].every((lang) => samples.some((s) => s.languageId === lang && s.id.endsWith('demo-test'))),
      samples.filter((s) => s.id.endsWith('demo-test')).map((s) => s.id).join(','),
    );
    check(
      'workspace frame advertises the languages',
      Array.isArray((wsMsg as { languages?: unknown[] })?.languages) &&
        ((wsMsg as unknown as { languages: Array<{ id: string }> }).languages).some((l) => l.id === 'go'),
      ((wsMsg as { languages?: Array<{ id: string }> })?.languages ?? []).map((l) => l.id).join(','),
    );
    check(
      'go slot reports its toolchain',
      ((wsMsg?.status as { languages?: Array<{ id: string; available: boolean }> })?.languages ?? []).some(
        (l) => l.id === 'go',
      ),
      '',
    );

    // ---------- run: happy path ----------
    client.clearReceived();
    client.send({
      kind: 'run',
      sessionId: 'verify',
      code: 'x = 6 * 7\nprint("answer", x)',
    });
    const start = await client.waitFor('runStart', 8000);
    check('run acknowledges with runStart', !!start, String(start?.sessionId ?? ''));

    const r1 = await client.waitFor('runResult', 25_000);
    check('run returns a result', !!r1, r1 ? `exit=${r1.exitCode} ${Math.round(Number(r1.durationMs))}ms` : 'timeout');
    check('stdout captured', /answer 42/.test(String(r1?.stdout ?? '')), JSON.stringify(String(r1?.stdout ?? '').trim()));
    check('successful run exits 0', Number(r1?.exitCode) === 0, `exit=${r1?.exitCode}`);
    check('run reports a session id', r1?.sessionId === 'verify', String(r1?.sessionId ?? ''));
    check('run reports output line count', Number(r1?.logLines) >= 1, `${r1?.logLines} line(s)`);

    // ---------- session persistence ----------
    client.clearReceived();
    client.send({
      kind: 'run',
      sessionId: 'verify',
      code: 'x = x + 1\nprint("persisted", x)',
    });
    const r2 = await client.waitFor('runResult', 25_000);
    check(
      'session persists data across runs',
      /persisted 43/.test(String(r2?.stdout ?? '')),
      JSON.stringify(String(r2?.stdout ?? '').trim()),
    );

    // ---------- error path ----------
    client.clearReceived();
    client.send({
      kind: 'run',
      sessionId: 'verify',
      code: 'print("before")\nraise ValueError("intentional failure")',
    });
    const r3 = await client.waitFor('runResult', 25_000);
    check('failing run exits non-zero', Number(r3?.exitCode) !== 0, `exit=${r3?.exitCode}`);
    check(
      'stderr carries the traceback',
      /Traceback/.test(String(r3?.stderr ?? '')) && /ValueError/.test(String(r3?.stderr ?? '')),
      String(r3?.stderr ?? '').split('\n').filter(Boolean).slice(-1)[0] ?? '',
    );
    check('stdout before the error is still delivered', /before/.test(String(r3?.stdout ?? '')));

    // ---------- session reset ----------
    client.clearReceived();
    client.send({ kind: 'resetSession', sessionId: 'verify' });
    const reset = await client.waitFor('session', 8000);
    check('resetSession acknowledged', reset?.reset === true, `reset=${reset?.reset}`);

    client.clearReceived();
    client.send({ kind: 'run', sessionId: 'verify', code: 'print("x" in dir())' });
    const r4 = await client.waitFor('runResult', 25_000);
    check(
      'reset cleared the namespace',
      /False/.test(String(r4?.stdout ?? '')),
      JSON.stringify(String(r4?.stdout ?? '').trim()),
    );

    // ---------- check (LSP diagnostics) ----------
    if (health.workspace.lsp.available) {
      client.clearReceived();
      client.send({
        kind: 'check',
        code: ['import os', '', 'def f():', '    return undefined_name'].join('\n'),
      });
      const diag = await client.waitFor('diagnostics', 15_000);
      const items = (diag?.items ?? []) as Array<{ message: string; severity: number; line: number }>;
      check('check returns diagnostics', !!diag && items.length > 0, `${items.length} item(s)`);
      check('check reports from the language server', diag?.fromLsp === true);
      check(
        'undefined name reported',
        items.some((i) => /undefined_name/.test(i.message)),
        items.map((i) => i.message).slice(0, 2).join(' | '),
      );
      check(
        'unused import reported',
        items.some((i) => /'os'/.test(i.message)),
        items.map((i) => i.message).slice(0, 2).join(' | '),
      );
      check(
        'diagnostics carry a line position',
        items.every((i) => typeof i.line === 'number' && i.line >= 0),
        `first at L${items[0]?.line}`,
      );

      client.clearReceived();
      client.send({ kind: 'check', code: 'def broken(:\n    pass' });
      const diag2 = await client.waitFor('diagnostics', 15_000);
      const items2 = (diag2?.items ?? []) as Array<{ severity: number; message: string }>;
      check(
        'syntax error reported as an error severity',
        items2.some((i) => i.severity === 1),
        items2.map((i) => i.message).slice(0, 1).join(''),
      );

      // ---------- completion / hover ----------
      // Request verbs are 'complete'/'hover'; responses are 'completion'/'hover'.
      client.clearReceived();
      client.send({ kind: 'complete', code: 'def greet():\n    pass\n\ngr', line: 3, character: 2, requestId: 1 });
      const comp = await client.waitFor('completion', 15_000);
      const compItems = (comp?.items ?? []) as Array<{ label: string }>;
      check('completion returns items', compItems.length > 0, `${compItems.length} items`);
      check(
        'completion includes the document symbol',
        compItems.some((i) => i.label === 'greet'),
        compItems.slice(0, 4).map((i) => i.label).join(','),
      );

      client.clearReceived();
      client.send({ kind: 'hover', code: 'print("hi")', line: 0, character: 2, requestId: 2 });
      const hov = await client.waitFor('hover', 15_000);
      check('hover returns contents', !!hov?.hover, JSON.stringify(hov?.hover).slice(0, 48));
    } else {
      check('LSP unavailable — diagnostics checks skipped', true, 'graceful degradation');
    }

    // ---------- Go over the same protocol ----------
    // `gopls` is optional: a machine can run Go without a language server, and
    // the platform is required to keep working in that state. Probe it here so
    // the LSP-dependent assertions below can skip instead of fail.
    const hasGopls = !!discoverGoServer(resolveGoBin()).launch;
    const goLang = ((wsMsg?.status as { languages?: Array<{ id: string; available: boolean; version?: string }> })
      ?.languages ?? []).find((l) => l.id === 'go');
    if (!goLang?.available) {
      check('Go toolchain unavailable — Go checks skipped', true, 'graceful degradation');
    } else {
      check('go toolchain version reported', !!goLang.version, goLang.version ?? 'n/a');

      // ---- run ----
      client.clearReceived();
      client.send({
        kind: 'run',
        language: 'go',
        sessionId: 'verify-go',
        code: 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("go", 6*7) }\n',
      });
      const gStart = await client.waitFor('runStart', 8000);
      check('go run acknowledges with runStart', gStart?.language === 'go', String(gStart?.language ?? ''));
      const g1 = await client.waitFor('runResult', 60_000);
      check('go run returns a result', !!g1, g1 ? `exit=${g1.exitCode} ${Math.round(Number(g1.durationMs))}ms` : 'timeout');
      check('go stdout captured', /go 42/.test(String(g1?.stdout ?? '')), JSON.stringify(String(g1?.stdout ?? '').trim()));
      check('go run exits 0', Number(g1?.exitCode) === 0, `exit=${g1?.exitCode}`);
      check('go result echoes its language', g1?.language === 'go', String(g1?.language ?? ''));
      check('go result reports the build phase time', Number(g1?.buildMs) > 0, `${Math.round(Number(g1?.buildMs ?? 0))}ms`);

      // ---- the Go demo test: intentional failure ----
      client.clearReceived();
      client.send({ kind: 'run', language: 'go', sessionId: 'verify-go', code: sampleById('go-demo-test').code });
      const g2 = await client.waitFor('runResult', 60_000);
      check('go demo test exits non-zero', Number(g2?.exitCode) === 1, `exit=${g2?.exitCode}`);
      check(
        'go demo test prints PASS/FAIL',
        /PASS /.test(String(g2?.stdout ?? '')) && /FAIL /.test(String(g2?.stdout ?? '')),
        String(g2?.stdout ?? '').split('\n').find((l) => l.startsWith('FAIL')) ?? '',
      );

      // ---- compile error ----
      client.clearReceived();
      client.send({
        kind: 'run',
        language: 'go',
        sessionId: 'verify-go',
        code: 'package main\n\nfunc main() { var x int = "nope"\n_ = x }\n',
      });
      const g3 = await client.waitFor('runResult', 60_000);
      check('go compile error flagged as such', g3?.compileError === true, `phase=${g3?.phase}`);

      // ---- go test ----
      client.clearReceived();
      client.send({ kind: 'run', language: 'go', sessionId: 'verify-go', mode: 'test', code: sampleById('go-test').code });
      const g4 = await client.waitFor('runResult', 60_000);
      check('go test runs through the UI protocol', g4?.phase === 'test', `phase=${g4?.phase}`);
      check('go test reports the failing test', /--- FAIL/.test(String(g4?.stdout ?? '')), '');

      // ---- diagnostics ----
      // The Go *toolchain* can be present while `gopls` is not. Diagnostics and
      // completion then have no server to ask, which is a supported state (the
      // UI says "diagnosis unavailable") — so those assertions skip rather than
      // fail. The protocol round-trip below still runs either way.
      client.clearReceived();
      client.send({
        kind: 'check',
        language: 'go',
        code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(undefinedThing)\n}\n',
      });
      const gdiag = await client.waitFor('diagnostics', 40_000);
      const gItems = (gdiag?.items ?? []) as Array<{ message: string; line: number }>;
      if (hasGopls) {
        check('go check returns diagnostics', !!gdiag && gItems.length > 0, `${gItems.length} item(s)`);
        check('go diagnostics come from gopls', gdiag?.fromLsp === true, String(gdiag?.language ?? ''));
        check(
          'go undefined identifier reported',
          gItems.some((i) => /undefined/i.test(i.message)),
          gItems.map((i) => i.message).slice(0, 2).join(' | '),
        );
      } else {
        check('go check still answers without gopls', !!gdiag, `${gItems.length} item(s), fromLsp=${String(gdiag?.fromLsp)}`);
        skip('go diagnostics come from gopls', 'gopls not installed');
        skip('go undefined identifier reported', 'gopls not installed');
      }

      // ---- completion ----
      client.clearReceived();
      client.send({
        kind: 'complete',
        language: 'go',
        requestId: 9001,
        code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.\n}\n',
        line: 5,
        character: 5,
      });
      const gcomp = await client.waitFor('completion', 40_000);
      const gCompItems = (gcomp?.items ?? []) as Array<{ label: string }>;
      if (hasGopls) {
        check('go completion returns items', gCompItems.length > 0, `${gCompItems.length} items`);
        check(
          'go completion includes Println',
          gCompItems.some((i) => i.label === 'Println'),
          gCompItems.slice(0, 5).map((i) => i.label).join(','),
        );
      } else {
        skip('go completion returns items', 'gopls not installed');
        skip('go completion includes Println', 'gopls not installed');
      }
      check('go completion echoes its language', gcomp?.language === 'go', String(gcomp?.language ?? ''));

      // ---- an unknown language must not break the socket ----
      client.clearReceived();
      client.send({ kind: 'run', language: 'klingon', sessionId: 'verify-go', code: 'print("fallback")' });
      const g5 = await client.waitFor('runResult', 60_000);
      check('unknown language falls back to python', /fallback/.test(String(g5?.stdout ?? '')), `lang=${g5?.language}`);
    }

    // ---------- metrics reach the Performance tab ----------
    // Poll the accumulated history, since `received` is cleared per request.
    const deadline = Date.now() + 25_000;
    let metricsMsg: (typeof client.history)[number] | undefined;
    while (Date.now() < deadline) {
      metricsMsg = client
        .findInHistory('metrics')
        .find((m) => !!((m.metrics as Record<string, unknown>) ?? {})['execution.run']);
      if (metricsMsg) break;
      await delay(100);
    }
    const metrics = (metricsMsg?.metrics ?? {}) as Record<string, { count: number; p50: number }>;
    check('execution.run metric reaches the UI', !!metrics['execution.run'], `n=${metrics['execution.run']?.count}`);
    check(
      'metric digest carries sparkline series',
      Object.keys((metricsMsg?.series as object) ?? {}).length > 0,
      `${Object.keys((metricsMsg?.series as object) ?? {}).length} series`,
    );

    // ---------- logs reach the Logs tab ----------
    // Use the accumulated history: `clearReceived()` is called between
    // requests, so `received` only holds the most recent frames.
    const logFrames = client.findInHistory('log');
    const records = logFrames.flatMap(
      (m) => m.records as Array<{ scope: string; message: string; level: number }>,
    );
    check('log frames delivered', records.length > 0, `${records.length} records`);
    // Under a full-suite run the log frame can land a beat after the run
    // result. Poll the accumulated history instead of trusting one snapshot.
    let userCode = records.find((r) => r.scope === 'user-code' && /answer 42/.test(r.message));
    const userCodeDeadline = Date.now() + 5000;
    while (!userCode && Date.now() < userCodeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const latest = client
        .findInHistory('log')
        .flatMap((m) => m.records as Array<{ scope: string; message: string; level: number }>);
      userCode = latest.find((r) => r.scope === 'user-code' && /answer 42/.test(r.message));
    }
    check(
      'user-code records reach the UI',
      !!userCode,
      `${records.filter((r) => r.scope === 'user-code').length} user-code record(s)`,
    );
    check(
      'language-server records reach the UI',
      !health.workspace.lsp.available || records.some((r) => r.scope === 'language-server'),
      `${records.filter((r) => r.scope === 'language-server').length} lsp record(s)`,
    );

    // ---------- a client vanishing mid-run must not kill the server ----------
    // Regression: writing to a socket whose peer had gone raised an unhandled
    // 'error' event on the connection, and EventEmitter re-throws those — one
    // closed tab took the entire server down.
    {
      const doomed = new RawWsClient(PORT);
      await doomed.ready;
      await doomed.waitFor('workspace', 8000);
      doomed.send({
        kind: 'run',
        language: 'python',
        sessionId: 'vanish',
        code: 'import time\ntime.sleep(1.5)\nprint("late")',
      });
      await doomed.waitFor('runStart', 8000);
      doomed.close(); // walk away while the run is still in flight
      await delay(3000); // let the reply land on the now-dead socket

      const health2 = await fetch(`http://127.0.0.1:${PORT}/health`);
      check('server survives a client disconnecting mid-run', health2.ok, `HTTP ${health2.status}`);

      const back = new RawWsClient(PORT);
      await back.ready;
      const reconnected = await back.waitFor('workspace', 8000);
      check('new clients can connect after a mid-run disconnect', !!reconnected);
      back.close();
    }

    // ---------- protocol errors ----------
    client.clearReceived();
    client.send({ kind: 'nonsense' });
    const err = await client.waitFor('error', 8000);
    check('unknown message kind rejected', !!err, String(err?.message ?? ''));

    client.close();
  } finally {
    client?.close();
    child.kill('SIGKILL');
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${skipped ? ` (${skipped} skipped: optional tool missing)` : ''}`);
  if (failed.length) {
    console.log('failed: ' + failed.map((f) => f.name).join('; '));
    console.log('--- server output (tail) ---\n' + serverOut.slice(-2000));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('verify-ide failed:', e);
  process.exit(1);
});
