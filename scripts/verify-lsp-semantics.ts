/**
 * What each server actually says, for one fixed fixture per language.
 *
 * The startup numbers say a server answered; these say it answered *correctly*.
 * Each target makes three claims, and every claim names a specific string rather
 * than "not empty":
 *
 *   completion contains a member that must be there (`fmt.` → `Println`)
 *   hover contains a type signature (`List<String> names`)
 *   diagnostics contain the server's own wording for a real error
 *
 * Servers are resolved the way the product resolves them: the managed root
 * (`<home>/servers/<id>`) first, then PATH. Installing a server therefore makes
 * the baseline thicker without touching this file; a missing one SKIPs.
 *
 * `expect` is a list because two backends can serve the same language: python is
 * pyright when it is installed and the bundled stub when it is not, and they word
 * the same fact differently. A list keeps the assertion specific to each.
 *
 * Run: npm run verify:lsp-semantics
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Kernel } from '../src/kernel/Kernel.js';
import type { LanguageManifest } from '../src/langs/manifest.js';
import { LspClient, fileUri } from '../src/lsp/LspClient.js';
import { hoverText, launchFor, targets } from './lib/lspProbe.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Per-process: these suites build a jdtls workspace with thousands of files,
// and a shared directory makes the start-up `rmSync` hit the sandbox's
// bulk-delete guard — which surfaces as a suite that dies before its first
// check (0/0) when it runs after the others.
const SANDBOX = join(ROOT, '.tmp', 'lsp-semantics', String(process.pid));
/** The product's own home, so a `nlg lang server install` is picked up here. */
const HOME = process.env.NOLANGUAGE_HOME ?? join(homedir(), '.nolanguage');

process.env.JDTLS = process.env.JDTLS ?? join(ROOT, '.tmp', 'langdeps', 'jdtls', 'bin', 'jdtls.bat');
process.env.LOCALAPPDATA = join(SANDBOX, 'appdata');
process.env.GOCACHE = join(SANDBOX, 'gocache');
process.env.TMP = join(SANDBOX, 'tmp');
process.env.TEMP = process.env.TMP;
process.env.TMPDIR = process.env.TMP;

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

const hit = (text: string, expect: string[]): boolean => expect.some((e) => text.includes(e));

const kernel = new Kernel({ appVersion: 'verify-semantics', logSilent: true });
await kernel.start();
rmSync(SANDBOX, { recursive: true, force: true });
for (const d of [SANDBOX, process.env.LOCALAPPDATA!, process.env.GOCACHE!, process.env.TMP!]) {
  mkdirSync(d, { recursive: true });
}

for (const t of targets) {
  const manifest = JSON.parse(readFileSync(t.manifest, 'utf8')) as LanguageManifest;
  const root = join(SANDBOX, t.id);
  for (const [rel, text] of Object.entries(t.files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }

  const probe = await launchFor(manifest, root, HOME);
  const { launch } = probe;
  if (!launch) {
    const why = probe.source.startsWith('unusable/')
      ? 'was found but could not run its version probe'
      : 'is not installed';
    skip(`${t.id}: semantic baseline`, `${manifest.lsp?.serverName ?? t.id} ${why}`);
    continue;
  }

  const client = new LspClient({ launch, timeoutMs: 120_000 });
  const uriOf = (rel: string): string => pathToFileURL(join(root, rel)).href;
  try {
    await client.start(kernel, fileUri(root));
    const uri = uriOf(t.complete.file);
    await client.openDocument(uri, t.files[t.complete.file], launch.languageId);

    // ---- completion ----
    // Labels are trimmed: clangd prefixes its snippets with a space, and ` x`
    // would make an `includes('x')` assertion pass for the wrong reason.
    let labels: string[] = [];
    const deadline = Date.now() + 90_000;
    for (;;) {
      labels = (await client.completion(uri, { line: t.complete.line, character: t.complete.character })).map((i) =>
        i.label.trim(),
      );
      if (labels.some((l) => hit(l, t.complete.expect)) || Date.now() > deadline) break;
      await sleep(1000);
    }
    check(
      `${t.id}: completion offers ${t.complete.expect.join(' | ')}`,
      labels.some((l) => hit(l, t.complete.expect)),
      `${labels.length} item(s): ${labels.slice(0, 6).join(', ')}`,
    );

    // ---- hover ----
    if (t.hover) {
      const text = hoverText(await client.hover(uriOf(t.hover.file), { line: t.hover.line, character: t.hover.character }));
      check(`${t.id}: hover states the type`, hit(text, t.hover.expect), text.replace(/\s+/g, ' ').slice(0, 90) || 'empty');
    } else {
      skip(`${t.id}: hover states the type`, `${launch.serverName} has no hover for this position`);
    }

    // ---- diagnostics ----
    const brokenUri = uriOf(t.broken.file);
    client.changeDocument(brokenUri, t.broken.text, launch.languageId);
    let messages = (await client.waitForDiagnostics(brokenUri, 20_000)).items.map((d) => d.message);
    if (!hit(messages.join('\n'), t.broken.expect)) {
      // Push-model servers may need a second nudge after the first wait.
      client.changeDocument(brokenUri, t.broken.text, launch.languageId);
      messages = [...messages, ...(await client.waitForDiagnostics(brokenUri, 20_000)).items.map((d) => d.message)];
    }
    check(
      `${t.id}: diagnostics mention ${t.broken.expect.join(' | ')}`,
      hit(messages.join('\n'), t.broken.expect),
      messages.map((m) => m.slice(0, 60)).join(' | ') || 'no diagnostics',
    );
  } catch (err) {
    check(`${t.id}: semantic baseline`, false, (err as Error).message.slice(0, 120));
  } finally {
    await client.stop().catch(() => undefined);
    await sleep(600);
  }
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
if (failed.length) console.log('FAILED:');
for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
try {
  rmSync(SANDBOX, { recursive: true, force: true });
} catch {
  /* a JVM may still hold a handle */
}
process.exitCode = failed.length ? 1 : 0;
