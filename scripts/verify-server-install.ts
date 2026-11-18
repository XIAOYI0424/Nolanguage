/**
 * `nlg lang server` — the answer to "why is this language dumb?".
 *
 * The product ships no language server, so every language is only as smart as
 * what happens to be on `PATH`. This suite covers the three things that make the
 * new command trustworthy rather than decorative:
 *
 *   1. it reports what is missing, per language, from the plugin's own manifest;
 *   2. `install` puts the server somewhere the *panel* then finds (the managed
 *      root is only consulted when normal discovery finds nothing);
 *   3. a `github` provider prints instructions instead of downloading a binary
 *      nobody can verify.
 *
 * The acceptance test is step 2's second half: after the install, the panel must
 * serve real member completion — not the stub's flat builtin list — without any
 * environment variable pointing at the server.
 *
 * Needs the network (npm). SKIPs when `npm` is unavailable or the exe is missing.
 *
 * Run: npm run verify:server-install
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawWsClient } from './lib/RawWsClient.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXE = process.env.NOLANGUAGE_EXE ?? join(ROOT, 'dist', 'Nolanguage.exe');
const SANDBOX = join(ROOT, '.tmp', 'verify-server-install');
const HOME = join(SANDBOX, 'home');
const TMP = join(SANDBOX, 'tmp');
const PORT = Number(process.env.VERIFY_PORT ?? 7821);

const results: Array<{ name: string; ok: boolean; detail: string; skipped?: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name: string, detail = ''): void {
  results.push({ name, ok: true, detail, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

function cli(args: string[]): { code: number | null; out: string } {
  // The temp paths must stay inside the checkout: this process unpacks its
  // embedded plugins before it can answer anything, and a sandboxed or locked
  // profile cannot write to `%LOCALAPPDATA%`.
  const r = spawnSync(EXE, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600_000,
    env: {
      ...process.env,
      NOLANGUAGE_HOME: HOME,
      TMP,
      TEMP: TMP,
      TMPDIR: TMP,
      // npm keeps its cache under `%LOCALAPPDATA%`; point it at the checkout so a
      // locked-down profile does not turn "install a server" into an EPERM.
      npm_config_cache: join(SANDBOX, 'npm-cache'),
    },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function waitHealth(): Promise<boolean> {
  for (let i = 0; i < 160; i++) {
    const ok = await new Promise<boolean>((res) => {
      const r = request({ host: '127.0.0.1', port: PORT, path: '/health' }, (x) => { x.resume(); x.on('end', () => res(true)); });
      r.on('error', () => res(false));
      r.end();
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main(): Promise<void> {
  rmSync(SANDBOX, { recursive: true, force: true });
  for (const d of [HOME, TMP]) mkdirSync(d, { recursive: true });

  // ---- 1. status before anything is installed ----
  const before = cli(['lang', 'server', '--home', HOME]);
  check('lang server answers', before.code === 0 && /SERVER/.test(before.out), (before.out.split('\n')[1] ?? '').trim());
  const beforeRows = before.out.split('\n').filter((l) => /^(python|go|javascript|markdown|java)\s/.test(l));
  check('it lists every builtin language', beforeRows.length === 5, `${beforeRows.length} row(s)`);
  check('all five are reported missing', beforeRows.every((l) => /MISSING/.test(l)), beforeRows.map((l) => l.trim().split(/\s+/)[0]).join(','));
  check('each missing row carries the exact command', beforeRows.some((l) => /npm install --prefix/.test(l)) && beforeRows.some((l) => /go install/.test(l)));

  // ---- 2. install one, and prove the panel uses it ----
  const npmOk = spawnSync('npm', ['--version'], { encoding: 'utf8', shell: true, windowsHide: true }).status === 0;
  if (!npmOk) {
    skip('lang server install javascript', 'npm is not available on this machine');
  } else {
    const install = cli(['lang', 'server', 'install', 'javascript', '--home', HOME]);
    check('lang server install runs the provider', install.code === 0 && /installed javascript/.test(install.out),
      (install.out.split('\n').filter(Boolean).slice(-2)[0] ?? '').trim().slice(0, 80));
    const managed = join(HOME, 'servers', 'javascript', 'node_modules', '.bin', 'typescript-language-server.cmd');
    check('it lands in the managed root', existsSync(managed), managed);
    check('it pulls the peer dependency too', existsSync(join(HOME, 'servers', 'javascript', 'node_modules', 'typescript')),
      'typescript');

    const after = cli(['lang', 'server', '--home', HOME]);
    const jsRow = after.out.split('\n').find((l) => /^javascript\s/.test(l)) ?? '';
    check('the status flips to found', /yes/.test(jsRow) && !/MISSING/.test(jsRow), jsRow.trim().slice(0, 70));
    check('and says it came from the managed root', /managed/.test(jsRow), jsRow.trim().slice(0, 70));

    // The panel must find it with no environment variable in sight: that is the
    // whole point of teaching `resolveServer` about the managed root.
    const logs: string[] = [];
    const child: ChildProcess = spawn(EXE, ['--no-open'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NOLANGUAGE_NO_BROWSER: '1',
        NOLANGUAGE_HOME: HOME,
        PANEL_PORT: String(PORT),
        PANEL_NO_DEMO: '1',
        PANEL_NO_STORE: '1',
        TMP,
        TEMP: TMP,
        TMPDIR: TMP,
        // Explicitly clear anything that would mask the managed lookup.
        JS_LSP: '',
      },
    });
    child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));

    let client: RawWsClient | undefined;
    try {
      if (!(await waitHealth())) {
        console.log(logs.join('').slice(-1500));
        throw new Error('the exe never answered /health');
      }
      client = new RawWsClient(PORT);
      await client.ready;
      const SRC = ['function sum(v) { return v.length; }', 'const nums = [1, 2, 3];', 'nums.', ''].join('\n');
      client.clearReceived();
      client.send({ kind: 'complete', language: 'javascript', code: SRC, line: 2, character: 5, requestId: 1 });
      const comp = (await client.waitFor('completion', 120_000)) as Record<string, unknown> | undefined;
      const items = (comp?.items ?? []) as Array<{ label: string }>;
      check('the panel finds the managed server without JS_LSP', !comp?.unsupported, String(comp?.unsupported ?? 'ok'));
      check('and serves real member completion', items.length >= 20, `${items.length} item(s)`);
      check('the members are Array members', items.some((i) => i.label === 'map') && items.some((i) => i.label === 'filter'),
        items.slice(0, 6).map((i) => i.label).join(','));
    } finally {
      client?.close();
      try { child.kill(); } catch { /* gone */ }
      await new Promise((ok) => setTimeout(ok, 400));
    }
  }

  // ---- 3. a github provider refuses to download ----
  const manual = cli(['lang', 'server', 'install', 'markdown', '--home', HOME]);
  check('a github provider explains instead of downloading', manual.code === 0 && /no automatic install/.test(manual.out),
    (manual.out.split('\n')[1] ?? '').trim().slice(0, 90));
  check('it names the exact path to drop the binary into',
    new RegExp(join('servers', 'markdown').replace(/\\/g, '\\\\')).test(manual.out));
  check('nothing was written for it', !existsSync(join(HOME, 'servers', 'markdown', 'marksman.exe')));

  rmSync(SANDBOX, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
  if (failed.length) {
    console.log('FAILED:\n' + failed.map((f) => `  - ${f.name}  ${f.detail}`).join('\n'));
    process.exit(1);
  }
}

if (!existsSync(EXE)) {
  console.log('SKIP  the packaged exe has not been built — run npm run build:exe');
  process.exit(0);
}

await main();
