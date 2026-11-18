/**
 * Install example languages from the command line, then use each one in the app.
 *
 * The `nlg lang add` path is the only distribution route for a plugin that is
 * not in the marketplace: a directory with a manifest. This suite runs the
 * shipped binary's CLI against a throwaway home, installs C++, C, Rust and Java
 * from `examples/`, then starts that same binary against the same home and asks
 * each language to do something real.
 *
 * The four were chosen because they cover the whole spectrum:
 *
 *   cpp    g++ present, clangd absent      -> compiles, degrades honestly
 *   c      gcc present, clangd absent      -> compiles, degrades honestly
 *   rust   rustc present, rust-analyzer    -> compiles AND navigates for real
 *   java   java present, jdtls absent      -> runs via the single-file launcher
 *
 * Every run check SKIPs when the compiler is missing, so the suite stays useful
 * on a machine that only has one of them.
 *
 * Run: npm run verify:lang-plugin
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawWsClient } from './lib/RawWsClient.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXE = process.env.NOLANGUAGE_EXE ?? join(ROOT, 'dist', 'Nolanguage.exe');
// Per-process: a shared directory makes the start-up `rmSync` hit the sandbox's
// bulk-delete guard after a few runs, which turns a green suite red in cleanup.
const SANDBOX = join(ROOT, '.tmp', 'verify-lang-plugin', String(process.pid));
const HOME = join(SANDBOX, 'home');
const TMP = join(SANDBOX, 'tmp');
const PORT = 7818;

interface LangCase {
  id: string;
  dir: string;
  fileName: string;
  code: string;
  /** What the program must print. */
  expect: string;
  /** The language server the manifest names, for the degradation message. */
  server: string;
  /** True when this machine has the server, so navigation should really work. */
  navigates: boolean;
  /**
   * Source and caret for the completion probe, when the runnable program has no
   * good completion site. Completing inside a string literal answers nothing.
   */
  completeSrc?: string;
  completeAt?: { line: number; character: number };
}

const CASES: LangCase[] = [
  {
    id: 'cpp',
    dir: join(ROOT, 'examples', 'cpp@1.0.0'),
    fileName: 'main.cpp',
    code: [
      '#include <cstdio>',
      '',
      'int add(int a, int b) { return a + b; }',
      '',
      'int main() {',
      '  std::printf("cpp %d\\n", add(20, 22));',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
    expect: 'cpp 42',
    server: 'clangd',
    navigates: false,
  },
  {
    id: 'c',
    dir: join(ROOT, 'examples', 'c@1.0.0'),
    fileName: 'main.c',
    code: [
      '#include <stdio.h>',
      '',
      'int add(int a, int b) { return a + b; }',
      '',
      'int main(void) {',
      '  printf("c %d\\n", add(20, 22));',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
    expect: 'c 42',
    server: 'clangd',
    navigates: false,
  },
  {
    id: 'rust',
    dir: join(ROOT, 'examples', 'rust@1.0.0'),
    fileName: 'main.rs',
    code: [
      'fn add(a: i32, b: i32) -> i32 {',
      '    a + b',
      '}',
      '',
      'fn main() {',
      '    println!("rust {}", add(20, 22));',
      '}',
      '',
    ].join('\n'),
    expect: 'rust 42',
    server: 'rust-analyzer',
    navigates: true,
    completeSrc: ['fn main() {', '    let s = String::new();', '    s.', '}', ''].join('\n'),
    completeAt: { line: 2, character: 6 },
  },
  {
    id: 'java',
    dir: join(ROOT, 'examples', 'java@1.0.0'),
    fileName: 'Main.java',
    code: [
      'public class Main {',
      '  static int add(int a, int b) { return a + b; }',
      '',
      '  public static void main(String[] args) {',
      '    System.out.println("java " + add(20, 22));',
      '  }',
      '}',
      '',
    ].join('\n'),
    expect: 'java 42',
    server: 'jdtls',
    navigates: false,
  },
];

const results: Array<{ name: string; ok: boolean; detail: string; skipped?: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name: string, detail = ''): void {
  results.push({ name, ok: true, detail, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

/** Run the binary's own CLI — `nlg.cmd` is a one-line shim around exactly this. */
function cli(args: string[]): { code: number | null; out: string } {
  // Temp paths stay inside the checkout: the exe unpacks its embedded plugins
  // before it can answer anything, and a locked-down profile cannot write to
  // `%LOCALAPPDATA%` (the fallback root) — which looks like "cpp is not installed".
  const r = spawnSync(EXE, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, NOLANGUAGE_HOME: HOME, TMP, TEMP: TMP, TMPDIR: TMP },
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
  // Cleanup is best effort and must never change the verdict: a sandbox that
  // refuses a bulk delete is a property of the machine, not of the product.
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch (err) {
    console.log(`  (cleanup left ${SANDBOX}: ${(err as Error).message.split('\n')[0]})`);
  }
  for (const d of [HOME, TMP]) mkdirSync(d, { recursive: true });

  // ---- 1. the CLI sees the built-ins, and none of the example-only ones ----
  const before = cli(['lang', 'ls', '--home', HOME]);
  check('nlg lang ls answers', before.code === 0 && /python/.test(before.out), (before.out.split('\n')[1] ?? '').trim());
  const fresh = CASES.filter((c) => c.id !== 'java'); // java is builtin now
  check('none of the example-only languages is installed yet', !fresh.some((c) => new RegExp(`^${c.id}\\s`, 'm').test(before.out)));

  // ---- 2. install the three example-only plugins; java ships builtin ----
  for (const c of fresh) {
    const add = cli(['lang', 'add', c.dir, '--home', HOME]);
    check(`nlg lang add ${c.id}`, add.code === 0 && new RegExp(`added ${c.id}@1\\.0\\.0`).test(add.out),
      (add.out.split('\n')[0] ?? '').trim());
  }
  const after = cli(['lang', 'ls', '--home', HOME]);
  for (const c of fresh) {
    const row = after.out.split('\n').find((l) => new RegExp(`^${c.id}\\s`).test(l)) ?? '';
    check(`${c.id} is listed in the user layer`, /user/.test(row) && /yes/.test(row), row.trim());
  }
  const javaRow = after.out.split('\n').find((l) => /^java\s/.test(l)) ?? '';
  check('java is listed in the builtin layer', /builtin/.test(javaRow) && /yes/.test(javaRow), javaRow.trim());

  // ---- 3. the app treats each as a first-class language ----
  const logs: string[] = [];
  const child = spawn(EXE, ['--no-open'], {
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
    },
  });
  child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));

  let client: RawWsClient | undefined;
  try {
    if (!(await waitHealth())) {
      console.log(logs.join('').slice(-2000));
      throw new Error('the exe never answered /health');
    }
    client = new RawWsClient(PORT);
    await client.ready;

    const ask = async (kind: string, payload: Record<string, unknown>, frame: string, ms = 60_000) => {
      client!.clearReceived();
      client!.send({ kind, ...payload });
      return (await client!.waitFor(frame, ms)) as Record<string, unknown> | undefined;
    };
    /**
     * Ask until the answer is non-empty.
     *
     * rust-analyzer answers `[]` in 1 ms while it is still loading the crate,
     * then 138 items once it is ready — the request is fine, the server is not.
     * A user who types straight after opening a Rust file waits the same way, so
     * the suite waits too instead of calling it a failure.
     */
    const askUntil = async (
      kind: string,
      payload: Record<string, unknown>,
      frame: string,
      hasAnswer: (f: Record<string, unknown>) => boolean,
      budgetMs = 150_000,
    ): Promise<Record<string, unknown> | undefined> => {
      const deadline = Date.now() + budgetMs;
      let last: Record<string, unknown> | undefined;
      for (;;) {
        last = await ask(kind, payload, frame, 60_000);
        if (last && hasAnswer(last)) return last;
        if (Date.now() > deadline) return last;
        await new Promise((ok) => setTimeout(ok, 5000));
      }
    };

    client.clearReceived();
    client.send({ kind: 'status' });
    const ws = await client.waitFor('workspace', 20_000);
    const langs = (ws?.languages ?? []) as Array<{ id: string; fileName?: string; runMode?: string }>;
    check('the workspace lists every language', langs.length === 5 + fresh.length,
      langs.map((l) => l.id).join(','));

    for (const c of CASES) {
      const slot = langs.find((l) => l.id === c.id);
      check(`${c.id}: slot with its own buffer name`, slot?.fileName === c.fileName, String(slot?.fileName ?? 'none'));
      check(`${c.id}: runs through the template runtime`, slot?.runMode === 'template', String(slot?.runMode ?? 'none'));

      const run = await ask('run', { language: c.id, code: c.code, sessionId: c.id }, 'runResult', 240_000);
      const noToolchain = /missing|not found|no .* available/i.test(`${run?.stderr ?? ''}${run?.error ?? ''}`);
      if (noToolchain) {
        skip(`${c.id}: compiles and runs`, 'no toolchain for this language on this machine');
      } else {
        check(`${c.id}: compiles and runs`, run?.exitCode === 0 && String(run?.stdout ?? '').includes(c.expect),
          `exit=${String(run?.exitCode)} out=${JSON.stringify(String(run?.stdout ?? '').trim().slice(0, 40))}`);
      }

      // Test mode: the engine has accepted `mode:'test'` for a long time; what
      // the toolbar button adds is a way to ask for it. Rust compiles its test
      // harness from the same file, so this is the cheapest real proof.
      client!.clearReceived();
      client!.send({ kind: 'run', language: c.id, code: c.code, sessionId: c.id + '-test', mode: 'test' });
      const test = (await client!.waitFor('runResult', 240_000)) as Record<string, unknown> | undefined;
      if (/missing|not found|no .* available/i.test(`${test?.stderr ?? ''}${test?.error ?? ''}`)) {
        skip(`${c.id}: test mode runs`, 'no toolchain on this machine');
      } else {
        check(`${c.id}: test mode runs`, test?.exitCode === 0,
          `exit=${String(test?.exitCode)} lang=${String(test?.language)} bin=${String(test?.binary)}`);
      }

      if (c.navigates) {
        // rust-analyzer is the only one of the four that is installed here, so it
        // is also the only one where "the server answered" is the expected state.
        const comp = await askUntil('complete', {
          language: c.id,
          code: c.completeSrc ?? c.code,
          line: c.completeAt?.line ?? 5,
          character: c.completeAt?.character ?? 20,
          requestId: 1,
        }, 'completion', (f) => ((f.items ?? []) as unknown[]).length > 0);
        check(`${c.id}: the language server started`, !comp?.unsupported, String(comp?.unsupported ?? 'ok'));
        check(`${c.id}: completion answers from the server`, ((comp?.items ?? []) as unknown[]).length > 0,
          `${((comp?.items ?? []) as unknown[]).length} item(s): ` +
            JSON.stringify(((comp?.items ?? []) as Array<{ label: string }>).slice(0, 4).map((i) => i.label)));
        const def = await askUntil('definition', { language: c.id, code: c.code, line: 5, character: 25, requestId: 2 }, 'definitionResult',
          (f) => ((f.locations ?? []) as unknown[]).length > 0);
        const locs = (def?.locations ?? []) as Array<{ line: number }>;
        check(`${c.id}: definition jumps to the declaration`, locs.length > 0 && locs[0].line === 0,
          JSON.stringify(locs.slice(0, 1)) + (def?.unsupported ? ` ${String(def.unsupported)}` : ''));
      } else {
        const diag = await ask('check', { language: c.id, code: c.code }, 'diagnostics', 30_000);
        check(`${c.id}: diagnostics name the missing server`,
          diag?.fromLsp === false && new RegExp(c.server).test(String(diag?.note ?? '')),
          String(diag?.note ?? 'none'));
        const def = await ask('definition', { language: c.id, code: c.code, line: 5, character: 20, requestId: 3 }, 'definitionResult', 30_000);
        check(`${c.id}: navigation names the missing server`, new RegExp(c.server).test(String(def?.unsupported ?? '')),
          String(def?.unsupported ?? 'none'));
      }

      const deps = await ask('dependencyReport', { language: c.id, code: c.code }, 'dependencies', 20_000);
      check(`${c.id}: no dependency block is reported as such`,
        deps?.supported === false && /manifest\.dependencies/.test(String(deps?.note ?? '')), String(deps?.note ?? 'none'));
    }
  } finally {
    client?.close();
    try { child.kill(); } catch { /* gone */ }
    await new Promise((ok) => setTimeout(ok, 600));
  }

  // ---- 4. the CLI can turn them off again ----
  const off = cli(['lang', 'disable', 'rust', '--home', HOME]);
  check('nlg lang disable flips the flag', off.code === 0, (off.out.split('\n')[0] ?? '').trim());
  const disabled = cli(['lang', 'ls', '--home', HOME]);
  const offRow = disabled.out.split('\n').find((l) => /^rust\s/.test(l)) ?? '';
  check('the listing shows it off', /\boff\b/.test(offRow), offRow.trim());

  const gone = cli(['lang', 'uninstall', 'rust', '--home', HOME]);
  if (/could not remove/.test(gone.out)) {
    // A sandbox or a file lock can refuse a recursive delete. That is the
    // environment, not the product — but the product must *say so* instead of
    // printing "uninstalled" over a directory that is still there.
    check('a refused removal is reported, not hidden', gone.code !== 0, (gone.out.split('\n')[0] ?? '').slice(0, 80));
    skip('nlg lang uninstall removes the body', 'the filesystem refused the delete');
  } else {
    check('nlg lang uninstall removes the body', gone.code === 0 && /removed rust@1\.0\.0/.test(gone.out),
      (gone.out.split('\n')[0] ?? '').trim());
    check('the listing no longer has it', !/^rust\s/m.test(cli(['lang', 'ls', '--home', HOME]).out));
  }

  // Cleanup is best effort and must never change the verdict: a sandbox that
  // refuses a bulk delete is a property of the machine, not of the product. This
  // suite printed its whole result and then exited 1 on the last line.
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch (err) {
    console.log(`  (cleanup left ${SANDBOX}: ${(err as Error).message.split('\n')[0]})`);
  }

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
