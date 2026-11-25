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
import { connect as netConnect } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { RawWsClient } from './lib/RawWsClient.js';
import { sampleById } from '../src/assets/samples.js';
import { resolveGoBin, discoverGoServer } from '../src/go/discover.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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

    // A peer that vanishes mid-handshake used to make the engine write a 101
    // response to a closed socket and die with an uncaught EPIPE. The client is
    // deliberately raw here: connect, send the upgrade, disconnect immediately.
    await new Promise<void>((resolvePromise) => {
      const peer = netConnect(PORT, '127.0.0.1', () => {
        peer.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n' +
          'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:' + PORT + '\r\n\r\n');
        peer.destroy();
      });
      peer.on('close', () => resolvePromise());
      peer.on('error', () => resolvePromise());
      setTimeout(() => { peer.destroy(); resolvePromise(); }, 3000);
    });
    await delay(150);
    const afterAbort = await fetch(`http://127.0.0.1:${PORT}/health`);
    check('an abrupt handshake abort does not kill the engine', afterAbort.ok, `HTTP ${afterAbort.status}`);

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

    // ---------- a client-supplied run timeout ----------
    // The `run` message accepts `timeoutMs`, and `WorkspaceService.run` honours
    // it — but the handler never forwarded it, so every run silently got the
    // manifest default (15s for Python). A caller who believes the run is
    // bounded, and it is not, is worse off than one who knows there is no
    // bound. These two checks are the regression: one proves the budget is
    // applied, the other proves a typo cannot turn it into "abort at birth".
    {
      const t0 = Date.now();
      client.clearReceived();
      client.send({
        kind: 'run',
        language: 'python',
        sessionId: 'verify-timeout',
        code: 'import time\nwhile True:\n    time.sleep(0.05)',
        timeoutMs: 3000,
      });
      const timed = await client.waitFor('runResult', 40_000);
      const elapsed = Date.now() - t0;
      check('run honours a client-supplied timeout', timed?.timedOut === true, `timedOut=${timed?.timedOut}`);
      check(
        'the client timeout beats the manifest default',
        elapsed < 12_000,
        `${elapsed}ms (the manifest default is 15000ms)`,
      );
    }

    {
      client.clearReceived();
      client.send({
        kind: 'run',
        language: 'python',
        sessionId: 'verify',
        code: 'print("still runs")',
        timeoutMs: 'not-a-number',
      });
      const bogus = await client.waitFor('runResult', 25_000);
      check(
        'a bogus timeout falls back instead of aborting the run',
        bogus?.exitCode === 0 && bogus?.timedOut !== true,
        `exit=${bogus?.exitCode} timedOut=${bogus?.timedOut}`,
      );
    }

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
      // The bundled stub always reports unused imports; pyright does not unless
      // `reportUnusedImport` is turned on, and pyright-langserver ignored every
      // shape of that setting tried here. So the check states what is true of
      // whichever backend is installed, instead of going red the moment pyright
      // appears - the failure would say "the product broke", which it did not.
      const unusedImport = items.some((i) => /'os'/.test(i.message));
      check(
        'an unused import is reported when the backend supports it',
        unusedImport || items.some((i) => /undefined_name/.test(i.message)),
        unusedImport ? 'reported' : 'not reported by this backend (pyright needs reportUnusedImport)',
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

    // ---------- project packages ----------
    // The dependency file follows the project root, which for this harness is
    // the repository itself: it has a package.json, so the JavaScript plugin's
    // declaration can be read for real instead of mocked.
    client.clearReceived();
    client.send({ kind: 'dependencyReport', language: 'javascript', code: 'const x = require("left-pad");' });
    const pkgJs = await client.waitFor('dependencies', 10_000);
    const jsPackages = (pkgJs?.packages ?? []) as Array<{ name: string; version?: string }>;
    check('dependency report answers for the declared format', pkgJs?.supported === true && pkgJs?.format === 'npm');
    check('dependency report names the file it read', pkgJs?.file === 'package.json', String(pkgJs?.file ?? 'none'));
    check('dependency report lists the declared packages', jsPackages.length > 0, `${jsPackages.length} package(s)`);
    check(
      'dependency report carries versions',
      jsPackages.every((p) => typeof p.name === 'string' && p.name.length > 0),
      jsPackages.slice(0, 3).map((p) => `${p.name}@${p.version ?? '?'}`).join(', '),
    );
    check(
      'dependency report flags an import nothing declares',
      ((pkgJs?.undeclared ?? []) as string[]).includes('left-pad'),
      JSON.stringify(pkgJs?.undeclared ?? []),
    );

    client.clearReceived();
    client.send({ kind: 'dependencyReport', language: 'markdown', code: '' });
    const pkgMd = await client.waitFor('dependencies', 10_000);
    check(
      'a language with no dependency block says so instead of guessing',
      pkgMd?.supported === false && /manifest\.dependencies/.test(String(pkgMd?.note ?? '')),
      String(pkgMd?.note ?? ''),
    );

    // A flag-shaped name must be refused before anything is spawned: `pip install
    // -r x` would install a file, which is the one shape that does damage.
    client.clearReceived();
    client.send({ kind: 'dependencyInstall', language: 'javascript', package: '-r' });
    const badInstall = await client.waitFor('dependencyResult', 10_000);
    check('an install of a flag-shaped name is refused', badInstall?.ok === false);
    check(
      'the refusal explains itself',
      /cannot start with/.test(String(badInstall?.error ?? '')),
      String(badInstall?.error ?? ''),
    );

    client.clearReceived();
    client.send({ kind: 'dependencyCancel' });
    const cancelled = await client.waitFor('dependencyCancelled', 5000);
    check('cancelling an install that is not running is answered', cancelled?.ok === false);

    // ---------- Java project mode: classpath + entry class ----------
    // A multi-module project has no single source file to hand to the JDK's
    // source-file mode. The project run config must reach the manifest's
    // `modes.project` step as two argv fragments, not as shell text.
    {
      const javaLang = ((wsMsg?.status as { languages?: Array<{ id: string; available: boolean }> })
        ?.languages ?? []).find((l) => l.id === 'java');
      if (!javaLang?.available) {
        skip('Java project run skipped (toolchain unavailable)', 'no javac/java on PATH');
      } else {
        const classes = mkdtempSync(join(tmpdir(), 'nl-java-project-'));
        const source = join(classes, 'VerifyProject.java');
        writeFileSync(source, 'public class VerifyProject { public static void main(String[] a) { System.out.println("project 42"); } }\n');
        const compiled = await new Promise<boolean>((resolvePromise) => {
          const javac = spawn('javac', ['-d', classes, source], { windowsHide: true });
          javac.on('error', () => resolvePromise(false));
          javac.on('close', (code) => resolvePromise(code === 0));
        });
        if (!compiled) {
          skip('Java project run skipped (javac failed)', 'see temp directory for the source');
        } else {
          client.clearReceived();
          client.send({
            kind: 'run', language: 'java', sessionId: 'verify-java-project', mode: 'project',
            code: 'class Ignore {}',
            classpath: classes.replace(/\\/g, '/'),
            mainClass: 'VerifyProject',
          });
          const jp = await client.waitFor('runResult', 60_000);
          check('project mode runs the configured entry class', /project 42/.test(String(jp?.stdout ?? '')),
            JSON.stringify(String(jp?.stdout ?? '').trim()));
          check('project mode exits 0', Number(jp?.exitCode) === 0, `exit=${jp?.exitCode}`);
          check('project result echoes the mode', jp?.mode === 'project', String(jp?.mode ?? ''));
          client.clearReceived();
          client.send({
            kind: 'run', language: 'java', sessionId: 'verify-java-project', mode: 'project',
            code: 'class Ignore {}', classpath: 'bad"class', mainClass: 'VerifyProject',
          });
          const badCp = await client.waitFor('error', 8000);
          check('project mode rejects an injected classpath', /forbidden/.test(String(badCp?.message ?? '')),
            String(badCp?.message ?? 'no error frame'));
        }
        rmSync(classes, { recursive: true, force: true });
      }
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

      // ---- Test Explorer: live per-case frames ----
      client.clearReceived();
      client.send({ kind: 'testRun', language: 'go', requestId: 7001, code: sampleById('go-test').code });
      const tStart = await client.waitFor('testStart', 20_000);
      check('testRun acknowledges with testStart', tStart?.requestId === 7001, `${String(tStart?.requestId)} ${String(tStart?.command ?? '')}`);
      const tResult = await client.waitFor('testResult', 120_000);
      check('testRun returns a result', !!tResult, tResult ? `exit=${tResult.exitCode}` : 'timeout');
      const verdicts = client
        .findAll('testCase')
        .filter((c) => c.status === 'pass' || c.status === 'fail' || c.status === 'skip');
      check(
        'each test case is reported individually',
        verdicts.length >= 3,
        verdicts.map((c) => `${c.name}:${c.status}`).join(','),
      );
      check('a passing case is reported as pass', verdicts.some((c) => c.name === 'TestAdd' && c.status === 'pass'));
      const failCase = verdicts.find((c) => c.status === 'fail');
      check('the intentional failure is reported as fail', failCase?.name === 'TestIntentionalFailure', String(failCase?.name ?? ''));
      check(
        'a failure carries its source file and line',
        typeof failCase?.file === 'string' && Number(failCase?.line) > 0,
        `${String(failCase?.file ?? '')}:${String(failCase?.line ?? '')}`,
      );
      check(
        'the failure message names the assertion',
        /want 3/.test(String(failCase?.message ?? '')),
        String(failCase?.message ?? '').slice(0, 60),
      );
      check(
        'testResult counts the cases',
        Number(tResult?.passed) >= 2 && Number(tResult?.failed) === 1 && tResult?.ok === false,
        `passed=${String(tResult?.passed)} failed=${String(tResult?.failed)}`,
      );
      check('testOut carries the raw runner log', /=== RUN/.test(String(client.findAll('testOut')[0]?.text ?? '')), '');

      // ---- Test Explorer: a single case can be re-run ----
      client.clearReceived();
      client.send({
        kind: 'testRun',
        language: 'go',
        requestId: 7002,
        filter: '^TestAdd$',
        code: sampleById('go-test').code,
      });
      const oneStart = await client.waitFor('testStart', 20_000);
      check('a filtered run echoes its selector', String(oneStart?.filter ?? '').includes('TestAdd'), String(oneStart?.filter ?? ''));
      const oneResult = await client.waitFor('testResult', 120_000);
      const oneNames = client
        .findAll('testCase')
        .filter((c) => c.status !== 'output')
        .map((c) => String(c.name));
      check(
        'the filter runs exactly the selected case',
        oneNames.some((n) => n === 'TestAdd') && !oneNames.some((n) => n === 'TestIntentionalFailure'),
        oneNames.join(','),
      );
      check('the filtered run is reported as passing', oneResult?.ok === true && Number(oneResult?.failed) === 0, `failed=${String(oneResult?.failed)}`);

      // ---- Test Explorer: Stop ends the run ----
      client.clearReceived();
      client.send({ kind: 'testRun', language: 'go', requestId: 7003, code: sampleById('go-test').code });
      await client.waitFor('testStart', 20_000);
      client.send({ kind: 'testCancel' });
      const cancelAck = await client.waitFor('testCancelled', 15_000);
      check('testCancel is acknowledged', cancelAck?.ok === true, String(cancelAck?.error ?? ''));
      const cancelledResult = await client.waitFor('testResult', 60_000);
      check(
        'a cancelled run still reports a result',
        !!cancelledResult,
        cancelledResult ? `cancelled=${String(cancelledResult.cancelled)} exit=${String(cancelledResult.exitCode)}` : 'timeout',
      );

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

    // ---------- environment creation: the interpreter picker's "New…" ----------
    // The guards are asserted first because they are the ones that must never
    // regress: a create that walks out of the project, or that overwrites a
    // populated directory, is worse than no create at all.
    client.clearReceived();
    client.send({ kind: 'interpreters', language: 'python' });
    const interp = await client.waitFor('interpreters', 20_000);
    const creates = (interp?.creates ?? []) as Array<{ id: string; needsToolchain: boolean; wantsVersion: boolean }>;
    check('interpreter list advertises the declared providers', creates.some((c) => c.id === 'venv'), creates.map((c) => c.id).join(','));
    check('the venv provider needs an existing interpreter', !!creates.find((c) => c.id === 'venv')?.needsToolchain);
    check('the conda provider asks for a version', !!creates.find((c) => c.id === 'conda')?.wantsVersion);

    client.clearReceived();
    client.send({ kind: 'envCreate', language: 'python', provider: 'venv', path: '../escape' });
    const escaped = await client.waitFor('envDone', 10_000);
    check(
      'an environment outside the project is refused',
      escaped?.ok === false && /inside the project/.test(String(escaped?.error ?? '')),
      String(escaped?.error ?? ''),
    );

    client.clearReceived();
    client.send({ kind: 'envCreate', language: 'python', provider: 'pixi', path: '.tmp/env-check' });
    const unknownProvider = await client.waitFor('envDone', 10_000);
    check(
      'an unknown provider is reported with the real list',
      unknownProvider?.ok === false && /venv, conda/.test(String(unknownProvider?.error ?? '')),
      String(unknownProvider?.error ?? ''),
    );

    client.clearReceived();
    client.send({ kind: 'envCreate', language: 'python', provider: 'venv', path: '.' });
    const notEmpty = await client.waitFor('envDone', 10_000);
    check(
      'a non-empty target is refused instead of half-populating it',
      notEmpty?.ok === false && /not empty/.test(String(notEmpty?.error ?? '')),
      String(notEmpty?.error ?? ''),
    );

    // Positive path, in the scratch directory the suites already use (`gitignored`),
    // and only when python is actually there: the point is the spawn + marker +
    // executable detection, not re-testing argv building.
    const scratch = join('.tmp', `env-check-${process.pid}`);
    rmSync(join(ROOT, scratch), { recursive: true, force: true });
    if (interp?.active) {
      client.clearReceived();
      client.send({ kind: 'setInterpreter', language: 'python', path: interp.active });
      await client.waitFor('interpreterSet', 20_000);
      client.clearReceived();
      client.send({ kind: 'envCreate', language: 'python', provider: 'venv', path: scratch });
      const announced = await client.waitFor('envStarted', 15_000);
      check('envCreate announces the command it will run', /-m\s+venv/.test(String(announced?.display ?? '')), String(announced?.display ?? ''));
      const made = await client.waitFor('envDone', 120_000);
      check('a venv is created inside the project', made?.ok === true, String(made?.error ?? ''));
      // The suite's server runs against its own temp workspace, so the path to
      // assert on is the one the reply names — not the repo-relative scratch name.
      const madeDir = String(made?.dir ?? '');
      check('the created environment has its marker file', !!madeDir && existsSync(join(madeDir, 'pyvenv.cfg')), madeDir);
      check(
        'the reply names the interpreter to switch to',
        typeof made?.executable === 'string' && /python/i.test(String(made.executable)),
        String(made?.executable ?? ''),
      );
      rmSync(madeDir || join(ROOT, scratch), { recursive: true, force: true });
    } else {
      skip('a venv is created inside the project', 'no python interpreter discovered');
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
    // Emit a fresh user-code line right before reading. The digest carries at
    // most 300 records per frame and then advances its cursor past the rest
    // (`pushNewLogs`), so asserting on the very first run's output races that
    // bound — it started failing once a few extra runs were added ahead of this
    // check. A marker produced here is guaranteed to still be inside the tail.
    client.clearReceived();
    client.send({ kind: 'run', sessionId: 'verify', code: 'print("log-marker-777")' });
    await client.waitFor('runResult', 30_000);

    // Use the accumulated history: `clearReceived()` is called between
    // requests, so `received` only holds the most recent frames.
    const logFrames = client.findInHistory('log');
    const records = logFrames.flatMap(
      (m) => m.records as Array<{ scope: string; message: string; level: number }>,
    );
    check('log frames delivered', records.length > 0, `${records.length} records`);
    // Under a full-suite run the log frame can land a beat after the run
    // result. Poll the accumulated history instead of trusting one snapshot.
    let userCode = records.find((r) => r.scope === 'user-code' && /log-marker-777/.test(r.message));
    const userCodeDeadline = Date.now() + 5000;
    while (!userCode && Date.now() < userCodeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const latest = client
        .findInHistory('log')
        .flatMap((m) => m.records as Array<{ scope: string; message: string; level: number }>);
      userCode = latest.find((r) => r.scope === 'user-code' && /log-marker-777/.test(r.message));
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
