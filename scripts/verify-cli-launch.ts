/**
 * Verify the `nlg web` and `nlg desktop` entry points boot the workspace server
 * and answer `/health`. Uses `--no-open` so no browser/window is actually
 * launched (headless-friendly); the test only asserts the server comes up.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-cli-launch.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    fails.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForHealth(base: string, proc: ChildProcess, timeoutMs = 25000): Promise<boolean> {
  const url = `${base}/health`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function testLaunch(kind: 'web' | 'desktop', port: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'nolang-cli-'));
  const proc = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--experimental-loader',
      './resolve-loader.mjs',
      `scripts/${kind}.ts`,
      '--no-open',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PANEL_PORT: port,
        PANEL_HOST: '127.0.0.1',
        NOLANGUAGE_HOME: home,
        NOLANGUAGE_QUIET: '1',
        NOLANGUAGE_NO_BROWSER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const base = `http://127.0.0.1:${port}`;
  const ok = await waitForHealth(base, proc);
  check(`nlg ${kind} --no-open serves /health on :${port}`, ok, ok ? '' : 'server did not come up');
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  if (proc.exitCode === null) proc.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
}

async function main(): Promise<void> {
  await testLaunch('web', '7411');
  await testLaunch('desktop', '7412');

  // The harness reads `N/M checks passed`; printing a different sentence made
  // this suite invisible to the summary (it counted as 0/0 and looked neutral).
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) {
    console.log('failures:');
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
