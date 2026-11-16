/**
 * JavaScript verification: discovery, execution, sessions, and the degrade path.
 *
 *   discovery → node is found (and *where* is reported), plus the LSP lookup
 *   run       → the demo test's thrown assertion is the non-zero exit code
 *   state     → `globalThis` survives between runs of one session, reset clears it
 *   timeout   → an infinite loop is killed and the pool recovers
 *   degrade   → no plane / bogus NODE_BIN / missing language server all degrade
 *               with a reason instead of a crash
 *   unified   → the workspace slot reports status and runs through `ws.run()`
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-javascript.ts
 */
import { spawn } from 'node:child_process';
import { Kernel } from '../src/kernel/Kernel.js';
import { LogLevel } from '../src/log/LogLevel.js';
import { commandExists } from '../src/lsp/LspClient.js';
import { ExecService } from '../src/exec/ExecService.js';
import { resolveNodeBin, discoverJsServer } from '../src/js/discover.js';
import { managedBinary } from '../src/langs/serverInstall.js';
import type { LanguageManifest } from '../src/langs/manifest.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsRunner } from '../src/js/JsRunner.js';
import { WorkspaceService } from '../src/panel/WorkspaceService.js';
import { defaultSample } from '../src/panel/samples.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The javascript plugin's manifest — the same one the workspace reads. */
const jsManifest = (): LanguageManifest =>
  JSON.parse(readFileSync(join(ROOT, 'builtin/javascript@1.0.0/manifest.json'), 'utf8')) as LanguageManifest;

const results: { name: string; ok: boolean; detail: string; skipped?: boolean }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/**
 * An optional external tool is absent, so the check could not run.
 *
 * Reported separately from PASS and FAIL on purpose: counting it as a pass
 * would overstate what was verified, and failing it would blame this project
 * for a machine that simply has no language server installed.
 */
function skip(name: string, detail = ''): void {
  results.push({ name, ok: true, detail, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

function makeKernel(): Kernel {
  return new Kernel({
    appVersion: '0.6.0-workspace',
    logLevel: LogLevel.WARN,
    logSilent: true,
    slowThresholdMs: 60,
  });
}

/** `node --version`, or null when the binary cannot be invoked. */
function nodeVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.on('error', () => done(null));
      child.on('close', (code) => done(code === 0 ? out.trim() || null : null));
      setTimeout(() => {
        child.kill();
        done(null);
      }, 10_000).unref?.();
    } catch {
      done(null);
    }
  });
}

const count = (text: string, marker: string): number => (text.match(new RegExp(marker, 'g')) ?? []).length;
const lastLine = (text: string): string => text.trim().split('\n').slice(-1)[0] ?? '';

async function main(): Promise<void> {
  // ================= discovery =================
  const node = resolveNodeBin();
  check('node runtime discovered', node.source !== 'missing', `${node.bin} (via ${node.source})`);

  const version = node.source === 'missing' ? null : await nodeVersion(node.bin);
  check('node version reported', !!version, version ?? 'n/a');

  // `discoverJsServer` is PATH-only, while the workspace also looks in the
  // managed root (`<home>/servers/javascript`). Probing with the narrower rule
  // made the suite assert "no server" on a machine where the workspace had one,
  // so the branch below tested the opposite of what actually happened. Passing
  // the managed path as the preferred one keeps the probe and the workspace in
  // agreement without changing the shape the checks read.
  const managed = managedBinary(jsManifest(), join(homedir(), '.nolanguage'));
  const server = discoverJsServer(managed ?? undefined);
  // Like gopls, the server is an *optional* external tool: a machine can have
  // node and no language server, and the platform must keep running code then.
  if (server.launch) {
    check('typescript-language-server discovered', true, `${server.serverName} (via ${server.source})`);
    check(
      'js launch spec is well formed',
      server.launch.languageId === 'javascript' && server.launch.args.includes('--stdio'),
      `${server.launch.command} ${server.launch.args.join(' ')}`,
    );
  } else {
    skip('typescript-language-server discovered', `not installed — searched ${server.searched.join(', ')}`);
    skip('js launch spec is well formed', 'no server to describe');
  }

  if (node.source === 'missing') {
    console.log('\nnode missing — skipping execution checks.');
    report();
    return;
  }

  // ================= execution =================
  const kernel = makeKernel();
  await kernel.start();
  // `minSize: 0` keeps this suite from pre-warming (and leaking) a python worker
  // it never uses — the JS runner allocates what it needs on first run.
  const exec = new ExecService(kernel, { minSize: 0, nodeBin: node.bin });
  const runner = new JsRunner(kernel, node.bin);
  runner.attachExec(exec);

  // ---- the demo test: 1 intentional failure, so the exit code must be 1 ----
  const demo = await runner.run({ code: defaultSample('javascript').code, sessionId: 'vjs' });
  check('js demo test runs', demo.exitCode !== null, `exit=${demo.exitCode} ${Math.round(demo.durationMs)}ms`);
  check('js demo test reports PASS lines', count(demo.stdout, 'PASS ') >= 7, `${count(demo.stdout, 'PASS ')} PASS`);
  check(
    'js demo test reports the intentional FAIL',
    /^FAIL {2}intentional failing case/m.test(demo.stdout),
    demo.stdout.split('\n').find((l) => l.startsWith('FAIL')) ?? '',
  );
  // A throw is this sandbox's failure signal: there is no process.exit to call.
  check('a thrown assertion is the exit code (1)', demo.exitCode === 1, `exit=${demo.exitCode}`);
  check(
    'the thrown message reaches stderr',
    /1 check\(s\) failed: intentional failing case/.test(demo.stderr),
    lastLine(demo.stderr).slice(0, 70),
  );
  check('demo output was replayed onto the log spine', demo.logLines > 0, `${demo.logLines} line(s)`);
  check('run result names the node binary', demo.nodeBin === node.bin, demo.nodeBin);

  // ---- a clean program ----
  const clean = await runner.run({ code: 'console.log("js ok", 6 * 7);\n', sessionId: 'vjs' });
  check('clean program exits 0', clean.exitCode === 0, `exit=${clean.exitCode}`);
  check('stdout captured', /js ok 42/.test(clean.stdout), JSON.stringify(clean.stdout.trim()));
  check('a clean run carries no error text', clean.stderr === '', JSON.stringify(clean.stderr));

  // ---- console.error goes to stderr, not stdout ----
  const toStderr = await runner.run({ code: 'console.error("bad thing");\n', sessionId: 'vjs' });
  check('console.error is captured as stderr', /bad thing/.test(toStderr.stderr) && !/bad thing/.test(toStderr.stdout));

  // ---- a runtime throw is reported, with a non-zero exit ----
  const thrown = await runner.run({ code: 'throw new Error("boom");\n', sessionId: 'vjs' });
  check('a thrown error exits non-zero', thrown.exitCode !== 0, `exit=${thrown.exitCode}`);
  check('the thrown message is captured', /boom/.test(thrown.stderr), thrown.stderr.trim().slice(0, 60));

  // ---- warm reuse + per-run isolation ----
  // `const` at the top level is the ordinary case, and it is exactly what a
  // shared vm context could not re-run — so re-running is the contract to pin.
  const bump = 'globalThis.n = (globalThis.n || 0) + 1;\nconst label = "seen";\nconsole.log(label + " n=" + globalThis.n);\n';
  const first = await runner.run({ code: bump, sessionId: 'stateful' });
  const second = await runner.run({ code: bump, sessionId: 'stateful' });
  check('the first run of a session is a cold start', first.warm === false, `warm=${first.warm}`);
  check('the second run reuses the warm worker', second.warm === true, `warm=${second.warm}`);
  check('a snippet with a top-level const can be re-run', second.exitCode === 0 && /seen n=1/.test(second.stdout), `exit=${second.exitCode} ${JSON.stringify(second.stdout.trim())}`);
  check(
    'globals do not leak between runs',
    /seen n=1/.test(first.stdout) && /seen n=1/.test(second.stdout),
    `${JSON.stringify(first.stdout.trim())} then ${JSON.stringify(second.stdout.trim())}`,
  );

  // A different session must not share the first session's worker either.
  const other = await runner.run({ code: 'console.log("n=" + (globalThis.n || 0));\n', sessionId: 'stateful-2' });
  check('a second session gets its own worker', other.warm === false, `warm=${other.warm}`);
  check('sessions are isolated', /n=0/.test(other.stdout), JSON.stringify(other.stdout.trim()));

  // The pool keys sessions globally, so a workspace run must own a namespace.
  check(
    'workspace sessions are namespaced in the pool',
    exec.list().some((s) => s.sessionId === 'js:stateful' && s.languageId === 'javascript'),
    exec.list().map((s) => `${s.sessionId}(${s.languageId})`).join(', '),
  );
  // ...and an idle worker must never be handed to a second session while the
  // first still owns it (the pool used to double-book cold starts).
  const ids = exec.list().map((s) => s.sessionId);
  check('no session id is registered twice', new Set(ids).size === ids.length, ids.join(', '));

  // ---- reset disposes the warm worker ----
  check('js sessions are counted', runner.sessionCount() >= 2, `${runner.sessionCount()} session(s)`);
  check('reset is acknowledged', (await runner.resetSession('stateful')) === true);
  check('reset forgets an unknown session', (await runner.resetSession('never-existed')) === false);
  const afterReset = await runner.run({ code: 'console.log("back");\n', sessionId: 'stateful' });
  check('a reset session starts cold again', afterReset.warm === false && /back/.test(afterReset.stdout), `warm=${afterReset.warm}`);

  // ---- timeout: an infinite loop must not take the suite with it ----
  const slow = await runner.run({ code: 'while (true) {}\n', sessionId: 'vtimeout', timeoutMs: 1200 });
  check('run timeout enforced', slow.timedOut === true, `${Math.round(slow.durationMs)}ms`);
  const recovered = await runner.run({ code: 'console.log("still alive");\n', sessionId: 'vtimeout' });
  check('the pool recovers after a killed worker', /still alive/.test(recovered.stdout), `exit=${recovered.exitCode}`);

  await runner.close();

  // ================= degrade paths =================
  const bare = new JsRunner(kernel, node.bin);
  let bareError = '';
  try {
    await bare.run({ code: 'console.log(1);\n', sessionId: 'x' });
  } catch (err) {
    bareError = (err as Error).message;
  }
  check('a runner without the execution plane says so', /execution plane is unavailable/.test(bareError), bareError.slice(0, 70));

  const bogus = new JsRunner(kernel, 'C:\\definitely\\not\\here\\node.exe');
  check('bogus NODE_BIN reports unavailable', bogus.available === false, bogus.discovery.source);
  check('bogus NODE_BIN is not papered over', bogus.binary === 'C:\\definitely\\not\\here\\node.exe', bogus.binary);

  // ================= the unified workspace path =================
  const ws = new WorkspaceService(kernel, { toolchain: { javascript: node.bin } });
  // Attached *before* init, so the slot created below must pick the plane up.
  const wsExec = new ExecService(kernel, { minSize: 0, nodeBin: node.bin });
  ws.setExec(wsExec);
  await ws.init({ javascript: defaultSample('javascript').code });

  const st = ws.status();
  const jsStatus = st.languages.find((l) => l.id === 'javascript');
  check('javascript appears in workspace status', !!jsStatus, jsStatus?.binary ?? '');
  check('javascript buffer file created', /main\.js$/.test(jsStatus?.bufferPath ?? ''), jsStatus?.bufferPath ?? '');
  check('javascript runner reports available', jsStatus?.available === true, jsStatus?.binarySource ?? '');
  check('javascript lsp starts out idle (lazy)', jsStatus?.lsp.state === 'pending', jsStatus?.lsp.state ?? '');
  check(
    'workspace status still lists every language',
    st.languages.map((l) => l.id).join(',') === 'python,go,javascript,markdown',
    st.languages.map((l) => l.id).join(','),
  );

  const unified = await ws.run('javascript', 'console.log("unified js");\n', { sessionId: 'vws' });
  check('javascript runs through the unified workspace path', /unified js/.test(unified.stdout), `exit=${unified.exitCode}`);
  check('unified run result carries languageId', unified.languageId === 'javascript', unified.languageId);
  check(
    'unified run result carries the node binary + log lines',
    // The `inline-vm` runtime evaluates in this process, so the binary that
    // produced the output is *this* node — not the one PATH discovery finds for
    // the (separate) warm pool.
    unified.binary === process.execPath && unified.logLines > 0,
    `${unified.binary}, ${unified.logLines} line(s)`,
  );
  const unified2 = await ws.run('javascript', 'console.log("second");\n', { sessionId: 'vws' });
  check('a second unified run reuses the session', /second/.test(unified2.stdout), `exit=${unified2.exitCode}`);

  // ---- Check: answers when the server exists, explains itself when it does not ----
  const diag = await ws.diagnose('javascript', 'const x = ;\n');
  if (server.launch) {
    check('javascript lsp answered a diagnostics request', diag.fromLsp === true, diag.items.map((d) => d.message).slice(0, 1).join(' | ') || '(no items)');
    check('javascript diagnostics carry a position', diag.items.every((d) => typeof d.line === 'number' && d.line >= 0), diag.items.length ? `first at L${diag.items[0].line}` : 'n/a');
  } else {
    check('check degrades to a note when the server is missing', diag.fromLsp === false && !!diag.note, (diag.note ?? '').slice(0, 60));
    check('the missing server explains what to install', /typescript-language-server/.test(diag.note ?? ''), '');
  }

  const jsAfter = ws.status().languages.find((l) => l.id === 'javascript');
  check(
    'javascript lsp state reflects the outcome',
    jsAfter?.lsp.state === (server.launch ? 'ready' : 'unavailable'),
    `${jsAfter?.lsp.state ?? ''} ${jsAfter?.lsp.error ?? jsAfter?.lsp.note ?? ''}`.slice(0, 80),
  );

  // ---- neighbours are unaffected ----
  const md = ws.status().languages.find((l) => l.id === 'markdown');
  check('markdown slot is untouched by js work', md?.lsp.state === 'pending', md?.lsp.state ?? '');
  if (commandExists('python')) {
    const pyRun = await ws.run('python', 'print("py still works")\n', { sessionId: 'vjs' });
    check('python still runs after js work', /py still works/.test(pyRun.stdout), `exit=${pyRun.exitCode}`);
  } else {
    skip('python still runs after js work', 'python not on PATH');
  }

  await ws.close();
  await wsExec.close();
  await exec.close();
  await kernel.stop();
  report();
}

function report(): void {
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${skipped ? ` (${skipped} skipped: optional tool missing)` : ''}`);
  if (failed.length) {
    console.log('failed: ' + failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('verify-javascript failed:', e);
  process.exit(1);
});
