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
import { buildManagerPlugin } from '../src/langs/managerPlugins.js';
import { discoverBinary } from '../src/langs/discover.js';
import type { LanguageManifest } from '../src/langs/manifest.js';
import { resolveServer } from '../src/langs/serverInstall.js';
import { toolchainEnv } from '../src/langs/toolchainEnv.js';
import { resolveBundledFallback } from '../src/lsp/bundledFallback.js';
import { LspClient, fileUri, type LspLaunchSpec } from '../src/lsp/LspClient.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX = join(ROOT, '.tmp', 'lsp-semantics');
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

interface Probe {
  file: string;
  line: number;
  character: number;
  /** Any one of these must appear. */
  expect: string[];
}

interface Target {
  id: string;
  manifest: string;
  files: Record<string, string>;
  complete: Probe;
  /** Omitted when the server has nothing to say at that position. */
  hover?: Probe;
  broken: { file: string; text: string; expect: string[] };
}

const targets: Target[] = [
  {
    id: 'python',
    manifest: 'builtin/python@1.0.0/manifest.json',
    files: { 'main.py': 'print("x")\n' },
    // `pri|nt` completes; `pr|int` hovers. pyright says "(function) def print",
    // the bundled stub says "builtin" — both are specific, so both are accepted.
    complete: { file: 'main.py', line: 0, character: 3, expect: ['print'] },
    hover: { file: 'main.py', line: 0, character: 2, expect: ['builtin', '(function) def print'] },
    broken: { file: 'main.py', text: 'def broken(:\n    pass\n', expect: ['SyntaxError', 'Expected parameter name'] },
  },
  {
    id: 'go',
    manifest: 'builtin/go@1.0.0/manifest.json',
    files: {
      'go.mod': 'module demo\n\ngo 1.21\n',
      'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n\tfmt.\n}\n',
    },
    complete: { file: 'main.go', line: 6, character: 5, expect: ['Println'] },
    hover: { file: 'main.go', line: 5, character: 6, expect: ['func fmt.Println'] },
    broken: { file: 'main.go', text: 'package main\n\nfunc main() {\n\tundefinedThing()\n}\n', expect: ['undefined'] },
  },
  {
    id: 'javascript',
    manifest: 'builtin/javascript@1.0.0/manifest.json',
    files: { 'package.json': '{"name":"demo"}\n', 'main.js': 'const nums = [1, 2, 3];\nnums.\n' },
    complete: { file: 'main.js', line: 1, character: 5, expect: ['filter'] },
    hover: { file: 'main.js', line: 0, character: 7, expect: ['number[]'] },
    broken: { file: 'main.js', text: 'const x = ;\n', expect: ['expected'] },
  },
  {
    id: 'markdown',
    manifest: 'builtin/markdown@1.0.0/manifest.json',
    files: {
      'README.md': '# Demo\n\nLink to [](other.md).\n',
      'other.md': '# Other\n\nText.\n',
      '.marksman.toml': '',
    },
    // marksman completes link targets inside `](`, and reports a link whose
    // target does not exist. It has no hover for links, so that probe is omitted.
    complete: { file: 'README.md', line: 2, character: 12, expect: ['other.md'] },
    broken: { file: 'README.md', text: '# Demo\n\nSee [gone](./nope.md).\n', expect: ['non-existent document'] },
  },
  {
    id: 'rust',
    manifest: 'examples/rust@1.0.0/manifest.json',
    files: {
      'Cargo.toml': '[package]\nname = "demo"\nversion = "0.0.0"\nedition = "2021"\n\n[[bin]]\nname = "demo"\npath = "main.rs"\n',
      'main.rs': 'fn main() {\n    let s = String::new();\n    s.\n}\n',
    },
    complete: { file: 'main.rs', line: 2, character: 6, expect: ['as_bytes'] },
    hover: { file: 'main.rs', line: 1, character: 9, expect: ['String'] },
    broken: { file: 'main.rs', text: 'fn main() {\n    let x: i32 = "s";\n}\n', expect: ['mismatched'] },
  },
  {
    id: 'c',
    manifest: 'examples/c@1.0.0/manifest.json',
    files: { 'main.c': 'struct P { int x; int y; };\n\nint main(void) {\n    struct P p;\n    p.\n}\n' },
    // No `#include` on purpose: clangd without a compile database cannot find the
    // platform's libc headers, and a header error would drown the assertion.
    complete: { file: 'main.c', line: 4, character: 6, expect: ['x', 'y'] },
    hover: { file: 'main.c', line: 3, character: 14, expect: ['Type: `struct P`'] },
    broken: { file: 'main.c', text: 'int main(void) {\n    return undefined_var;\n}\n', expect: ['undeclared identifier'] },
  },
  {
    id: 'cpp',
    manifest: 'examples/cpp@1.0.0/manifest.json',
    files: { 'main.cpp': 'struct P { int x; int y; };\n\nint main() {\n    P p;\n    p.\n}\n' },
    complete: { file: 'main.cpp', line: 4, character: 6, expect: ['x', 'y'] },
    hover: { file: 'main.cpp', line: 3, character: 6, expect: ['Type: `P`'] },
    broken: { file: 'main.cpp', text: 'int main() {\n    return undefined_var;\n}\n', expect: ['undeclared identifier'] },
  },
  {
    id: 'java',
    manifest: 'examples/java@1.0.0/manifest.json',
    files: {
      'pom.xml':
        '<project><modelVersion>4.0.0</modelVersion><groupId>d</groupId><artifactId>d</artifactId><version>1.0.0</version></project>\n',
      'src/main/java/demo/App.java':
        'package demo;\n\nimport java.util.ArrayList;\nimport java.util.List;\n\npublic class App {\n    public static void main(String[] args) {\n        List<String> names = new ArrayList<>();\n        names.add("a");\n        names.\n    }\n}\n',
    },
    complete: { file: 'src/main/java/demo/App.java', line: 9, character: 14, expect: ['add('] },
    hover: { file: 'src/main/java/demo/App.java', line: 8, character: 12, expect: ['List<String>'] },
    broken: {
      file: 'src/main/java/demo/App.java',
      text: 'package demo;\n\npublic class App {\n    public static void main(String[] args) {\n        int x = undefinedThing;\n    }\n}\n',
      expect: ['cannot be resolved'],
    },
  },
];

/** The launch spec the product would build for this manifest. */
async function launchFor(manifest: LanguageManifest, root: string): Promise<LspLaunchSpec | undefined> {
  const spec = manifest.lsp;
  if (!spec) return undefined;
  const toolchain = discoverBinary(manifest.run?.discovery, { root }).bin;
  const env = toolchainEnv(toolchain);

  if (spec.manager) {
    const plugin = await buildManagerPlugin(manifest, { home: HOME, workspaceRoot: root });
    const cfg = plugin?.lspConfig(root);
    if (!cfg) return undefined;
    return {
      languageId: cfg.languageId,
      serverName: cfg.serverName,
      command: cfg.command,
      args: cfg.args,
      cwd: cfg.cwd,
      ...(cfg.env ? { env: cfg.env } : {}),
      ...(cfg.initializationOptions ? { initializationOptions: cfg.initializationOptions } : {}),
    };
  }

  const found = resolveServer(manifest, HOME, { root });
  if (found.source !== 'missing' && found.bin) {
    return {
      languageId: spec.languageId ?? manifest.id,
      serverName: spec.serverName ?? manifest.id,
      command: found.bin,
      args: spec.args ?? [],
      cwd: root,
      ...(env ? { env } : {}),
      ...(spec.initializationOptions ? { initializationOptions: spec.initializationOptions } : {}),
    };
  }
  if (spec.bundledFallback) {
    const fb = resolveBundledFallback(spec.bundledFallback, { languageId: manifest.id, toolchain });
    if (fb) return { ...fb, cwd: root };
  }
  return undefined;
}

function hoverText(hover: { contents: unknown } | null): string {
  if (!hover) return '';
  const one = (v: unknown): string =>
    typeof v === 'string' ? v : typeof v === 'object' && v && 'value' in v ? String((v as { value: unknown }).value) : '';
  const c = hover.contents as unknown;
  return Array.isArray(c) ? c.map(one).join('\n') : one(c);
}

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

  const launch = await launchFor(manifest, root);
  if (!launch) {
    skip(`${t.id}: semantic baseline`, `${manifest.lsp?.serverName ?? t.id} is not installed`);
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
