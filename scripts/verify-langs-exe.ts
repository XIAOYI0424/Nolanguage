/**
 * The other three languages, in the packaged binary.
 *
 * Python is covered everywhere (it has a bundled language server). Go,
 * JavaScript and Markdown are not — and on a machine with no gopls, no
 * tsserver and no marksman they have *no* intelligence at all. That is the
 * state this suite exists to pin down: **does each language degrade honestly?**
 *
 * A request that cannot be served must come back with a reason, never with an
 * empty list. "No server installed" and "no matches" look identical in the UI,
 * and only one of them is worth acting on. `complete` used to be the exception —
 * it answered `items: []` with no explanation — which is exactly the kind of
 * inconsistency that only a cross-language sweep finds.
 *
 * Run: npm run verify:langs-exe
 * Skipped when the exe has not been built.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawWsClient } from './lib/RawWsClient.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXE = process.env.NOLANGUAGE_EXE ?? join(ROOT, 'dist', 'Nolanguage.exe');
const SANDBOX = join(ROOT, '.tmp', 'verify-langs-exe');
const PROJECT = join(SANDBOX, 'project');
const HOME = join(SANDBOX, 'home');
const TMP = join(SANDBOX, 'tmp');
const PORT = 7816;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const CODE: Record<string, string> = {
  go: 'package main\n\nimport "fmt"\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n\nfunc main() {\n\tfmt.Println(add(1, 2))\n}\n',
  javascript: 'const nums = [1, 2, 3];\nfunction sum(v) {\n  return v.reduce((a, b) => a + b, 0);\n}\nconsole.log(sum(nums));\n',
  markdown: '# Title\n\nSome **bold** text and a [link](https://example.com).\n\n## Sub\n\n- item\n',
};

/** The eight requests that only a language server can answer. */
const LSP_REQUESTS: Array<{ kind: string; frame: string; payload: (code: string) => Record<string, unknown> }> = [
  { kind: 'complete', frame: 'completion', payload: (code) => ({ code, line: 1, character: 1, requestId: 1 }) },
  { kind: 'signatureHelp', frame: 'signatureResult', payload: (code) => ({ code, line: 1, character: 1, requestId: 2 }) },
  { kind: 'completionResolve', frame: 'completionItemDetail', payload: () => ({ label: 'print', requestId: 3 }) },
  { kind: 'definition', frame: 'definitionResult', payload: (code) => ({ code, line: 8, character: 14, requestId: 4 }) },
  { kind: 'references', frame: 'referencesResult', payload: (code) => ({ code, line: 5, character: 6, requestId: 5 }) },
  { kind: 'renameSymbol', frame: 'renameResult', payload: (code) => ({ code, line: 5, character: 6, newName: 'plus', requestId: 6 }) },
  { kind: 'codeAction', frame: 'codeActionResult', payload: (code) => ({ code, line: 5, character: 6, requestId: 7 }) },
  { kind: 'workspaceSymbol', frame: 'workspaceSymbolResult', payload: () => ({ query: 'add', requestId: 8 }) },
];

async function waitHealth(): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
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
  for (const d of [PROJECT, HOME, TMP]) mkdirSync(d, { recursive: true });
  writeFileSync(join(PROJECT, 'go.mod'), 'module demo\n\ngo 1.22\n\nrequire github.com/spf13/cobra v1.8.0\n');
  writeFileSync(join(PROJECT, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }, null, 2));
  writeFileSync(join(PROJECT, 'requirements.txt'), 'requests==2.31.0\n');

  const logs: string[] = [];
  const child: ChildProcess = spawn(EXE, ['--no-open'], {
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

  let client: RawWsClient | undefined;
  try {
    if (!(await waitHealth())) {
      console.log(logs.join('').slice(-2000));
      throw new Error('the packaged exe never answered /health');
    }
    client = new RawWsClient(PORT);
    await client.ready;

    const ask = async (kind: string, payload: Record<string, unknown>, frame: string, ms = 20_000): Promise<Record<string, unknown> | undefined> => {
      client!.clearReceived();
      client!.send({ kind, ...payload });
      return (await client!.waitFor(frame, ms)) as Record<string, unknown> | undefined;
    };

    // ---- each language answers for itself ----
    for (const lang of ['go', 'javascript', 'markdown']) {
      const code = CODE[lang];
      // Every request must name its language: a missing `language` does not
      // fail, it silently answers for the default one (python).
      const askLang = (kind: string, payload: Record<string, unknown>, frame: string, ms?: number) =>
        ask(kind, { language: lang, ...payload }, frame, ms);

      // Dependency reading is per-format, and this is the only place all three
      // non-Python formats are exercised against the shipped binary.
      const deps = await askLang('dependencyReport', { code }, 'dependencies');
      if (lang === 'markdown') {
        check('markdown declares no dependency file', deps?.supported === false && /manifest\.dependencies/.test(String(deps?.note ?? '')),
          String(deps?.note ?? ''));
      } else {
        const want = lang === 'go' ? 'go.mod' : 'package.json';
        check(`${lang} reads ${want}`, deps?.file === want && deps?.supported === true, String(deps?.file ?? 'none'));
        check(`${lang} lists the declared packages`, ((deps?.packages ?? []) as unknown[]).length > 0,
          JSON.stringify((deps?.packages ?? []) as unknown[]).slice(0, 60));
      }

      // Every LSP-backed request must name its reason rather than answer empty.
      let named = 0;
      const silent: string[] = [];
      for (const req of LSP_REQUESTS) {
        const frame = await askLang(req.kind, req.payload(code), req.frame);
        if (typeof frame?.unsupported === 'string' && frame.unsupported) named++;
        else silent.push(`${req.kind}(${frame ? JSON.stringify(frame).slice(0, 60) : 'no-frame'})`);
      }
      check(`${lang}: all 8 language-server requests explain themselves`, silent.length === 0,
        silent.length ? `silent: ${silent.join(', ')}` : '8 of 8 carry a reason');

      // ...and the reason is the plugin's own wording, not a generic string.
      const sig = await askLang('signatureHelp', { code, line: 1, character: 1, requestId: 9 }, 'signatureResult');
      check(`${lang}: the reason names what to install`, /not installed/.test(String(sig?.unsupported ?? '')),
        String(sig?.unsupported ?? 'none'));
    }

    // ---- running still works, which is the whole point of the degradation ----
    const goRun = await ask('run', { language: 'go', code: CODE.go, sessionId: 'v-go' }, 'runResult', 90_000);
    check('go still runs without gopls', goRun?.exitCode === 0 && /3/.test(String(goRun?.stdout ?? '')),
      `exit=${String(goRun?.exitCode)} out=${JSON.stringify(String(goRun?.stdout ?? '').trim())}`);

    const jsRun = await ask('run', { language: 'javascript', code: CODE.javascript, sessionId: 'v-js' }, 'runResult', 30_000);
    check('javascript still runs without tsserver', jsRun?.exitCode === 0 && /6/.test(String(jsRun?.stdout ?? '')),
      `exit=${String(jsRun?.exitCode)} out=${JSON.stringify(String(jsRun?.stdout ?? '').trim())}`);

    // A render-only language must say so instead of pretending to have a runtime.
    const mdRun = await ask('run', { language: 'markdown', code: CODE.markdown, sessionId: 'v-md' }, 'error', 15_000);
    check('markdown refuses to run, with a reason', /nothing to run|documents render/.test(String(mdRun?.message ?? '')),
      String(mdRun?.message ?? 'no frame'));

    // ---- Markdown's own pipeline still works with no server ----
    const md = await ask('mdRender', { language: 'markdown', code: CODE.markdown }, 'mdPreview');
    check('markdown renders without marksman', md?.ok === true && /<h1/.test(String(md?.html ?? '')),
      String(md?.html ?? '').slice(0, 40));
    check('the outline is built from the headings', ((md?.headings ?? []) as unknown[]).length === 2,
      JSON.stringify((md?.headings ?? []) as Array<{ text?: string }>).slice(0, 60));
  } finally {
    client?.close();
    try { child.kill(); } catch { /* gone */ }
    await new Promise((ok) => setTimeout(ok, 400));
    rmSync(SANDBOX, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
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
