/**
 * Packaged-exe smoke test.
 *
 * Copies `dist/Nolanguage.exe` into an isolated directory (so its SQLite
 * telemetry lands there and not in the repo), starts it, and drives it like a
 * real user would over HTTP + WebSocket:
 *
 *   1. GET /health            — server up, Python LSP ready, Go slot resolved
 *   2. GET /                  — the workspace page is the PyCharm-style shell
 *   3. WS check (Go)          — the *first* gopls call in the process, i.e. the
 *                               cold-start path that needs the nudge retry
 *   4. WS run  (Python)       — real execution through the packaged binary
 *   5. telemetry file         — the warm tier actually persisted
 *
 * Run:  node --experimental-loader ./resolve-loader.mjs --experimental-transform-types scripts/smoke-exe.ts
 * Exits non-zero (and leaves the log tail) on the first failure.
 *
 * Sandbox note: the exe is copied into a sandbox under the *project* tree
 * (`.tmp/smoke-<pid>-<rand>/`) rather than `%TEMP%`. A sandboxed harness (see
 * the fs shim referenced in the error path below) authorises descendant writes
 * per spawn, so a directory freshly created under `%TEMP%` by an earlier tool
 * call ends up outside the allow-list and every `writeFile` fails with
 * `EPERM -4048`. The project tree stays inside the sandboxed workspace, so it
 * is writable from a grandchild process. `NOLANGUAGE_SMOKE_DIR` overrides it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawWsClient, delay } from './lib/RawWsClient.js';
import { resolveGoBin, discoverGoServer } from '../src/go/discover.js';

const PREFERRED_PORT = Number(process.env.PANEL_PORT ?? 7399);

/**
 * Probe candidate ports for a free one.
 *
 * The port is verified **after** the exe is up, not before: closing a probe
 * socket and hoping the exe wins the race is not reliable here. Instead we ask
 * the OS for a candidate, and `startAndWait()` retries with the next candidate
 * if the exe answers `EADDRINUSE`. That keeps a leftover server from being
 * misreported as a broken build.
 */
function probePort(candidate = 0): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(0));
    probe.listen(candidate, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

let PORT = PREFERRED_PORT;
let BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
let skipped = 0;

function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

/**
 * An optional external tool is absent, so the check could not run. Counted
 * apart from pass/fail: the packaged exe must work on a machine without
 * `gopls`, and blaming the build for that would be wrong.
 */
function skip(label: string, detail = ''): void {
  skipped++;
  console.log(`SKIP  ${label}${detail ? `  — ${detail}` : ''}`);
}

const GO_BROKEN = `package main

import "fmt"

func main() {
	fmt.Printl("hello")
}
`;

/**
 * Is `gopls` installed? The packaged exe has to boot and serve either way; this
 * only decides whether the LSP-dependent assertions can actually run.
 */
const hasGopls = !!discoverGoServer(resolveGoBin()).launch;

function waitForExit(child: ChildProcess, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => resolve(), timeoutMs);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const exe = join(root, 'dist', 'Nolanguage.exe');
  // See the sandbox note in the header: keep the sandbox inside the project
  // tree so a sandboxed harness still authorises the exe's writes.
  const sandboxRoot = process.env.NOLANGUAGE_SMOKE_DIR ?? join(root, '.tmp');
  const sandbox = join(sandboxRoot, `smoke-${process.pid}-${Date.now().toString(36)}`);
  await mkdir(sandbox, { recursive: true });
  const exeInSandbox = join(sandbox, 'Nolanguage.exe');
  await copyFile(exe, exeInSandbox);

  console.log(`smoke: ${exe}`);
  console.log(`sandbox: ${sandbox}\n`);

  // Pre-create the directories the workspace writes into, so the exe only has
  // to open files rather than create the tree itself.
  const workspaceDir = join(sandbox, 'ide');
  await mkdir(join(workspaceDir, 'python'), { recursive: true });
  await mkdir(join(workspaceDir, 'go'), { recursive: true });
  // App state (telemetry database, WebView profile) goes to `%LOCALAPPDATA%`
  // by default now, which is outside the sandbox. NOLANGUAGE_DATA pins it back
  // inside, so the check below still proves where the bytes landed without
  // touching the developer's real profile.
  const appDataDir = join(sandbox, 'appdata');
  await mkdir(appDataDir, { recursive: true });
  // The packaged build unpacks its embedded extensions under `%TEMP%` on every
  // start. Pointing TEMP at the sandbox keeps that write inside the tree the test
  // is allowed to touch, and keeps concurrent runs from sharing one cache.
  const tempDir = join(sandbox, 'temp');
  await mkdir(tempDir, { recursive: true });
  // Stand-in for the user profile: `~/.nolanguage` lands here instead of in the
  // developer's real home.
  const homeDir = join(sandbox, 'home');
  await mkdir(homeDir, { recursive: true });

  // Start the exe, retrying on a different port if that one is taken. A stale
  // server holding the preferred port must not look like a broken build.
  let child!: ChildProcess;
  let serverLog = '';
  let health: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 4 && !health; attempt++) {
    PORT = attempt === 0 ? await probePort(PREFERRED_PORT) : await probePort(0);
    BASE = `http://127.0.0.1:${PORT}`;
    serverLog = '';
    child = spawn(exeInSandbox, [], {
      cwd: sandbox,
      // NOLANGUAGE_QUIET=0 so the server banner (and any failure detail) is
      // visible in the captured log; no window is popped during an automated run.
      // PANEL_WORKSPACE pins the editor buffer dir into the sandbox: the default
      // is `%TEMP%/nolanguage-ide-<pid>`, which a sandboxed harness may not allow
      // the child to create.
      //
      // TEMP/TMP do the same for the embedded extension tree
      // (`%TEMP%/nolanguage-embedded`), which the packaged build writes on every
      // start. Two reasons beyond the sandbox: a denied write there aborts
      // startup with EPERM and no server, and the real `%TEMP%` is shared, so two
      // concurrent smoke runs would fight over the same files.
      env: {
        ...process.env,
        PANEL_PORT: String(PORT),
        PANEL_WORKSPACE: workspaceDir,
        NOLANGUAGE_DATA: appDataDir,
        TEMP: tempDir,
        TMP: tempDir,
        // The plugin home is `~/.nolanguage` (sessions, per-language data), and
        // `homedir()` reads USERPROFILE on Windows. Without this the packaged exe
        // writes into the developer's real profile — which a sandboxed harness
        // denies, so a run session silently never starts.
        USERPROFILE: homeDir,
        HOME: homeDir,
        NOLANGUAGE_QUIET: '0',
        NOLANGUAGE_NO_BROWSER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout!.on('data', (c: Buffer) => {
      serverLog += c.toString();
    });
    child.stderr!.on('data', (c: Buffer) => {
      serverLog += c.toString();
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 40_000) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) {
          health = (await res.json()) as Record<string, unknown>;
          break;
        }
      } catch {
        /* not up yet */
      }
      // An EADDRINUSE means the port, not the build, is the problem: give up on
      // this attempt immediately and try another port.
      if (serverLog.includes('EADDRINUSE')) break;
      await delay(300);
    }
    if (!health) {
      child.kill();
      await waitForExit(child);
      if (serverLog.includes('EADDRINUSE')) {
        console.log(`note: port ${PORT} was busy — retrying on another one`);
        continue;
      }
      break;
    }
  }

    check(!!health, 'GET /health responds', `port ${PORT}`);
    if (!health) {
      console.log('\n--- server log tail ---');
      console.log(serverLog.split('\n').slice(-40).join('\n') || '(no output)');
      throw new Error('server never came up');
    }
    // The banner wording differs between the disabled and enabled paths, so
    // match the intent rather than one exact sentence.
    check(
      /Window launch disabled|Browser launch disabled/.test(serverLog),
      'NOLANGUAGE_NO_BROWSER is honoured (no window popped)',
      serverLog.match(/Window launch disabled|Browser launch disabled/)?.[0] ?? 'banner line missing',
    );

  try {
    const wsStatus = health.workspace as {
      lsp: { available: boolean; serverName: string };
      languages: Array<{ id: string; binary: string; binarySource: string; version?: string }>;
    };
    check(wsStatus.lsp.available === true, 'python LSP is ready', wsStatus.lsp.serverName);
    const go = wsStatus.languages.find((l) => l.id === 'go');
    check(!!go?.available !== false, 'go slot present');
    check(
      /Go lang[\\/]bin[\\/]go\.exe$/i.test(go?.binary ?? ''),
      'go toolchain discovered in "D:\\Go lang"',
      `${go?.binary ?? '(none)'} [${go?.binarySource ?? '?'}]`,
    );
    check((go?.version ?? '').includes('1.27'), 'go version probed', go?.version ?? '');

    // ---- from here on we talk to the running server over the socket ------
    const ws = new RawWsClient(PORT);
    try {
      // ---- 2. workspace page is the PyCharm-style shell --------------------
      const page = await (await fetch(`${BASE}/`)).text();
      check(page.includes('id="strip"') && page.includes('data-theme="darcula"'), 'workspace page is the PyCharm shell', `${page.length} bytes`);
      check(page.includes('id="termIn"'), 'workspace page ships the terminal');

      // ---- 2b. every served page is present and self-contained -------------
      for (const [route, marker] of [
        ['/monitor', 'Dev Panel'],
        ['/perf', 'Kernel Performance'],
        ['/extensions', 'Extensions'],
      ] as Array<[string, string]>) {
        const body = await (await fetch(`${BASE}${route}`)).text();
        check(
          body.includes(marker) && !/<script[^>]+src=/i.test(body),
          `GET ${route} serves a self-contained page`,
          `${body.length} bytes`,
        );
      }
      const perfPage = await (await fetch(`${BASE}/perf`)).text();
      check(perfPage.includes("app.component('trend-chart'"), 'the perf page ships its trend chart');
      check(perfPage.includes('function unitOf'), 'the perf page ships unit classification');

      // ---- 3. first Go check (gopls cold start) ----------------------------
      // The packaged exe must boot and serve on a machine with no language
      // server, so the Go *toolchain* check still runs — but the diagnostics
      // themselves need gopls to answer, and its absence is a skip, not a
      // failure of the build.
      await ws.ready;
      ws.send({ kind: 'check', language: 'go', code: GO_BROKEN });
      const diag = await ws.waitFor('diagnostics', 45_000);
      check(!!diag, 'first go check answers (cold gopls)');
      const items = (diag as { items?: Array<{ message: string; severity: number }> })?.items ?? [];
      if (hasGopls) {
        check(items.length > 0, 'first go check reports the error', `${items.length} item(s)`);
        check(
          items.some((i) => /Printl|undefined/.test(i.message)),
          'message names the undefined identifier',
          items.map((i) => i.message).join(' | '),
        );
      } else {
        skip('first go check reports the error', 'gopls not installed on this machine');
        skip('message names the undefined identifier', 'gopls not installed on this machine');
      }

      // ---- 4. Python run ----------------------------------------------------
      ws.clearReceived();
      ws.send({ kind: 'run', language: 'python', code: 'print("hi from exe", 6 * 7)' });
      const run = (await ws.waitFor('runResult', 30_000)) as
        | { exitCode: number | null; stdout: string }
        | undefined;
      check(run?.exitCode === 0, 'python run exits 0', `exit=${run?.exitCode}`);
      check(
        (run?.stdout ?? '').includes('hi from exe 42'),
        'python stdout captured',
        JSON.stringify(run?.stdout ?? ''),
      );

      // ---- 5. warm tier persisted in the app data root ----------------------
      await delay(600);
      const dbPath = join(appDataDir, 'telemetry.db');
      try {
        const s = await stat(dbPath);
        check(s.size > 0, 'sqlite warm tier persisted', `${s.size} bytes`);
      } catch {
        check(false, 'sqlite warm tier persisted', `missing: ${dbPath}`);
      }

      // ---- 6. built-in extensions, unpacked from the exe --------------------
      // They live only inside the executable, so discovering them proves the
      // embedded assets were materialised and the host can import them.
      ws.clearReceived();
      ws.send({ kind: 'listExtensions' });
      const list = (await ws.waitFor('extensions', 20_000)) as
        | { extensions: Array<{ id: string; state: string; compatible: boolean }> }
        | undefined;
      const ids = (list?.extensions ?? []).map((e) => e.id).sort();
      check(ids.length > 0, 'embedded extensions are discovered by the exe', ids.join(','));
      check(ids.includes('demo.hello'), 'demo.hello shipped inside the exe');
      check(ids.includes('demo.faulty'), 'demo.faulty shipped inside the exe');

      // Run a contributed command: this spawns the exe again in host mode.
      ws.clearReceived();
      ws.send({ kind: 'runExtensionCommand', id: 'demo.hello.fib', args: [16], reqId: 1 });
      const cmd = (await ws.waitFor('extensionResult', 45_000)) as
        | { ok: boolean; result?: unknown; error?: string }
        | undefined;
      check(cmd?.ok === true, 'extension command runs from the packaged exe', String(cmd?.result ?? cmd?.error));
      check(cmd?.result === 987, 'fib(16) = 987 across the process boundary', String(cmd?.result));

      // The host is a second instance of the same exe.
      ws.clearReceived();
      ws.send({ kind: 'listExtensions' });
      const after = (await ws.waitFor('extensions', 15_000)) as
        | { extensions: Array<{ id: string; state: string; pid?: number }> }
        | undefined;
      const hello = after?.extensions.find((e) => e.id === 'demo.hello');
      check(hello?.state === 'ready', 'extension host is ready in the packaged build', hello?.state ?? '?');
      check(!!hello?.pid, 'host runs in its own process', `pid=${hello?.pid}`);
    } finally {
      ws.close();
    }
  } finally {
    child.kill();
    await waitForExit(child);
  }

  const total = passed + failed;
  console.log(`\n${passed}/${total} checks passed${skipped ? ` (${skipped} skipped: optional tool missing)` : ''}`);
  if (failed > 0) {
    console.log('\n--- server log tail ---');
    console.log(serverLog.split('\n').slice(-40).join('\n'));
  }
  // Windows keeps an image lock on the copied exe for a moment after the
  // process exits, so removing the sandbox can race with EBUSY. Cleanup is
  // best-effort: a leftover directory under `.tmp/` must never fail the run.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 400 });
      break;
    } catch {
      if (attempt === 2) console.log(`note: left sandbox behind -> ${sandbox}`);
      await delay(500);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
