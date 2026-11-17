/**
 * The dependency features inside the *packaged* binary.
 *
 * `verify-ide.ts` drives `src/panel/server.ts`; `verify-pycharm.ts` drives the
 * client in jsdom. Neither touches the thing a user double-clicks. This suite
 * closes that gap: it launches `dist/Nolanguage.exe`, points the explorer at a
 * scratch project, and talks to it over the same WebSocket the panel uses.
 *
 * # Why a plugin is written into the scratch project
 *
 * The install has to *succeed* for the post-install refresh to be observable,
 * and `pip install` needs the network. So the project tier gets a copy of the
 * Python manifest with two fields changed: a new id, and an `install` command
 * that is `node -e 'console.log(...)'`. Everything else — the language server,
 * the toolchain discovery, the `{toolchain}` placeholder — is the real thing, so
 * the install runs through the real code path and the refresh restarts a real
 * language server. No network, no fake plumbing.
 *
 * Skipped (SKIP, not FAIL) when the exe has not been built.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawWsClient } from './lib/RawWsClient.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// `NOLANGUAGE_EXE` points the suite at any build — an installed copy, a
// release candidate, a machine with the exe somewhere else entirely. Defaults
// to the build output so `npm run verify:packages-exe` just works.
const EXE = process.env.NOLANGUAGE_EXE ?? join(ROOT, 'dist', 'Nolanguage.exe');
// Per-process: a shared directory makes the start-up `rmSync` hit the sandbox's
// bulk-delete guard after a few runs, which shows up as a suite that dies
// before its first check.
const SANDBOX = join(ROOT, '.tmp', 'verify-packages-exe', String(process.pid));
const PROJECT = join(SANDBOX, 'project');
const HOME = join(SANDBOX, 'home');
const TMP = join(SANDBOX, 'tmp');
const PORT = 7814;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name: string, why: string): void {
  results.push({ name, ok: true, detail: `SKIP — ${why}` });
  console.log(`SKIP  ${name}  — ${why}`);
}

/**
 * The project-tier plugin: Python's manifest with a new id and a harmless
 * installer. `pkgt` is a deliberately unused extension so it cannot collide
 * with a real language the panel already knows.
 */
function writeTestPlugin(): void {
  const src = JSON.parse(readFileSync(join(ROOT, 'builtin', 'python@1.0.0', 'manifest.json'), 'utf8')) as Record<string, any>;
  src.id = 'pkgpy';
  src.displayName = 'Package Probe';
  src.description = 'Test-only copy of the Python plugin with a local installer.';
  src.file = { extensions: ['pkgt'], defaultExt: 'pkgt', fileName: 'main.pkgt' };
  src.dependencies = {
    format: 'requirements',
    files: ['deps.txt', 'requirements.txt'],
    // `node -e` prints what it was asked to install, then exits 0. The package
    // name is appended by the engine, so this also proves argv construction.
    install: [process.execPath, '-e', 'console.log("installed " + process.argv[1])'],
  };
  const dir = join(PROJECT, '.nolanguage', 'languages', 'pkgpy@1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(src, null, 2));
}

function launch(): { child: ChildProcess; logs: string[] } {
  const logs: string[] = [];
  const child = spawn(EXE, ['--no-open'], {
    cwd: PROJECT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NOLANGUAGE_NO_BROWSER: '1',
      NOLANGUAGE_HOME: HOME,
      PANEL_EXPLORER_ROOT: PROJECT,
      PANEL_PORT: String(PORT),
      PANEL_NO_DEMO: '1',
      PANEL_NO_STORE: '1',
      TMP,
      TEMP: TMP,
      TMPDIR: TMP,
    },
  });
  child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));
  return { child, logs };
}

async function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function waitHealth(): Promise<{ status: number; body: string }> {
  for (let i = 0; i < 100; i++) {
    const r = await httpGet('/health');
    if (r.status === 200) return r;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  return { status: 0, body: '' };
}

async function main(): Promise<void> {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(TMP, { recursive: true });

  writeFileSync(join(PROJECT, 'requirements.txt'), 'requests==2.31.0\nnumpy>=1.26\n');
  writeFileSync(join(PROJECT, 'go.mod'), 'module example.com/probe\n\ngo 1.22\n\nrequire github.com/spf13/cobra v1.8.0\n');
  writeFileSync(join(PROJECT, 'deps.txt'), 'flask==3.0.0\n');
  writeTestPlugin();

  const { child, logs } = launch();
  let client: RawWsClient | undefined;
  try {
    const health = await waitHealth();
    if (health.status !== 200) {
      console.log(logs.join('').slice(-2000));
      throw new Error('the packaged exe never answered /health');
    }
    const h = JSON.parse(health.body) as { appVersion: string; workspace?: { languages?: unknown[] } };
    check('packaged exe answers /health', true, h.appVersion);
    check('packaged exe carries the new version', /^0\.7\.24/.test(h.appVersion), h.appVersion);

    // ---- the UI actually shipped in the binary ----
    const page = await httpGet('/');
    const html = page.body;
    check('the Packages pane is in the served page', html.includes('pkgs-install') && html.includes('id="pkgName"'));
    check('the Packages tab is registered in the client', html.includes("id: 'packages'") || html.includes('id: "packages"'));
    check('the snippet expander shipped', html.includes('expandSnippet'));
    check('the signature popup shipped', html.includes('sigRender'));
    check('the on-demand completion docs shipped', html.includes('cmpOnDetail'));

    client = new RawWsClient(PORT);
    await client.ready;

    // ---- the test plugin was picked up from the project tier ----
    client.clearReceived();
    client.send({ kind: 'dependencyReport', language: 'pkgpy', code: 'import requests\nimport flask\n' });
    const probe = await client.waitFor('dependencies', 15_000);
    check('a project-tier plugin is loaded from the workspace', probe?.language === 'pkgpy' && probe?.supported === true,
      JSON.stringify(probe?.note ?? probe?.file ?? ''));
    check('its declared dependency file is read', probe?.file === 'deps.txt', String(probe?.file ?? 'none'));
    check('its declared packages are parsed', ((probe?.packages ?? []) as Array<{ name: string }>).some((p) => p.name === 'flask'),
      JSON.stringify((probe?.packages ?? []) as unknown[]));
    check('its undeclared imports are flagged', ((probe?.undeclared ?? []) as string[]).includes('requests'),
      JSON.stringify(probe?.undeclared ?? []));

    // ---- the shipped Python plugin, on the same project ----
    client.clearReceived();
    client.send({ kind: 'dependencyReport', language: 'python', code: 'import requests\nimport flask\n' });
    const py = await client.waitFor('dependencies', 15_000);
    check('python reads requirements.txt', py?.file === 'requirements.txt', String(py?.file ?? 'none'));
    check('python reports the pinned version', ((py?.packages ?? []) as Array<{ name: string; version?: string }>)
      .some((p) => p.name === 'requests' && p.version === '==2.31.0'), JSON.stringify((py?.packages ?? []) as unknown[]));
    check('python flags what nothing declares', ((py?.undeclared ?? []) as string[]).includes('flask'),
      JSON.stringify(py?.undeclared ?? []));
    check('python declares an install command', py?.installable === true && Array.isArray(py?.installTemplate));

    // A project with only a pyproject.toml: the manifest's default format is
    // `requirements`, so the per-file `format` is what keeps this from parsing
    // as five fake packages (`name`, `version`, `dependencies` …).
    renameSync(join(PROJECT, 'requirements.txt'), join(PROJECT, 'requirements.txt.off'));
    writeFileSync(
      join(PROJECT, 'pyproject.toml'),
      '[project]\nname = "demo"\ndependencies = [\n  "requests>=2.31",\n  "flask",\n]\n',
    );
    client.clearReceived();
    client.send({ kind: 'dependencyReport', language: 'python', code: 'import requests\n' });
    const pep = await client.waitFor('dependencies', 15_000);
    const pepNames = ((pep?.packages ?? []) as Array<{ name: string }>).map((p) => p.name);
    check('a pyproject-only project is read as pyproject', pep?.file === 'pyproject.toml' && pep?.format === 'pyproject',
      `${String(pep?.file ?? 'none')} · ${String(pep?.format ?? 'none')}`);
    check('its [project].dependencies are the packages', pepNames.join(',') === 'requests,flask', pepNames.join(','));
    check('its metadata keys are not mistaken for packages', !pepNames.includes('name') && !pepNames.includes('version'),
      pepNames.join(','));
    rmSync(join(PROJECT, 'pyproject.toml'), { force: true });
    renameSync(join(PROJECT, 'requirements.txt.off'), join(PROJECT, 'requirements.txt'));

    client.clearReceived();
    client.send({ kind: 'dependencyReport', language: 'go', code: '' });
    const go = await client.waitFor('dependencies', 15_000);
    check('go reads the go.mod require block', ((go?.packages ?? []) as Array<{ name: string }>)
      .some((p) => p.name === 'github.com/spf13/cobra'), JSON.stringify((go?.packages ?? []) as unknown[]));

    client.clearReceived();
    client.send({ kind: 'dependencyReport', language: 'markdown', code: '' });
    const md = await client.waitFor('dependencies', 15_000);
    check('a language with no dependency block says so', md?.supported === false && /manifest\.dependencies/.test(String(md?.note ?? '')),
      String(md?.note ?? ''));

    // ---- containment through a link, over the real wire ----
    // The explorer refuses `..` lexically; a junction inside the project resolves
    // to a path that *is* under the root, so only a realpath check catches it.
    const linkTarget = join(SANDBOX, 'outside-the-project');
    mkdirSync(linkTarget, { recursive: true });
    writeFileSync(join(linkTarget, 'secret.txt'), 'must not be readable');
    const linkKind: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      symlinkSync(linkTarget, join(PROJECT, 'link'), linkKind);
      client.clearReceived();
      client.send({ kind: 'fsList', path: 'link', reqId: 900 });
      const throughLink = await client.waitFor('fsError', 10_000);
      check('the explorer refuses to follow a link out of the project',
        throughLink?.code === 'outside', `${String(throughLink?.code)}: ${String(throughLink?.message)}`);
      client.clearReceived();
      client.send({ kind: 'fsRead', path: 'link/secret.txt', reqId: 901 });
      const readThroughLink = await client.waitFor('fsError', 10_000);
      check('and refuses to read through it', readThroughLink?.code === 'outside', String(readThroughLink?.code));
    } catch (err) {
      check('a link can be created for the containment test', true, `SKIP: ${(err as Error).message}`);
    }

    // ---- refusals ----
    client.clearReceived();
    client.send({ kind: 'dependencyInstall', language: 'python', package: '-r' });
    const bad = await client.waitFor('dependencyResult', 10_000);
    check('a flag-shaped package name is refused', bad?.ok === false && /cannot start with/.test(String(bad?.error ?? '')),
      String(bad?.error ?? ''));

    client.clearReceived();
    client.send({ kind: 'dependencyCancel' });
    const cancel = await client.waitFor('dependencyCancelled', 5000);
    check('cancelling nothing is answered, not ignored', cancel?.ok === false, String(cancel?.error ?? ''));

    // ---- a real install, then the refresh it triggers ----
    client.clearReceived();
    client.send({ kind: 'dependencyInstall', language: 'pkgpy', package: 'requests' });
    const start = await client.waitFor('dependencyStart', 10_000);
    check('the install announces itself first', start?.package === 'requests', JSON.stringify(start && { package: start.package }));
    const out = await client.waitFor('dependencyOut', 15_000);
    check('installer output streams back', /installed requests/.test(String(out?.text ?? '')), JSON.stringify(String(out?.text ?? '').slice(0, 80)));
    const done = await client.waitFor('dependencyResult', 30_000);
    check('the install exits 0', done?.ok === true && done?.code === 0, `exit=${done?.code}`);
    check('the reply names the command it ran', /requests/.test(String(done?.command ?? '')), String(done?.command ?? ''));
    check('a successful install restarts the language server',
      (done?.refresh as { ok?: boolean } | undefined)?.ok === true,
      JSON.stringify(done?.refresh ?? null));

    // The restarted server must still answer, not merely report "ready".
    client.clearReceived();
    client.send({ kind: 'check', language: 'pkgpy', code: 'import os\n\ndef f():\n    return undefined_name\n' });
    const diag = await client.waitFor('diagnostics', 25_000);
    check('the restarted server still answers diagnostics',
      ((diag?.items ?? []) as Array<{ message: string }>).some((i) => /undefined_name/.test(i.message)),
      `${((diag?.items ?? []) as unknown[]).length} item(s)`);

    // ---- items 1-3, over the shipped wire ----
    client.clearReceived();
    client.send({ kind: 'signatureHelp', language: 'python', code: 'print(1, 2)\n', line: 0, character: 8, requestId: 11 });
    const sig = await client.waitFor('signatureResult', 15_000);
    const signatures = (sig?.signatures ?? []) as Array<{ label: string; parameters?: unknown[] }>;
    check('signatureHelp returns real signatures from the packaged binary', signatures.length > 0,
      signatures.slice(0, 1).map((s) => s.label).join(''));
    check('signatureHelp names the active parameter', typeof sig?.activeParameter === 'number', String(sig?.activeParameter));

    client.clearReceived();
    client.send({ kind: 'completionResolve', language: 'python', label: 'print', requestId: 12 });
    const doc = await client.waitFor('completionItemDetail', 15_000);
    check('completionItemDetail comes back for a builtin', doc?.label === 'print' && (!!doc?.detail || !!doc?.documentation),
      JSON.stringify({ detail: doc?.detail, doc: String(doc?.documentation ?? '').slice(0, 40) }));

    client.clearReceived();
    client.send({ kind: 'complete', language: 'python', code: 'def greet():\n    pass\n\ngr', line: 3, character: 2, requestId: 13 });
    const comp = await client.waitFor('completion', 15_000);
    const items = (comp?.items ?? []) as Array<{ label: string }>;
    check('completion still answers in the packaged binary', items.length > 0, `${items.length} item(s)`);
  } finally {
    client?.close();
    try { child.kill(); } catch { /* gone */ }
    await new Promise((ok) => setTimeout(ok, 500));
    rmSync(SANDBOX, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.detail.startsWith('SKIP'));
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} checks passed` +
    (skipped.length ? ` (${skipped.length} skipped)` : ''));
  if (failed.length) {
    console.log('FAILED:\n' + failed.map((f) => `  - ${f.name}  ${f.detail}`).join('\n'));
    process.exit(1);
  }
}

if (!existsSync(EXE)) {
  skip('packaged exe', 'dist/Nolanguage.exe not built — run npm run build:exe');
  process.exit(0);
}

await main();
