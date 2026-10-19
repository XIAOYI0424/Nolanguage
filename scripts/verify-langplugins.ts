/**
 * Language-plugin substrate verification.
 *
 * Proves the four claims the plugin architecture rests on:
 *
 *   1. **Manifest contract** — validation rejects exactly what it should, with
 *      a field path, and every shipped `builtin/` manifest passes.
 *   2. **Version constraints** — `^` / `~` / comparison ranges behave, and an
 *      unmet `requires` is a clear error rather than a spawn-time mystery.
 *   3. **Registry** — scan, order, extension lookup, enable/disable with
 *      persistence, install/uninstall with data separation.
 *   4. **Runtimes** — all five capabilities execute *real* code:
 *      `template` (build+run steps), `repl-session` (state across runs),
 *      `directory-session` (scaffold + stale-source cleanup), `inline-vm`
 *      (fresh context + timeout), `script-host` (JSON protocol + kill).
 *
 * Optional toolchains (Go) SKIP, never FAIL.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-langplugins.ts
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Kernel } from '../src/kernel/Kernel.js';
import { validateManifest, bufferName, primaryExtension, supportsRun, type LanguageManifest } from '../src/langs/manifest.js';
import { LanguageRegistry, type RegistryRoot } from '../src/langs/Registry.js';
import { RunnerFactory } from '../src/langs/RunnerFactory.js';
import { RuntimeRegistry, satisfies, parseRequirement } from '../src/runtimes/RuntimeRegistry.js';
import { defaultRuntimeRegistry } from '../src/runtimes/index.js';
import { TemplateRuntime } from '../src/runtimes/template.js';
import { ReplSessionRuntime } from '../src/runtimes/repl-session.js';
import { DirectorySessionRuntime } from '../src/runtimes/directory-session.js';
import { InlineVmRuntime } from '../src/runtimes/inline-vm.js';
import { ScriptHostRuntime } from '../src/runtimes/script-host.js';
import { discoverBinary } from '../src/langs/discover.js';
import type { HostContext, RunConfig } from '../src/runtimes/types.js';

const results: { name: string; ok: boolean; detail: string; skipped?: boolean }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name: string, detail = ''): void {
  results.push({ name, ok: true, detail, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

const ROOT = process.cwd();
const BUILTIN = join(ROOT, 'builtin');
const TMP = join(ROOT, '.tmp', `langplugins-${process.pid}-${Date.now()}`);

function baseManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    displayName: 'Demo',
    version: '1.0.0',
    apiVersion: '^1.0.0',
    file: { extensions: ['dm'], defaultExt: 'dm' },
    ...over,
  };
}

// ============================================================ 1. manifest

function testManifest(): void {
  const ok = validateManifest(baseManifest());
  check('manifest: a minimal valid manifest passes', ok.ok, ok.issues.map((i) => i.field).join(','));

  const badId = validateManifest(baseManifest({ id: 'Demo Lang' }));
  check(
    'manifest: a bad id is rejected with a field path',
    !badId.ok && badId.issues.some((i) => i.field === 'id'),
    badId.issues[0]?.message ?? '',
  );

  const badVer = validateManifest(baseManifest({ version: '1.0' }));
  check('manifest: a non-semver version is rejected', !badVer.ok && badVer.issues.some((i) => i.field === 'version'));

  const badApi = validateManifest(baseManifest({ apiVersion: 'one' }));
  check('manifest: a bad apiVersion range is rejected', !badApi.ok && badApi.issues.some((i) => i.field === 'apiVersion'));

  const noFile = validateManifest({ id: 'x', displayName: 'X', version: '1.0.0', apiVersion: '^1.0.0' });
  check('manifest: `file` is required', !noFile.ok && noFile.issues.some((i) => i.field === 'file'));

  const badExt = validateManifest(baseManifest({ file: { extensions: ['a b'] } }));
  check('manifest: an invalid extension is rejected', !badExt.ok && badExt.issues.some((i) => i.field === 'file.extensions'));

  // A grammar rule that does not compile must be rejected at install time —
  // otherwise the whole language silently loses highlighting at runtime.
  const badRe = validateManifest(baseManifest({ grammar: { rules: [{ re: '([', cls: 'k' }] } }));
  check(
    'manifest: an uncompilable grammar regex is rejected',
    !badRe.ok && badRe.issues.some((i) => i.field.startsWith('grammar.rules') && /compile/.test(i.message)),
    badRe.issues.map((i) => i.message).join(' | ').slice(0, 60),
  );

  const badCls = validateManifest(baseManifest({ grammar: { rules: [{ re: 'x', cls: 'zzz' }] } }));
  check('manifest: an unknown token class is rejected', !badCls.ok && badCls.issues.some((i) => /cls/.test(i.field)));

  const noMode = validateManifest(baseManifest({ run: { timeoutMs: 100 } }));
  check('manifest: `run.mode` is required when `run` is present', !noMode.ok && noMode.issues.some((i) => i.field === 'run.mode'));

  const badRequires = validateManifest(baseManifest({ run: { mode: 'template', requires: [1] } }));
  check('manifest: `run.requires` must be strings', !badRequires.ok && badRequires.issues.some((i) => i.field === 'run.requires'));
}

// ========================================================== 3. examples shelf

/**
 * `examples/` is the copy-paste shelf: a plugin a user can install as-is. An
 * example that no longer validates is worse than no example at all, so every
 * manifest there is checked — including that the factory can assemble it, which
 * is the check that catches a `run` block renamed under someone's feet.
 */
async function testExamples(): Promise<void> {
  const dir = join(ROOT, 'examples');
  if (!existsSync(dir)) {
    skip('examples: the shelf exists', 'examples/ missing');
    return;
  }
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  check('examples: the shelf is not empty', entries.length > 0, entries.join(',') || '(none)');

  for (const name of entries) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, name, 'manifest.json'), 'utf8')) as unknown;
    } catch {
      check(`examples: ${name} has a readable manifest`, false, name);
      continue;
    }
    const v = validateManifest(raw);
    check(`examples: ${name} validates`, v.ok, v.issues.map((i) => `${i.field}: ${i.message}`).join('; ').slice(0, 90));
    if (!v.ok) continue;
    const diag = new RunnerFactory(defaultRuntimeRegistry()).diagnose(raw as LanguageManifest);
    check(`examples: ${name} assembles into a runner`, diag.ok, diag.reason ?? '');
  }
}

// ============================================================ 2. versions

function testVersions(): void {
  check('versions: ^1.0.0 accepts 1.2.3', satisfies('1.2.3', '^1.0.0'));
  check('versions: ^1.0.0 rejects 2.0.0', !satisfies('2.0.0', '^1.0.0'));
  check('versions: ~1.2.3 rejects 1.3.0', !satisfies('1.3.0', '~1.2.3'));
  check('versions: ~1.2.3 accepts 1.2.9', satisfies('1.2.9', '~1.2.3'));
  check('versions: >=1.0.0 accepts 3.0.0', satisfies('3.0.0', '>=1.0.0'));
  check('versions: * accepts anything', satisfies('9.9.9', '*'));

  const parsed = parseRequirement('repl-session@^1.0.0');
  check('versions: a requirement splits into id + range', parsed.id === 'repl-session' && parsed.range === '^1.0.0', `${parsed.id} ${parsed.range}`);

  const reg = defaultRuntimeRegistry();
  const okReq = reg.satisfiesAll(['template@^1.0.0', 'inline-vm@1.0.0']);
  check('versions: the shipped runtimes satisfy ^1.0.0', okReq.ok, okReq.unmet.join(','));
  const bad = reg.satisfiesAll(['template@^2.0.0']);
  check('versions: an unmet requirement is reported', !bad.ok && bad.unmet[0] === 'template@^2.0.0', bad.unmet.join(','));

  const empty = new RuntimeRegistry();
  check('versions: an empty registry satisfies nothing', !empty.satisfies('template', '^1.0.0'));
}

// ============================================================ 3. registry

async function testRegistry(kernel: Kernel): Promise<void> {
  const home = join(TMP, 'home');
  // `extraRoots`, not `roots`: the defaults must stay so `<home>/languages`
  // (where `install()` writes) is scanned too.
  const roots: RegistryRoot[] = [{ dir: BUILTIN, kind: 'builtin', removable: false }];
  const reg = new LanguageRegistry({ home, extraRoots: roots });
  await reg.scan();

  const ids = reg.all().map((m) => m.id);
  check('registry: the official plugins are discovered', ids.length === 4, ids.join(','));
  check(
    'registry: presentation order comes from the manifests',
    ids.join(',') === 'python,go,javascript,markdown',
    ids.join(','),
  );
  check('registry: builtin plugins are not removable', reg.sourceOf('python')?.removable === false);
  check('registry: every plugin validates', reg.installed().every((p) => p.validation.ok));

  const py = reg.byExtension('py');
  check('registry: extension lookup finds python', py?.id === 'python', py?.id ?? '');
  const pyDot = reg.byExtension('.PY');
  check('registry: extension lookup normalises case and the dot', pyDot?.id === 'python', pyDot?.id ?? '');
  check('registry: unknown extensions resolve to undefined', reg.byExtension('zzz') === undefined);
  check('registry: file-name lookup works', reg.byFileName('main.go')?.id === 'go');

  check('registry: buffer name comes from the manifest', bufferName(py!) === 'main.py', bufferName(py!));
  check('registry: primary extension has a dot', primaryExtension(py!) === '.py', primaryExtension(py!));
  check('registry: markdown declares no runner', supportsRun(reg.get('markdown')!) === false);
  check('registry: go declares a test mode', !!reg.get('go')!.run?.modes?.test);

  // enable / disable persists
  await reg.disable('go');
  check('registry: disable removes it from all()', !reg.all().some((m) => m.id === 'go'));
  check('registry: disable keeps it in installed()', reg.installed().some((p) => p.manifest.id === 'go'));
  const cfg = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as { disabled: string[] };
  check('registry: disable is persisted', cfg.disabled.includes('go'), cfg.disabled.join(','));

  const reg2 = new LanguageRegistry({ home, extraRoots: roots });
  await reg2.scan();
  check('registry: a rescan honours the persisted state', !reg2.all().some((m) => m.id === 'go'));

  await reg.enable('go');
  check('registry: enable restores it', reg.all().some((m) => m.id === 'go'));

  // change events
  const seen: string[] = [];
  const sub = reg.onDidChange((e) => seen.push(`${e.type}:${e.id}`));
  await reg.disable('markdown');
  await reg.enable('markdown');
  sub.dispose();
  check('registry: changes are broadcast', seen.includes('disabled:markdown') && seen.includes('enabled:markdown'), seen.join(','));

  // install / uninstall with data separation
  const src = join(TMP, 'rust-src');
  await mkdir(src, { recursive: true });
  await writeFile(
    join(src, 'manifest.json'),
    JSON.stringify({
      id: 'rust',
      displayName: 'Rust',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      order: 100,
      file: { extensions: ['rs'], defaultExt: 'rs' },
      run: { mode: 'template', steps: [{ role: 'run', cmd: 'echo hi' }] },
    }),
    'utf8',
  );
  const installed = await reg.install(src);
  check('registry: install copies the plugin into languages/', installed.dir.includes('languages'), installed.dir);
  check('registry: the installed plugin is usable', reg.byExtension('rs')?.id === 'rust');

  const dataDir = await reg.ensureDataDir('rust');
  await writeFile(join(dataDir, 'run-configs.json'), '{"keep":true}', 'utf8');
  const removed = await reg.uninstall('rust');
  check('registry: uninstall removes a user plugin', removed && reg.byExtension('rs') === undefined);
  check('registry: uninstall keeps user data by default', existsSync(join(dataDir, 'run-configs.json')));

  let builtinError = '';
  try {
    await reg.uninstall('python');
  } catch (err) {
    builtinError = (err as Error).message;
  }
  check('registry: a builtin plugin cannot be uninstalled', /disable it instead/.test(builtinError), builtinError.slice(0, 60));

  // invalid plugin is listed but never enabled
  const badDir = join(TMP, 'bad-root', 'broken@1.0.0');
  await mkdir(badDir, { recursive: true });
  await writeFile(join(badDir, 'manifest.json'), JSON.stringify({ id: 'broken' }), 'utf8');
  const reg3 = new LanguageRegistry({ home: join(TMP, 'home2'), extraRoots: [...roots, { dir: join(TMP, 'bad-root'), kind: 'user', removable: true }] });
  await reg3.scan();
  check('registry: an invalid manifest is skipped, not fatal', reg3.all().length === 4, `${reg3.all().length} enabled`);

  void kernel;
}

// ============================================================ 4. runtimes

function ctxFor(kernel: Kernel, languageId: string, dir: string, toolchain?: string): HostContext {
  return {
    kernel: kernel as never,
    languageId,
    dataDir: join(dir, 'data'),
    pluginDir: dir,
    toolchain,
  };
}

async function testTemplate(kernel: Kernel, pythonBin: string): Promise<void> {
  const dir = join(TMP, 'rt-template');
  await mkdir(dir, { recursive: true });
  const config: RunConfig = {
    mode: 'template',
    sourceExt: '.py',
    timeoutMs: 15000,
    steps: [{ role: 'build', cmd: `"{toolchain}" -c "print('build-ok')"` }],
  };
  const runner = new TemplateRuntime().createRunner(config, ctxFor(kernel, 'demo-template', dir, pythonBin));
  const r = await runner.run({ code: 'print("never runs")' });
  check('template: a step executes', r.exitCode === 0 && /build-ok/.test(r.stdout), `exit=${r.exitCode} ${r.stdout.trim()}`);
  check('template: the build phase is reported', r.phase === 'run' || r.phase === 'build', r.phase ?? '-');
  check('template: the binary is the first step command', runner.binary === pythonBin, runner.binary);

  const failing: RunConfig = {
    mode: 'template',
    sourceExt: '.py',
    timeoutMs: 15000,
    steps: [{ role: 'build', cmd: `"{toolchain}" -c "import sys; sys.exit(3)"` }],
  };
  const f = new TemplateRuntime().createRunner(failing, ctxFor(kernel, 'demo-template', dir, pythonBin));
  const rf = await f.run({ code: '' });
  check('template: a failing build stops the run', rf.exitCode === 3, `exit=${rf.exitCode}`);
  check('template: a failing build is a compile error', rf.compileError === true && rf.phase === 'build', `${rf.phase} compileError=${rf.compileError}`);

  const invalid = new TemplateRuntime().validate({ mode: 'template' }, 'x');
  check('template: validate rejects a config with no steps', !invalid.ok, invalid.errors[0] ?? '');
}

async function testReplSession(kernel: Kernel, pythonBin: string): Promise<void> {
  const dir = join(TMP, 'rt-repl');
  await mkdir(join(dir, 'data'), { recursive: true });
  const pluginDir = join(BUILTIN, 'python@1.0.0');
  const ctx = { ...ctxFor(kernel, 'python', dir, pythonBin), pluginDir };
  const config: RunConfig = {
    mode: 'repl-session',
    command: ['{toolchain}', '-u'],
    sourceExt: '.py',
    bootstrap: 'bootstrap.py',
    timeoutMs: 15000,
  };
  const runner = new ReplSessionRuntime().createRunner(config, ctx);

  const a = await runner.run({ code: 'value = 40\nprint("a", value)', sessionId: 'rt' });
  check('repl-session: a snippet runs', a.exitCode === 0 && /a 40/.test(a.stdout), a.stdout.trim());
  const b = await runner.run({ code: 'print("b", value + 2)', sessionId: 'rt' });
  check('repl-session: state persists across runs', /b 42/.test(b.stdout), b.stdout.trim() || b.stderr.trim().slice(0, 60));

  check('repl-session: one session is tracked', runner.sessionCount() === 1, `${runner.sessionCount()}`);
  const reset = await runner.resetSession('rt');
  check('repl-session: reset drops the session', reset === true && runner.sessionCount() === 0);

  const c = await runner.run({ code: 'print("c", "value" in dir())', sessionId: 'rt' });
  check('repl-session: reset clears the namespace', /c False/.test(c.stdout), c.stdout.trim());

  const err = await runner.run({ code: 'raise SystemExit(7)', sessionId: 'rt' });
  check('repl-session: a non-zero exit propagates', err.exitCode === 7, `exit=${err.exitCode}`);

  const missing = new ReplSessionRuntime().createRunner(config, { ...ctx, toolchain: undefined });
  check('repl-session: a missing toolchain reports unavailable', missing.available === false, missing.binary);

  const bad = new ReplSessionRuntime().validate({ mode: 'repl-session' }, 'x');
  check('repl-session: validate requires a command', !bad.ok, bad.errors[0] ?? '');
}

async function testDirectorySession(kernel: Kernel, pythonBin: string): Promise<void> {
  const dir = join(TMP, 'rt-dir');
  await mkdir(join(dir, 'data'), { recursive: true });
  const ctx = ctxFor(kernel, 'demo-dir', dir, pythonBin);
  const config: RunConfig = {
    mode: 'directory-session',
    command: ['{toolchain}'],
    sourceExt: '.py',
    timeoutMs: 15000,
    scaffold: { required: true, onFirstRun: [{ file: 'module.cfg', template: 'name = "demo"\n' }] },
    steps: [{ role: 'run', cmd: `"{toolchain}" {file}` }],
    modes: { test: { steps: [{ role: 'test', cmd: `"{toolchain}" {file}` }] } },
  };
  const runner = new DirectorySessionRuntime().createRunner(config, ctx);
  const r = await runner.run({ code: 'print("run-mode")', sessionId: 'd1' });
  check('directory-session: a run executes', r.exitCode === 0 && /run-mode/.test(r.stdout), r.stdout.trim());

  const sessionDir = join(ctx.dataDir, 'sessions', 'd1');
  check('directory-session: the scaffold file is written', existsSync(join(sessionDir, 'module.cfg')));
  check('directory-session: the run-mode source exists', existsSync(join(sessionDir, 'main.py')));

  const t = await runner.run({ code: 'print("test-mode")', sessionId: 'd1', mode: 'test' });
  check('directory-session: a named mode executes', t.exitCode === 0 && /test-mode/.test(t.stdout), t.stdout.trim());
  check('directory-session: the mode is reported as the phase', t.phase === 'test', t.phase ?? '-');
  check('directory-session: the other mode\'s source is cleared', !existsSync(join(sessionDir, 'main.py')));
  check('directory-session: the scaffold survives a mode switch', existsSync(join(sessionDir, 'module.cfg')));

  const bad = new DirectorySessionRuntime().validate({ mode: 'directory-session', sourceExt: '.py' }, 'x');
  check('directory-session: validate requires steps', !bad.ok, bad.errors[0] ?? '');
}

async function testInlineVm(kernel: Kernel): Promise<void> {
  const dir = join(TMP, 'rt-vm');
  await mkdir(join(dir, 'data'), { recursive: true });
  const runner = new InlineVmRuntime().createRunner(
    { mode: 'inline-vm', sourceExt: '.js', vmTimeoutMs: 2000 },
    ctxFor(kernel, 'demo-vm', dir),
  );

  const a = await runner.run({ code: 'console.log("vm", 1 + 1)' });
  check('inline-vm: code evaluates', a.exitCode === 0 && /vm 2/.test(a.stdout), a.stdout.trim());

  // A fresh context per run is what lets a `const` snippet be re-run.
  const b = await runner.run({ code: 'const x = 1; console.log("again", x)' });
  const c = await runner.run({ code: 'const x = 2; console.log("again", x)' });
  check('inline-vm: every run gets a fresh context', b.exitCode === 0 && c.exitCode === 0 && /again 2/.test(c.stdout), c.stdout.trim());

  const thrown = await runner.run({ code: 'throw new Error("boom")' });
  check('inline-vm: a throw is a failed run, not a crash', thrown.exitCode === 1 && /boom/.test(thrown.stderr), thrown.stderr.trim().slice(0, 40));

  const slow = await runner.run({ code: 'while (true) {}', timeoutMs: 120 });
  check('inline-vm: a runaway loop is stopped', slow.timedOut === true, `timedOut=${slow.timedOut} exit=${slow.exitCode}`);

  check('inline-vm: it reports this process as the binary', runner.binary === process.execPath);
}

async function testScriptHost(kernel: Kernel): Promise<void> {
  const dir = join(TMP, 'rt-script');
  const pluginDir = join(dir, 'plugin');
  await mkdir(pluginDir, { recursive: true });
  await mkdir(join(dir, 'data'), { recursive: true });

  await writeFile(
    join(pluginDir, 'runtime.js'),
    [
      "let buf = '';",
      "process.stdin.on('data', (d) => { buf += d; });",
      "process.stdin.on('end', () => {",
      '  const req = JSON.parse(buf);',
      "  process.stdout.write(JSON.stringify({ t: 'out', s: 'stdout', text: 'hello ' + req.mode + '\\n' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ t: 'exit', code: 0 }) + '\\n');",
      '});',
    ].join('\n'),
    'utf8',
  );
  const ctx = { ...ctxFor(kernel, 'demo-script', dir), pluginDir };
  const runner = new ScriptHostRuntime().createRunner(
    { mode: 'script-host', script: 'runtime.js', sourceExt: '.demo', timeoutMs: 15000 },
    ctx,
  );

  const r = await runner.run({ code: 'whatever', mode: 'run' });
  check('script-host: the plugin script runs in a child', r.exitCode === 0, `exit=${r.exitCode} ${r.stderr.trim().slice(0, 50)}`);
  check('script-host: JSON frames reach the result', /hello run/.test(r.stdout), r.stdout.trim());

  await writeFile(join(pluginDir, 'hang.js'), 'setInterval(() => {}, 1000);\n', 'utf8');
  const hang = new ScriptHostRuntime().createRunner(
    { mode: 'script-host', script: 'hang.js', sourceExt: '.demo', timeoutMs: 200 },
    ctx,
  );
  const hr = await hang.run({ code: '' });
  check('script-host: a hung script is killed', hr.timedOut === true, `timedOut=${hr.timedOut}`);

  const bad = new ScriptHostRuntime().validate({ mode: 'script-host', sourceExt: '.x' }, 'x');
  check('script-host: validate requires a script path', !bad.ok, bad.errors[0] ?? '');
}

// ============================================================ 5. factory

async function testFactory(kernel: Kernel): Promise<void> {
  const home = join(TMP, 'factory-home');
  const reg = new LanguageRegistry({ home, extraRoots: [{ dir: BUILTIN, kind: 'builtin', removable: false }] });
  await reg.scan();
  const factory = new RunnerFactory(defaultRuntimeRegistry());

  check('factory: five runtimes are registered', factory.registry.list().length === 5, factory.registry.list().map((r) => r.id).join(','));

  const pyManifest = reg.get('python')!;
  const dataDir = await reg.ensureDataDir('python');
  const runner = factory.create(pyManifest, {
    kernel: kernel as never,
    languageId: 'python',
    dataDir,
    pluginDir: reg.sourceOf('python')!.dir,
    toolchain: process.env.PYTHON_BIN ?? 'python',
  });
  check('factory: python is built by the repl-session runtime', runner !== null && pyManifest.run?.mode === 'repl-session', pyManifest.run?.mode ?? '');
  check('factory: no builtin-runner branch exists', !('BUILTIN_RUNNERS' in factory));

  check('factory: a render-only language yields no runner', factory.create(reg.get('markdown')!, {
    kernel: kernel as never,
    languageId: 'markdown',
    dataDir,
    pluginDir: reg.sourceOf('markdown')!.dir,
  }) === null);

  const diag = factory.diagnose(reg.get('markdown')!);
  check('factory: diagnose explains a render-only language', !diag.ok && /render/.test(diag.reason ?? ''), diag.reason ?? '');

  const ghost = { ...pyManifest, run: { ...pyManifest.run!, mode: 'wasm-host' } };
  let msg = '';
  try {
    factory.create(ghost as typeof pyManifest, { kernel: kernel as never, languageId: 'python', dataDir, pluginDir: '' });
  } catch (err) {
    msg = (err as Error).message;
  }
  check('factory: an unknown runtime names itself in the error', /wasm-host.*not available/.test(msg), msg.slice(0, 70));

  const tooNew = { ...pyManifest, run: { ...pyManifest.run!, requires: ['repl-session@^9.0.0'] } };
  let msg2 = '';
  try {
    factory.create(tooNew as typeof pyManifest, { kernel: kernel as never, languageId: 'python', dataDir, pluginDir: '' });
  } catch (err) {
    msg2 = (err as Error).message;
  }
  check('factory: an unmet requirement names the range', /requirement not met: repl-session@\^9\.0\.0/.test(msg2), msg2.slice(0, 70));

  const badCfg = { ...pyManifest, run: { mode: 'repl-session' } };
  let msg3 = '';
  try {
    factory.create(badCfg as typeof pyManifest, { kernel: kernel as never, languageId: 'python', dataDir, pluginDir: '' });
  } catch (err) {
    msg3 = (err as Error).message;
  }
  check('factory: an invalid run config is rejected with reasons', /Invalid run config/.test(msg3), msg3.slice(0, 70));
}

// ============================================================ discovery hints

/**
 * `versionFiles` + glob `knownPaths`: a project declaration (`.python-version`,
 * `package.json` engines, `go.mod`, `pyproject.toml`) orders the candidates,
 * but never *fails* a lookup — a pinned version that is not installed still
 * resolves to the closest installed one.
 */
async function testDiscovery(): Promise<void> {
  const root = await mkdtemp(join(TMP, 'disc-'));
  try {
    const touch = async (p: string): Promise<void> => {
      await mkdir(join(p, '..'), { recursive: true });
      await writeFile(p, '', 'utf8');
    };

    // plain: .python-version
    const py = join(root, 'py');
    await touch(join(py, 'versions', '3.10.2', 'bin', 'python3'));
    await touch(join(py, 'versions', '3.11.4', 'bin', 'python3'));
    await writeFile(join(py, '.python-version'), '3.11.4\n', 'utf8');
    const plain = discoverBinary(
      {
        knownPaths: [join(py, 'versions', '*', 'bin', 'python3')],
        versionFiles: [{ path: '.python-version', format: 'plain' }],
      },
      { root: py },
    );
    check(
      'discover: a plain .python-version selects the matching version',
      plain.source === 'known' && plain.bin.includes('3.11.4') && plain.wantedVersion === '3.11.4',
      `${plain.bin} (${plain.source})`,
    );

    // json: package.json engines.node
    const nd = join(root, 'node');
    await touch(join(nd, 'v18.0.0', 'bin', 'node'));
    await touch(join(nd, 'v20.1.0', 'bin', 'node'));
    await writeFile(join(nd, 'package.json'), JSON.stringify({ engines: { node: '>=20' } }), 'utf8');
    const json = discoverBinary(
      {
        knownPaths: [join(nd, '*', 'bin', 'node')],
        versionFiles: [{ path: 'package.json', format: 'json', key: 'engines.node' }],
      },
      { root: nd },
    );
    check(
      'discover: a JSON engines.node hint selects v20',
      json.source === 'known' && json.bin.includes('v20.1.0') && json.wantedVersion === '>=20',
      `${json.bin} (${json.source})`,
    );

    // regex: go.mod's `go 1.22` line
    const go = join(root, 'go');
    await touch(join(go, 'go1.21', 'bin', 'go'));
    await touch(join(go, 'go1.22', 'bin', 'go'));
    await writeFile(join(go, 'go.mod'), 'module example\n\ngo 1.22\n', 'utf8');
    const goRes = discoverBinary(
      {
        knownPaths: [join(go, 'go*', 'bin', 'go')],
        versionFiles: [{ path: 'go.mod', format: 'regex', pattern: '^go\\s+(\\S+)' }],
      },
      { root: go },
    );
    check(
      'discover: a regex go.mod hint selects go1.22',
      goRes.source === 'known' && goRes.bin.includes('go1.22') && goRes.wantedVersion === '1.22',
      `${goRes.bin} (${goRes.source})`,
    );

    // toml: pyproject.toml requires-python
    const tm = join(root, 'toml');
    await touch(join(tm, '3.10', 'bin', 'python3'));
    await touch(join(tm, '3.11', 'bin', 'python3'));
    await writeFile(join(tm, 'pyproject.toml'), '[project]\nrequires-python = ">=3.11"\n', 'utf8');
    const toml = discoverBinary(
      {
        knownPaths: [join(tm, '*', 'bin', 'python3')],
        versionFiles: [{ path: 'pyproject.toml', format: 'toml', key: 'project.requires-python' }],
      },
      { root: tm },
    );
    check(
      'discover: a TOML requires-python hint selects 3.11',
      toml.source === 'known' && toml.bin.includes('3.11') && toml.wantedVersion === '>=3.11',
      `${toml.bin} (${toml.source})`,
    );

    // a declaration that is absent is a hint, not an error
    const none = discoverBinary(
      { knownPaths: [join(py, 'versions', '*', 'bin', 'python3')], versionFiles: [{ path: '.missing', format: 'plain' }] },
      { root: py },
    );
    check('discover: a missing version file still resolves', none.source === 'known', `${none.bin} (${none.source})`);

    // validation: every bad field gets its own path
    const bad = validateManifest({
      id: 'x', displayName: 'X', version: '1.0.0', apiVersion: '^1.0.0',
      file: { extensions: ['x'] },
      run: {
        mode: 'template',
        steps: [{ role: 'run', cmd: 'echo' }],
        discovery: {
          versionFiles: [
            { path: '', format: 'json' },
            { path: 'a', format: 'regex', pattern: '(' },
          ],
        },
      },
    });
    check(
      'manifest: a bad versionFiles entry names its field',
      !bad.ok &&
        bad.issues.some((i) => i.field === 'run.discovery.versionFiles[0].path') &&
        bad.issues.some((i) => i.field === 'run.discovery.versionFiles[0].key') &&
        bad.issues.some((i) => i.field === 'run.discovery.versionFiles[1].pattern'),
      bad.issues.map((i) => i.field).join(','),
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ============================================================ main

async function main(): Promise<void> {
  await mkdir(TMP, { recursive: true });
  const kernel = new Kernel({ devMode: true, logSilent: true });
  await kernel.start();

  const py = discoverBinary({ commands: ['python', 'python3'], envVars: ['PYTHON_BIN'] });
  const pythonBin = py.source === 'missing' ? '' : py.bin;

  try {
    testManifest();
    testVersions();
    await testDiscovery();
    await testExamples();
    await testRegistry(kernel);

    if (!pythonBin) {
      skip('template: a step executes', 'python not found');
      skip('repl-session: state persists across runs', 'python not found');
      skip('directory-session: a run executes', 'python not found');
    } else {
      await testTemplate(kernel, pythonBin);
      await testReplSession(kernel, pythonBin);
      await testDirectorySession(kernel, pythonBin);
    }
    await testInlineVm(kernel);
    await testScriptHost(kernel);
    await testFactory(kernel);
  } finally {
    await kernel.stop();
    // The harness grants per-spawn write access; a bulk recursive delete here
    // would trip its bulk-delete guard, so cleanup is best-effort.
    await rm(TMP, { recursive: true, force: true }).catch(() => undefined);
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} checks passed` +
    (skipped.length ? ` (${skipped.length} skipped: optional tool missing)` : ''));
  if (failed.length) {
    console.log(`failed: ${failed.map((r) => r.name).join('; ')}`);
    process.exitCode = 1;
  }
}

await main();
