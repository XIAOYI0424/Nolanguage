/**
 * Phase 3 (install / uninstall / enable / disable + live apply) and Phase 4
 * (memory budget, LRU, idle reclamation) — the plugin UI's backend.
 *
 *   1. ProfileManager — hint parsing, two budgets, LRU choice, idle
 *      reclamation, the eager-language exemption, `overBudget` reporting.
 *   2. Registry — install/uninstall, data separation, enable/disable, and the
 *      upgrade migration script (including a failing one aborting the install).
 *   3. WorkspaceService — a registry change takes effect without a restart.
 *   4. The `lang-install` CLI — spawned as a real child process, so arguments,
 *      exit codes and filesystem effects are all inside the verification.
 *
 * Everything here runs against real directories and real processes (the
 * migrations are spawned), but no language server is involved: the point of the
 * ProfileManager split is that the budget policy is testable without one.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-plugins.ts
 */
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Kernel } from '../src/kernel/Kernel.js';
import { WorkspaceService } from '../src/panel/WorkspaceService.js';
import { LanguageRegistry } from '../src/langs/Registry.js';
import { ProfileManager, parseMemoryHint, runtimeMemoryBytes, type ResourceProfile } from '../src/langs/ProfileManager.js';
import { validateManifest } from '../src/langs/manifest.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const MB = 1024 * 1024;

// ============================================================ ProfileManager

/** A workspace stub: no processes, just the numbers the budget cares about. */
class FakeProvider {
  constructor(private profiles: ResourceProfile[]) {}
  stopped: string[] = [];
  profiles_list = (): ResourceProfile[] => this.profiles;
  set(p: ResourceProfile[]): void {
    this.profiles = p;
  }
  async stopLsp(id: string): Promise<void> {
    this.stopped.push(id);
    // A stopped server really does stop costing: the language's *total* drops
    // by the server's share, otherwise the budget never sees any relief and
    // would reap until nothing is left. (The real provider computes this the
    // same way by no longer counting the server it just stopped.)
    this.profiles = this.profiles.map((p) =>
      p.languageId === id ? { ...p, lspRunning: false, memoryBytes: Math.max(0, p.memoryBytes - p.lspMemoryBytes) } : p,
    );
  }
}

function profile(id: string, lspBytes: number, extra: Partial<ResourceProfile> = {}): ResourceProfile {
  return {
    languageId: id,
    memoryBytes: lspBytes + (extra.runnerBytes ?? 0),
    lspMemoryBytes: lspBytes,
    lspRunning: true,
    eager: false,
    lastUsedAt: 0,
    ...extra,
  };
}

async function testHints(): Promise<void> {
  check('hints: "380MB" is 380 MiB in bytes', parseMemoryHint('380MB') === 380 * MB, String(parseMemoryHint('380MB')));
  check('hints: "1.5GB" scales', parseMemoryHint('1.5GB') === Math.round(1.5 * 1024 * MB), String(parseMemoryHint('1.5GB')));
  check('hints: a bare number is bytes', parseMemoryHint('512') === 512, String(parseMemoryHint('512')));
  check('hints: an unreadable hint is 0, never "free"', parseMemoryHint('lots') === 0);
  check('hints: a longer runtime costs more than a renderer', runtimeMemoryBytes('repl-session') > runtimeMemoryBytes(undefined));
}

async function testBudget(): Promise<void> {
  // Two quiet servers and one busy one; the total budget fits exactly two.
  const p = new FakeProvider([
    profile('a', 100 * MB, { lastUsedAt: 100 }),
    profile('b', 100 * MB, { lastUsedAt: 300 }),
    profile('c', 100 * MB, { lastUsedAt: 200 }),
  ]);
  const mgr = new ProfileManager({ budgetBytes: 250 * MB, lspBudgetBytes: 250 * MB, idleMs: 0 });
  mgr.bind({ profiles: () => p.profiles, stopLsp: (id) => p.stopLsp(id) });
  const reaped = await mgr.enforce();
  check('budget: the least-recently-used server is the one stopped', p.stopped.join(',') === 'a', p.stopped.join(','));
  check('budget: the reap is reported with its size', reaped.length === 1 && reaped[0].freedBytes === 100 * MB, JSON.stringify(reaped));
  check('budget: summary no longer over budget', mgr.summary().overBudget === false, JSON.stringify(mgr.summary().lspBytes));

  // Eager languages are exempt: only an eager language left means nothing to do.
  const eager = new FakeProvider([profile('py', 400 * MB, { eager: true })]);
  const mgr2 = new ProfileManager({ budgetBytes: 300 * MB, idleMs: 0 });
  mgr2.bind({ profiles: () => eager.profiles, stopLsp: (id) => eager.stopLsp(id) });
  await mgr2.enforce();
  check('budget: an eager language is never stopped to fit a budget', eager.stopped.length === 0, eager.stopped.join(','));
  check('budget: the pressure is reported as overBudget instead', mgr2.summary().overBudget === true);

  // Reaping stops when a stop does not help.
  const stuck = new FakeProvider([profile('a', 100 * MB, { lastUsedAt: 1 }), profile('b', 100 * MB, { lastUsedAt: 2 })]);
  const mgr3 = new ProfileManager({ budgetBytes: 100 * MB, idleMs: 0 });
  mgr3.bind({ profiles: () => stuck.profiles, stopLsp: () => Promise.reject(new Error('nope')) });
  const reaped3 = await mgr3.enforce();
  check('budget: a failing stop is recorded, not retried forever', reaped3.length === 0 && mgr3.summary().failedStops.length > 0, mgr3.summary().failedStops.join(','));
}

async function testIdle(): Promise<void> {
  const start = 10_000;
  let now = start;
  const p = new FakeProvider([
    profile('quiet', 50 * MB, { lastUsedAt: now - 600_000 }),
    profile('busy', 50 * MB, { lastUsedAt: now - 1_000 }),
    profile('eager', 50 * MB, { eager: true, lastUsedAt: now - 600_000 }),
  ]);
  const mgr = new ProfileManager({ budgetBytes: 10 * 1024 * MB, lspBudgetBytes: 10 * 1024 * MB, idleMs: 300_000, now: () => now });
  mgr.bind({ profiles: () => p.profiles, stopLsp: (id) => p.stopLsp(id) });
  await mgr.enforce();
  check('idle: a language nobody touched for the window is stopped', p.stopped.join(',') === 'quiet', p.stopped.join(','));

  // `noteUse` is the manager's own clock: touching a language *now* keeps it
  // alive even though its profile's `lastUsedAt` is stale.
  now = start + 400_000;
  mgr.noteUse('busy');
  await mgr.enforce();
  check('idle: noteUse() keeps a used language alive', !p.stopped.includes('busy'), p.stopped.join(','));
  check('idle: the eager language is still running after the window passes', !p.stopped.includes('eager'), p.stopped.join(','));

  // …and forgetting it lets the next pass have it.
  mgr.forget('busy');
  p.set(p.profiles_list().map((x) => (x.languageId === 'busy' ? { ...x, lspRunning: true, lastUsedAt: start } : x)));
  await mgr.enforce();
  check('idle: forget() releases the protection', p.stopped.includes('busy'), p.stopped.join(','));
}

// ==================================================================== manifests

async function testManifestValidation(): Promise<void> {
  const base = JSON.parse(await readFile(resolve('builtin/python@1.0.0/manifest.json'), 'utf8')) as Record<string, unknown>;
  check('manifest: the official python plugin still validates', validateManifest(base).ok === true);
  const bad = JSON.parse(JSON.stringify(base));
  (bad.migrations as unknown[]) = [{ from: 'x', to: 'y' }];
  const v = validateManifest(bad);
  check('manifest: a malformed migration is rejected with a field path', !v.ok && v.issues.some((i) => i.field === 'migrations[0].from'), JSON.stringify(v.issues));
  const bad2 = JSON.parse(JSON.stringify(base));
  (bad2.debug as Record<string, unknown>).adapter = '';
  check('manifest: an empty debug.adapter is rejected', validateManifest(bad2).issues.some((i) => i.field === 'debug.adapter'));

  // The manifest is where the capability is declared; the Registry must not be
  // the only thing that knows how to read it.
  const adapterOf = async (id: string): Promise<string> => {
    const m = (await readFile(resolve(`builtin/${id}@1.0.0/manifest.json`), 'utf8').then((t) => JSON.parse(t))) as {
      debug: { adapter: string };
    };
    return m.debug.adapter;
  };
  const py = await adapterOf('python');
  const go = await adapterOf('go');
  check('manifest: python declares a debug adapter', py.length > 0, py);
  check('manifest: go declares a debug adapter', go.length > 0, go);
}

// ==================================================================== registry

/** Write a plugin directory into a scratch dir. */
async function makePlugin(
  dir: string,
  id: string,
  version: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const target = join(dir, `${id}@${version}`);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, 'manifest.json'),
    JSON.stringify(
      {
        id,
        displayName: id,
        version,
        apiVersion: '^1.0.0',
        order: 90,
        file: { extensions: [id === 'demo' ? 'demo' : id], defaultExt: id === 'demo' ? 'demo' : id, fileName: `main.${id}` },
        ...extra,
      },
      null,
      2,
    ),
    'utf8',
  );
  return target;
}

async function testRegistryLifecycle(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'nl-plugins-'));
  const builtinDir = join(home, 'official');
  const reg = new LanguageRegistry({
    home,
    roots: [
      { dir: builtinDir, kind: 'builtin', removable: false },
      { dir: join(home, 'languages'), kind: 'user', removable: true },
    ],
  });
  await reg.scan();
  check('registry: a fresh home has no plugins', reg.installed().length === 0, String(reg.installed().length));

  const dir = await makePlugin(home, 'demo', '1.0.0');
  await reg.install(dir);
  check('registry: after install the plugin is listed', reg.get('demo')?.version === '1.0.0');
  check('registry: user plugins are removable', reg.entry('demo')?.source.removable === true);
  await reg.enable('demo');
  check('registry: enable is idempotent', reg.isEnabled('demo') === true);
  await reg.disable('demo');
  check('registry: disable removes it from the active set', reg.get('demo') === undefined && reg.entry('demo') !== undefined);
  await reg.enable('demo');

  // Data separation: something in data/<id>/ survives an uninstall.
  const dataDir = await reg.ensureDataDir('demo');
  await writeFile(join(dataDir, 'keep.txt'), 'breakpoints', 'utf8');
  const gone = await reg.uninstall('demo', { keepData: true });
  const bodyDir = join(home, 'languages', 'demo@1.0.0');
  check('registry: uninstall removes the body', gone === true && !existsSync(bodyDir), bodyDir);
  check('registry: user data survives a keepData uninstall', existsSync(join(dataDir, 'keep.txt')), dataDir);

  // A builtin cannot be uninstalled — it ships with the binary.
  const official = await makePlugin(builtinDir, 'demo', '1.0.0');
  await reg.install(official);
  check('registry: an official root marks its plugins non-removable', reg.entry('demo')?.source.removable === false);
  try {
    await reg.uninstall('demo');
    check('registry: a builtin plugin refuses to be uninstalled', false, 'no error thrown');
  } catch (err) {
    check('registry: a builtin plugin refuses to be uninstalled', /builtin/.test((err as Error).message), (err as Error).message);
  }

  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

async function testMigrations(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'nl-mig-'));
  const reg = new LanguageRegistry({ home, extraRoots: [] });
  await reg.scan();

  // 1.0.0 has data the 1.1.0 body cannot read.
  const v1 = await makePlugin(home, 'demo', '1.0.0');
  await reg.install(v1);
  const dataDir = await reg.ensureDataDir('demo');
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ old: true }), 'utf8');

  // 1.1.0 ships a migration that rewrites it, and declares it in the manifest.
  const src = join(home, 'upgrade');
  const v2 = join(src, 'demo@1.1.0');
  await mkdir(join(v2, 'migrations'), { recursive: true });
  await writeFile(
    join(v2, 'manifest.json'),
    JSON.stringify({
      id: 'demo',
      displayName: 'demo',
      version: '1.1.0',
      apiVersion: '^1.0.0',
      order: 90,
      file: { extensions: ['demo'], defaultExt: 'demo', fileName: 'main.demo' },
      migrations: [{ from: '1.0.0', to: '1.1.0', file: 'migrations/rewrite.js' }],
    }),
    'utf8',
  );
  await writeFile(
    join(v2, 'migrations', 'rewrite.js'),
    [
      "const fs = require('node:fs');",
      "const [dataDir, from, to] = process.argv.slice(2);",
      "const file = dataDir + '/state.json';",
      "const st = JSON.parse(fs.readFileSync(file, 'utf8'));",
      "delete st.old;",
      "st.migrated = from + '->' + to;",
      "fs.writeFileSync(file, JSON.stringify(st));",
    ].join('\n'),
    'utf8',
  );

  const out = await reg.install(v2);
  check('migration: the install reports what it ran', out.migrated.join(',') === '1.0.0->1.1.0', out.migrated.join(','));
  const state = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')) as Record<string, unknown>;
  check('migration: the script really rewrote the data', state.migrated === '1.0.0->1.1.0' && state.old === undefined, JSON.stringify(state));
  const record = JSON.parse(await readFile(join(dataDir, 'migrations.json'), 'utf8')) as { applied: string[] };
  check('migration: the applied step is recorded', record.applied.includes('1.0.0->1.1.0'), JSON.stringify(record));
  const again = await reg.install(v2);
  check('migration: reinstalling the same version runs nothing', again.migrated.length === 0, again.migrated.join(','));

  // A failing migration must abort the install, leaving the old body usable.
  const broken = join(home, 'broken');
  const v3 = join(broken, 'demo@1.2.0');
  await mkdir(join(v3, 'migrations'), { recursive: true });
  await writeFile(
    join(v3, 'manifest.json'),
    JSON.stringify({
      id: 'demo',
      displayName: 'demo',
      version: '1.2.0',
      apiVersion: '^1.0.0',
      order: 90,
      file: { extensions: ['demo'], defaultExt: 'demo', fileName: 'main.demo' },
      migrations: [{ from: '1.1.0', to: '1.2.0', file: 'migrations/boom.js' }],
    }),
    'utf8',
  );
  await writeFile(join(v3, 'migrations', 'boom.js'), "process.exit(3);\n", 'utf8');
  let aborted = '';
  try {
    await reg.install(v3);
  } catch (err) {
    aborted = (err as Error).message;
  }
  check('migration: a failing script aborts the install', /exited 3/.test(aborted), aborted);
  check('migration: the previous version is still active after the abort', reg.get('demo')?.version === '1.1.0', reg.get('demo')?.version ?? 'none');

  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

// ============================================================ workspace apply

async function testWorkspaceApply(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'nl-ws-'));
  const kernel = new Kernel({ logSilent: true });
  await kernel.start();
  const ws = new WorkspaceService(kernel, {
    home,
    pluginRoots: [{ dir: resolve('builtin'), kind: 'builtin', removable: false }],
  });
  await ws.init();
  const ids = (): string => ws.status().languages.map((l) => l.id).join(',');

  await ws.languages.disable('python');
  await ws.pluginsSynced();
  check('apply: a disabled language leaves the workspace', !ids().includes('python'), ids());

  await ws.languages.enable('python');
  await ws.pluginsSynced();
  check('apply: re-enabling brings it back, same language', ids().includes('python'), ids());

  const order = ids();
  check('apply: the language list keeps manifest order', order === 'go,javascript,markdown,python' || order === 'python,go,javascript,markdown', order);

  // The budget sees every language, and an over-budget install sheds a quiet one.
  const budget = ws.resourceSummary();
  check('apply: the resource summary covers every language', budget.profiles.length === ids().split(',').length, String(budget.profiles.length));
  check('apply: python is marked as the eager language', budget.profiles.some((p) => p.languageId === 'python' && p.eager));

  await ws.close();
  await kernel.stop();
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

// ======================================================================== cli

/**
 * The command-line face (`scripts/lang-install.ts`) must stay a thin shell over
 * this registry: same validation, same data separation, same refusal to remove
 * a builtin. It is spawned as a real child process so the arguments, the exit
 * codes and the printed filesystem effects are all part of what is verified.
 */
async function testCli(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'nl-cli-'));
  const cli = resolve('scripts/lang-install.ts');
  const loader = resolve('resolve-loader.mjs');
  const run = (...argv: string[]): Promise<{ code: number; out: string }> =>
    new Promise((done) => {
      const child = spawn(
        process.execPath,
        ['--experimental-transform-types', '--experimental-loader', pathToFileURL(loader).href, cli, '--home', home, ...argv],
        { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } },
      );
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.on('close', (code) => done({ code: code ?? -1, out }));
    });

  const help = await run('--help');
  check('cli: --help exits 0 and lists every command', help.code === 0 && /install <pluginDir>/.test(help.out) && /uninstall <id>/.test(help.out), help.out.split('\n')[0] ?? '');

  const src = await makePlugin(home, 'demo', '1.0.0');
  const install = await run('install', src);
  check('cli: install copies the body under the home', install.code === 0 && /installed demo@1\.0\.0/.test(install.out) && existsSync(join(home, 'languages', 'demo@1.0.0', 'manifest.json')), install.out.split('\n')[0] ?? '');

  const list = await run('list');
  check('cli: list shows the installed plugin as enabled', list.code === 0 && /^demo\s+1\.0\.0\s+user\s+yes/m.test(list.out), list.out.split('\n').slice(1).join(' | '));
  check('cli: list also shows the official plugins next to the source', /^python\s+1\.0\.0\s+builtin/m.test(list.out), 'python row');

  const off = await run('disable', 'demo');
  const listOff = await run('list');
  check('cli: disable is reported and the list shows it off', off.code === 0 && /disabled demo/.test(off.out) && /^demo\s+1\.0\.0\s+user\s+off/m.test(listOff.out), off.out.trim());

  const dataDir = join(home, 'data', 'demo');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'keep.txt'), 'breakpoints', 'utf8');
  const removal = await run('uninstall', 'demo');
  check('cli: uninstall removes the body but keeps user data', removal.code === 0 && !existsSync(join(home, 'languages', 'demo@1.0.0')) && existsSync(join(dataDir, 'keep.txt')), removal.out.split('\n').slice(1).join(' '));

  const builtin = await run('uninstall', 'python');
  check('cli: a builtin refuses to be uninstalled from the command line', builtin.code === 1 && /builtin/.test(builtin.out), builtin.out.trim());

  const broken = join(home, 'broken');
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, 'manifest.json'), JSON.stringify({ id: 'broken', version: '1.0.0' }), 'utf8');
  const refused = await run('install', broken);
  check('cli: a broken manifest is refused with its field paths', refused.code === 1 && /displayName/.test(refused.out), refused.out.trim());

  // The conversion layer: `nlg run <script> -- <args>` must forward the script's
  // own arguments untouched — that pass-through is the wrapper's whole contract,
  // and it is exactly what breaks when a launcher re-parses the command line.
  const shell = process.platform === 'win32' ? 'cmd' : 'bash';
  const shellPrologue = process.platform === 'win32' ? ['/c', 'nlg.cmd'] : ['./nlg'];
  const viaNlg = (argv: string[]): Promise<{ code: number; out: string } | undefined> =>
    new Promise((done) => {
      let settled = false;
      const child = spawn(shell, [...shellPrologue, ...argv], {
        cwd: resolve('.'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
      // No shell in this environment is not a failure of the wrapper.
      child.on('error', () => (settled = true, done(undefined)));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        done({ code: code ?? -1, out });
      });
    });

  const wrapped = await viaNlg(['run', 'lang-install', '--', '--help']);
  if (!wrapped) skip('nlg: the wrapper runs a script and prints its usage', `no ${shell} here`);
  else check('nlg: the wrapper runs a script and prints its usage', wrapped.code === 0 && /install <pluginDir>/.test(wrapped.out), (wrapped.out.split('\n')[0] ?? '').trim());

  const listed = await viaNlg(['run', 'lang-install', '--', '--home', home, 'list']);
  if (!listed) skip('nlg: the wrapper forwards arguments untouched', `no ${shell} here`);
  else check('nlg: the wrapper forwards arguments untouched', listed.code === 0 && /^python\s+1\.0\.0\s+builtin/m.test(listed.out), (listed.out.split('\n')[1] ?? '').trim());

  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

// ======================================================================= driver

async function main(): Promise<void> {
  console.log('— ProfileManager —');
  await testHints();
  await testBudget();
  await testIdle();
  console.log('— manifests —');
  await testManifestValidation();
  console.log('— registry —');
  await testRegistryLifecycle();
  await testMigrations();
  console.log('— workspace —');
  await testWorkspaceApply();
  console.log('— cli —');
  await testCli();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} checks passed (${failed} failed)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
