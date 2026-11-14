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
import { gzipSync } from 'node:zlib';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Kernel } from '../kernel/Kernel.js';
import { appDataPath } from '../util/appData.js';
import { LogLevel } from '../log/LogLevel.js';
import { WebSocketServer, type WebSocketConnection } from '../net/websocket.js';
import { PanelHub, type PanelFilter, type PanelSink } from './PanelHub.js';
import { renderPanelHtml } from '../ui/ui.js';
import { renderPerfHtml } from '../ui/perf-ui.js';
import { renderExtensionsHtml } from '../ui/extensions-ui.js';
import { renderPluginsHtml } from '../ui/plugins-ui.js';
import { renderPyCharmHtml } from './pycharm-ui.js';
import { renderProfileHtml } from '../ui/profile-ui.js';
import { SAMPLES } from './samples.js';
import { startTraffic } from './traffic.js';
import { WorkspaceService } from './WorkspaceService.js';
import { ExecService } from '../exec/ExecService.js';
import { ProfilerService } from '../profiler/ProfilerService.js';
import { FsService, FsError } from './FsService.js';
import { McpManager } from '../mcp/McpManager.js';
import { APP_VERSION } from '../version.js';
import { ExtensionManager } from '../extensions/ExtensionManager.js';
import { materializeAssets } from '../assets/embeddedAssets.js';
import { StdioTransport, WsTransport, parseFrame, type Transport } from './Transport.js';
import { FlameSampler } from './flame.js';
import { runPythonCoverage } from './coverage.js';
import { gitStatus, gitCommit } from './git.js';
import { DapClient, type DapScope, type DapStackFrame, type DapVariable } from '../dap/DapClient.js';
import { discoverBinary } from '../langs/discover.js';
import { asLanguage, asSandboxLanguage, handleCheck, handleComplete, handleHover, handleMdRender } from './handlers/languages.js';
import { envToolchains, handleImportIdea, handleInterpreters, handleSetInterpreter } from './handlers/migration.js';
import { handleAttribute } from './handlers/attribution.js';
import { languageRoots, pluginPayload } from './handlers/plugins.js';
import { PerfHandlers } from './handlers/perf.js';
import { handleFs } from './handlers/fs.js';
import { handleDebug, handleDebugCmd, handleRun, handleRunScript, handleTerm } from './handlers/run.js';
import { stateFor, takeConnection } from './conn-state.js';

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

export interface MainOptions {
  /**
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

  /**
   * NDJSON kernel log path from the environment.
   *
   * `NOLANGUAGE_LOG_FILE` is a path, or `0`/`off` to disable. The desktop entry
   * sets a default under `%LOCALAPPDATA%\Nolanguage\logs`; a bare suite run
   * leaves it unset and writes nothing.
   */
  function logFileFromEnv(): string | false {
    const raw = process.env.NOLANGUAGE_LOG_FILE;
    if (!raw || raw === '0' || raw.toLowerCase() === 'off') return false;
    return raw;
  }

  const kernel = new Kernel({
    appVersion: APP_VERSION,
    slowThresholdMs: Number(process.env.PANEL_SLOW_MS ?? 60),
    logLevel: LogLevel.TRACE,
    logPretty: !stdio,
    logSilent: stdio,
    // Set by the desktop entry (`src/desktop/main.ts`); unset in suites, which
    // must not write into the user's app data. `NOLANGUAGE_LOG_FILE=0` opts out.
    logFile: logFileFromEnv(),
    // Stage 6 · baseline system: SQLite warm tier + auto-baselines on every
    // git commit change. `PANEL_NO_STORE=1` falls back to memory-only.
    store: process.env.PANEL_NO_STORE === '1' ? false : (process.env.NOLANGUAGE_DB ?? true),
    sessionId: `panel-${Date.now().toString(36)}`,
  });

  // Order matters: `kernel.logger` is only populated by spine installation in
  // `start()`, and startDemo captures a logger — so start first.
  await kernel.start();

  // Best-effort install receipt: one place doctor/update can read "which build
  // is installed here".
  //
  // `NOLANGUAGE_DESKTOP=1` alone is not enough: `nlg desktop` and the
  // verification suites set it while running under node.exe, and a node path in
  // this file makes `nlg doctor` report the interpreter as the installed build —
  // the exact confusion the receipt exists to prevent (0.7.5 found a suite run
  // had left `exePath: …\node.exe` behind). A receipt describes the *installed
  // app*, so it is only written when the running image is not node itself.
  const packagedImage = !/(^|[\\/])node(\.exe)?$/i.test(process.execPath);
  if (process.env.NOLANGUAGE_DESKTOP === '1' && packagedImage) {
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
  const sandboxMinRaw = Number(process.env.SANDBOX_MIN ?? 0);
  const sandboxMaxRaw = Number(process.env.SANDBOX_MAX_WORKERS ?? 8);
  const sandboxIdleRaw = Number(process.env.SANDBOX_SESSION_IDLE ?? 300_000);
  // The panel's regular Run path uses WorkspaceService, not the MCP warm pool;
  // leave the pool cold unless an operator explicitly opts into pre-warming.
  const sandboxMin = Number.isFinite(sandboxMinRaw) ? Math.max(0, Math.floor(sandboxMinRaw)) : 0;
  const sandboxMaxWorkers = Number.isFinite(sandboxMaxRaw) ? Math.max(1, Math.floor(sandboxMaxRaw)) : 8;
  const sandboxSessionIdleMs = Number.isFinite(sandboxIdleRaw) ? Math.max(0, Math.floor(sandboxIdleRaw)) : 300_000;
  try {
    exec = new ExecService(kernel, {
      pythonBin: process.env.PYTHON_BIN,
      goBin: process.env.GO_BIN,
      nodeBin: process.env.NODE_BIN,
      minSize: sandboxMin,
      maxWorkers: sandboxMaxWorkers,
      maxSessionIdleMs: sandboxSessionIdleMs,
      maxIdleMs: Number(process.env.SANDBOX_MAX_IDLE ?? 60_000),
      runTimeoutMs: process.env.PANEL_RUN_TIMEOUT ? Number(process.env.PANEL_RUN_TIMEOUT) : 15_000,
    });
    exec.registerCommands();
    workspace.setExec(exec);
    kernel.logger.root().info('Execution plane ready', { minSize: sandboxMin, maxWorkers: sandboxMaxWorkers, ephemeralIdleMs: sandboxSessionIdleMs });
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
  // Performance cases own `lastProfile` and a cross-client fan-out; see
  // handlers/perf.ts for why those six cases moved out of the switch.
  let perfHandlers: PerfHandlers | undefined;
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
  perfHandlers = new PerfHandlers({
    workspace,
    profiler,
    flame,
    broadcastToOthers: (payload, except) => {
      for (const c of wsClients) {
        if (c === except) continue;
        try {
          c.send(payload);
        } catch {
          /* a closed client missed the update */
        }
      }
    },
  });
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
        // Performance cases live in handlers/perf.ts: they own `lastProfile` and
        // fan out to other windows. Delegating here keeps the switch a routing
        // table instead of a place where state hides.
        case 'profile':
        case 'profileLast':
        case 'profileCaps':
        case 'coverage':
        case 'flameStart':
        case 'flameStop':
          if (perfHandlers) perfHandlers.handle(String(msg.kind), msg, reply, transport);
          break;

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
          handleTerm(String(msg.cmd ?? ''), reply, key, fs.root);
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
      // `takeConnection` removes the entry and hands it back, so a dead
      // connection cannot leave a `ChildProcess` behind.
      const st = takeConnection(key);
      if (st?.termChild) { try { st.termChild.kill('SIGKILL'); } catch { /* gone */ } }
      // A closed window must not keep the CPU profiler (or a debug adapter)
      // alive; both are per-window subscriptions, not per-process services.
      flame.unsubscribe(reply);
      if (st?.dap) void st.dap.stop().catch(() => undefined);
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
    const gzipHtmlCache = new Map<string, Buffer>();

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
          const accepted = String(req.headers['accept-encoding'] ?? '');
          // Parse Accept-Encoding: match "gzip" and check its q-value is not 0.
          const gzipMatch = /(?:^|,\s*)gzip(?:;\s*q=([0-9.]+))?/i.exec(accepted);
          const gzipQ = gzipMatch ? (gzipMatch[1] !== undefined ? parseFloat(gzipMatch[1]) : 1) : 0;
          const wantsGzip = gzipQ > 0;
          const headers: Record<string, string | number> = {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            vary: 'Accept-Encoding',
          };
          if (wantsGzip && Buffer.byteLength(body) >= 16 * 1024) {
            let compressed = gzipHtmlCache.get(body);
            if (!compressed) {
              compressed = gzipSync(Buffer.from(body), { level: 6 });
              gzipHtmlCache.set(body, compressed);
            }
            headers['content-encoding'] = 'gzip';
            headers['content-length'] = compressed.length;
            res.writeHead(200, headers);
            res.end(compressed);
            return;
          }
          res.writeHead(200, headers);
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
 * The message switch below routes; the handlers themselves live in
 * `handlers/`. The run/debug ones were moved out with the connection state
 * (`conn-state.ts`) because they own processes and this file does not.
 */

// ---------------- project explorer ----------------
