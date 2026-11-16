/**
 * Manifests in, `LanguagePlugin`s out.
 *
 * This is the only place that knows a manifest and the manager both exist, and it
 * contains no language: extensions, project markers, launch templates, fallback
 * vocabulary and idle TTL all come from the manifest, so adding a language is
 * adding a JSON file.
 *
 * ## Launch templates, and why they exist
 *
 * The obvious design — "run the discovered binary" — does not survive contact
 * with real servers. jdtls ships `bin/jdtls.bat`, which on Windows shells out to
 * Python and ends with `pause`: spawning it blocks forever. The actual server is
 * `java -jar …/plugins/org.eclipse.equinox.launcher_*.jar`. So a plugin may
 * declare a template, and this file expands it:
 *
 * | placeholder | meaning |
 * |---|---|
 * | `{resolved}` | the binary discovery found |
 * | `{dist}` | the distribution root (`…/jdtls` when the launcher is in `bin/`) |
 * | `{toolchain}` | the resolved toolchain (`run.discovery`) |
 * | `{root}` | the project root |
 * | `{dataDir}` | a persistent per-plugin directory for the server's own state |
 * | `{glob:<pattern>}` | the first match, sorted — for versioned jar names |
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { discoverBinary, probeVersion } from './discover.js';
import type { LanguageManifest } from './manifest.js';
import type { LanguageRegistry } from './Registry.js';
import { resolveServer } from './serverInstall.js';
import { LexicalFallback } from '../lsp/manager/fallback.js';
import { versionSignature } from '../lsp/manager/signature.js';
import { ContentHashStrategy, GitDiffStrategy } from '../lsp/manager/strategies.js';
import type { IncrementalStrategy, LanguagePlugin, LspServerConfig } from '../lsp/manager/types.js';

/** Five minutes: long enough that tab-switching does not respawn, short enough to matter. */
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

export interface AdapterOptions {
  /** `<home>` — managed server installs and per-plugin data live here. */
  home: string;
  /** Workspace root; project-root discovery never walks above it. */
  workspaceRoot?: string;
  /** Overridable for tests. */
  probe?: (bin: string, args: string[]) => Promise<string | null>;
}

interface TemplateContext {
  resolved: string;
  dist: string;
  root: string;
  dataDir: string;
  toolchain: string;
  /** `win` | `linux` | `mac` — distributions name their config dirs this way. */
  platform: string;
}

const PLATFORM = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

/** `*` and `?` only — enough for `launcher_*.jar`, and no new dependency. */
function globIn(pattern: string): string[] {
  const dir = dirname(pattern);
  const mask = basename(pattern);
  if (!mask.includes('*') && !mask.includes('?')) return existsSync(pattern) ? [pattern] : [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const re = new RegExp(
    `^${mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  );
  return names
    .filter((n) => re.test(n))
    .sort()
    .map((n) => join(dir, n));
}

/**
 * Expand one argv entry.
 *
 * Returns undefined when a `{glob:}` has no match: launching `java -jar ""` would
 * produce a confusing server crash instead of an honest "the distribution is
 * incomplete".
 */
function expandOne(raw: string, ctx: TemplateContext): string | undefined {
  let missing = false;
  // Simple placeholders first, so `{glob:{dist}/…}` has no nested braces left
  // when the glob is parsed. `{toolchain}` is the one that may genuinely be
  // absent: launching a JVM-based server without a JVM is not something to
  // paper over with an empty string.
  const substituted = raw.replace(/\{(resolved|dist|root|dataDir|toolchain|platform)\}/g, (_m, key: string) => {
    const v = (ctx as unknown as Record<string, string>)[key];
    if (!v) {
      missing = true;
      return '';
    }
    return v;
  });
  if (missing) return undefined;

  const glob = /\{glob:(.+)\}/.exec(substituted);
  if (glob) {
    const matches = globIn(glob[1]);
    if (!matches.length) return undefined;
    return substituted.replace(glob[0], matches[0]);
  }
  return substituted;
}

function expandAll(parts: string[], ctx: TemplateContext): string[] | undefined {
  const out: string[] = [];
  for (const part of parts) {
    const expanded = expandOne(part, ctx);
    if (expanded === undefined) return undefined;
    out.push(expanded);
  }
  return out;
}

/** The distribution root: `…/jdtls` for `…/jdtls/bin/jdtls.bat`. */
function distOf(bin: string): string {
  const dir = dirname(bin);
  return basename(dir).toLowerCase() === 'bin' ? dirname(dir) : dir;
}

/**
 * A fingerprint of a directory-based distribution.
 *
 * A launcher shim does not change when the server does, so stamping only the
 * binary would let a jdtls upgrade slip past the cache check. Size and mtime of
 * every jar is cheap (one readdir, N stats) and changes exactly when the
 * distribution changes.
 */
function distributionStamp(dist: string): string {
  const plugins = join(dist, 'plugins');
  if (!existsSync(plugins)) return '';
  let names: string[];
  try {
    names = readdirSync(plugins);
  } catch {
    return '';
  }
  let bytes = 0;
  let newest = 0;
  for (const name of names) {
    try {
      const st = statSync(join(plugins, name));
      bytes += st.size;
      newest = Math.max(newest, Math.round(st.mtimeMs));
    } catch {
      /* vanished mid-scan */
    }
  }
  return `${names.length}:${bytes}:${newest}`;
}

function binaryStamp(bin: string): string {
  try {
    const st = statSync(bin);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * Nearest project root at or below `ceiling`.
 *
 * The *outermost* marker wins, not the nearest one: a Maven reactor has a
 * `pom.xml` at the root and one per module, and picking the module would give
 * every module its own JVM. A `.git` boundary stops the walk so two unrelated
 * checkouts in one workspace stay two projects.
 */
export function findProjectRoot(file: string, markers: string[], ceiling?: string): string | undefined {
  if (!markers.length) return undefined;
  const stop = ceiling ? dirname(ceiling) : undefined;
  let dir = dirname(file);
  let best: string | undefined;
  for (;;) {
    if (markers.some((m) => existsSync(join(dir, m)))) best = dir;
    if (existsSync(join(dir, '.git'))) return best ?? dir;
    if (stop && dir === stop) return best;
    const parent = dirname(dir);
    if (parent === dir) return best;
    dir = parent;
  }
}

/** Build one plugin, or undefined when the manifest did not opt in. */
export async function buildManagerPlugin(
  manifest: LanguageManifest,
  opts: AdapterOptions,
): Promise<LanguagePlugin | undefined> {
  const spec = manifest.lsp;
  if (!spec?.manager) return undefined;

  const markers = spec.projectMarkers ?? [];
  const extensions = new Set((manifest.file?.extensions ?? []).map((e) => e.toLowerCase()));
  const home = opts.home;
  const dataDir = join(home, 'lsp-data', manifest.id);

  const resolved = resolveServer(manifest, home, opts.workspaceRoot ? { root: opts.workspaceRoot } : {});
  const bin = resolved.source === 'missing' ? undefined : resolved.bin;

  const toolchain = discoverBinary(manifest.run?.discovery, opts.workspaceRoot ? { root: opts.workspaceRoot } : {}).bin;

  let serverVersion = spec.serverVersion ?? (bin ? binaryStamp(bin) : 'missing');
  if (bin && spec.versionArgs?.length) {
    const probe = opts.probe ?? probeVersion;
    const probed = await probe(bin, spec.versionArgs).catch(() => null);
    if (probed) serverVersion = probed;
  }
  if (bin) {
    const dist = distributionStamp(distOf(bin));
    if (dist) serverVersion = `${serverVersion}|dist:${dist}`;
  }

  const signature = versionSignature({
    pluginId: manifest.id,
    serverName: spec.serverName ?? manifest.id,
    serverVersion,
    toolchainVersion: 'unknown',
  });

  const fallback = spec.fallback ? new LexicalFallback(spec.fallback) : undefined;
  const strategy: IncrementalStrategy | undefined =
    spec.incremental === 'none'
      ? undefined
      : spec.incremental === 'content-hash'
        ? new ContentHashStrategy()
        : new GitDiffStrategy();

  const configs = new Map<string, LspServerConfig | undefined>();
  let launchNote: string | undefined;

  const buildConfig = (root: string): LspServerConfig | undefined => {
    if (!bin) {
      launchNote = spec.degradedNote ?? `${spec.serverName ?? manifest.id} not found`;
      return undefined;
    }
    const ctx: TemplateContext = { resolved: bin, dist: distOf(bin), root, dataDir, toolchain, platform: PLATFORM };
    const template = spec.command ?? ['{resolved}'];
    const expanded = expandAll(template, ctx);
    if (!expanded || !expanded.length) {
      launchNote = `${spec.serverName ?? manifest.id}: launch template did not resolve (a versioned file inside the distribution is missing)`;
      return undefined;
    }
    const extra = expandAll(spec.args ?? [], ctx);
    if (!extra) {
      launchNote = `${spec.serverName ?? manifest.id}: an argument template did not resolve`;
      return undefined;
    }
    return {
      serverName: spec.serverName ?? manifest.id,
      languageId: spec.languageId ?? manifest.id,
      command: expanded[0],
      args: [...expanded.slice(1), ...extra],
      cwd: root,
      ...(spec.initializationOptions ? { initializationOptions: spec.initializationOptions } : {}),
      ...(spec.startTimeoutMs !== undefined ? { startTimeoutMs: spec.startTimeoutMs } : {}),
      ...(spec.firstRequestBudgetMs !== undefined ? { firstRequestBudgetMs: spec.firstRequestBudgetMs } : {}),
      ...(spec.navBudgetMs !== undefined ? { navBudgetMs: spec.navBudgetMs } : {}),
    };
  };

  return {
    id: manifest.id,
    matches(file: string): boolean {
      if (!extensions.size) return false;
      return extensions.has(extname(file).slice(1).toLowerCase());
    },
    projectRoot(file: string): string | undefined {
      return findProjectRoot(file, markers, opts.workspaceRoot);
    },
    lspConfig(root: string): LspServerConfig | undefined {
      if (configs.has(root)) return configs.get(root);
      const cfg = buildConfig(root);
      configs.set(root, cfg);
      return cfg;
    },
    versionSignature(): string {
      return signature;
    },
    fallback() {
      return fallback;
    },
    incremental() {
      return strategy;
    },
    serverPriority(): number {
      return 0;
    },
    idleTtlMs(): number {
      return spec.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    },
    get degradedNote(): string {
      return launchNote ?? spec.degradedNote ?? `${spec.serverName ?? manifest.id} not found`;
    },
  };
}

/** Every manifest that opted in, built and ready to register. */
export async function buildManagerPlugins(
  registry: LanguageRegistry,
  opts: AdapterOptions,
): Promise<LanguagePlugin[]> {
  const out: LanguagePlugin[] = [];
  for (const manifest of registry.all()) {
    const plugin = await buildManagerPlugin(manifest, opts);
    if (plugin) out.push(plugin);
  }
  return out;
}
