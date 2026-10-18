/**
 * Install-time dependency resolution.
 *
 * `manifest.run.requires` names **host runtimes** (`template`, `repl-session`, …)
 * — capabilities compiled into this build, not installable plugins. So the
 * honest behaviour is: check them at install time (not only at Run, which is
 * where RunnerFactory checks them), report an unmet one precisely, and let
 * `--strict` refuse the install outright.
 *
 * These checks pin down the part that is easy to get wrong: a refusal must
 * happen *before* the body is copied, or a failed install leaves a plugin that
 * looks installed and cannot run.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LanguageRegistry, describeUnmet, type RegistryRoot } from '../src/langs/Registry.js';
import { RuntimeRegistry } from '../src/runtimes/RuntimeRegistry.js';

let passed = 0;
let total = 0;

function check(name: string, ok: boolean, detail?: string): void {
  total++;
  if (ok) {
    passed++;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

/**
 * A runtime catalogue with a deliberately odd set, so "available" in a message
 * is observable and a missing runtime cannot be masked by accident.
 */
function stubRuntimes(): RuntimeRegistry {
  // `satisfiesAll` only reads `id`/`version`, so a plain shape is enough — and
  // it keeps the fixture honest about what the check actually depends on.
  type Entry = Parameters<RuntimeRegistry['register']>[0];
  const reg = new RuntimeRegistry();
  reg.register({ id: 'template', version: '1.0.0' } as unknown as Entry);
  reg.register({ id: 'repl-session', version: '1.2.0' } as unknown as Entry);
  return reg;
}

function manifestOf(id: string, requires?: string[]): string {
  return JSON.stringify({
    id,
    displayName: id.toUpperCase(),
    version: '1.0.0',
    apiVersion: '^1.0.0',
    file: { extensions: [id], defaultExt: id },
    run: requires ? { mode: 'template', requires } : undefined,
  });
}

async function writePlugin(root: string, id: string, requires?: string[]): Promise<string> {
  const dir = join(root, `${id}@1.0.0`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), manifestOf(id, requires));
  return dir;
}

async function openRegistry(home: string): Promise<LanguageRegistry> {
  // No `roots`: passing `[]` would override the defaults with nothing and the
  // scan would find no plugins at all, which makes every downstream assertion
  // pass against an empty set.
  const reg = new LanguageRegistry({ home, runtimes: stubRuntimes() });
  await reg.scan();
  return reg;
}

async function main(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'nlg-langdeps-'));
  try {
    // ---- the real example: cpp needs template@^1.0.0, and the host has it ----
    const cppDir = await writePlugin(work, 'cpp', ['template@^1.0.0']);
    const home1 = join(work, 'home1');
    const reg1 = await openRegistry(home1);
    const installed = await reg1.install(cppDir);
    check('met: installing cpp reports its requirement as met', installed.requirements.ok === true);
    check('met: the requirement is echoed back', installed.requirements.requires.join() === 'template@^1.0.0');
    check('met: the body was installed', existsSync(installed.dir));

    // ---- unmet, non-strict: installs, but says so ----
    const quantumDir = await writePlugin(work, 'quantum', ['quantum@^2.0.0']);
    const home2 = join(work, 'home2');
    const reg2 = await openRegistry(home2);
    const lenient = await reg2.install(quantumDir);
    check('unmet: install still succeeds without --strict', lenient.requirements.ok === false);
    check('unmet: the missing requirement is named', lenient.requirements.unmet.join() === 'quantum@^2.0.0');
    check('unmet: available runtimes are listed for context',
      lenient.requirements.available.some((r) => r.id === 'template'),
      lenient.requirements.available.map((r) => `${r.id} ${r.version}`).join(', '));

    // ---- unmet + strict: refused, and nothing is left behind ----
    const home3 = join(work, 'home3');
    const reg3 = await openRegistry(home3);
    let threw: Error | undefined;
    try {
      await reg3.install(quantumDir, { strictDeps: true });
    } catch (err) {
      threw = err as Error;
    }
    check('strict: an unmet requirement refuses the install', threw !== undefined, threw?.message);
    check('strict: the message names the missing requirement',
      !!threw && threw.message.includes('quantum@^2.0.0'));
    check('strict: the message names a runtime that does exist',
      !!threw && threw.message.includes('template'));
    check('strict: the body was never copied', !existsSync(join(home3, 'languages', 'quantum@1.0.0')));
    check('strict: it is not registered as installed', reg3.entry('quantum') === undefined);

    // ---- a strict refusal must not damage an existing install ----
    const home4 = join(work, 'home4');
    const reg4 = await openRegistry(home4);
    await reg4.install(quantumDir); // 1.0.0 installs (lenient)
    const quantumAgain = await writePlugin(join(work, 'again'), 'quantum', ['quantum@^2.0.0']);
    let threw2: Error | undefined;
    try {
      // Same id, still unmet: the refusal must leave 1.0.0 in place.
      await reg4.install(quantumAgain, { strictDeps: true });
    } catch (err) {
      threw2 = err as Error;
    }
    check('strict: a refused upgrade leaves the previous body alone',
      threw2 !== undefined && existsSync(join(home4, 'languages', 'quantum@1.0.0')),
      threw2?.message);

    // ---- version ranges are honoured, not just presence ----
    const home5 = join(work, 'home5');
    const reg5 = await openRegistry(home5);
    const tooNew = await writePlugin(work, 'toonew', ['template@^9.0.0']);
    const rangeMiss = await reg5.install(tooNew);
    check('range: a present-but-too-old runtime does not satisfy ^9.0.0',
      rangeMiss.requirements.ok === false && rangeMiss.requirements.unmet.join() === 'template@^9.0.0');

    const caretOk = await writePlugin(work, 'caretok', ['repl-session@^1.0.0']);
    const caret = await reg5.install(caretOk);
    check('range: repl-session 1.2.0 satisfies ^1.0.0', caret.requirements.ok === true);

    // ---- no requires at all: nothing to report ----
    const plain = await writePlugin(work, 'plain');
    const none = await reg5.install(plain);
    check('none: a plugin without run.requires reports ok with nothing to list',
      none.requirements.ok === true && none.requirements.requires.length === 0);

    // ---- the audit ----
    const audit = await reg5.dependencyAudit();
    check('audit: lists only plugins that declare requirements',
      audit.every((row) => row.requires.length > 0));
    check('audit: marks the unmet one', audit.some((r) => r.id === 'toonew' && r.ok === false));
    check('audit: marks the met one', audit.some((r) => r.id === 'caretok' && r.ok === true));
    check('audit: is sorted by id',
      audit.map((r) => r.id).join() === [...audit.map((r) => r.id)].sort().join(),
      audit.map((r) => r.id).join());

    // ---- the message itself ----
    const message = describeUnmet('quantum', {
      ok: false,
      unmet: ['quantum@^2.0.0'],
      available: [{ id: 'template', version: '1.0.0' }],
      requires: ['quantum@^2.0.0'],
    });
    check('message: says the runtime is a host capability, not an installable plugin',
      message.includes('host capability'), message);
    check('message: names what is missing and what exists',
      message.includes('quantum@^2.0.0') && message.includes('template 1.0.0'));
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(`${passed}/${total} checks passed`);
  process.exit(passed === total ? 0 : 1);
}

void main();
