/**
 * Dev server: kernel + PanelHub + WebSocket, hosting four UIs.
 *
 *   /            Workspace (IDE) — write & run Python/Go/JS, see problems/perf/logs
 *   /monitor     live monitoring panel (metrics, slow paths, log stream)
 *   /perf        kernel performance analysis (full summaries, trends, attribution)
 *   /extensions  extension host view
 *   /health      JSON status
 *
 * The WebSocket endpoint is shared by every page: each client receives the
 * metrics digest / slow paths / log stream, and IDE clients additionally get
 * run / check / completion responses.
 *
 * IDE clients additionally get run / check / completion / mdRender responses.
 *
 * Run:  node --experimental-transform-types --experimental-loader ./resolve-loader.mjs src/panel/server.ts
 * Env:  PANEL_PORT (default 7310)
 *       PANEL_NO_DEMO=1        skip the synthetic background traffic
 *       PANEL_WITH_PYTHON=1    also attach the Stage-3 LSP/Python loop
 *       PANEL_PY_INTERVAL=2000 loop tick interval (ms)
 *       PANEL_RUN_TIMEOUT=15000 hard timeout per editor run (ms)
 *       PYTHON_BIN             interpreter to use
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Kernel } from '../kernel/Kernel.js';
import { appDataPath } from '../util/appData.js';
import { LogLevel } from '../log/LogLevel.js';
import { WebSocketServer, type WebSocketConnection } from './WebSocketServer.js';
import { PanelHub, type PanelFilter, type PanelSink } from './PanelHub.js';
import { renderPanelHtml } from './ui.js';
import { renderPerfHtml } from './perf-ui.js';
import { renderExtensionsHtml } from './extensions-ui.js';
import { renderPluginsHtml } from './plugins-ui.js';
import { renderPyCharmHtml } from './pycharm-ui.js';
import { renderProfileHtml } from './profile-ui.js';
import { SAMPLES, type LanguageId } from './samples.js';
import { startTraffic } from './traffic.js';
import { WorkspaceService } from './WorkspaceService.js';
import { bufferName, normaliseExtensions } from '../langs/manifest.js';
import type { RegistryRoot } from '../langs/Registry.js';
import { officialRoots } from '../langs/pluginRoots.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { ExecService } from '../exec/ExecService.js';
import { ProfilerService } from '../profiler/ProfilerService.js';
import type { SandboxLanguage } from '../exec/types.js';
import { FsService, FsError } from './FsService.js';
import { McpManager } from '../mcp/McpManager.js';
import { APP_VERSION } from '../version.js';
import { discoverInterpreters, pickInterpreter } from '../langs/interpreters.js';
import { importIdeaProject } from '../langs/ideaImport.js';
import { attribute } from '../perf/Attribution.js';
import { ExtensionManager } from '../extensions/ExtensionManager.js';
import { materializeAssets } from '../desktop/embeddedAssets.js';
import { StdioTransport, WsTransport, parseFrame, type Transport } from './Transport.js';
import { FlameSampler } from './flame.js';
import { runPythonCoverage } from './coverage.js';
import { gitStatus, gitCommit } from './git.js';
import { DapClient, type DapStackFrame } from '../dap/DapClient.js';
import { discoverBinary } from '../langs/discover.js';

/**
 * Directory of this source file. In a Single Executable Application build
 * `import.meta.url` is not a `file://` URL, so fall back to the cwd rather than
 * throwing at module load time.
 */
function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}
const __dirname = moduleDir();

/**
 * Validate a language id coming off the wire.
 *
 * There is no allow-list any more: languages are plugins, so the id is checked
 * against the workspace's registry (which throws a precise "unknown language"
 * for a bad id) rather than against a hardcoded array.
 */
function asLanguage(v: unknown, workspace?: WorkspaceService): LanguageId {
  if (typeof v !== 'string' || !v) return 'python';
  // An id the workspace does not know is not a crash: it degrades to the
  // default language, which is what the wire contract has always promised.
  if (workspace && !workspace.hasLanguage(v)) return 'python';
  return v;
}

/**
 * Language ids the execution plane can run. This is *not* the same set as
 * `LANGUAGES`: Markdown renders rather than executes, and the pool only keeps
 * warm workers for the interpreted languages.
 */
const SANDBOX_LANGUAGES: SandboxLanguage[] = ['python', 'javascript', 'go'];

/** Validate a sandbox language id coming off the wire, defaulting to Python. */
function asSandboxLanguage(v: unknown): SandboxLanguage {
  return SANDBOX_LANGUAGES.some((l) => l === v) ? (v as SandboxLanguage) : 'python';
}

/**
 * Per-language toolchain pins read from the environment.
 *
 * These are the *official* plugin ids; a user-installed plugin is pinned through
 * its own manifest instead. The workspace only ever sees the resulting
 * `Record<pluginId, path>`, so adding a language here is host wiring, not an
 * engine change.
 */
function envToolchains(): Record<string, string> {
  const pins: Array<[string, string | undefined]> = [
    ['python', process.env.PYTHON_BIN],
    ['go', process.env.GO_BIN],
    ['javascript', process.env.NODE_BIN],
    ['markdown', process.env.MARKSMAN_BIN],
  ];
  const env = Object.fromEntries(pins.filter((p): p is [string, string] => !!p[1]));
  // The interpreter picker's pins sit *under* the environment: an explicit
  // `PYTHON_BIN` is a developer's override for this run and must win.
  return { ...readToolchainPins(), ...env };
}

/**
 * Interpreter candidates for one language — migration threshold 1.
 *
 * The answer always names an `active` interpreter: the pin when one is set,
 * otherwise the project's own environment. Leaving it empty would push the
 * decision back to "whatever PATH has", which is the behaviour the picker
 * exists to replace.
 */
async function handleInterpreters(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const pinned = workspace.toolchains()[language];
  try {
    const candidates = await discoverInterpreters(workspace.root, language, {
      sdkName: typeof msg.sdkName === 'string' && msg.sdkName ? msg.sdkName : undefined,
    });
    const picked = pickInterpreter(candidates, { pinned });
    reply({
      kind: 'interpreters',
      language,
      root: workspace.root,
      candidates,
      active: picked?.path ?? null,
      pinned: pinned ?? null,
    });
  } catch (err) {
    reply({
      kind: 'interpreters',
      language,
      root: workspace.root,
      candidates: [],
      active: null,
      pinned: pinned ?? null,
      error: (err as Error).message,
    });
  }
}

/** Pin (or unpin) a language's interpreter and rebuild its slot. */
async function handleSetInterpreter(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const path = typeof msg.path === 'string' ? msg.path : undefined;
  try {
    const result = await workspace.setToolchain(language, path);
    if (result.ok) await saveToolchainPins(workspace.toolchains());
    reply({ kind: 'interpreterSet', language, ...result });
  } catch (err) {
    reply({ kind: 'interpreterSet', language, ok: false, error: (err as Error).message });
  }
}

/** Import `.idea/runConfigurations` — migration threshold 2. */
async function handleImportIdea(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const root = typeof msg.root === 'string' && msg.root.trim() ? msg.root.trim() : workspace.root;
  try {
    const result = await importIdeaProject(root);
    reply({ kind: 'ideaImport', ...result });
  } catch (err) {
    reply({
      kind: 'ideaImport',
      root,
      missing: true,
      projectSdk: undefined,
      modules: [],
      configurations: [],
      warnings: [(err as Error).message],
    });
  }
}

/**
 * Stage 11 — attribute a metric's shift to a point in time.
 *
 * Samples come from the hot perf ring (the same records the Performance tab
 * shows), so the answer is about *this* session, not a stored baseline. The
 * split defaults to the midpoint of the window; `splitAt` pins it to a moment
 * (a deploy, a commit checkout).
 */
function handleAttribute(
  kernel: Kernel,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): void {
  const metric = String(msg.metric ?? '');
  const values: number[] = [];
  const times: number[] = [];
  for (const r of kernel.recentPerf(5000)) {
    const v =
      r.type === 'metric'
        ? r.name === metric
          ? r.value
          : undefined
        : r.type === 'sample'
          ? r.profileType === metric
            ? r.value
            : undefined
          : r.name === metric
            ? r.duration
            : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) {
      values.push(v);
      times.push(r.timestamp);
    }
  }

  const splitAt = Number(msg.splitAt);
  let cut = Number.isFinite(splitAt) && splitAt > 0 ? times.findIndex((t) => t >= splitAt) : Math.floor(values.length / 2);
  if (cut <= 0 || cut >= values.length) cut = Math.floor(values.length / 2);

  const result = attribute({
    before: values.slice(0, cut),
    after: values.slice(cut),
    series: values,
  });
  reply({ kind: 'attribution', metric, ...result, samples: { before: cut, after: values.length - cut } });
}

/**
 * Pins chosen in the interpreter picker, persisted across restarts.
 *
 * Kept out of the workspace directory on purpose: the interpreter belongs to
 * the *machine*, and a project checked out twice should not disagree with
 * itself about which python it uses.
 */
function toolchainPinPath(): string {
  return appDataPath('toolchains.json');
}

function readToolchainPins(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(toolchainPinPath(), 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

async function saveToolchainPins(pins: Record<string, string>): Promise<void> {
  try {
    await mkdir(appDataPath(), { recursive: true });
    await writeFile(toolchainPinPath(), JSON.stringify(pins, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort: a pin that cannot be saved still applies to this session */
  }
}

/**
 * The payload the Plugins page renders.
 *
 * Everything here is derived from manifests plus the Phase 4 budget — the page
 * never has a language id of its own, which is the same rule the IDE follows.
 */
function pluginPayload(workspace: WorkspaceService): Record<string, unknown> {
  const registry = workspace.languages;
  const budget = workspace.resourceSummary();
  const budgetOf = new Map(budget.profiles.map((p) => [p.languageId, p]));
  const slots = new Map(workspace.status().languages.map((l) => [l.id, l]));
  // Layer, override and shadow data only exist after a scan; asking the
  // registry before that throws, and the page must still render.
  const scanned = registry.isScanned();
  const overrideOf = new Map((scanned ? registry.overrides() : []).map((o) => [o.id, o]));
  const plugins = (scanned ? registry.installed() : []).map((p) => {
    const m = p.manifest;
    const res = budgetOf.get(m.id);
    const slot = slots.get(m.id);
    const override = overrideOf.get(m.id);
    return {
      id: m.id,
      displayName: m.displayName,
      version: m.version,
      publisher: m.publisher ?? '',
      description: m.description ?? '',
      kind: p.source.kind,
      removable: p.source.removable,
      enabled: p.enabled,
      extensions: normaliseExtensions(m.file),
      fileName: bufferName(m),
      runMode: m.run?.mode,
      needsRunner: !!m.run,
      runnerError: slot?.runnerError ?? '',
      lspServerName: m.lsp?.serverName,
      debugAdapter: m.debug?.adapter,
      profilerAdapter: m.profiler?.adapter,
      memoryBytes: res?.memoryBytes ?? 0,
      memoryRunning: res?.lspRunning ?? false,
      migrations: (m.migrations ?? []).length,
      validation: p.validation.issues,
      validationOk: p.validation.ok,
      dir: p.source.dir,
      // Which tier supplied this body, and what `overrides/<id>.json` changed.
      // The page's job is to make "why is this plugin here / why is its LSP
      // command different" answerable without a terminal.
      layer: (scanned ? registry.layerOf(m.id)?.id : undefined) ?? p.source.kind,
      readOnly: (scanned ? registry.layerOf(m.id)?.readOnly : undefined) ?? !p.source.removable,
      overrides: override
        ? { file: override.file, changed: override.changed, stale: override.stale }
        : undefined,
    };
  });
  return {
    kind: 'plugins',
    plugins,
    resource: budget,
    runtimes: workspace.runtimes.list(),
    // Same id in several tiers: the losers are not installed, but seeing them is
    // the only way to understand a plugin that "should" be a different version.
    conflicts: scanned ? registry.conflicts() : [],
    overrideProblems: scanned ? registry.overrideIssues() : [],
    home: registry.home,
  };
}

/**
 * Candidate directories scanned for `extension.json` manifests. `EXT_DIR` may
 * list several (`:`/`;` separated); we also look in the built-in examples and a
 * top-level `extensions/` folder.
 *
 * In a packaged build the examples are not on disk at all — they travel inside
 * the executable as embedded assets and are unpacked to a temp dir first, so
 * the extension host child process can `import()` them by path.
 */
function extensionDirs(): string[] {
  const fromEnv = (process.env.EXT_DIR ?? '')
    .split(/[:;]/)
    .filter(Boolean)
    .map((p) => resolve(p));
  const builtins = [join(__dirname, '..', 'extensions', 'examples'), join(process.cwd(), 'extensions')];
  const unpacked = materializeAssets('extensions/examples');
  return [...new Set([...fromEnv, ...builtins, ...(unpacked ? [unpacked] : [])])];
}

/**
 * Extra roots scanned for language plugins (`<id>@<version>/manifest.json`).
 *
 * The registry itself owns `~/.nolanguage/builtin` and `~/.nolanguage/languages`;
 * these are the *development* and *packaged* sources of the official plugins,
 * which must not have to be copied into the home directory before first run.
 *
 * `LANG_DIR` (`:`/`;` separated) lets a host or a test point at its own tree.
 */
function languageRoots(): RegistryRoot[] {
  // Shared with the CLI and `--dump-plugins` so the three cannot drift apart.
  return officialRoots();
}

export interface MainOptions {  /**
   * How a UI reaches the engine.
   *
   *   `'ws'`    (default) serve HTTP + WebSocket for a browser page, or for the
   *             packaged WebView window opened by `src/desktop/main.ts`.
   *   `'stdio'` speak newline-delimited JSON on stdin/stdout instead — the
   *             Tauri sidecar. No port, no HTTP server, exactly one peer.
   *
   * When omitted it is inferred: `--panel-stdio` on the command line (what the
   * bundled sidecar passes) or `NOLANGUAGE_TRANSPORT=stdio`.
   */
  transport?: 'ws' | 'stdio';
}

export async function main(
  opts: MainOptions = {},
): Promise<{ base: string; close: () => Promise<void>; clientCount: () => number }> {
  const port = Number(process.env.PANEL_PORT ?? 7310);
  const host = process.env.PANEL_HOST ?? '127.0.0.1';
  /** One build identity shared by `/health`, the install receipt and doctor. */
  const startedAt = new Date().toISOString();
  const exePath = process.execPath;
  const exeSize = (() => {
    try {
      return statSync(exePath).size;
    } catch {
      return 0;
    }
  })();
  const stdio =
    opts.transport === 'stdio' ||
    (opts.transport !== 'ws' && (process.argv.includes('--panel-stdio') || process.env.NOLANGUAGE_TRANSPORT === 'stdio'));
  // A pipe has exactly one peer: nothing to demo for, and stdout belongs to the
  // protocol — a pretty log line written there would desynchronise the relay.
  const withDemo = !stdio && process.env.PANEL_NO_DEMO !== '1';
  const withPython = process.env.PANEL_WITH_PYTHON === '1';
  /** Set when `WorkspaceService.init()` failed; reported through `/health`. */
  let workspaceFailure: string | undefined;

  const kernel = new Kernel({
    appVersion: APP_VERSION,
    slowThresholdMs: Number(process.env.PANEL_SLOW_MS ?? 60),
    logLevel: LogLevel.TRACE,
    logPretty: !stdio,
    logSilent: stdio,
    // Stage 6 · baseline system: SQLite warm tier + auto-baselines on every
    // git commit change. `PANEL_NO_STORE=1` falls back to memory-only.
    store: process.env.PANEL_NO_STORE === '1' ? false : (process.env.NOLANGUAGE_DB ?? true),
    sessionId: `panel-${Date.now().toString(36)}`,
  });

  // Order matters: `kernel.logger` is only populated by spine installation in
  // `start()`, and startDemo captures a logger — so start first.
  await kernel.start();

  // Best-effort install receipt: one place doctor/update can read "which build
  // is installed here". Only the packaged desktop writes it: `nlg ide` and the
  // test servers run on node.exe and would otherwise overwrite the receipt with
  // the interpreter path. Diagnostics must never block startup.
  if (process.env.NOLANGUAGE_DESKTOP === '1') {
    try {
      await mkdir(appDataPath(), { recursive: true });
      await writeFile(
        appDataPath('install-receipt.json'),
        JSON.stringify({ version: kernel.appVersion, exePath, exeSize, startedAt }, null, 2) + '\n',
        'utf8',
      );
    } catch {
      /* best-effort */
    }
  }

  const { startDemo } = await import('./demo-commands.js');
  startDemo(kernel);

  // ---- Stage 5 · extension host (面板接入) ----
  // Started *before* the workspace on purpose: extension activation is a
  // background concern (spec 4.3 延迟激活 — 启动只加载清单), and spawning the
  // hosts here keeps the first painted page independent of how long a language
  // server takes to come up. `activateStartup()` is the only await.
  const extManager = new ExtensionManager(kernel, { activateOnStartup: true });
  for (const d of extensionDirs()) extManager.discover(d);
  extManager.installCommands();
  await extManager.activateStartup();
  kernel.events.on('extension:activated', (p: { extensionId: string; hostId?: string }) =>
    hub.push({ kind: 'extension', at: Date.now(), event: 'activated', extensionId: p.extensionId, hostId: p.hostId }),
  );
  kernel.events.on('extension:crashed', (p: { extensionId: string; hostId?: string }) =>
    hub.push({ kind: 'extension', at: Date.now(), event: 'crashed', extensionId: p.extensionId, hostId: p.hostId }),
  );
  kernel.logger.root().info('Extension manager ready', {
    discovered: extManager.list().length,
    dirs: extensionDirs(),
  });

  // ---- the editor backend (one slot per language) ----
  const workspace = new WorkspaceService(kernel, {
    toolchain: envToolchains(),
    runTimeoutMs: process.env.PANEL_RUN_TIMEOUT ? Number(process.env.PANEL_RUN_TIMEOUT) : undefined,
    // Opt-in eager start for every server (useful for benchmarking startup).
    eagerLsp: process.env.PANEL_EAGER_LSP === '1',
    // Official plugins ship beside the source (and inside the executable);
    // user-installed ones live under `NOLANGUAGE_HOME`.
    pluginRoots: languageRoots(),
    // `<workspace>/.nolanguage/languages` is the `project` tier: it must follow
    // the folder the panel was opened on, not the process launch directory.
    projectDir: process.env.PANEL_EXPLORER_ROOT ?? process.cwd(),
  });
  // A workspace that cannot materialise its buffers must not take the whole
  // server down: the panel, the extension host and every read-only view still
  // work. Surface it as a WARN and keep serving — `status()` reports the slots
  // as unavailable, which is exactly what the UI renders for a missing runner.
  try {
    await workspace.init();
  } catch (err) {
    workspaceFailure = err instanceof Error ? err.message : String(err);
    kernel.logger.root().warn('Workspace unavailable — panel continues without it', {
      error: workspaceFailure,
      dir: workspace.root,
    });
  }
  const wsStatus = workspace.status();
  kernel.logger.root().info('Workspace ready', {
    toolchains: wsStatus.languages.map((l) => `${l.id}=${l.binary || '-'}`).join(', '),
    languages: wsStatus.languages
      .map((l) => `${l.id}${l.available ? '' : '(unavailable)'}`)
      .join(', '),
    lsp: wsStatus.lsp.serverName,
    lspAvailable: wsStatus.lsp.available,
    degraded: workspaceFailure ?? false,
  });

  // ---- Stage 9 · execution plane (sandbox warm pool) ----
  // Optional by design: if construction fails the panel still works. The pool
  // pre-warms `minSize` idle workers so the first sandbox run is already warm.
  let exec: ExecService | undefined;
  try {
    exec = new ExecService(kernel, {
      pythonBin: process.env.PYTHON_BIN,
      goBin: process.env.GO_BIN,
      nodeBin: process.env.NODE_BIN,
      minSize: Number(process.env.SANDBOX_MIN ?? 1),
      maxIdleMs: Number(process.env.SANDBOX_MAX_IDLE ?? 60_000),
      runTimeoutMs: process.env.PANEL_RUN_TIMEOUT ? Number(process.env.PANEL_RUN_TIMEOUT) : 15_000,
    });
    exec.registerCommands();
    workspace.setExec(exec);
    kernel.logger.root().info('Execution plane ready', { minSize: Number(process.env.SANDBOX_MIN ?? 1) });
  } catch (err) {
    kernel.logger.root().warn('Execution plane unavailable', { error: (err as Error).message });
  }

  // ---- Stage 10 · user-code profiler (adapters resolved from manifests) ----
  let profiler: ProfilerService | undefined;
  try {
    profiler = new ProfilerService(kernel, {
      pythonBin: process.env.PYTHON_BIN,
      goBin: process.env.GO_BIN,
      // The profiler reads manifests instead of knowing language ids, so it is
      // bound to the workspace's registry rather than to a list of languages.
      languages: () => (workspace.languages.isScanned() ? workspace.languages.all() : []),
    });
    profiler.registerCommands();
    kernel.logger.root().info('Profiler ready', { adapters: JSON.stringify(profiler.describe()) });
  } catch (err) {
    kernel.logger.root().warn('Profiler unavailable', { error: (err as Error).message });
  }

  // ---- project explorer ----
  // The explorer shows the *project*, not the IDE's scratch buffers, so it
  // defaults to the process working directory. `PANEL_EXPLORER_ROOT` pins it
  // (tests use this); the UI can repoint it at runtime via `openFolder`.
  const explorerRoot = process.env.PANEL_EXPLORER_ROOT ?? process.cwd();
  const fs = new FsService(explorerRoot);
  kernel.logger.root().info('Project explorer ready', { root: fs.root });

  // ---- MCP (Model Context Protocol) servers, for the sidebar tool window ----
  // Config lives in app state (`<appData>/mcp.json`); `NOLANGUAGE_MCP_CONFIG`
  // overrides it, which is what the test harness uses. Loading is tolerant: a
  // broken file becomes a card-level error, never a boot failure.
  const mcp = new McpManager({
    configPath: process.env.NOLANGUAGE_MCP_CONFIG,
    logger: {
      info: (m, meta) => kernel.logger.root().info(m, meta),
      warn: (m, meta) => kernel.logger.root().warn(m, meta),
    },
  });
  await mcp.load();
  kernel.logger.root().info('MCP manager ready', {
    config: mcp.payload().configPath,
    servers: mcp.payload().servers.length,
  });

  const hub = new PanelHub(kernel, { pushIntervalMs: 1000 });
  hub.install();
  hub.start();

  // ---- kernel flame graph ----
  // One V8 CPU profiler for the whole process, shared by every IDE window that
  // opens the flame graph. Sampling starts on the first subscriber and stops
  // when the last one leaves (see flame.ts).
  const flame = new FlameSampler({
    // Memory attribution next to the CPU samples. The kernel's own RSS/heap is
    // measurable in-process; a language server is a separate process, and its
    // RSS is what `ProfileManager` already tracks — that is the "which service
    // is holding the memory" half of the window, not a guess.
    memory: () => {
      const mu = process.memoryUsage();
      const profiles = workspace.resourceSummary().profiles ?? [];
      const services = profiles
        .filter((p) => p.lspRunning && p.lspMemoryBytes > 0)
        .map((p) => ({ name: `${p.languageId} LSP`, bytes: p.lspMemoryBytes }));
      return { rss: mu.rss, heapUsed: mu.heapUsed, external: mu.external, services };
    },
  });

  /**
   * Wire one client to the engine. Everything below is transport-agnostic: the
   * router only knows `send` / `onMessage` / `onClose`, which is why the same
   * code serves a browser tab and the Tauri sidecar unchanged.
   *
   * `label` is for logging only; `key` is this client's identity for the
   * interactive-execution state (terminal child, run stdin sink).
   */
  /** Clients currently attached, so page-specific frames can be broadcast. */
  const wsClients = new Set<Transport>();
  /**
   * Push the MCP catalogue to every attached client. A connect/disconnect
   * changes what another window should show, and the sidebar repaints from it.
   */
  const broadcastMcp = (): void => {
    const payload = mcp.payload();
    for (const c of wsClients) {
      try {
        c.send(payload);
      } catch {
        /* a closed client missed the update */
      }
    }
  };
  /** Last user-code profile result, so a /profile page opened after the IDE
   * triggered a run can render it without the IDE relaying state. */
  let lastProfile: unknown = null;
  /** Project root — where `resolve-loader.mjs` and `scripts/` live. */
  const projectRoot = join(__dirname, '..', '..');

  /**
   * One plugin operation from the Plugins page. Every op answers on the
   * requesting client with `pluginOp { ok }`, and a success re-broadcasts the
   * whole list so a second tab (or the IDE) sees the change too.
   *
   * Failures are answers, not exceptions: a user who points the installer at a
   * directory that is not a plugin must be told *why*, not dropped.
   */
  const handlePluginOp = async (
    msg: Record<string, unknown>,
    reply: (payload: unknown) => void,
  ): Promise<void> => {
    const op = String(msg.kind ?? '');
    const id = String(msg.id ?? '');
    const answer = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      reply({ kind: 'pluginOp', ok, op, id, ...extra });
      if (ok) {
        const payload = pluginPayload(workspace);
        for (const c of wsClients) {
          try {
            c.send(payload);
          } catch {
            /* a closed client simply missed the update */
          }
        }
      }
    };
    try {
      if (op === 'langInstall') {
        const dir = String(msg.dir ?? '').trim();
        if (!dir) throw new Error('dir is required');
        const installed = await workspace.languages.install(resolve(dir));
        await workspace.pluginsSynced();
        kernel.logger.root().info('Plugin installed', { id: installed.id, version: installed.version });
        answer(true, { installed });
        return;
      }
      if (op === 'langEnable') {
        await workspace.languages.enable(id);
        await workspace.pluginsSynced();
        answer(true);
        return;
      }
      if (op === 'langDisable') {
        await workspace.languages.disable(id);
        await workspace.pluginsSynced();
        answer(true);
        return;
      }
      if (op === 'langUninstall') {
        const keepData = msg.keepData !== false;
        const gone = await workspace.languages.uninstall(id, { keepData });
        await workspace.pluginsSynced();
        if (!gone) throw new Error(`"${id}" is not installed`);
        answer(true);
        return;
      }
      answer(false, { error: `unknown plugin op: ${op}` });
    } catch (err) {
      kernel.logger.root().warn('Plugin operation failed', { op, id, error: (err as Error).message });
      answer(false, { error: (err as Error).message });
    }
  };

  const attachClient = (transport: Transport, label: string, key: object): void => {
    const clientId = hub.allocateClientId();
    const reply = (payload: unknown): void => transport.send(payload);

    hub.addClient({ id: clientId, send: reply } as PanelSink);
    wsClients.add(transport);
    transport.onClose(() => wsClients.delete(transport));
    // Tell IDE clients what the workspace can do. `languages` is derived from
    // the plugin manifests, so a newly installed language shows up in the UI
    // without a page release.
    reply({
      kind: 'workspace',
      status: workspace.status(),
      languages: workspace.languageList(),
      samples: SAMPLES.map((s) => ({ id: s.id, name: s.name, languageId: s.languageId, mode: s.mode })),
    });
    // …and where the project explorer is rooted, so the tree can paint a root
    // row immediately instead of waiting for the first `fsList` round-trip.
    reply({ kind: 'fsRoot', reqId: 0, ...fs.describe() });
    // Plugins page bootstrap: installed set + budget + runtimes in one frame.
    reply(pluginPayload(workspace));
    // MCP sidebar bootstrap: the declared servers and their live state.
    reply(mcp.payload());
    kernel.logger.root().info('Client connected', { client: label, clients: hub.clientCount() });

    transport.onMessage((raw: string) => {
      const msg = parseFrame(raw);
      if (!msg) {
        reply({ kind: 'error', message: 'invalid JSON' });
        return;
      }
      switch (msg.kind) {
        // ---------- Phase 3 · plugins ----------
        case 'listPlugins':
          reply(pluginPayload(workspace));
          break;

        case 'langEnable':
        case 'langDisable':
        case 'langUninstall':
        case 'langInstall':
          void handlePluginOp(msg, reply);
          break;

        // ---------- MCP (sidebar tool window) ----------
        case 'mcpList':
          reply(mcp.payload());
          break;

        case 'mcpReload':
          void mcp
            .load()
            .then(() => reply(mcp.payload()))
            .catch((err: unknown) => reply({ kind: 'mcpError', id: '', error: (err as Error).message }));
          break;

        case 'mcpInitConfig':
          void mcp
            .initConfig()
            .then(() => {
              broadcastMcp();
              reply(mcp.payload());
            })
            .catch((err: unknown) => reply({ kind: 'mcpError', id: '', error: (err as Error).message }));
          break;

        case 'mcpConnect':
        case 'mcpDisconnect': {
          const id = String(msg.id ?? '');
          const op = msg.kind === 'mcpConnect' ? mcp.connect(id) : mcp.disconnect(id);
          void Promise.resolve(op)
            .then(() => broadcastMcp())
            .catch((err: unknown) => {
              reply({ kind: 'mcpError', id, error: (err as Error).message });
              broadcastMcp();
            });
          break;
        }

        case 'mcpCall': {
          const id = String(msg.id ?? '');
          const tool = String(msg.tool ?? '');
          const args = msg.args && typeof msg.args === 'object' ? (msg.args as Record<string, unknown>) : {};
          void mcp
            .callTool(id, tool, args, msg.timeoutMs ? Number(msg.timeoutMs) : undefined)
            .then((result) => reply({ kind: 'mcpCallResult', id, tool, ok: true, result }))
            .catch((err: unknown) =>
              reply({ kind: 'mcpCallResult', id, tool, ok: false, error: (err as Error).message }),
            );
          break;
        }

        case 'reclaimResources':
          void workspace
            .enforceResources()
            .then((reaped) => reply({ kind: 'resources', resource: workspace.resourceSummary(), reaped }))
            .catch((err: unknown) =>
              reply({ kind: 'error', message: `reclaim failed: ${(err as Error).message}` }),
            );
          break;

        // ---------- monitoring (shared) ----------
        case 'filter': {
          const f = msg as unknown as PanelFilter & { pattern?: string };
          hub.applyFilter({
            minLevel: (f.minLevel ?? LogLevel.INFO) as LogLevel,
            components: f.components,
            messagePattern: (f.pattern as string) ?? (f.messagePattern as string),
          });
          break;
        }
        case 'clear':
          hub.clearLogs();
          break;
        case 'ping':
          reply({ kind: 'pong', at: Date.now() });
          break;

        // ---------- project explorer (file system) ----------
        case 'fsList':
        case 'fsRead':
        case 'fsWrite':
        case 'fsCreate':
        case 'fsRename':
        case 'fsDelete':
        case 'openFolder':
          void handleFs(fs, msg, reply);
          break;

        // ---------- extensions (host process) ----------
        case 'listExtensions':
          reply({ kind: 'extensions', at: Date.now(), extensions: extManager.panelInfo() });
          break;

        case 'runExtensionCommand': {
          const id = String(msg.id ?? '');
          const args = Array.isArray(msg.args) ? (msg.args as unknown[]) : [];
          const rid = Number(msg.reqId ?? 0);
          void extManager
            .runCommand(id, ...args)
            .then((result) => reply({ kind: 'extensionResult', reqId: rid, ok: true, result }))
            .catch((err: unknown) =>
              reply({ kind: 'extensionResult', reqId: rid, ok: false, error: (err as Error).message }),
            );
          break;
        }

        case 'activateExtension':
          void extManager
            .activateForCommand(String(msg.id ?? ''))
            .then(() => reply({ kind: 'extension', at: Date.now(), event: 'activated', extensionId: String(msg.id ?? '') }));
          break;

        // ---------- terminal (PyCharm shell) ----------
        case 'termExec':
          handleTerm(String(msg.cmd ?? ''), reply, key);
          break;
        case 'termInput': {
          const tc = stateFor(key).termChild;
          if (tc && tc.stdin) tc.stdin.write(String(msg.text ?? ''));
          break;
        }
        case 'runInput': {
          const rs = stateFor(key).runSink;
          if (rs) rs(String(msg.text ?? ''));
          break;
        }

        // ---------- IDE ----------
        case 'run':
          void handleRun(key, workspace, msg, reply);
          break;

        // Stop button / Run → Stop: cancel the live run *and* a debug session.
        case 'stop': {
          const sessionId = String(msg.sessionId ?? 'ide');
          const st = stateFor(key);
          const debugStopped = !!st.dap;
          if (st.dap) {
            void st.dap.stop().catch(() => undefined);
            st.dap = undefined;
          }
          const cancelled = workspace.cancel(sessionId);
          reply({ kind: 'stopped', sessionId, cancelled, debugStopped });
          break;
        }

        // Debug: the manifest's `debug` block names the adapter; a missing
        // adapter is reported as such instead of faking a session.
        case 'debug':
          void handleDebug(key, workspace, kernel, msg, reply);
          break;

        case 'debugCmd':
          void handleDebugCmd(key, msg, reply);
          break;

        // Run with coverage (Python stdlib tracer).
        case 'coverage': {
          const language = asLanguage(msg.language, workspace);
          if (language !== 'python') {
            reply({
              kind: 'coverageResult',
              ok: false,
              language,
              error: `line coverage is only implemented for Python (this document is ${language})`,
            });
            break;
          }
          const bin = workspace.languageStatus('python').binary || process.env.PYTHON_BIN || 'python';
          void runPythonCoverage(bin, String(msg.code ?? ''), {
            timeoutMs: msg.timeoutMs ? Number(msg.timeoutMs) : 30_000,
          })
            .then((r) => reply({ kind: 'coverageResult', ...r }))
            .catch((err: unknown) =>
              reply({ kind: 'coverageResult', ok: false, language, error: (err as Error).message }),
            );
          break;
        }

        // Commit pane + git widget: real porcelain status and commit.
        case 'gitStatus':
          void gitStatus(fs.root)
            .then((s) => reply({ kind: 'gitStatus', ...s }))
            .catch((err: unknown) =>
              reply({ kind: 'gitStatus', ok: false, branch: '', changes: [], error: (err as Error).message }),
            );
          break;

        case 'gitCommit':
          void gitCommit(fs.root, String(msg.message ?? ''))
            .then((r) => reply({ kind: 'gitCommitResult', ...r }))
            .catch((err: unknown) =>
              reply({ kind: 'gitCommitResult', ok: false, branch: '', committed: 0, output: '', error: (err as Error).message }),
            );
          break;

        // Kernel flame graph: subscribe this window to live CPU samples.
        case 'flameStart':
          flame.subscribe(reply, msg.intervalMs ? Number(msg.intervalMs) : undefined);
          break;

        case 'flameStop':
          flame.unsubscribe(reply);
          break;

        // Command palette → kernel command. The list arrives in `hello`, and
        // selecting one runs it for real; an argument-taking command answers
        // with the bus's own error instead of a silent no-op.
        case 'command': {
          const id = String(msg.id ?? '');
          const args = Array.isArray(msg.args) ? (msg.args as unknown[]) : [];
          void kernel.commands
            .execute(id, ...args)
            .then((result) => reply({ kind: 'commandResult', id, ok: true, result }))
            .catch((err: unknown) =>
              reply({ kind: 'commandResult', id, ok: false, error: (err as Error).message }),
            );
          break;
        }

        case 'check':
          void handleCheck(workspace, msg, reply);
          break;

        case 'complete':
        case 'completion': // accept both spellings
          void handleComplete(workspace, msg, reply);
          break;

        case 'hover':
          void handleHover(workspace, msg, reply);
          break;

        case 'mdRender':
          void handleMdRender(workspace, msg, reply);
          break;

        // ---------- P1 · migration thresholds ----------
        case 'interpreters':
          void handleInterpreters(workspace, msg, reply);
          break;

        case 'setInterpreter':
          void handleSetInterpreter(workspace, msg, reply);
          break;

        case 'importIdea':
          void handleImportIdea(workspace, msg, reply);
          break;

        // ---------- Stage 11 · attribution ----------
        case 'attribute':
          handleAttribute(kernel, msg, reply);
          break;

        // ---------- Stage 10 · user-code profiler ----------
        case 'profile': {
          if (!profiler) {
            reply({ kind: 'profileResult', ok: false, error: 'profiler unavailable', hotspots: [], sampleCount: 0 });
            break;
          }
          // The profiler is the last language-keyed component (Phase 6 moves it
          // onto manifests), so ask *it* which languages it has adapters for
          // rather than picking ids here.
          const wanted = String(msg.language ?? '');
          const language = profiler.supports(wanted) ? wanted : profiler.defaultLanguage();
          void profiler
            .profile({
              languageId: language,
              code: String(msg.code ?? ''),
              timeoutMs: msg.timeoutMs ? Number(msg.timeoutMs) : undefined,
            })
            .then((r) => {
              lastProfile = r;
              reply({ kind: 'profileResult', ...r });
              // A /profile page opened in another tab gets it live.
              for (const c of wsClients) {
                if (c === transport) continue;
                try {
                  c.send({ kind: 'profileResult', ...r });
                } catch {
                  /* closed client missed the update */
                }
              }
            })
            .catch((err: unknown) =>
              reply({ kind: 'profileResult', ok: false, error: (err as Error).message, hotspots: [], sampleCount: 0 }),
            );
          break;
        }

        case 'profileLast':
          reply(lastProfile ? { kind: 'profileResult', ...(lastProfile as object) } : { kind: 'profileResult', ok: false, error: 'no profile yet', hotspots: [], sampleCount: 0 });
          break;

        case 'profileCaps':
          reply({
            kind: 'profileCaps',
            languages: profiler ? profiler.languages().map((m) => ({
              id: m.id,
              displayName: m.displayName,
              adapter: m.profiler?.adapter ?? '',
              available: profiler.adapterFor(m.id)?.available ?? false,
            })) : [],
          });
          break;

        // ---------- command palette (nlg run <script> -- <args>) ----------
        case 'runScript':
          void handleRunScript(msg, reply, projectRoot);
          break;

        case 'resetSession': {
          const sessionId = String(msg.sessionId ?? 'ide');
          const language = asLanguage(msg.language, workspace);
          void workspace.resetSession(language, sessionId).then((reset) => {
            reply({ kind: 'session', sessionId, language, reset });
          });
          break;
        }

        // ---------- Stage 9 · execution plane (sandbox warm pool) ----------
        case 'sandboxCreate': {
          if (!exec) { reply({ kind: 'error', message: 'execution plane unavailable' }); break; }
          const language = asSandboxLanguage(msg.language);
          void exec
            .create(language, msg.sessionId ? String(msg.sessionId) : undefined)
            .then((r) => reply({ kind: 'sandboxCreated', ...r }))
            .catch((err: unknown) => reply({ kind: 'sandboxCreated', sessionId: String(msg.sessionId ?? ''), language, warm: false, error: (err as Error).message }));
          break;
        }

        case 'sandboxRun': {
          if (!exec) { reply({ kind: 'error', message: 'execution plane unavailable' }); break; }
          const language = asSandboxLanguage(msg.language);
          void exec
            .run({
              languageId: language,
              sessionId: msg.sessionId ? String(msg.sessionId) : undefined,
              code: String(msg.code ?? ''),
              args: Array.isArray(msg.args) ? (msg.args as string[]) : undefined,
              mode: msg.mode === 'test' ? 'test' : 'run',
              timeoutMs: msg.timeoutMs ? Number(msg.timeoutMs) : undefined,
            })
            .then((r) => reply({ kind: 'sandboxResult', ...r }))
            .catch((err: unknown) => reply({ kind: 'sandboxResult', sessionId: String(msg.sessionId ?? ''), languageId: language, ok: false, error: (err as Error).message, stdout: '', stderr: '', exitCode: -1, signal: null, durationMs: 0, timedOut: false, runId: '', warm: false, mode: 'run' }));
          break;
        }

        case 'sandboxReset': {
          if (!exec) { reply({ kind: 'error', message: 'execution plane unavailable' }); break; }
          const sessionId = String(msg.sessionId ?? '');
          void exec.reset(sessionId).then((ok) => reply({ kind: 'sandboxReset', sessionId, ok }));
          break;
        }

        case 'sandboxList': {
          if (!exec) { reply({ kind: 'sandboxList', sessions: [] }); break; }
          reply({ kind: 'sandboxList', sessions: exec.list() });
          break;
        }

        default:
          reply({ kind: 'error', message: `unknown message kind: ${String(msg.kind)}` });
      }
    });

    transport.onClose(() => {
      const st = connState.get(key);
      if (st?.termChild) { try { st.termChild.kill('SIGKILL'); } catch { /* gone */ } }
      // A closed window must not keep the CPU profiler (or a debug adapter)
      // alive; both are per-window subscriptions, not per-process services.
      flame.unsubscribe(reply);
      if (st?.dap) void st.dap.stop().catch(() => undefined);
      if (st) connState.delete(key);
      hub.removeClient(clientId);
      kernel.logger.root().info('Client disconnected', { client: label, clients: hub.clientCount() });
    });
  };

  let base = '';
  let ws: WebSocketServer | undefined;

  if (stdio) {
    // Tauri sidecar mode: the Rust relay owns the process, so this must not
    // install signal handlers that exit before the relay has drained stdout.
    attachClient(new StdioTransport(), 'stdio', { stdio: true });
  } else {
    const monitorHtml = renderPanelHtml(port);
    const perfHtml = renderPerfHtml(port);
    const profileHtml = renderProfileHtml(port);
    const extensionsHtml = renderExtensionsHtml(port);
    const pluginsHtml = renderPluginsHtml();
    const pycharmHtml = renderPyCharmHtml(port);

    ws = new WebSocketServer({
      port,
      host,
      // A WebSocket upgrade is not covered by the same-origin policy, so the
      // server refuses third-party origins itself. `PANEL_ALLOW_ANY_ORIGIN=1`
      // opens it back up for a proxy / remote-debug setup.
      allowedOrigins: process.env.PANEL_ALLOW_ANY_ORIGIN === '1' ? ['*'] : [],
      onRequest: (req, res) => {
        const url = (req.url ?? '/').split('?')[0];
        const html = (body: string): void => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(body);
        };
        // The PyCharm-style shell is the workspace; the old Vue IDE page is gone.
        if (url === '/' || url === '/index.html' || url === '/ide') return html(pycharmHtml), true;
        if (url === '/monitor' || url === '/panel') return html(monitorHtml), true;
        if (url === '/perf' || url === '/performance') return html(perfHtml), true;
        if (url === '/profile' || url === '/profiles') return html(profileHtml), true;
        if (url === '/extensions') return html(extensionsHtml), true;
        if (url === '/plugins' || url === '/languages') return html(pluginsHtml), true;
        if (url === '/pycharm' || url === '/ide-pycharm') return html(pycharmHtml), true;
        if (url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              clients: hub.clientCount(),
              appVersion: kernel.appVersion,
              build: { appVersion: kernel.appVersion, pid: process.pid, exePath, exeSize, startedAt },
              workspace: workspace.status(),
              ...(workspaceFailure ? { degraded: { workspace: workspaceFailure } } : {}),
            }),
          );
          return true;
        }
        return false;
      },
    });

    ws.on('connection', (conn: WebSocketConnection) => {
      const label = conn.remoteAddress + ':' + Math.floor(Math.random() * 1e6);
      attachClient(new WsTransport(conn), label, conn);
    });

    const addr = await ws.listen();
    base = `http://${addr.host}:${addr.port}`;
    kernel.logger.root().info('Dev server ready', {
      workspace: `${base}/`,
      monitor: `${base}/monitor`,
      plugins: `${base}/plugins`,
      ws: `ws://${addr.host}:${addr.port}/`,
    });
  }

  // Stage 6 · baseline system: report where telemetry is being persisted and
  // let an operator force a baseline without waiting for a git commit.
  const telemetry = kernel.sqliteStore();
  if (telemetry) {
    kernel.commands.register('baseline.checkpoint', async (reason?: unknown) => {
      const cp = await kernel.checkpointBaseline(typeof reason === 'string' ? reason : 'manual');
      return cp ? { regressed: cp.comparison.summary.regressed, reason: cp.baseline.reason } : null;
    }, { title: 'Capture a metric baseline', category: 'perf' });
    kernel.logger.root().info('Warm tier ready', {
      database: telemetry.path,
      retentionDays: telemetry.retentionDays,
      command: 'baseline.checkpoint',
    });
  }

  // The desktop entry (`src/desktop/main.ts`) prints its own banner; the stdio
  // mode may not print anything at all (stdout is the protocol channel).
  if (withDemo) startTraffic(kernel);

  // Optional: feed the UI with *real* LSP + Python data (Stage-3 loop).
  let pythonLoop: { stop(): Promise<void> } | undefined;
  if (withPython) {
    const { startPythonLoop } = await import('./pythonTraffic.js');
    pythonLoop = await startPythonLoop(kernel, {
      intervalMs: Number(process.env.PANEL_PY_INTERVAL ?? 2500),
      pythonBin: process.env.PYTHON_BIN,
    });
    kernel.logger.root().info('Stage-3 Python loop attached');
  }

  const shutdown = async (): Promise<void> => {
    kernel.logger.root().info('Server shutting down');
    // A child that refuses to close must not keep the port bound: an orphan
    // server makes the next launch exit with no window.
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref?.();
    await pythonLoop?.stop();
    await workspace.close();
    // The execution plane (warm node workers) and extension hosts are not owned
    // by a language slot. Without these two lines they outlive the app — the
    // "Node.js still running after close" report.
    if (exec) await exec.close().catch(() => undefined);
    // MCP servers are grandchildren of the shell: without this they outlive the
    // window exactly like the language servers did.
    await mcp.close().catch(() => undefined);
    await extManager.dispose().catch(() => undefined);
    hub.stop();
    if (ws) await ws.close();
    await kernel.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  void readFile(join(__dirname, 'ide.ts')).catch(() => undefined); // keep import graph warm

  // In stdio mode stdout is the protocol channel, so nothing human-readable may
  // be written to it — the relay reports lifecycle on its own.
  if (!stdio && process.env.NOLANGUAGE_QUIET !== '1') {
    const telemetry = kernel.sqliteStore();
    if (telemetry) process.stdout.write(`  Telemetry (SQLite)  ->  ${telemetry.path}\n`);
    process.stdout.write(
      `\n  Python Workspace  ->  ${base}/\n` +
        `  Monitor panel     ->  ${base}/monitor\n` +
        `  Perf analysis     ->  ${base}/perf\n\n`,
    );
  }

  // `clientCount` is how the desktop entry tells "the window is still there"
  // from "the window is gone": a chromeless app has no other liveness signal
  // once the Edge process it spawned is no longer the one holding the profile.
  return { base, close: shutdown, clientCount: () => hub.clientCount() };
}

/**
 * True when this module was launched directly — i.e. `node src/panel/server.ts`
 * in development. The desktop entry (`src/desktop/main.ts`) imports `main()`
 * itself, so it must not double-boot.
 *
 * The packaged exe must never take this path. When esbuild bundles the SEA
 * entry, `server.ts` and `desktop/main.ts` end up in **one file**, and
 * `import.meta.url` is rewritten to that bundle — which for SEA is the exe
 * itself. Double-clicking `Nolanguage.exe` sets `process.argv[1]` to the exe
 * path, so the comparison matches and the server boots a second time; the
 * desktop entry then loses the port race with `EADDRINUSE`.
 *
 * Import order cannot save us here (esbuild hoists every import above
 * top-level statements, so an env flag set by the desktop entry is assigned
 * too late). SEA is detected structurally instead: a single-file bundle never
 * has a *real* source path as `argv[1]`, so a `.ts`/`.js` script argument is
 * required, and `--experimental-transform-types`/`--loader` are dead giveaways
 * for the dev invocation.
 */
const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  if (!/\.(?:ts|js|mjs|cjs|mts|cts)$/i.test(arg)) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(arg);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// ---------------- IDE handlers ----------------

/**
 * Per-connection interactive-execution state: an attached terminal child and the
 * active run's stdin sink. Keyed by the live connection object.
 */
const connState = new Map<unknown, {
  runSink?: (d: string) => void;
  termChild?: ChildProcess;
  dap?: DapClient;
}>();
function stateFor(conn: unknown): {
  runSink?: (d: string) => void;
  termChild?: ChildProcess;
  dap?: DapClient;
} {
  let s = connState.get(conn);
  if (!s) { s = {}; connState.set(conn, s); }
  return s;
}

/**
 * Terminal command execution for the PyCharm-style shell. Spawns an attached
 * shell child (piped stdin/stdout/stderr) so the terminal can drive interactive
 * programs — e.g. `python main.py` that calls `input()`, or a long-running
 * server. Output streams back live as `termOut` frames; the child stays attached
 * until it exits, when a `termResult` frame arrives. While attached, the UI sends
 * `termInput` to feed the child's stdin. A 4 MiB output cap kills a runaway
 * producer so it can't wedge the panel.
 */
function handleTerm(cmd: string, reply: (p: unknown) => void, conn: unknown): void {
  const st = stateFor(conn);
  if (st.termChild) return; // already attached; ignore stray commands
  const started = Date.now();
  let bytes = 0;
  const CAP = 4 * 1024 * 1024;
  const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
  const args = process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd];
  const child = spawn(shell, args, { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  st.termChild = child;
  const cap = (d: Buffer): void => {
    bytes += d.length;
    if (bytes > CAP) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };
  child.stdout?.on('data', (d) => { cap(d); reply({ kind: 'termOut', text: d.toString('utf8'), stream: 'stdout' }); });
  child.stderr?.on('data', (d) => { cap(d); reply({ kind: 'termOut', text: d.toString('utf8'), stream: 'stderr' }); });
  child.on('error', (err) => {
    st.termChild = undefined;
    reply({ kind: 'termResult', cmd, stdout: '', stderr: String(err), code: 1, ms: Date.now() - started });
  });
  child.on('close', (code, signal) => {
    st.termChild = undefined;
    reply({ kind: 'termResult', cmd, stdout: '', stderr: '', code: code ?? null, ms: Date.now() - started });
  });
}

/**
 * Command-palette script runner (the server side of `nlg run <script> -- <args>`).
 *
 * Mirrors the `nlg` wrapper exactly: it resolves `<script>` to `scripts/<script>.ts`
 * (run through the resolve-loader) or `<script>.mjs` (run directly), then spawns
 * Node with the user's args. The script name is whitelisted to `[A-Za-z0-9_-]+`
 * and must exist on disk, so a palette entry can never reach an arbitrary path.
 * Output streams back live as `scriptOut`; a final `scriptResult` carries the
 * exit code.
 */
function handleRunScript(
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
  projectRoot: string,
): void {
  const script = typeof msg.script === 'string' ? msg.script : '';
  if (!/^[A-Za-z0-9_-]+$/.test(script)) {
    reply({ kind: 'scriptResult', ok: false, code: -1, ms: 0, error: `invalid script name: ${JSON.stringify(script)}` });
    return;
  }
  const args = Array.isArray(msg.args) ? (msg.args as unknown[]).map((a) => String(a)) : [];
  const tsPath = join(projectRoot, 'scripts', `${script}.ts`);
  const mjsPath = join(projectRoot, 'scripts', `${script}.mjs`);
  const useTs = existsSync(tsPath);
  const entry = useTs ? tsPath : mjsPath;
  if (!useTs && !existsSync(mjsPath)) {
    reply({ kind: 'scriptResult', ok: false, code: -1, ms: 0, error: `script not found: scripts/${script}.(ts|mjs)` });
    return;
  }
  const nodeArgs = useTs
    ? ['--experimental-transform-types', '--experimental-loader', pathToFileURL(join(projectRoot, 'resolve-loader.mjs')).href, entry, ...args]
    : [entry, ...args];
  const started = Date.now();
  let bytes = 0;
  const CAP = 4 * 1024 * 1024;
  const child = spawn(process.execPath, nodeArgs, {
    cwd: projectRoot,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cap = (d: Buffer): void => {
    bytes += d.length;
    if (bytes > CAP) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };
  child.stdout?.on('data', (d) => { cap(d); reply({ kind: 'scriptOut', stream: 'stdout', text: d.toString('utf8') }); });
  child.stderr?.on('data', (d) => { cap(d); reply({ kind: 'scriptOut', stream: 'stderr', text: d.toString('utf8') }); });
  child.on('error', (err) => {
    reply({ kind: 'scriptResult', ok: false, code: 1, ms: Date.now() - started, error: String(err) });
  });
  child.on('close', (code) => {
    reply({ kind: 'scriptResult', ok: code === 0, code: code ?? null, ms: Date.now() - started });
  });
}

async function handleRun(
  client: object,
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : 'ide';
  const language = asLanguage(msg.language, workspace);
  // `mode` selects `go test` over `go run`; ignored by Python.
  const mode = msg.mode === 'test' ? 'test' : 'run';
  try {
    // Announce the run so the UI can show a busy state before the toolchain boots.
    const st = stateFor(client);
    reply({ kind: 'runStart', runId: `pending-${Date.now()}`, sessionId, language, mode });
    const result = await workspace.run(language, code, {
      sessionId,
      reset: msg.reset === true,
      mode,
      onData: (stream, text) => reply({ kind: 'runOut', stream, text }),
      onStdinReady: (sink) => { st.runSink = sink; },
    });
    st.runSink = undefined;
    reply({
      kind: 'runResult',
      language,
      mode: result.mode,
      runId: result.runId,
      sessionId: result.sessionId,
      exitCode: result.exitCode,
      signal: result.signal,
      cancelled: result.cancelled,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      logLines: result.logLines,
      binary: result.binary,
      phase: result.phase,
      compileError: result.compileError,
      buildMs: result.buildMs,
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `run failed: ${(err as Error).message}` });
  }
}

/**
 * Start a debug session for one document.
 *
 * The adapter is declared by the language plugin (`manifest.debug`), so this
 * function contains no language branching: it discovers the adapter, launches
 * it over DAP, applies the breakpoints the editor already renders, and streams
 * output/stopped frames back. When discovery fails, the reply says exactly
 * what is missing — a Debug button that silently does nothing is worse than a
 * Debug button that explains why it cannot start.
 */
async function handleDebug(
  client: object,
  workspace: WorkspaceService,
  kernel: Kernel,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const code = typeof msg.code === 'string' ? msg.code : '';
  const st = stateFor(client);
  if (st.dap) {
    reply({ kind: 'debugState', ok: false, state: 'running', error: 'a debug session is already running' });
    return;
  }
  const spec = workspace.manifestOf(language)?.debug;
  if (!spec) {
    reply({
      kind: 'debugState',
      ok: false,
      error: `"${language}" does not declare a debug adapter (manifest.debug)`,
    });
    return;
  }
  const resolved = discoverBinary(spec.discovery, { root: workspace.root });
  if (!resolved.bin || resolved.source === 'missing') {
    reply({
      kind: 'debugState',
      ok: false,
      adapter: spec.adapter,
      error: spec.degradedNote || `${spec.serverName ?? spec.adapter} is not installed`,
      hint: `install ${spec.adapter} or point ${(spec.discovery?.envVars ?? [])[0] ?? 'its discovery env var'} at the adapter`,
      install: spec.install,
    });
    return;
  }
  // A debug configuration may name the entry script explicitly (VS Code's
  // launch.json `program`). When it does, debug that file on disk; otherwise
  // fall back to the language's scratch buffer (the original behaviour).
  const requestedProgram = typeof msg.program === 'string' && msg.program ? msg.program : '';
  const program = requestedProgram ? join(workspace.root, requestedProgram) : workspace.bufferPath(language);
  if (!program) {
    reply({ kind: 'debugState', ok: false, error: `no program path for "${language}"` });
    return;
  }
  // `serverReads` means the script already exists on disk (e.g. a configuration
  // pointing at a file that is not the open buffer) — launch it as-is. When code
  // is supplied (an open, possibly dirty buffer) we flush it to disk first, the
  // same way an IDE saves before launching.
  const serverReads = requestedProgram !== '' && msg.serverReads === true;
  let effectiveCode = code;
  if (serverReads && !effectiveCode) {
    try {
      effectiveCode = await readFile(program, 'utf8');
    } catch {
      /* missing file — the adapter will report a clean error */
    }
  }
  if (effectiveCode) await writeFile(program, effectiveCode, 'utf8').catch(() => undefined);

  const template = spec.command?.length ? spec.command : ['{resolved}'];
  const [head, ...rest] = template;
  const command = head.replace('{resolved}', resolved.bin);
  const args = [...rest, ...(spec.args ?? [])].map((a) => a.replace('{resolved}', resolved.bin));

  // Extra launch fields from the configuration: program arguments, environment
  // overrides and a working directory. All optional; adapters ignore what they
  // do not understand. (`request: 'attach'` is accepted but treated as launch
  // for now — attach needs a running target, which this flow does not yet start.)
  const cfgArgs = Array.isArray(msg.args)
    ? msg.args.map((a) => String(a))
    : typeof msg.args === 'string' && msg.args
      ? msg.args.split(/\s+/).filter(Boolean)
      : [];
  const cfgEnv = msg.env && typeof msg.env === 'object' ? (msg.env as Record<string, string>) : undefined;
  const cfgCwd = typeof msg.cwd === 'string' && msg.cwd ? msg.cwd : undefined;

  const dap = new DapClient(
    kernel,
    {
      command,
      args,
      adapterId: spec.type ?? spec.adapter,
      cwd: cfgCwd ?? workspace.root,
      launchArgs: {
        program,
        stopOnEntry: msg.stopOnEntry !== false,
        // Compiled-language adapters (dlv dap) need the build mode; ignored by
        // adapters that do not know the field.
        mode: 'debug',
        ...(cfgArgs.length ? { args: cfgArgs } : {}),
        ...(cfgEnv ? { env: cfgEnv } : {}),
        ...(cfgCwd ? { cwd: cfgCwd } : {}),
      },
    },
    {
      onStopped: (info) => {
        void (async () => {
          let frames: DapStackFrame[] = [];
          try {
            frames = await dap.stackTrace(info.threadId);
          } catch {
            /* the adapter may have no stack for this stop */
          }
          reply({ kind: 'debugState', ok: true, state: 'stopped', reason: info.reason, frames });
        })();
      },
      onOutput: (text, category) => reply({ kind: 'debugOut', text, category }),
      onTerminated: () => {
        const live = connState.get(client);
        if (live) live.dap = undefined;
        reply({ kind: 'debugState', ok: true, state: 'terminated' });
      },
    },
  );
  st.dap = dap;
  try {
    await dap.start();
    const breakpoints = Array.isArray(msg.breakpoints)
      ? (msg.breakpoints as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    if (breakpoints.length) await dap.setBreakpoints(program, breakpoints);
    reply({ kind: 'debugState', ok: true, state: 'running', adapter: spec.adapter, program });
  } catch (err) {
    st.dap = undefined;
    reply({
      kind: 'debugState',
      ok: false,
      adapter: spec.adapter,
      error: `debug adapter failed: ${(err as Error).message}`,
    });
  }
}

/** One debugger command from the toolbar (continue / step / stack / stop). */
async function handleDebugCmd(
  client: object,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const st = connState.get(client);
  const dap = st?.dap;
  if (!dap) {
    reply({ kind: 'debugState', ok: false, error: 'no debug session is running' });
    return;
  }
  const cmd = String(msg.cmd ?? '');
  try {
    if (cmd === 'continue') {
      await dap.continue_();
      reply({ kind: 'debugState', ok: true, state: 'running' });
      return;
    }
    if (cmd === 'next' || cmd === 'stepIn' || cmd === 'stepOut') {
      if (cmd === 'next') await dap.stepOver();
      else if (cmd === 'stepIn') await dap.stepIn();
      else await dap.stepOut();
      const frames = await dap.stackTrace();
      reply({ kind: 'debugState', ok: true, state: 'stopped', reason: cmd, frames });
      return;
    }
    if (cmd === 'stack') {
      const frames = await dap.stackTrace();
      reply({ kind: 'debugState', ok: true, state: 'stopped', frames });
      return;
    }
    if (cmd === 'stop') {
      await dap.stop();
      if (st) st.dap = undefined;
      reply({ kind: 'debugState', ok: true, state: 'terminated' });
      return;
    }
    reply({ kind: 'debugState', ok: false, error: `unknown debug command: ${cmd}` });
  } catch (err) {
    reply({ kind: 'debugState', ok: false, error: (err as Error).message });
  }
}

async function handleCheck(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const language = asLanguage(msg.language, workspace);
  try {
    const d = await workspace.diagnose(language, code);
    reply({
      kind: 'diagnostics',
      language,
      uri: d.uri,
      items: d.items,
      errors: d.errors,
      warnings: d.warnings,
      fromLsp: d.fromLsp,
      note: d.note,
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `check failed: ${(err as Error).message}` });
  }
}

async function handleComplete(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const language = asLanguage(msg.language, workspace);
  const line = Number(msg.line ?? 0);
  const character = Number(msg.character ?? 0);
  const requestId = Number(msg.requestId ?? 0);
  try {
    const items = await workspace.complete(language, code, line, character);
    reply({
      kind: 'completion',
      language,
      requestId,
      items: items.slice(0, 100).map((i) => ({ label: i.label, kind: i.kind, detail: i.detail })),
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `completion failed: ${(err as Error).message}` });
  }
}

async function handleHover(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const language = asLanguage(msg.language, workspace);
  const line = Number(msg.line ?? 0);
  const character = Number(msg.character ?? 0);
  const requestId = Number(msg.requestId ?? 0);
  try {
    const hover = await workspace.hover(language, code, line, character);
    reply({ kind: 'hover', language, requestId, hover });
  } catch (err) {
    reply({ kind: 'error', language, message: `hover failed: ${(err as Error).message}` });
  }
}

/**
 * Stage 8: render a Markdown document for the preview pane.
 *
 * The reply carries the sanitized HTML plus the metadata the UI shows beside
 * it (title, headings for the outline, render time). `ok: false` keeps the
 * pane in a recoverable state instead of leaving it spinning — a renderer
 * bug must degrade one document, not the connection.
 */
async function handleMdRender(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const language = asLanguage(msg.language, workspace);
  const requestId = Number(msg.requestId ?? 0);
  try {
    const p = await workspace.preview(language, code);
    reply({ kind: 'mdPreview', language, requestId, ok: true, ...p });
  } catch (err) {
    reply({
      kind: 'mdPreview',
      language,
      requestId,
      ok: false,
      html: '',
      headings: [],
      stats: { blocks: 0, words: 0, codeBlocks: 0, links: 0, headings: 0 },
      ms: 0,
      error: `render failed: ${(err as Error).message}`,
    });
  }
}

// ---------------- project explorer ----------------

/**
 * One dispatcher for every file-system message.
 *
 * A shared error funnel matters here: `FsService` signals a rejected path
 * (traversal, absolute, missing) by throwing `FsError`, and the client must be
 * told *which* path failed and why — otherwise a refused `..` looks identical
 * to a broken explorer. Every branch therefore reports `reqId` back so the UI
 * can clear its pending state, and never lets a rejection reach the socket.
 */
async function handleFs(
  fs: FsService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const reqId = Number(msg.reqId ?? 0);
  const path = typeof msg.path === 'string' ? msg.path : '';
  const fail = (err: unknown, at?: string): void => {
    const code = err instanceof FsError ? err.code : 'io';
    reply({ kind: 'fsError', reqId, path: at ?? path, code, message: (err as Error).message });
  };

  try {
    switch (msg.kind) {
      case 'fsList': {
        const listing = await fs.list(path);
        reply({ kind: 'fsListing', reqId, ...listing });
        return;
      }
      case 'fsRead': {
        const file = await fs.read(path);
        reply({ kind: 'fsFile', reqId, file });
        return;
      }
      case 'fsWrite': {
        const saved = await fs.write(path, typeof msg.content === 'string' ? msg.content : '');
        reply({ kind: 'fsSaved', reqId, path: saved.path, mtime: saved.mtime, size: saved.size });
        return;
      }
      case 'fsCreate': {
        const entry = await fs.create(path, msg.entryKind === 'dir' ? 'dir' : 'file');
        reply({ kind: 'fsChanged', reqId, op: 'create', path: entry.path, entry });
        return;
      }
      case 'fsRename': {
        const to = typeof msg.to === 'string' ? msg.to : '';
        const entry = await fs.rename(path, to);
        // `from` travels back so the UI can remap any open tab / expanded node.
        reply({ kind: 'fsChanged', reqId, op: 'rename', path: entry.path, from: path, entry });
        return;
      }
      case 'fsDelete': {
        const removed = await fs.remove(path);
        reply({ kind: 'fsChanged', reqId, op: 'delete', path: removed.path });
        return;
      }
      case 'openFolder': {
        await fs.setRoot(path);
        reply({ kind: 'fsRoot', reqId, ...fs.describe() });
        return;
      }
      default:
        reply({ kind: 'fsError', reqId, code: 'io', message: `unknown fs message: ${String(msg.kind)}` });
    }
  } catch (err) {
    fail(err);
  }
}
