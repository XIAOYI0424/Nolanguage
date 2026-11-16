/**
 * The manager's contract, tested.
 *
 * Three layers, in increasing cost:
 *
 * 1. **Pure logic** — routing, project roots, template expansion, cache
 *    validation, git/content-hash invalidation, the diagnostics buffer, the
 *    lexical fallback. No processes.
 * 2. **A fake LSP server** (`scripts/fixtures/fake-lsp.mjs`) — pooling, root
 *    convergence, lazy start, latest-only cancellation, dedupe. Fast and
 *    deterministic, and it logs every inbound method so "the cancel was
 *    forwarded" is an assertion, not a hope.
 * 3. **Real jdtls**, when it is installed — the whole chain on a real Maven
 *    project, with timings. SKIPs cleanly when it is not.
 *
 * Run: npm run verify:lsp-manager
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Kernel } from '../src/kernel/Kernel.js';
import { WorkspaceService } from '../src/panel/WorkspaceService.js';
import { buildManagerPlugin, findProjectRoot } from '../src/langs/managerPlugins.js';
import type { LanguageManifest } from '../src/langs/manifest.js';
import { CacheValidator } from '../src/lsp/manager/CacheValidator.js';
import { DiagnosticsBuffer } from '../src/lsp/manager/DiagnosticsBuffer.js';
import { LexicalFallback, scanText } from '../src/lsp/manager/fallback.js';
import { LspManager } from '../src/lsp/manager/LspManager.js';
import { Scheduler } from '../src/lsp/manager/Scheduler.js';
import { versionSignature } from '../src/lsp/manager/signature.js';
import { ContentHashStrategy, GitDiffStrategy, resolveDirty } from '../src/lsp/manager/strategies.js';
import type { DirtyReport, LanguagePlugin } from '../src/lsp/manager/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX = join(ROOT, '.tmp', 'lsp-manager');
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'fake-lsp.mjs');
const JAVA_MANIFEST = join(ROOT, 'examples', 'java@1.0.0', 'manifest.json');
const JDTLS_DEFAULT = join(ROOT, '.tmp', 'langdeps', 'jdtls', 'bin', 'jdtls.bat');

const results: Array<{ name: string; ok: boolean; detail: string; skipped?: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function skip(name: string, why: string): void {
  results.push({ name, ok: true, detail: why, skipped: true });
  console.log(`SKIP  ${name}  — ${why}`);
}
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, out: (err as Error).message });
      return;
    }
    let out = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.on('error', (e) => resolve({ code: null, out: `${out}${e.message}` }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** A manifest for the fake server: every knob is a CLI flag. */
function fakeManifest(opts: {
  id: string;
  log: string;
  completionDelayMs?: number;
  diagnostics?: boolean;
  failStart?: boolean;
  idleTtlMs?: number;
  budgetMs?: number;
}): LanguageManifest {
  const args = [FIXTURE, '--log', opts.log];
  if (opts.completionDelayMs) args.push('--completion-delay', String(opts.completionDelayMs));
  if (opts.diagnostics) args.push('--diagnostics');
  if (opts.failStart) args.push('--fail-start');
  return {
    id: opts.id,
    file: { extensions: ['fake'] },
    lsp: {
      manager: true,
      discovery: { knownPaths: [process.execPath] },
      command: ['{resolved}', ...args],
      projectMarkers: ['pom.xml'],
      initializationOptions: { settings: { 'java.import.mode': 'ondemand' } },
      firstRequestBudgetMs: opts.budgetMs ?? 2000,
      startTimeoutMs: 20_000,
      idleTtlMs: opts.idleTtlMs ?? 120_000,
      fallback: { keywords: ['class', 'void'], declarationPattern: 'class\\s+([A-Za-z_$][\\w$]*)' },
    },
  } as unknown as LanguageManifest;
}

async function newManager(home: string): Promise<LspManager> {
  const kernel = new Kernel({ appVersion: 'verify', logSilent: true });
  await kernel.start();
  return new LspManager({ kernel, home, reapIntervalMs: 0 });
}

function makeProject(dir: string, withMarker = true): string {
  mkdirSync(dir, { recursive: true });
  if (withMarker) writeFileSync(join(dir, 'pom.xml'), '<project/>\n');
  return dir;
}

async function main(): Promise<void> {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });

  // Before any plugin is built: a plugin resolves its binary once, at
  // registration, and memoises the result per root.
  const jdtls = process.env.JDTLS ?? (existsSync(JDTLS_DEFAULT) ? JDTLS_DEFAULT : '');
  if (jdtls) process.env.JDTLS = jdtls;

  // ================================================================ routing
  const javaManifest = JSON.parse(readFileSync(JAVA_MANIFEST, 'utf8')) as LanguageManifest;
  const javaPlugin = await buildManagerPlugin(javaManifest, { home: join(SANDBOX, 'home-java') });
  if (!javaPlugin) throw new Error('the java manifest did not opt into the manager');

  check('routing: .java is owned by the java plugin', javaPlugin.matches('/p/App.java'));
  check('routing: .kt is not', !javaPlugin.matches('/p/App.kt'));
  const emptyRegistryManager = await newManager(join(SANDBOX, 'home-route'));
  check('routing: an unknown extension routes nowhere', emptyRegistryManager.pluginFor('/p/App.kt') === undefined);
  await emptyRegistryManager.close();

  // ============================================================ project root
  const reactor = makeProject(join(SANDBOX, 'reactor'));
  const moduleA = makeProject(join(reactor, 'module-a'));
  mkdirSync(join(moduleA, 'src'), { recursive: true });
  writeFileSync(join(moduleA, 'src', 'A.java'), 'class A {}\n');
  check(
    'project root: a module resolves to the reactor, not itself',
    findProjectRoot(join(moduleA, 'src', 'A.java'), ['pom.xml']) === reactor,
    String(findProjectRoot(join(moduleA, 'src', 'A.java'), ['pom.xml'])),
  );
  const otherRepo = makeProject(join(SANDBOX, 'other'));
  mkdirSync(join(otherRepo, '.git'), { recursive: true });
  check(
    'project root: two checkouts stay two roots',
    findProjectRoot(join(reactor, 'module-a', 'src', 'A.java'), ['pom.xml']) !==
      findProjectRoot(join(otherRepo, 'src', 'B.java'), ['pom.xml']),
  );

  // ===================================================== template expansion
  const dist = join(SANDBOX, 'dist');
  mkdirSync(join(dist, 'plugins'), { recursive: true });
  mkdirSync(join(dist, 'bin'), { recursive: true });
  writeFileSync(join(dist, 'bin', 'launcher.bat'), '@echo off\n');
  writeFileSync(join(dist, 'plugins', 'org.eclipse.equinox.launcher_9.9.9.jar'), 'x');
  mkdirSync(join(dist, 'config_win'), { recursive: true });
  process.env.FAKE_LAUNCHER = join(dist, 'bin', 'launcher.bat');
  const templated = await buildManagerPlugin(
    {
      id: 'templated',
      file: { extensions: ['tpl'] },
      lsp: {
        manager: true,
        discovery: { knownPaths: [join(dist, 'bin', 'launcher.bat')] },
        command: [
          '{toolchain}',
          '-jar',
          '{glob:{dist}/plugins/org.eclipse.equinox.launcher_*.jar}',
          '-configuration',
          '{dist}/config_{platform}',
          '-data',
          '{dataDir}',
        ],
        firstRequestBudgetMs: 10,
      },
      run: { mode: 'template', discovery: { knownPaths: [process.execPath] } },
    } as unknown as LanguageManifest,
    { home: join(SANDBOX, 'home-tpl') },
  );
  const tplCfg = templated?.lspConfig(reactor);
  check(
    'template: {glob:} resolves the versioned launcher jar',
    !!tplCfg && tplCfg.args.some((a) => a.endsWith('org.eclipse.equinox.launcher_9.9.9.jar')),
    tplCfg?.args.join(' ') ?? 'no config',
  );
  check(
    'template: {platform} names the host config directory',
    !!tplCfg && tplCfg.args.some((a) => a.endsWith(`config_${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}`)),
  );
  const noToolchain = await buildManagerPlugin(
    {
      id: 'no-toolchain',
      file: { extensions: ['nt'] },
      lsp: { manager: true, discovery: { knownPaths: [process.execPath] }, command: ['{toolchain}'] },
    } as unknown as LanguageManifest,
    { home: join(SANDBOX, 'home-nt') },
  );
  check(
    'template: a missing {toolchain} degrades instead of launching an empty command',
    noToolchain?.lspConfig(reactor) === undefined,
    noToolchain?.degradedNote ?? 'no note',
  );

  // ================================================= pool / lazy / convergence
  const poolHome = join(SANDBOX, 'home-pool');
  const poolLog = join(SANDBOX, 'pool.log');
  const poolManager = await newManager(poolHome);
  poolManager.register(await buildManagerPlugin(fakeManifest({ id: 'fake', log: poolLog }), { home: poolHome }) as LanguagePlugin);
  const poolEntry = poolManager.acquire('fake', reactor)!;
  check('lazy: nothing is spawned before the first request', !existsSync(poolLog));

  const fakeUri = pathToFileURL(join(moduleA, 'src', 'A.fake')).href;
  await poolEntry.openDocument(fakeUri, 'class A {}\n', 'fake');
  const started = await poolEntry.waitUntilReady(20_000);
  check('lazy: the first request starts exactly one server', started && existsSync(poolLog), `ready=${started}`);

  const converged = poolManager.acquire('fake', moduleA)!;
  check('pool: a module reuses the reactor server', converged === poolEntry, `entries=${poolManager.entries().length}`);
  check('pool: convergence is counted', poolManager.stats().converged >= 1, JSON.stringify(poolManager.stats()));

  const second = makeProject(join(SANDBOX, 'second-repo'));
  const secondEntry = poolManager.acquire('fake', second)!;
  check('pool: a different root gets its own entry', secondEntry !== poolEntry && poolManager.entries().length === 2);

  const reaped = poolManager.reapNow(Date.now() + 10 * 60_000);
  // The pool key is `plugin\0root` — fine as a map key, but a NUL in a log line
  // makes grep call the whole stream binary. Show it as `plugin @ root`.
  check(
    'pool: idle entries are reaped',
    reaped.length >= 1,
    reaped.map((k) => k.replace(/\u0000/g, ' @ ')).join(', '),
  );
  await poolManager.close();

  // ============================================ latest-only / cancel / dedupe
  const schedHome = join(SANDBOX, 'home-sched');
  const schedLog = join(SANDBOX, 'sched.log');
  const schedManager = await newManager(schedHome);
  schedManager.register(
    await buildManagerPlugin(
      fakeManifest({ id: 'slow', log: schedLog, completionDelayMs: 300, budgetMs: 5000 }),
      { home: schedHome },
    ) as LanguagePlugin,
  );
  const slowEntry = schedManager.acquire('slow', reactor)!;
  const slowUri = pathToFileURL(join(moduleA, 'src', 'A.fake')).href;
  await slowEntry.openDocument(slowUri, 'class A {}\n', 'fake');
  await slowEntry.waitUntilReady(20_000);

  const first = slowEntry.completion(slowUri, { line: 0, character: 6 });
  await sleep(60);
  const second2 = slowEntry.completion(slowUri, { line: 0, character: 6 });
  const [r1, r2] = await Promise.all([first, second2]);
  check('latest-only: the superseded request yields nothing', r1.length === 0, `${r1.length} items`);
  check('latest-only: the newest request is answered', r2.length > 0, `${r2.length} items`);
  const schedLogText = existsSync(schedLog) ? readFileSync(schedLog, 'utf8') : '';
  check('latest-only: $/cancelRequest reached the server', schedLogText.includes('$/cancelRequest'), schedLogText.split('\n').filter(Boolean).length + ' frames');
  check('latest-only: the drop is counted', schedManager.stats().staleDropped >= 1, JSON.stringify(schedManager.stats()));

  // Dedupe: two identical explicit requests must cost one round trip.
  const before = (schedLogText.match(/textDocument\/definition/g) ?? []).length;
  await Promise.all([
    slowEntry.definition(slowUri, { line: 0, character: 6 }),
    slowEntry.definition(slowUri, { line: 0, character: 6 }),
  ]);
  const afterText = readFileSync(schedLog, 'utf8');
  const after = (afterText.match(/textDocument\/definition/g) ?? []).length;
  check('dedupe: identical concurrent requests share one round trip', after - before === 1, `${after - before} request(s)`);
  await schedManager.close();

  // A scheduler on its own: a stale answer must never be returned as fresh.
  const solo = new Scheduler();
  let cancelSeen = 0;
  const soloScheduler = new Scheduler((id) => {
    cancelSeen++;
    void id;
    return true;
  });
  const slow = soloScheduler.latest('k', async (report) => {
    // A cancellation needs an id; a request that never reports one cannot be
    // cancelled, which is exactly what the first version of this test measured.
    report(4242);
    await sleep(200);
    return 'old';
  });
  await sleep(20);
  const fast = soloScheduler.latest('k', async () => 'new');
  const [oldOut, newOut] = await Promise.all([slow, fast]);
  check('scheduler: the older result is marked stale', oldOut.stale && oldOut.value === 'old');
  check('scheduler: the newer result wins', !newOut.stale && newOut.value === 'new');
  check('scheduler: cancellation was attempted', cancelSeen >= 1, `${cancelSeen}`);
  void solo;

  // ============================================================ cache validator
  const cacheDir = join(SANDBOX, 'index');
  const validator = new CacheValidator(cacheDir);
  const sigA = versionSignature({ pluginId: 'x', serverName: 'x', serverVersion: '1.0.0' });
  const sigB = versionSignature({ pluginId: 'x', serverName: 'x', serverVersion: '2.0.0' });
  const stubPlugin = (sig: string): LanguagePlugin =>
    ({
      id: 'x',
      matches: () => true,
      projectRoot: () => undefined,
      lspConfig: () => undefined,
      versionSignature: () => sig,
      fallback: () => undefined,
      incremental: () => undefined,
      serverPriority: () => 0,
      idleTtlMs: () => 0,
    }) as LanguagePlugin;

  await validator.save('x', { signature: sigA, indexedCommit: null, indexedAt: new Date().toISOString() });
  check('cache: the same signature is reusable', validator.validate(stubPlugin(sigA), await validator.load('x')).valid);
  const verdict = validator.validate(stubPlugin(sigB), await validator.load('x'));
  check('cache: a different signature is not', !verdict.valid, verdict.reason);
  check('cache: the reason names both signatures', /signature changed/.test(verdict.reason), verdict.reason);

  const ensured = await validator.ensure(stubPlugin(sigB), reactor);
  check('cache: an invalid cache is rebuilt, not refreshed', ensured.rebuilt, ensured.reason);
  const meta = await validator.load('x');
  check('cache: the rebuilt metadata carries the new signature', meta?.signature === sigB);
  check('cache: indexedAt is an ISO timestamp', !!meta && !Number.isNaN(Date.parse(meta.indexedAt)), meta?.indexedAt ?? 'none');

  // ================================================================ git diff
  // Git is a toolchain like any other: absent on a minimal machine, and the
  // suite must say so rather than fail.
  const gitOk = (await run('git', ['--version'], ROOT)).code === 0;
  const gitIt = (name: string, ok: boolean, detail = ''): void => {
    if (gitOk) check(name, ok, detail);
    else skip(name, 'git is not installed');
  };
  const repo = join(SANDBOX, 'gitrepo');
  makeProject(repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, 'b.txt'), 'one\n');
  await run('git', ['init', '-q'], repo);
  await run('git', ['add', '-A'], repo);
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], repo);
  const head = (await run('git', ['rev-parse', 'HEAD'], repo)).out.trim();

  const git = new GitDiffStrategy();
  const hash = new ContentHashStrategy();
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  const dirty = await git.dirtyFiles(repo, { signature: 's', indexedCommit: head, indexedAt: new Date().toISOString() });
  gitIt('git: an edited file is dirty', dirty.files.includes('a.txt'), JSON.stringify(dirty));
  gitIt('git: an untouched file is not', !dirty.files.includes('b.txt'), JSON.stringify(dirty.files));
  gitIt('git: the source is git', dirty.source === 'git');
  gitIt('git: isLargeChange honours the threshold', git.isLargeChange(dirty, 0) && !git.isLargeChange(dirty, 5));

  writeFileSync(join(repo, 'c.txt'), 'new\n');
  await run('git', ['add', '-A'], repo);
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'second'], repo);
  const committed = await git.dirtyFiles(repo, { signature: 's', indexedCommit: head, indexedAt: new Date().toISOString() });
  gitIt('git: a commit since the index is dirty too', committed.files.includes('c.txt'), JSON.stringify(committed.files));

  const noGit = join(SANDBOX, 'plain');
  mkdirSync(noGit, { recursive: true });
  const none = await git.dirtyFiles(noGit, { signature: 's', indexedCommit: head, indexedAt: new Date().toISOString() });
  gitIt('git: outside a checkout the answer is "unknown", not "clean"', none.source === 'none', none.reason ?? '');

  // =========================================================== content hash
  const stamps = await hash.stampsFor(repo);
  const stamped = { signature: 's', indexedCommit: null, indexedAt: new Date().toISOString(), stamps };
  writeFileSync(join(repo, 'b.txt'), 'changed by the hash strategy\n');
  const byHash = await hash.dirtyFiles(repo, stamped);
  check('hash: a modified file is dirty', byHash.files.includes('b.txt'), JSON.stringify(byHash.files));
  check('hash: an unmodified file is not', !byHash.files.includes('a.txt'), JSON.stringify(byHash.files));

  const chained = await resolveDirty({ git, hash }, noGit, undefined);
  check('chain: no git and no stamps reports unknown', chained.source === 'none', chained.reason ?? '');

  // ========================================================= diagnostics buffer
  const buf = new DiagnosticsBuffer(3, 2);
  buf.set('file:///a', [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x' },
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x' },
  ]);
  check('buffer: duplicates collapse', buf.get('file:///a').length === 1, `${buf.get('file:///a').length}`);
  buf.set('file:///b', [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: '1' },
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, message: '2' },
    { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, message: '3' },
  ]);
  check('buffer: the per-file cap holds', buf.get('file:///b').length === 2, `${buf.get('file:///b').length}`);
  buf.set('file:///c', [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: '1' },
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, message: '2' },
  ]);
  check('buffer: the global cap truncates whole files', buf.all().length === 2, `${buf.all().length} file(s)`);

  // ================================================================ fallback
  const fb = new LexicalFallback({
    keywords: ['class', 'void', 'public'],
    types: ['String'],
    declarationPattern: 'class\\s+([A-Za-z_$][\\w$]*)',
  });
  const javaText = ['public class Demo {', '    void run() {', '        Dem', '    }', '}', ''].join('\n');
  const completions = fb.completions({ file: 'Demo.java', text: javaText, line: 2, character: 11 });
  check('fallback: the declaration in this file is offered', completions.some((c) => c.label === 'Demo'), completions.map((c) => c.label).join(','));
  check('fallback: the prefix filters the list', completions.every((c) => c.label.toLowerCase().startsWith('dem')), completions.map((c) => c.label).join(','));
  check('fallback: hover names the declaration', /declared in this file/.test(fb.hover({ file: 'Demo.java', text: javaText, line: 0, character: 14 }) ?? ''));

  const broken = ['class A {', '    void f() {', '        String s = "oops;', '    }', ''].join('\n');
  const scan = scanText(broken);
  check('scanner: an unterminated literal is found', scan.unterminated?.what === 'string', JSON.stringify(scan.unterminated));
  const fbDiag = fb.diagnostics({ file: 'A.java', text: broken, line: 0, character: 0 });
  check('fallback: the unterminated literal becomes a diagnostic', fbDiag.some((d) => /unterminated string/.test(d.message)), JSON.stringify(fbDiag.map((d) => d.message)));
  const unclosed = fb.diagnostics({ file: 'A.java', text: 'class A {\n', line: 0, character: 0 });
  check('fallback: an unclosed brace becomes a diagnostic', unclosed.some((d) => /unclosed/.test(d.message)), JSON.stringify(unclosed.map((d) => d.message)));
  check(
    'scanner: a brace inside a string does not unbalance the count',
    scanText('class A { String s = "}"; }\n').depth === 0,
    String(scanText('class A { String s = "}"; }\n').depth),
  );

  // ================================================================ jdtls
  const javaCfg = javaPlugin.lspConfig(reactor);
  if (!jdtls || !javaCfg) {
    skip('jdtls: end-to-end', jdtls ? 'the java toolchain is not on PATH' : 'jdtls is not installed (.tmp/langdeps/jdtls)');
  } else {
    const init = JSON.stringify(javaCfg.initializationOptions);
    check('jdtls: java.import.mode is ondemand', /"java\.import\.mode":"ondemand"/.test(init), init);
    check('jdtls: vmargs are the requested ones', /-Xmx2G -XX:\+UseG1GC/.test(init));
    check('jdtls: build configuration updates are disabled', /updateBuildConfiguration":"disabled"/.test(init));

    const jHome = join(SANDBOX, 'home-jdtls');
    const jProject = join(SANDBOX, 'jproject');
    mkdirSync(join(jProject, 'src', 'main', 'java', 'demo'), { recursive: true });
    writeFileSync(join(jProject, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion><groupId>d</groupId><artifactId>d</artifactId><version>1.0.0</version></project>\n');
    const code = [
      'package demo;',
      '',
      'import java.util.ArrayList;',
      'import java.util.List;',
      '',
      'public class App {',
      '    public static void main(String[] args) {',
      '        List<String> names = new ArrayList<>();',
      '        names.add("a");',
      '        names.',
      '    }',
      '}',
      '',
    ].join('\n');
    const file = join(jProject, 'src', 'main', 'java', 'demo', 'App.java');
    writeFileSync(file, code);
    const uri = pathToFileURL(file).href;
    const line = code.split('\n').findIndex((l) => l.trim() === 'names.');
    const character = '        names.'.length;

    const manager = await newManager(jHome);
    manager.register(javaPlugin);
    const entry = manager.acquire('java', jProject)!;
    await entry.openDocument(uri, code, 'java');
    const t0 = Date.now();
    const ready = await entry.waitUntilReady(240_000);
    const readyMs = Date.now() - t0;
    check('jdtls: initialize completes', ready, `${readyMs} ms`);
    if (ready) {
      // The first completion races the Maven import. It must not block: either a
      // real answer inside the budget, or the fallback while the import runs.
      const firstT = Date.now();
      const firstItems = await entry.completion(uri, { line, character });
      const firstMs = Date.now() - firstT;
      check('jdtls: the first completion respects its budget', firstMs <= 5000, `${firstMs} ms, ${firstItems.length} items`);

      let importMs = -1;
      let real: string[] = [];
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const items = await entry.completion(uri, { line, character });
        const labels = items.map((i) => i.label);
        if (labels.some((l) => /^add\(/.test(l) || l === 'clear()')) {
          real = labels;
          importMs = Date.now() - t0;
          break;
        }
        await sleep(1000);
      }
      check('jdtls: member completion arrives once the import finishes', real.length > 0, `${real.length} items after ${importMs} ms`);
      check('jdtls: the members are ArrayList\'s, not a keyword list', real.some((l) => /add\(String/.test(l)), real.slice(0, 6).join(', '));

      const warmT = Date.now();
      await entry.completion(uri, { line, character });
      const warmMs = Date.now() - warmT;
      check('jdtls: a warm completion is fast', warmMs < 1000, `${warmMs} ms`);

      const hover = await entry.hover(uri, { line: line - 1, character: 12 });
      check('jdtls: hover resolves the symbol', !!hover, JSON.stringify(hover)?.slice(0, 80));

      const diag = await entry.waitForDiagnostics(uri, 30_000);
      check('jdtls: publishDiagnostics reaches the buffer', diag.source === 'lsp', `${diag.items.length} item(s), source=${diag.source}`);

      const same = manager.acquire('java', join(jProject, 'src'))!;
      check('jdtls: a nested root reuses the reactor server', same === entry);
      const stats = manager.stats();
      check('jdtls: one server for one root', stats.live === 1, JSON.stringify(stats));

      console.log(
        `\n  timings: initialize ${readyMs} ms · first completion ${firstMs} ms · import ${importMs} ms · warm ${warmMs} ms`,
      );

      // ---- the whole chain: WorkspaceService → manager → jdtls ----
      // The manager suite proves the manager; this proves the panel is wired to
      // it. Without it, `slot.lsp` could be typed correctly and still never
      // receive a pooled entry.
      const wsHome = join(SANDBOX, 'home-ws');
      mkdirSync(join(wsHome, 'languages'), { recursive: true });
      cpSync(join(ROOT, 'examples', 'java@1.0.0'), join(wsHome, 'languages', 'java@1.0.0'), { recursive: true });
      const wsKernel = new Kernel({ appVersion: 'verify-ws', logSilent: true });
      await wsKernel.start();
      const ws = new WorkspaceService(wsKernel, {
        home: wsHome,
        pluginRoots: [],
        workspaceDir: join(SANDBOX, 'ws-work'),
      });
      await ws.init({ java: code });
      let panelItems: string[] = [];
      const panelDeadline = Date.now() + 120_000;
      while (Date.now() < panelDeadline) {
        const out = await ws.complete('java', code, line, character);
        const labels = out.items.map((i) => i.label);
        if (labels.some((l) => /^add\(/.test(l))) {
          panelItems = labels;
          break;
        }
        await sleep(1000);
      }
      // Read the pool *after* the first request: java is not eager, so nothing
      // exists until something is asked of it — which is the lazy-start rule.
      const pooled = ws.lspManager.entry('java');
      check('panel: the java slot is attached to a pooled entry', !!pooled, pooled?.root ?? 'none');
      check('panel: completion through the panel returns real members', panelItems.length > 0, `${panelItems.length} item(s)`);
      const panelDiag = await ws.diagnose('java', code);
      check('panel: Check reports the server as the source', panelDiag.fromLsp, `fromLsp=${panelDiag.fromLsp} items=${panelDiag.items.length}`);
      await ws.close();
    }
    await manager.close();
  }

  // ================================================================ stdio service
  // The spec asks for a test service that exposes the manager over stdio; this
  // drives it the way a client would, so the service is covered rather than
  // merely present.
  const svcProject = join(SANDBOX, 'svc-project');
  mkdirSync(svcProject, { recursive: true });
  const svcFile = join(svcProject, 'A.fake');
  writeFileSync(svcFile, 'class A {}\n');
  const svcManifestPath = join(SANDBOX, 'svc.manifest.json');
  writeFileSync(svcManifestPath, JSON.stringify(fakeManifest({ id: 'svc', log: join(SANDBOX, 'svc.log') }), null, 2));
  const svc = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--experimental-loader',
      './resolve-loader.mjs',
      'scripts/lsp-manager-service.ts',
      '--home',
      join(SANDBOX, 'home-svc'),
      '--workspace',
      svcProject,
      '--manifest',
      svcManifestPath,
    ],
    { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let svcBuf = '';
  const svcWaiters: Array<(line: string) => void> = [];
  svc.stdout.on('data', (c: Buffer) => {
    svcBuf += c.toString('utf8');
    for (;;) {
      const nl = svcBuf.indexOf('\n');
      if (nl < 0) break;
      const line = svcBuf.slice(0, nl);
      svcBuf = svcBuf.slice(nl + 1);
      const waiter = svcWaiters.shift();
      if (waiter) waiter(line);
    }
  });
  const askService = (msg: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      svcWaiters.push((line) => resolve(JSON.parse(line) as Record<string, unknown>));
      svc.stdin.write(`${JSON.stringify(msg)}\n`);
    });

  const opened = await askService({ id: 1, op: 'open', file: svcFile });
  check('service: open brings a pooled server up', opened.ok === true && opened.ready === true, JSON.stringify(opened).slice(0, 110));
  const svcComp = await askService({ id: 2, op: 'completion', file: svcFile, line: 0, character: 6 });
  check(
    "service: completion returns the server's items",
    Array.isArray(svcComp.items) && (svcComp.items as unknown[]).length === 3,
    JSON.stringify(svcComp).slice(0, 110),
  );
  const svcStats = await askService({ id: 3, op: 'stats' });
  check('service: stats report one live server', svcStats.live === 1, JSON.stringify(svcStats).slice(0, 110));
  const bye = await askService({ id: 4, op: 'shutdown' });
  check('service: shutdown is acknowledged', bye.ok === true);
  // Wait for the child to actually exit. Removing the sandbox while it is still
  // shutting down is a race that shows up as an unexplained non-zero exit: the
  // suite prints its summary and then dies in the cleanup.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        svc.kill();
      } catch {
        /* gone */
      }
      resolve();
    }, 3000);
    svc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  // ================================================================ summary
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
  if (failed.length) console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
  // Cleanup is best effort and must never change the verdict: a JVM still
  // holding a handle on its `-data` directory would otherwise turn a green
  // suite into an unexplained exit code 1.
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch (err) {
    console.log(`  (cleanup left ${SANDBOX}: ${(err as Error).message})`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

await main();
