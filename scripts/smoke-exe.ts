/**
 * Packaged-exe smoke test.
 *
 * Copies `dist/Nolanguage.exe` into an isolated directory (so its SQLite
 * telemetry lands there and not in the repo), starts it, and drives it like a
 * real user would over HTTP + WebSocket:
 *
 *   1. GET /health            — server up, Python LSP ready, Go slot resolved
 *   2. GET /                  — the IDE page is the Vue one (inline runtime)
 *   3. WS check (Go)          — the *first* gopls call in the process, i.e. the
 *                               cold-start path that needs the nudge retry
 *   4. WS run  (Python)       — real execution through the packaged binary
 *   5. telemetry file         — the warm tier actually persisted
 *
 * Run:  node --experimental-loader ./resolve-loader.mjs --experimental-transform-types scripts/smoke-exe.ts
 * Exits non-zero (and leaves the log tail) on the first failure.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawWsClient, delay } from './lib/RawWsClient.js';

const PORT = Number(process.env.PANEL_PORT ?? 7399);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

const GO_BROKEN = `package main

import "fmt"

func main() {
	fmt.Printl("hello")
}
`;

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
  const sandbox = await mkdtemp(join(tmpdir(), 'nolanguage-smoke-'));
  const exeInSandbox = join(sandbox, 'Nolanguage.exe');
  await copyFile(exe, exeInSandbox);

  console.log(`smoke: ${exe}`);
  console.log(`sandbox: ${sandbox}\n`);

  const child = spawn(exeInSandbox, [], {
    cwd: sandbox,
    // NOLANGUAGE_QUIET=0 so the server banner (and any failure detail) is
    // visible in the captured log; no window is popped during an automated run.
    env: {
      ...process.env,
      PANEL_PORT: String(PORT),
      NOLANGUAGE_QUIET: '0',
      NOLANGUAGE_NO_BROWSER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverLog = '';
  child.stdout!.on('data', (c: Buffer) => {
    serverLog += c.toString();
  });
  child.stderr!.on('data', (c: Buffer) => {
    serverLog += c.toString();
  });

  let health: Record<string, unknown> | undefined;
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
    await delay(300);
  }
    check(!!health, 'GET /health responds');
    if (!health) {
      child.kill();
      throw new Error('server never came up');
    }
    check(
      serverLog.includes('Browser launch disabled'),
      'NOLANGUAGE_NO_BROWSER is honoured (no window popped)',
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
      // ---- 2. IDE page carries the Vue runtime -----------------------------
      const page = await (await fetch(`${BASE}/`)).text();
      check(page.includes('__NOLANGUAGE_IDE__'), 'IDE page is the Vue build', `${page.length} bytes`);
      check(page.includes('Vue is not defined') === false, 'no legacy markers');

      // ---- 3. first Go check (gopls cold start) ----------------------------
      await ws.ready;
      ws.send({ kind: 'check', language: 'go', code: GO_BROKEN });
      const diag = await ws.waitFor('diagnostics', 45_000);
      check(!!diag, 'first go check answers (cold gopls)');
      const items = (diag as { items?: Array<{ message: string; severity: number }> })?.items ?? [];
      check(items.length > 0, 'first go check reports the error', `${items.length} item(s)`);
      check(
        items.some((i) => /Printl|undefined/.test(i.message)),
        'message names the undefined identifier',
        items.map((i) => i.message).join(' | '),
      );

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

      // ---- 5. warm tier persisted next to the exe ---------------------------
      await delay(600);
      const dbPath = join(sandbox, '.nolanguage', 'telemetry.db');
      try {
        const s = await stat(dbPath);
        check(s.size > 0, 'sqlite warm tier persisted', `${s.size} bytes`);
      } catch {
        check(false, 'sqlite warm tier persisted', `missing: ${dbPath}`);
      }
    } finally {
      ws.close();
    }
  } finally {
    child.kill();
    await waitForExit(child);
  }

  const total = passed + failed;
  console.log(`\n${passed}/${total} checks passed`);
  if (failed > 0) {
    console.log('\n--- server log tail ---');
    console.log(serverLog.split('\n').slice(-40).join('\n'));
  }
  // Windows keeps an image lock on the copied exe for a moment after the
  // process exits, so removing the sandbox can race with EBUSY. Cleanup is
  // best-effort: a leftover directory under %TEMP% must never fail the run.
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
