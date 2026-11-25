/**
 * Real-application test: open an external project folder and configure its
 * Python virtual environment through Nolanguage's own built-in protocol.
 *
 * This does not simulate the panel. It spawns the real panel server, connects
 * with the same WebSocket protocol the IDE page uses, and drives the same
 * messages the File > Open Folder, Project Interpreter and Packages actions
 * send. The environment is pinned with `setInterpreter`, dependencies are
 * installed with `dependencyInstall`, and the result is exercised through
 * `run`.
 *
 * Run:
 *   npm run verify:workspace-env
 *
 * Optional overrides:
 *   NLG_TARGET_DIR       folder to open (default D:/15936/Documents/NeroSama)
 *   NLG_TEST_PACKAGES    comma-separated pip specs (default fastapi>=0.115)
 *   VERIFY_PORT          panel port (default 7527)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { RawWsClient } from './lib/RawWsClient.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGET = resolve(process.env.NLG_TARGET_DIR ?? 'D:/15936/Documents/NeroSama');
const SUBDIR = resolve(TARGET, 'vtuber', 'python');
const PORT = Number(process.env.VERIFY_PORT ?? 7527);
const PACKAGES = (process.env.NLG_TEST_PACKAGES ?? 'fastapi>=0.115')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const VENV_PY = resolve(TARGET, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function moduleOf(spec: string): string {
  return spec.replace(/\[[^\]]*\]/, '').split(/[<>=!~;]/)[0].trim().replace(/-/g, '_');
}

async function waitForHttp(port: number, timeoutMs: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return (await response.json()) as Record<string, unknown>;
    } catch {
      /* server is still booting */
    }
    if (Date.now() - started > timeoutMs) throw new Error('panel did not start');
    await delay(150);
  }
}

async function main(): Promise<void> {
  if (!existsSync(TARGET)) throw new Error(`target folder not found: ${TARGET}`);
  if (!existsSync(VENV_PY)) throw new Error(`the project environment has no interpreter: ${VENV_PY}`);

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
      cwd: ROOT,
      env: {
        ...process.env,
        PANEL_PORT: String(PORT),
        PANEL_EXPLORER_ROOT: TARGET,
        PANEL_NO_DEMO: '1',
        PANEL_NO_STORE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let serverOut = '';
  child.stdout.on('data', (d: Buffer) => (serverOut += d.toString()));
  child.stderr.on('data', (d: Buffer) => (serverOut += d.toString()));

  // Two throwaway folders let the suite prove that File > Open Folder is a
  // per-window project context, not a process-wide variable.
  const scratch = await mkdtemp(join(tmpdir(), 'nlg-project-root-'));
  const ROOT_A = join(scratch, 'project-a');
  const ROOT_B = join(scratch, 'project-b');
  await mkdir(ROOT_A, { recursive: true });
  await mkdir(ROOT_B, { recursive: true });

  let client: RawWsClient | undefined;
  let clientA: RawWsClient | undefined;
  let clientB: RawWsClient | undefined;
  try {
    const health = await waitForHttp(PORT, 25_000);
    check('panel: real server boots against the external project', true, String(health.appVersion ?? ''));

    client = new RawWsClient(PORT);
    await client.ready;
    check('panel: IDE WebSocket handshake succeeds', true, `port ${PORT}`);

    // ---- File > Open Folder ----
    client.clearReceived();
    client.send({ kind: 'openFolder', reqId: 1, path: TARGET });
    const rootMsg = await client.waitFor('fsRoot', 10_000);
    check(
      'openFolder: the explorer points at NeroSama',
      String(rootMsg?.root ?? '').toLowerCase() === TARGET.toLowerCase(),
      String(rootMsg?.root ?? 'no fsRoot reply'),
    );

    client.clearReceived();
    client.send({ kind: 'fsList', reqId: 2, path: '.' });
    const listing = await client.waitFor('fsListing', 10_000);
    const names = ((listing?.entries ?? []) as Array<{ name: string }>).map((e) => e.name);
    check(
      'openFolder: the project tree lists real NeroSama files',
      names.includes('vtuber') && names.includes('README.md'),
      names.slice(0, 8).join(', '),
    );

    // ---- two IDE windows keep independent project roots ----
    clientA = new RawWsClient(PORT);
    clientB = new RawWsClient(PORT);
    await Promise.all([clientA.ready, clientB.ready]);
    clientA.clearReceived();
    clientB.clearReceived();
    clientA.send({ kind: 'openFolder', reqId: 901, path: ROOT_A });
    clientB.send({ kind: 'openFolder', reqId: 902, path: ROOT_B });
    const [rootA, rootB] = await Promise.all([
      clientA.waitForWhere('fsRoot', (m) => Number(m.reqId) === 901, 10_000),
      clientB.waitForWhere('fsRoot', (m) => Number(m.reqId) === 902, 10_000),
    ]);
    check(
      'project root: two windows open different folders without sharing one root',
      String(rootA?.root ?? '').toLowerCase() === ROOT_A.toLowerCase() &&
        String(rootB?.root ?? '').toLowerCase() === ROOT_B.toLowerCase(),
      `${String(rootA?.root ?? 'none')} | ${String(rootB?.root ?? 'none')}`,
    );

    clientA.clearReceived();
    clientB.clearReceived();
    clientA.send({ kind: 'interpreters', language: 'python', requestId: 903 });
    clientB.send({ kind: 'interpreters', language: 'python', requestId: 904 });
    const [interpA, interpB] = await Promise.all([
      clientA.waitFor('interpreters', 20_000),
      clientB.waitFor('interpreters', 20_000),
    ]);
    check(
      'project root: interpreter discovery follows each window',
      String(interpA?.root ?? '').toLowerCase() === ROOT_A.toLowerCase() &&
        String(interpB?.root ?? '').toLowerCase() === ROOT_B.toLowerCase(),
      `${String(interpA?.root ?? 'none')} | ${String(interpB?.root ?? 'none')}`,
    );

    clientA.clearReceived();
    clientB.clearReceived();
    clientA.send({ kind: 'templatesList', reqId: 905 });
    clientB.send({ kind: 'templatesList', reqId: 906 });
    const [templatesA, templatesB] = await Promise.all([
      clientA.waitFor('templates', 10_000),
      clientB.waitFor('templates', 10_000),
    ]);
    check(
      'project root: templates are offered for each window’s folder',
      String(templatesA?.root ?? '').toLowerCase() === ROOT_A.toLowerCase() &&
        String(templatesB?.root ?? '').toLowerCase() === ROOT_B.toLowerCase(),
      `${String(templatesA?.root ?? 'none')} | ${String(templatesB?.root ?? 'none')}`,
    );

    clientA.clearReceived();
    clientA.send({ kind: 'envCreate', language: 'python', provider: 'venv', path: '../escape', reqId: 907 });
    const envA = await clientA.waitFor('envDone', 10_000);
    check(
      'project root: envCreate validates the path against the same window’s root',
      envA?.ok === false && String(envA?.error ?? '').toLowerCase().includes(ROOT_A.toLowerCase()),
      String(envA?.error ?? 'no envDone reply'),
    );

    // ---- File > Project Interpreter ----
    client.clearReceived();
    client.send({ kind: 'interpreters', language: 'python' });
    const first = await client.waitFor('interpreters', 20_000);
    const creates = (first?.creates ?? []) as Array<{ id: string }>;
    check(
      'interpreter picker: venv provider is advertised',
      creates.some((c) => c.id === 'venv'),
      creates.map((c) => c.id).join(', '),
    );
    const rootVenv = ((first?.candidates ?? []) as Array<{ path: string; source: string }>).find(
      (c) => c.path.toLowerCase() === VENV_PY.toLowerCase(),
    );
    check(
      'interpreter picker: discovers the environment in the opened folder',
      !!rootVenv && rootVenv.source === '.venv',
      rootVenv ? rootVenv.source : 'not discovered',
    );

    // The create guard must refuse a path outside the project. Configuring an
    // existing environment must not spawn a second one, so this is deliberately
    // the negative path only; the positive path is covered by verify:ide.
    client.clearReceived();
    client.send({ kind: 'envCreate', language: 'python', provider: 'venv', path: '../escape' });
    const refused = await client.waitFor('envDone', 10_000);
    check(
      'envCreate: a path outside the project is refused',
      refused?.ok === false && /inside the project/.test(String(refused?.error ?? '')),
      String(refused?.error ?? 'no envDone reply'),
    );

    client.clearReceived();
    client.send({ kind: 'setInterpreter', language: 'python', path: VENV_PY });
    const pinned = await client.waitFor('interpreterSet', 30_000);
    check(
      'setInterpreter: the project .venv becomes the Python toolchain',
      pinned?.ok === true && String(pinned?.toolchain ?? '').toLowerCase() === VENV_PY.toLowerCase(),
      `${String(pinned?.ok)} ${String(pinned?.toolchain ?? pinned?.error ?? '')}`,
    );

    client.clearReceived();
    client.send({ kind: 'interpreters', language: 'python' });
    const second = await client.waitFor('interpreters', 20_000);
    check(
      'setInterpreter: the pin is reported back to the picker',
      String(second?.pinned ?? '').toLowerCase() === VENV_PY.toLowerCase(),
      String(second?.pinned ?? 'no pinned interpreter'),
    );

    // ---- a subfolder project must see the workspace environment too ----
    client.clearReceived();
    client.send({ kind: 'openFolder', reqId: 3, path: SUBDIR });
    const subRoot = await client.waitFor('fsRoot', 10_000);
    check(
      'openFolder: the nested Python project becomes the explorer root',
      String(subRoot?.root ?? '').toLowerCase() === SUBDIR.toLowerCase(),
      String(subRoot?.root ?? 'no fsRoot reply'),
    );

    client.clearReceived();
    client.send({ kind: 'interpreters', language: 'python' });
    const nested = await client.waitFor('interpreters', 20_000);
    const parentVenv = ((nested?.candidates ?? []) as Array<{ path: string; source: string }>).find(
      (c) => c.path.toLowerCase() === VENV_PY.toLowerCase(),
    );
    check(
      'interpreter picker: a subfolder project discovers the parent .venv',
      !!parentVenv && parentVenv.source === '../../.venv',
      parentVenv ? parentVenv.source : 'not discovered',
    );

    // ---- Packages tool window, now reading the nested project's pyproject ----
    client.clearReceived();
    client.send({ kind: 'dependencyReport', language: 'python', code: '' });
    const report = await client.waitFor('dependencies', 15_000);
    const declared = ((report?.packages ?? []) as Array<{ name: string }>).map((p) => p.name);
    check(
      'Packages: the nested project declares its own dependencies',
      report?.file === 'pyproject.toml' && declared.includes('fastapi') && declared.includes('uvicorn'),
      `${String(report?.file ?? 'no file')}: ${declared.join(', ')}`,
    );

    for (const pkg of PACKAGES) {
      client.clearReceived();
      client.send({ kind: 'dependencyInstall', language: 'python', package: pkg });
      const start = await client.waitFor('dependencyStart', 15_000);
      check(`Packages: install starts for ${pkg}`, !!start, String(start?.toolchain ?? ''));
      const result = await client.waitForWhere(
        'dependencyResult',
        (m) => String(m.package ?? '') === pkg,
        300_000,
      );
      check(
        `Packages: ${pkg} installs through the pinned environment`,
        result?.ok === true,
        String(result?.error ?? result?.command ?? 'no dependencyResult reply'),
      );
    }

    // ---- prove the runner really uses the configured environment ----
    const module = moduleOf(PACKAGES[0] ?? 'fastapi');
    const code = [
      'import sys',
      'import ' + module,
      'print("NLG_EXE=" + sys.executable)',
      'print("NLG_MODULE=" + ' + module + '.__name__)',
    ].join('\n');
    client.clearReceived();
    client.send({ kind: 'run', language: 'python', sessionId: 'verify-workspace-env', code });
    const ran = await client.waitFor('runResult', 60_000);
    const stdout = String(ran?.stdout ?? '');
    check(
      'run: the built-in runner executes inside the configured .venv',
      Number(ran?.exitCode) === 0 &&
        stdout.toLowerCase().includes(VENV_PY.toLowerCase()) &&
        stdout.includes('NLG_MODULE=' + module),
      stdout.trim().replace(/\r?\n/g, ' | ').slice(0, 240),
    );
  } finally {
    client?.close();
    clientA?.close();
    clientB?.close();
    child.kill();
    await delay(200);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} workspace-environment checks passed`);
  if (failed.length) {
    console.log('Failed checks: ' + failed.map((f) => f.name).join('; '));
    const tail = serverOut.split(/\r?\n/).filter(Boolean).slice(-25).join('\n');
    if (tail) console.log('--- panel output (tail) ---\n' + tail);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('FAIL  workspace-environment test aborted — ' + String(err));
  process.exitCode = 1;
});
