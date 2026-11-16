/**
 * Where a language server comes from, and how to get one.
 *
 * The product ships **no** language server. That is a deliberate size decision
 * (pyright alone is ~380 MB installed), and it means every language is only as
 * smart as what the user happens to have on `PATH`. This module is the missing
 * half: a plugin can declare *where its server comes from*, and the CLI can then
 * say — per language, in one place — "this one is missing, here is the exact
 * command, here is how big it is".
 *
 * # What this deliberately does not do
 *
 * **It never downloads a binary itself.** `npm` and `go` already verify what
 * they fetch (npm integrity, Go's checksum database); a hand-rolled downloader
 * for a GitHub release would be a supply-chain hole with our name on it. So the
 * three provider kinds are:
 *
 *   npm      `npm install --prefix <home>/servers/<id> <pkg>@<version>`
 *   go       `go install <module>@<version>` with `GOBIN` pointed at the home
 *   github   no automatic install: we print the releases page and the path to
 *            drop the binary into, because we cannot verify what we would get
 *
 * # Why the version is pinned
 *
 * A version that is not pinned turns "install a server" into "install whatever
 * the registry serves today". The pin is what makes the command reproducible
 * and what makes a bug report answerable.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { discoverBinary } from './discover.js';
import type { LanguageManifest } from './manifest.js';

export type ServerProviderKind = 'npm' | 'go-install' | 'github';

/** What a plugin declares under `lsp.provider`. */
export interface ServerProvider {
  kind: ServerProviderKind;
  /** npm package name, Go module path, or `owner/repo` on GitHub. */
  package: string;
  /** Pinned version. Absent only for `github`, which is manual by design. */
  version?: string;
  /** npm: the executable name inside `node_modules/.bin/`. */
  bin?: string;
  /** Extra versioned packages the install needs (a peer dependency). */
  also?: string[];
  /** github: the asset a user should pick from the release page. */
  asset?: string;
}

/** How to obtain one server, and where it lands. */
export interface ServerPlan {
  /** Managed directory an install writes into. */
  root: string;
  /** Paths (relative to `root`) that prove the install worked. */
  probe: string[];
  /** Command that performs the install; absent when it is manual. */
  command?: string[];
  /** What to do when `command` is absent. */
  manual?: string;
}

export interface ServerStatus {
  id: string;
  serverName: string;
  found: boolean;
  /** Resolved executable, or the first name that was looked for. */
  bin: string;
  /** `env:PYTHON_BIN` / `known` / `path` / `managed` / `missing`. */
  source: string;
  memoryHint?: string;
  degradedNote?: string;
  provider?: ServerProvider;
  plan: ServerPlan;
}

/** Where a managed install for this plugin lives. */
export function managedRoot(home: string, id: string): string {
  return join(home, 'servers', id);
}

/**
 * The plan for one plugin, derived from its manifest.
 *
 * `probe` is what makes "installed" mean something: the install command can
 * succeed and still leave nothing usable behind (a package with no bin, a
 * module whose name differs from its binary), so the status is decided by
 * whether one of these paths exists.
 */
export function planFor(manifest: LanguageManifest, home: string): ServerPlan {
  const root = managedRoot(home, manifest.id);
  const provider = manifest.lsp?.provider;
  if (!provider) {
    return { root, probe: [], manual: 'this plugin does not declare where its server comes from (lsp.provider)' };
  }
  if (provider.kind === 'npm') {
    const bin = provider.bin ?? basename(provider.package);
    const spec = provider.version ? `${provider.package}@${provider.version}` : provider.package;
    return {
      root,
      probe: [`node_modules/.bin/${bin}.cmd`, `node_modules/.bin/${bin}`],
      command: ['npm', 'install', '--prefix', root, '--no-audit', '--no-fund', spec, ...(provider.also ?? [])],
    };
  }
  if (provider.kind === 'go-install') {
    const exe = basename(provider.package) + (process.platform === 'win32' ? '.exe' : '');
    const spec = provider.version ? `${provider.package}@${provider.version}` : provider.package;
    return {
      root,
      probe: [join('bin', exe)],
      command: ['go', 'install', spec],
    };
  }
  const exe = provider.asset ?? basename(provider.package);
  return {
    root,
    probe: [exe],
    manual:
      `download ${exe} from https://github.com/${provider.package}/releases and put it at ` +
      join(root, exe) +
      ' (no automatic install: a release asset has no checksum we can verify)',
  };
}

/** The managed executable for this plugin, if one of the probe paths exists. */
export function managedBinary(manifest: LanguageManifest, home: string): string | undefined {
  const plan = planFor(manifest, home);
  for (const rel of plan.probe) {
    const abs = join(plan.root, rel);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

/**
 * Resolve the server the way the panel does, then fall back to the managed copy.
 *
 * Order matters: an explicit env var or a `knownPaths` hit is the user telling
 * us where their server is, and a managed copy must never override that. The
 * managed root is consulted only when normal discovery finds nothing.
 */
export function resolveServer(
  manifest: LanguageManifest,
  home: string,
  opts: { root?: string } = {},
): { bin: string; source: string } {
  const found = discoverBinary(manifest.lsp?.discovery, { root: opts.root });
  if (found.source !== 'missing') return { bin: found.bin, source: found.source };
  const managed = managedBinary(manifest, home);
  if (managed) return { bin: managed, source: 'managed' };
  return { bin: found.bin, source: 'missing' };
}

/** One row of `nlg lang server`: what this language needs and whether it is here. */
export function statusFor(manifest: LanguageManifest, home: string, opts: { root?: string } = {}): ServerStatus {
  const resolved = resolveServer(manifest, home, opts);
  return {
    id: manifest.id,
    serverName: manifest.lsp?.serverName ?? '(none)',
    found: resolved.source !== 'missing',
    bin: resolved.bin,
    source: resolved.source,
    ...(manifest.lsp?.memoryHint ? { memoryHint: manifest.lsp.memoryHint } : {}),
    ...(manifest.lsp?.degradedNote ? { degradedNote: manifest.lsp.degradedNote } : {}),
    ...(manifest.lsp?.provider ? { provider: manifest.lsp.provider } : {}),
    plan: planFor(manifest, home),
  };
}

export interface InstallOutcome {
  ok: boolean;
  /** Everything the installer printed, capped by the caller if it cares. */
  output: string;
  /** Resolved binary after the install, when it worked. */
  bin?: string;
  error?: string;
}

/**
 * Run the plan's install command.
 *
 * Async spawn, never `spawnSync`: a `go install` compiles for tens of seconds
 * and a synchronous call would freeze the panel. `onData` receives output as it
 * arrives so a CLI can stream it instead of going silent.
 */
export async function installServer(
  manifest: LanguageManifest,
  home: string,
  opts: { onData?: (chunk: string) => void; timeoutMs?: number } = {},
): Promise<InstallOutcome> {
  const plan = planFor(manifest, home);
  if (!plan.command) return { ok: false, output: '', error: plan.manual ?? 'no install command' };

  await mkdir(plan.root, { recursive: true });
  const [cmd, ...args] = plan.command;
  // `go install` writes to GOBIN; pointing it at the managed root keeps the
  // install self-contained instead of dropping a binary into ~/go/bin. Keyed on
  // the *provider kind*, not on the command name: the parity gate is right that
  // a core layer must not recognise a language — or a toolchain — by its name.
  const env =
    manifest.lsp?.provider?.kind === 'go-install'
      ? { ...process.env, GOBIN: join(plan.root, 'bin') }
      : process.env;

  return new Promise<InstallOutcome>((resolve) => {
    const child = spawn(cmd, args, { cwd: plan.root, env, windowsHide: true, shell: process.platform === 'win32' });
    let output = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
    }, opts.timeoutMs ?? 300_000);
    child.stdout?.on('data', (d: Buffer) => {
      output += d.toString();
      opts.onData?.(d.toString());
    });
    child.stderr?.on('data', (d: Buffer) => {
      output += d.toString();
      opts.onData?.(d.toString());
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output, error: `${cmd} could not start: ${err.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, output, error: `${cmd} exited with ${code}` });
        return;
      }
      const bin = managedBinary(manifest, home);
      resolve(bin ? { ok: true, output, bin } : { ok: false, output, error: 'the installer succeeded but produced no executable at the expected path' });
    });
  });
}
