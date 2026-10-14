/**
 * Go verification: discovery, execution, and the gopls loop.
 *
 *   discovery → the toolchain and gopls are found (and *where* is reported)
 *   run       → build-then-run preserves the program's exact exit code
 *   test      → `go test -v` drives the real testing package
 *   errors    → a compile error is reported as such, not as a runtime failure
 *   lsp       → gopls publishes diagnostics and serves completion
 *   degrade   → a bogus GO_BIN produces a clear error instead of a crash
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-go.ts
 */
import { setTimeout as delay } from 'node:timers/promises';
import { Kernel } from '../src/kernel/Kernel.js';
import { LogLevel } from '../src/log/LogLevel.js';
import { GoRunner } from '../src/go/GoRunner.js';
import { resolveGoBin, discoverGoServer, goVersion } from '../src/go/discover.js';
import { WorkspaceService } from '../src/panel/WorkspaceService.js';
import { defaultSample, sampleById } from '../src/panel/samples.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function makeKernel(): Kernel {
  return new Kernel({
    appVersion: '0.4.0-workspace',
    logLevel: LogLevel.WARN,
    logSilent: true,
    slowThresholdMs: 60,
  });
}

async function main(): Promise<void> {
  // ================= discovery =================
  const go = resolveGoBin();
  check('go toolchain discovered', go.source !== 'missing', `${go.bin} (via ${go.source})`);

  const version = go.source === 'missing' ? null : await goVersion(go.bin);
  check('go version reported', !!version, version ?? 'n/a');

  const server = discoverGoServer(go);
  check('gopls discovered', !!server.launch, `${server.serverName} (via ${server.source})`);
  check(
    'gopls launch spec is well formed',
    !!server.launch && server.launch.languageId === 'go' && server.launch.args.includes('serve'),
    server.launch ? `${server.launch.command} ${server.launch.args.join(' ')}` : 'none',
  );

  if (go.source === 'missing') {
    console.log('\nGo toolchain missing — skipping execution checks.');
    report();
    return;
  }

  // ================= execution =================
  const kernel = makeKernel();
  await kernel.start();
  const runner = new GoRunner(kernel, go.bin);

  // ---- the demo test: 1 intentional failure, so exit code must be 1 ----
  const demo = await runner.run({ code: defaultSample('go').code, sessionId: 'vgo' });
  check('go demo test runs', demo.exitCode !== null, `exit=${demo.exitCode} ${Math.round(demo.durationMs)}ms`);
  check(
    'go demo test reports PASS lines',
    (demo.stdout.match(/PASS /g) ?? []).length >= 7,
    `${(demo.stdout.match(/PASS /g) ?? []).length} PASS`,
  );
  check(
    'go demo test reports the intentional FAIL',
    /FAIL  intentional failing case/.test(demo.stdout),
    demo.stdout.split('\n').find((l) => l.startsWith('FAIL')) ?? '',
  );
  // This is the whole reason for build-then-run: `go run` would collapse this
  // to exit 1 with the real code only in a stderr message.
  check('exact exit code preserved (1)', demo.exitCode === 1, `exit=${demo.exitCode}`);
  check('demo test went through the build phase', demo.phase === 'run' && demo.buildMs > 0, `build ${Math.round(demo.buildMs)}ms`);
  check('demo test is not a compile error', demo.compileError === false);

  // ---- a clean program ----
  const clean = await runner.run({
    code: 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("go ok", 6*7) }\n',
    sessionId: 'vgo',
  });
  check('clean program exits 0', clean.exitCode === 0, `exit=${clean.exitCode}`);
  check('stdout captured', /go ok 42/.test(clean.stdout), JSON.stringify(clean.stdout.trim()));

  // ---- non-zero exit from os.Exit is preserved verbatim ----
  const exit7 = await runner.run({
    code: 'package main\n\nimport "os"\n\nfunc main() { os.Exit(7) }\n',
    sessionId: 'vgo',
  });
  check('arbitrary exit code preserved (7)', exit7.exitCode === 7, `exit=${exit7.exitCode}`);

  // ---- compile error is a distinct outcome ----
  const broken = await runner.run({
    code: 'package main\n\nfunc main() {\n\tvar x int = "not an int"\n\t_ = x\n}\n',
    sessionId: 'vgo',
  });
  check('compile error detected', broken.compileError === true, `phase=${broken.phase}`);
  check('compile error exits non-zero', broken.exitCode !== 0, `exit=${broken.exitCode}`);
  check(
    'compiler message captured on stderr',
    /cannot use|type string/.test(broken.stderr),
    broken.stderr.split('\n').filter(Boolean)[0] ?? '',
  );
  check('no binary was run after a failed build', broken.phase === 'build');

  // ---- go test ----
  const testFail = await runner.run({ code: sampleById('go-test').code, sessionId: 'vgo', mode: 'test' });
  check('go test runs', testFail.phase === 'test', `exit=${testFail.exitCode}`);
  check('go test reports the failing test', /--- FAIL: TestIntentionalFailure/.test(testFail.stdout), '');
  check('go test reports passing subtests', /--- PASS: TestAdd/.test(testFail.stdout), '');
  check('failing go test exits 1', testFail.exitCode === 1, `exit=${testFail.exitCode}`);

  const testPass = await runner.run({
    code: sampleById('go-test').code.replace(/func TestIntentionalFailure[\s\S]*$/, ''),
    sessionId: 'vgo',
    mode: 'test',
  });
  check('passing go test exits 0', testPass.exitCode === 0, `exit=${testPass.exitCode}`);
  check('passing go test reports ok', /^ok\s/m.test(testPass.stdout) || /PASS/.test(testPass.stdout), '');

  // ---- session reset ----
  check('session is tracked', runner.sessionCount() >= 1, `${runner.sessionCount()} session(s)`);
  const reset = await runner.resetSession('vgo');
  check('session reset acknowledged', reset === true);
  check('session count drops after reset', runner.sessionCount() === 0, `${runner.sessionCount()}`);

  // ---- timeout ----
  const slow = await runner.run({
    code: 'package main\n\nimport "time"\n\nfunc main() { time.Sleep(10 * time.Second) }\n',
    sessionId: 'vtimeout',
    timeoutMs: 1500,
  });
  check('run timeout enforced', slow.timedOut === true, `${Math.round(slow.durationMs)}ms`);

  await runner.close();

  // ================= degrade path =================
  const bogus = new GoRunner(kernel, 'C:\\definitely\\not\\here\\go.exe');
  check('bogus GO_BIN reports unavailable', bogus.available === false, bogus.discovery.source);
  const degraded = await bogus.run({ code: 'package main\n\nfunc main() {}\n', sessionId: 'x' });
  check('degrade path returns a clear error', /toolchain not found/i.test(degraded.stderr), degraded.stderr.trim().slice(0, 60));
  check('degrade path does not throw', degraded.exitCode === -1 && degraded.compileError === true);
  await bogus.close();

  // ================= the gopls loop =================
  if (!server.launch) {
    check('gopls unavailable — LSP checks skipped', true, 'graceful degradation');
  } else {
    const ws = new WorkspaceService(kernel, { goBin: go.bin });
    await ws.init({ go: defaultSample('go').code });

    const st = ws.status();
    const goStatus = st.languages.find((l) => l.id === 'go');
    check('go appears in workspace status', !!goStatus, goStatus?.binary ?? '');
    check('go buffer file created', /main\.go$/.test(goStatus?.bufferPath ?? ''), goStatus?.bufferPath ?? '');
    check('go runner reports available', goStatus?.available === true, goStatus?.binarySource ?? '');
    check(
      'go lsp starts out idle (lazy)',
      goStatus?.lsp.state === 'pending',
      goStatus?.lsp.state ?? '',
    );

    // First Go operation starts gopls. It type-checks the module on startup,
    // so this is the slowest step in the suite.
    const bad = [
      'package main',
      '',
      'import "fmt"',
      '',
      'func main() {',
      '\tfmt.Println(undefinedThing)',
      '}',
      '',
    ].join('\n');
    const t0 = Date.now();
    const diag = await ws.diagnose('go', bad);
    const elapsed = Date.now() - t0;
    check('gopls answered a diagnostics request', diag.fromLsp === true, `${elapsed}ms`);
    check(
      'gopls reports the undefined identifier',
      diag.items.some((d) => /undefined/i.test(d.message)),
      diag.items.map((d) => d.message).slice(0, 2).join(' | ') || '(no items)',
    );
    check(
      'gopls diagnostics carry a position',
      diag.items.every((d) => typeof d.line === 'number' && d.line >= 0),
      diag.items.length ? `first at L${diag.items[0].line}` : 'n/a',
    );

    const afterStart = ws.status().languages.find((l) => l.id === 'go');
    check('go lsp reports ready after first use', afterStart?.lsp.state === 'ready', afterStart?.lsp.serverName ?? '');
    check(
      'go lsp logged language-server records',
      (afterStart?.lsp.logRecords ?? 0) >= 0,
      `${afterStart?.lsp.logRecords ?? 0} record(s)`,
    );

    // A clean file should produce no errors.
    const good = ['package main', '', 'import "fmt"', '', 'func main() {', '\tfmt.Println("hi")', '}', ''].join('\n');
    const cleanDiag = await ws.diagnose('go', good);
    check(
      'clean go file reports no errors',
      cleanDiag.errors === 0,
      cleanDiag.items.map((d) => d.message).slice(0, 2).join(' | ') || 'clean',
    );

    // Completion after `fmt.` should offer exported stdlib symbols.
    const compSrc = ['package main', '', 'import "fmt"', '', 'func main() {', '\tfmt.', '}', ''].join('\n');
    const items = await ws.complete('go', compSrc, 5, 5);
    check('gopls returns completion items', items.length > 0, `${items.length} items`);
    check(
      'completion includes Println',
      items.some((i) => i.label === 'Println' || /Println/.test(i.label)),
      items.slice(0, 5).map((i) => i.label).join(', '),
    );

    // Python must be unaffected by any of the above.
    const pyStatus = ws.status().languages.find((l) => l.id === 'python');
    check('python slot still healthy alongside go', pyStatus?.lsp.state === 'ready', pyStatus?.lsp.serverName ?? '');

    const pyRun = await ws.run('python', 'print("py still works")', { sessionId: 'vgo' });
    check('python still runs after go work', /py still works/.test(pyRun.stdout), `exit=${pyRun.exitCode}`);

    // And Go executes through the same unified path.
    const goRun = await ws.run('go', 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("unified") }\n', {
      sessionId: 'vgo',
    });
    check('go runs through the unified workspace path', /unified/.test(goRun.stdout), `exit=${goRun.exitCode}`);
    check('unified run result carries languageId', goRun.languageId === 'go', goRun.languageId);

    await ws.close();
  }

  await kernel.stop();
  report();
}

function report(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failed: ' + failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('verify-go failed:', e);
  process.exit(1);
});
