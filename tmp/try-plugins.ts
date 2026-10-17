import { Kernel } from '../src/kernel/Kernel.js';
import { LanguageRegistry } from '../src/langs/Registry.js';
import { RunnerFactory } from '../src/langs/RunnerFactory.js';
import { defaultRuntimeRegistry } from '../src/runtimes/index.js';
import { join } from 'node:path';

const home = join(process.cwd(), 'tmp', 'nl-home');
const reg = new LanguageRegistry({
  home,
  roots: [],
  extraRoots: [{ dir: join(process.cwd(), 'builtin'), kind: 'builtin', removable: false }],
});
await reg.scan();
console.log('languages:', reg.describe().map((d) => `${d.id}@${d.version}:${d.runMode ?? 'render'}`).join(', '));

const kernel = new Kernel({ devMode: true, logSilent: true });
await kernel.start();
const factory = new RunnerFactory(defaultRuntimeRegistry());
console.log('runtimes:', factory.registry.list());

for (const m of reg.all()) {
  const diag = factory.diagnose(m);
  console.log(`diagnose ${m.id}:`, diag.ok, diag.reason ?? '');
}

// Python: persistence across two runs
const py = reg.get('python')!;
const dataDir = await reg.ensureDataDir('python');
const pyRunner = factory.create(py, {
  kernel: kernel as never,
  languageId: 'python',
  dataDir,
  pluginDir: reg.sourceOf('python')!.dir,
  toolchain: process.env.PYTHON_BIN ?? 'python',
})!;
const a = await pyRunner.run({ code: 'x = 41\nprint("first", x)', sessionId: 'smoke' });
console.log('py#1', a.exitCode, JSON.stringify(a.stdout));
const b = await pyRunner.run({ code: 'print("second", x + 1)', sessionId: 'smoke' });
console.log('py#2', b.exitCode, JSON.stringify(b.stdout));

// JavaScript
const js = reg.get('javascript')!;
const jsRunner = factory.create(js, {
  kernel: kernel as never,
  languageId: 'javascript',
  dataDir: await reg.ensureDataDir('javascript'),
  pluginDir: reg.sourceOf('javascript')!.dir,
})!;
const j = await jsRunner.run({ code: 'console.log("js", 1 + 1)', sessionId: 'smoke' });
console.log('js', j.exitCode, JSON.stringify(j.stdout));

// Go (skip when missing)
const go = reg.get('go')!;
const goTool = (await import('../src/langs/discover.js')).discoverBinary(go.run?.discovery);
console.log('go toolchain:', goTool);
if (goTool.source !== 'missing') {
  const goRunner = factory.create(go, {
    kernel: kernel as never,
    languageId: 'go',
    dataDir: await reg.ensureDataDir('go'),
    pluginDir: reg.sourceOf('go')!.dir,
    toolchain: goTool.bin,
  })!;
  const g = await goRunner.run({ code: 'package main\nimport "fmt"\nfunc main(){ fmt.Println("go ok") }', sessionId: 'smoke' });
  console.log('go', g.exitCode, g.phase, JSON.stringify(g.stdout), JSON.stringify(g.stderr.slice(0, 200)));
}

await kernel.stop();
