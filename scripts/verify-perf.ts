/**
 * Performance budgets: the shell's weight, the boot's latency, and the boot's silence.
 *
 * Three properties that no correctness suite can catch, and that decay with every
 * feature added in the right way:
 *
 *   1. The assembled page stays small enough to parse on a cold WebView2. Every
 *      feature that ships markup ships it here — the fragments are concatenated
 *      into one document, so the size is the sum of everything.
 *   2. Cold start stays in seconds, measured from spawn to the first `/health`
 *      200 — the number the user experiences when the window opens.
 *   3. Booting makes no outbound connection. Not "few": zero. A version check or
 *      a catalog prefetch at startup turns every launch behind a captive portal
 *      into a stall, and TLS errors into noise in the log.
 *
 * Each budget is a ratchet with headroom, like the language-literal budgets: the
 * measured value is printed, and raising a number is a deliberate edit here, not a
 * side effect of adding a panel.
 *
 * Run: node --experimental-transform-types --no-warnings --experimental-loader ./resolve-loader.mjs scripts/verify-perf.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { renderPyCharmHtml } from '../src/panel/pycharm-ui.js';
import { renderPluginsHtml } from '../src/ui/plugins-ui.js';

/** Raw document size. 1.19 MB measured; headroom for one more panel. */
const HTML_BUDGET_BYTES = 1_400_000;
/** What actually crosses the wire with gzip. 311 KB measured. */
const HTML_GZIP_BUDGET_BYTES = 380_000;
/** Spawn → `/health` 200, including the TypeScript loader in a source checkout. */
const COLD_START_BUDGET_MS = 20_000;
/** Outbound attempts allowed while booting. Not a threshold — a contract. */
const BOOT_NETWORK_BUDGET = 0;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}   — ${detail}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL  ${name}   — ${detail}`);
  }
}

const ROOT = process.cwd();

function htmlBudgets(): void {
  const html = renderPyCharmHtml(7310);
  const raw = Buffer.byteLength(html);
  const gz = gzipSync(Buffer.from(html), { level: 6 }).length;
  console.log(`      shell document: ${raw} bytes raw, ${gz} bytes gzip`);
  check('the IDE shell stays under its byte budget', raw <= HTML_BUDGET_BYTES, `${raw} / ${HTML_BUDGET_BYTES}`);
  check('the IDE shell compresses under its budget', gz <= HTML_GZIP_BUDGET_BYTES, `${gz} / ${HTML_GZIP_BUDGET_BYTES}`);
  // A self-contained document is the reason the gzip ratio exists at all: assets
  // fetched at runtime would not be counted here and would defeat the budget.
  check('the IDE shell is one self-contained document', !/\ssrc=["']https?:/i.test(html), 'no remote script/asset URLs');
  const plugins = Buffer.byteLength(renderPluginsHtml());
  console.log(`      plugins page: ${plugins} bytes`);
  check('the plugins page stays small', plugins <= 200_000, `${plugins} / 200000`);
}

async function waitForHealth(port: number, deadline: number): Promise<number | undefined> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return Date.now();
      await res.text();
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

/**
 * A probe that never fires is indistinguishable from a silent boot, so prove the
 * instrument works before trusting the zero.
 */
async function probeSelfTest(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'nl-probe-'));
  const report = join(dir, 'net.json');
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/net-probe.mjs', '-e', "fetch('http://127.0.0.1:9/nope').catch(() => {})"], {
    cwd: ROOT,
    env: { ...process.env, NET_PROBE_FILE: report },
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const counts = existsSync(report) ? (JSON.parse(readFileSync(report, 'utf8')) as Record<string, number>) : undefined;
  check('the network probe sees a fetch', (counts?.fetch ?? 0) >= 1, `fetch ${counts?.fetch ?? 0}`);
  rmSync(dir, { recursive: true, force: true });
}

async function bootBudgets(): Promise<void> {
  const port = 7411;
  const data = mkdtempSync(join(tmpdir(), 'nl-perf-'));
  const probe = join(data, 'net.json');
  const child: ChildProcess = spawn(
    process.execPath,
    [
      // Relative specifiers: an absolute Windows path ("D:\\...") is not a valid
      // ESM URL, and Node rejects it before the server boots.
      '--import',
      './scripts/fixtures/net-probe.mjs',
      '--experimental-transform-types',
      '--no-warnings',
      '--experimental-loader',
      './resolve-loader.mjs',
      './src/panel/server.ts',
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PANEL_PORT: String(port),
        PANEL_HOST: '127.0.0.1',
        PANEL_NO_STORE: '1',
        PANEL_NO_DEMO: '1',
        NOLANGUAGE_DATA: join(data, 'app'),
        NET_PROBE_FILE: probe,
        NOLANGUAGE_LOG_FILE: join(data, 'log.ndjson'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  // Boot failures are invisible otherwise: the child is a server, so "it printed
  // nothing" and "it exited immediately" look identical from here.
  const childLog: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => childLog.push(String(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => childLog.push(String(chunk)));

  const started = Date.now();
  const readyAt = await waitForHealth(port, started + COLD_START_BUDGET_MS + 10_000);
  const elapsed = readyAt === undefined ? -1 : readyAt - started;
  console.log(`      cold start: ${elapsed} ms (spawn to /health 200)`);
  check('cold start stays within its budget', elapsed > 0 && elapsed <= COLD_START_BUDGET_MS, `${elapsed} / ${COLD_START_BUDGET_MS} ms`);
  if (readyAt === undefined) {
    console.log('      (no /health answer — the child said:)');
    for (const line of childLog.join('').split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-12)) {
      console.log(`      | ${line}`);
    }
  }

  // Give any post-boot timer a chance to fire, then read the report while the child
  // is still running: on Windows `kill()` terminates it without running `exit`
  // handlers, so a report written only on exit would never appear.
  await new Promise((r) => setTimeout(r, 500));
  if (!existsSync(probe)) {
    console.log('      (the network probe did not write a report — the preload may not have run)');
  }
  const counts = existsSync(probe) ? (JSON.parse(readFileSync(probe, 'utf8')) as Record<string, number>) : undefined;
  const attempts = counts ? (counts.fetch ?? 0) + (counts.http ?? 0) + (counts.https ?? 0) : -1;
  console.log(`      outbound attempts during boot: ${attempts < 0 ? 'unknown' : attempts}`);
  check(
    'booting makes no outbound connection',
    attempts === BOOT_NETWORK_BUDGET,
    attempts < 0 ? 'no probe report' : `${attempts} / ${BOOT_NETWORK_BUDGET} (fetch ${counts?.fetch ?? 0}, http ${counts?.http ?? 0}, https ${counts?.https ?? 0})`,
  );

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  rmSync(data, { recursive: true, force: true });
}

async function main(): Promise<void> {
  htmlBudgets();
  await probeSelfTest();
  await bootBudgets();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exitCode = 1;
  }
}

void main();
