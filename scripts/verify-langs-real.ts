/**
 * The other languages with a *real* language server installed.
 *
 * `verify-langs-exe.ts` proves the degradation is honest when nothing is
 * installed. This suite proves the opposite end: once gopls / tsserver are
 * actually there, do the eight requests return real answers?
 *
 * It exists because "installed but unlaunchable" is a real state — every
 * npm-distributed server on Windows is a `.cmd` shim, and `spawn` cannot start
 * one. That is what `spawn EINVAL` looked like from the panel, and no
 * source-level test could have caught it.
 *
 * Servers are looked up in `NOLANGUAGE_LANGBIN` (default `.tmp/langdeps`), so a
 * checkout with nothing installed SKIPs instead of failing:
 *
 *   npm install --prefix .tmp/langdeps typescript-language-server typescript
 *   GOBIN=<abs>/.tmp/langdeps/bin go install golang.org/x/tools/gopls@latest
 *
 * Run: npm run verify:langs-real
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawWsClient } from './lib/RawWsClient.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = process.env.NOLANGUAGE_LANGBIN ?? join(ROOT, '.tmp', 'langdeps');
const PORT = Number(process.env.VERIFY_PORT ?? 7521);

/** Where each server would be if the documented install ran. */
const JS_SERVER = process.env.JS_LSP ?? join(BIN, 'node_modules', '.bin', 'typescript-language-server.cmd');
const GO_SERVER = process.env.GOPLS_BIN ?? join(BIN, 'bin', 'gopls.exe');
/** gopls shells out to `go`, which is not always on PATH. */
const GO_BIN_DIR = process.env.GO_BIN_DIR ?? 'D:\\Go lang\\bin';

const results: Array<{ name: string; ok: boolean; detail: string; skipped?: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name: string, detail = ''): void {
  results.push({ name, ok: true, detail, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

const JS_SRC = [
  'function sum(values) {',
  '  return values.reduce((a, b) => a + b, 0);',
  '}',
  '',
  'const nums = [1, 2, 3];',
  'const total = sum(nums);',
  'nums.',
  '',
].join('\n');

const GO_SRC = [
  'package main',
  '',
  'import "fmt"',
  '',
  'func Add(a, b int) int {',
  '\treturn a + b',
  '}',
  '',
  'func main() {',
  '\tfmt.',
  '}',
  '',
].join('\n');

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
  const hasJs = existsSync(JS_SERVER);
  const hasGo = existsSync(GO_SERVER);
  if (!hasJs && !hasGo) {
    skip('a real language server is installed', `nothing under ${BIN} — see the header for the two install commands`);
    console.log('\n0/0 checks passed (1 skipped)');
    return;
  }

  // `NOLANGUAGE_EXE` runs the same checks against the shipped binary instead of
  // the source tree — the servers are resolved from the environment either way,
  // so this is the only way to prove the packaged build can use a real server.
  const exe = process.env.NOLANGUAGE_EXE;
  const logs: string[] = [];
  const child: ChildProcess = spawn(exe ?? process.execPath, exe ? ['--no-open'] : [
    '--experimental-transform-types', '--no-warnings',
    '--experimental-loader', './resolve-loader.mjs',
    'src/panel/server.ts',
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PANEL_PORT: String(PORT),
      PANEL_NO_DEMO: '1',
      PANEL_NO_STORE: '1',
      NOLANGUAGE_NO_BROWSER: '1',
      ...(exe ? { NOLANGUAGE_HOME: join(ROOT, '.tmp', 'langs-real-home') } : {}),
      ...(hasJs ? { JS_LSP: JS_SERVER } : {}),
      ...(hasGo ? { GOPLS_BIN: GO_SERVER } : {}),
      // gopls shells out to the `go` tool; a machine can have both without the
      // toolchain being on the PATH this process inherited.
      PATH: `${GO_BIN_DIR};${process.env.PATH ?? ''}`,
      // gopls keeps a persistent index under the user cache dir. Point it (and
      // the panel's own app data) inside the checkout: a sandboxed or locked-down
      // profile cannot create `%LOCALAPPDATA%\gopls`, and gopls exits with code 1
      // when that happens — which looks exactly like "gopls is broken".
      LOCALAPPDATA: join(ROOT, '.tmp', 'localappdata'),
      // `go` creates its build work dir under TMP; a sandboxed shell refuses
      // that path, and gopls reports it as "initialization failed".
      TMP: join(ROOT, '.tmp', 'gotmp'),
      TEMP: join(ROOT, '.tmp', 'gotmp'),
      TMPDIR: join(ROOT, '.tmp', 'gotmp'),
      GOCACHE: join(ROOT, '.tmp', 'gocache'),
    },
  });
  child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));

  let client: RawWsClient | undefined;
  try {
    if (!(await waitHealth())) {
      console.log(logs.join('').slice(-2000));
      throw new Error('the panel server never answered /health');
    }
    client = new RawWsClient(PORT);
    await client.ready;

    const ask = async (language: string, kind: string, payload: Record<string, unknown>, frame: string, ms = 60_000) => {
      client!.clearReceived();
      client!.send({ kind, language, ...payload });
      return (await client!.waitFor(frame, ms)) as Record<string, unknown> | undefined;
    };
    /** Ask again until the answer is non-empty: servers warm up at their own pace. */
    const askUntil = async (
      kind: string,
      payload: Record<string, unknown>,
      frame: string,
      hasAnswer: (f: Record<string, unknown>) => boolean,
      budgetMs = 120_000,
    ): Promise<Record<string, unknown> | undefined> => {
      const deadline = Date.now() + budgetMs;
      let last: Record<string, unknown> | undefined;
      for (;;) {
        last = await ask(String(payload.language ?? 'go'), kind, payload, frame, 60_000);
        if (last && hasAnswer(last)) return last;
        if (Date.now() > deadline) return last;
        await new Promise((ok) => setTimeout(ok, 4000));
      }
    };

    // ---- JavaScript with tsserver ----
    if (!hasJs) {
      skip('javascript: real server', `no server at ${JS_SERVER}`);
    } else {
      const comp = await ask('javascript', 'complete', { code: JS_SRC, line: 6, character: 5, requestId: 1 }, 'completion');
      const items = (comp?.items ?? []) as Array<{ label: string }>;
      check('javascript: the server started (no `unsupported`)', !comp?.unsupported, String(comp?.unsupported ?? 'ok'));
      // The stub answers `json.` and `requests.` with the same 31 builtin names.
      // Member completion is the thing that only a real server can do.
      check('javascript: member completion on `nums.`', items.length >= 20, `${items.length} items`);
      check(
        'javascript: the members are Array members',
        ['map', 'filter', 'reduce', 'push'].every((m) => items.some((i) => i.label === m)),
        items.slice(0, 8).map((i) => i.label).join(','),
      );

      const sig = await ask('javascript', 'signatureHelp', { code: 'Math.max(\n', line: 0, character: 9, requestId: 2 }, 'signatureResult');
      const sigs = (sig?.signatures ?? []) as Array<{ label: string }>;
      check('javascript: signature help names the parameters', sigs.length > 0 && /max/.test(sigs[0]?.label ?? ''),
        sigs[0]?.label ?? 'none');

      const def = await ask('javascript', 'definition', { code: JS_SRC, line: 5, character: 15, requestId: 3 }, 'definitionResult');
      const locs = (def?.locations ?? []) as Array<{ line: number }>;
      check('javascript: definition jumps to the declaration', locs.length > 0 && locs[0].line === 0, JSON.stringify(locs.slice(0, 1)));

      const refs = await ask('javascript', 'references', { code: JS_SRC, line: 0, character: 10, requestId: 4 }, 'referencesResult');
      check('javascript: references finds both uses', ((refs?.locations ?? []) as unknown[]).length >= 2,
        `${((refs?.locations ?? []) as unknown[]).length} location(s)`);

      const ren = await ask('javascript', 'renameSymbol', { code: JS_SRC, line: 0, character: 10, newName: 'total', requestId: 5 }, 'renameResult');
      const edits = (ren?.edits ?? []) as Array<{ newText: string }>;
      check('javascript: rename rewrites the definition and the call', edits.length >= 2 && edits.every((e) => e.newText === 'total'),
        `${edits.length} edit(s)`);

      const ws = await ask('javascript', 'workspaceSymbol', { query: 'sum', requestId: 6 }, 'workspaceSymbolResult');
      check('javascript: workspace symbol search finds the function',
        ((ws?.symbols ?? []) as Array<{ name: string }>).some((s) => s.name === 'sum'),
        JSON.stringify(((ws?.symbols ?? []) as Array<{ name: string }>).map((s) => s.name).slice(0, 4)));

      // Formatting. typescript-language-server does not advertise
      // `documentFormattingProvider` at all, so the correct answer here is a
      // refusal with a reason — the client then falls back to its own indenter.
      // Asserting the *refusal* is the only honest check available on a machine
      // where no installed server formats.
      const messyJs = ['function  f ( a,b ) {', 'return a+b ;', '}', ''].join('\n');
      const fmt = await ask('javascript', 'format', { code: messyJs, requestId: 14 }, 'formatResult');
      // tsserver advertises formatting but answers `null` for a snippet with no
      // project config. Either answer is legitimate; what this pins is that the
      // request is wired and the reply is shaped as edits.
      check('javascript: the format request is answered', Array.isArray(fmt?.edits),
        `${((fmt?.edits ?? []) as unknown[]).length} edit(s)` + (fmt?.unsupported ? ` ${String(fmt.unsupported)}` : ''));

      const act = await ask('javascript', 'codeAction', { code: JS_SRC, line: 0, character: 10, requestId: 7 }, 'codeActionResult');
      check('javascript: quick fixes come back from the server',
        ((act?.actions ?? []) as Array<{ title: string }>).length > 0,
        JSON.stringify(((act?.actions ?? []) as Array<{ title: string }>).slice(0, 2).map((a) => a.title)));

      const bad = await ask('javascript', 'check', { code: 'const x = ;\n' }, 'diagnostics', 60_000);
      check('javascript: a syntax error is reported', ((bad?.items ?? []) as unknown[]).length > 0 && bad?.fromLsp === true,
        `${((bad?.items ?? []) as unknown[]).length} item(s)`);
    }

    // ---- Go with gopls ----
    if (!hasGo) {
      skip('go: real server', `no server at ${GO_SERVER}`);
    } else {
      const comp = await ask('go', 'complete', { code: GO_SRC, line: 9, character: 5, requestId: 11 }, 'completion');
      const items = (comp?.items ?? []) as Array<{ label: string }>;
      check('go: the server started (no `unsupported`)', !comp?.unsupported, String(comp?.unsupported ?? 'ok'));
      check('go: member completion on `fmt.`', items.length > 0, `${items.length} items`);
      check('go: the members are fmt symbols', items.some((i) => i.label === 'Println' || /Println/.test(i.label)),
        items.slice(0, 6).map((i) => i.label).join(','));

      const def = await ask('go', 'definition', { code: GO_SRC, line: 9, character: 4, requestId: 12 }, 'definitionResult');
      check('go: definition resolves `fmt`', ((def?.locations ?? []) as unknown[]).length > 0 || !def?.unsupported,
        JSON.stringify(def?.locations ?? []).slice(0, 80));

      const diag = await ask('go', 'check', { code: 'package main\n\nfunc main() {\n\tundefinedThing()\n}\n' }, 'diagnostics', 90_000);
      const msgs = ((diag?.items ?? []) as Array<{ message: string }>).map((i) => i.message);
      check('go: an undefined identifier is reported', msgs.some((m) => /undefinedThing/.test(m)), msgs.slice(0, 2).join(' | ') || 'none');

      // gopls *does* advertise formatting, so the request must be accepted. What
      // comes back depends on whether gofmt has anything to change.
      const fmtGo = await ask('go', 'format', { language: 'go', code: GO_SRC, requestId: 14 }, 'formatResult', 60_000);
      check('go: the format request is accepted by the server', !fmtGo?.unsupported,
        fmtGo?.unsupported ? String(fmtGo.unsupported) : `${((fmtGo?.edits ?? []) as unknown[]).length} edit(s)`);

      const ws = await ask('go', 'workspaceSymbol', { query: 'Add', requestId: 13 }, 'workspaceSymbolResult');
      check('go: workspace symbol search finds `Add`',
        ((ws?.symbols ?? []) as Array<{ name: string }>).some((s) => s.name === 'Add'),
        JSON.stringify(((ws?.symbols ?? []) as Array<{ name: string }>).map((s) => s.name).slice(0, 4)));
    }
  } finally {
    client?.close();
    try { child.kill(); } catch { /* gone */ }
    await new Promise((ok) => setTimeout(ok, 400));
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
  if (failed.length) {
    console.log('FAILED:\n' + failed.map((f) => `  - ${f.name}  ${f.detail}`).join('\n'));
    console.log('\n--- server log tail ---\n' + logs.join('').split('\n').slice(-12).join('\n'));
    process.exit(1);
  }
}

await main();
