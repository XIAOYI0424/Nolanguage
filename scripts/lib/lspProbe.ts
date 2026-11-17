/**
 * One fixture per language, and one way to launch and time its server.
 *
 * Shared by the semantic baseline (`verify-lsp-semantics`) and the startup
 * baseline (`verify-startup`) so the two can never disagree about *which*
 * project, *which* server or *which* position they measured. A second copy of
 * the fixtures would drift the moment a server changes its wording, and the
 * startup numbers would then describe a project nobody else tests.
 *
 * Launch resolution is the product's: pooled manager when the manifest asks for
 * it, otherwise the managed root, PATH, a known path, or the bundled stub.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kernel } from '../../src/kernel/Kernel.js';
import { discoverBinary } from '../../src/langs/discover.js';
import { buildManagerPlugin } from '../../src/langs/managerPlugins.js';
import type { LanguageManifest } from '../../src/langs/manifest.js';
import { resolveServer } from '../../src/langs/serverInstall.js';
import { toolchainEnv } from '../../src/langs/toolchainEnv.js';
import { resolveBundledFallback } from '../../src/lsp/bundledFallback.js';
import { fileUri, type LspClient, type LspLaunchSpec, type Position } from '../../src/lsp/LspClient.js';

export interface Probe {
  file: string;
  line: number;
  character: number;
  /** Any one of these must appear. */
  expect: string[];
}

export interface Target {
  id: string;
  manifest: string;
  files: Record<string, string>;
  complete: Probe;
  /** Omitted when the server has nothing to say at that position. */
  hover?: Probe;
  broken: { file: string; text: string; expect: string[] };
}

export const targets: Target[] = [
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
export async function launchFor(
  manifest: LanguageManifest,
  root: string,
  home: string,
): Promise<{ launch?: LspLaunchSpec; source: string }> {
  const spec = manifest.lsp;
  if (!spec) return { source: 'no-lsp' };
  const toolchain = discoverBinary(manifest.run?.discovery, { root }).bin;
  const env = toolchainEnv(toolchain);

  if (spec.manager) {
    const plugin = await buildManagerPlugin(manifest, { home, workspaceRoot: root });
    const cfg = plugin?.lspConfig(root);
    if (!cfg) return { source: 'template-failed' };
    return {
      source: `manager/${cfg.serverName}`,
      launch: {
        languageId: cfg.languageId,
        serverName: cfg.serverName,
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        ...(cfg.env ? { env: cfg.env } : {}),
        ...(cfg.initializationOptions ? { initializationOptions: cfg.initializationOptions } : {}),
      },
    };
  }

  const found = resolveServer(manifest, home, { root });
  if (found.source !== 'missing' && found.bin) {
    return {
      source: `${found.source}/${spec.serverName ?? manifest.id}`,
      launch: {
        languageId: spec.languageId ?? manifest.id,
        serverName: spec.serverName ?? manifest.id,
        command: found.bin,
        args: spec.args ?? [],
        cwd: root,
        ...(env ? { env } : {}),
        ...(spec.initializationOptions ? { initializationOptions: spec.initializationOptions } : {}),
      },
    };
  }
  if (spec.bundledFallback) {
    const fb = resolveBundledFallback(spec.bundledFallback, { languageId: manifest.id, toolchain });
    if (fb) return { source: `bundled/${fb.serverName}`, launch: { ...fb, cwd: root } };
  }
  return { source: 'missing' };
}

export interface StartupTiming {
  /** Spawn + `initialize` handshake. "Did it start?" */
  handshake: number;
  /** First completion with items. "Did something appear?" */
  first: number;
  /** The count stopped growing. "Is it done loading?" */
  stable: number;
  items: number;
}

/**
 * Three thresholds, because a server answers in stages.
 *
 * Reporting only `first` flatters rust-analyzer: it answers 16 items at 1.2 s
 * and 138 at 5 s. Reporting only `stable` hides that the user already has help.
 * The baseline gates on `stable` — a server that is "up" but still loading is
 * not fast, and the handshake number is the one that changes for reasons the
 * product cannot control (a JVM starting, a disk spinning up).
 */
export async function measureStartup(
  client: LspClient,
  kernel: Kernel,
  root: string,
  uri: string,
  text: string,
  position: Position,
  opts: { budgetMs?: number; settleMs?: number; expectItems?: number } = {},
): Promise<StartupTiming> {
  const settleMs = opts.settleMs ?? 1500;
  // A server can plateau on a partial answer: rust-analyzer returns 16 items
  // while it loads and 138 when it is done, and 1.5 s of "16" looks stable.
  // The baseline knows how many items the finished answer has, so wait for it.
  const expectItems = opts.expectItems ?? 1;
  const deadlineMs = opts.budgetMs ?? 60_000;
  const t0 = Date.now();
  await client.start(kernel, fileUri(root));
  const handshake = Date.now() - t0;
  await client.openDocument(uri, text);

  let first = -1;
  let stable = -1;
  let items = 0;
  let unchangedFor = 0;
  let last = -1;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    let n = -1;
    try {
      n = (await client.completion(uri, position)).length;
    } catch {
      /* still warming */
    }
    if (n > 0 && first < 0) first = Date.now() - t0;
    // Stability is "the answer stopped changing", not "it stopped growing":
    // clangd answers 8 items while it parses and 2 once it knows the type, so a
    // growth-only rule never settles and burns the whole budget.
    if (n === last && n > 0) {
      unchangedFor += 100;
    } else {
      last = n;
      unchangedFor = 0;
    }
    if (n > items) items = n;
    if (last >= expectItems && unchangedFor >= settleMs) {
      stable = Date.now() - t0 - unchangedFor;
      items = last;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { handshake, first, stable, items };
}

/** Read one of the fixtures and its manifest, ready for `launchFor`. */
export function loadTarget(t: Target, root: string): { manifest: LanguageManifest; code: string } {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), t.manifest), 'utf8')) as LanguageManifest;
  return { manifest, code: t.files[t.complete.file] ?? '' };
}
