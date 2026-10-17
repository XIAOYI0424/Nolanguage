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
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Kernel } from '../kernel/Kernel.js';
import { LogLevel } from '../log/LogLevel.js';
import { WebSocketServer, type WebSocketConnection } from './WebSocketServer.js';
import { PanelHub, type PanelFilter, type PanelSink } from './PanelHub.js';
import { renderPanelHtml } from './ui.js';
import { renderPerfHtml } from './perf-ui.js';
import { renderExtensionsHtml } from './extensions-ui.js';
import { renderPyCharmHtml } from './pycharm-ui.js';
import { SAMPLES, type LanguageId } from './samples.js';
import { startTraffic } from './traffic.js';
import { WorkspaceService } from './WorkspaceService.js';
import type { RegistryRoot } from '../langs/Registry.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { ExecService } from '../exec/ExecService.js';
import { ProfilerService } from '../profiler/ProfilerService.js';
import type { SandboxLanguage } from '../exec/types.js';
import { FsService, FsError } from './FsService.js';
import { ExtensionManager } from '../extensions/ExtensionManager.js';
import { materializeAssets } from '../desktop/embeddedAssets.js';
import { StdioTransport, WsTransport, parseFrame, type Transport } from './Transport.js';

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
  return Object.fromEntries(pins.filter((p): p is [string, string] => !!p[1]));
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
  const fromEnv = (process.env.LANG_DIR ?? '')
    .split(/[:;]/)
    .filter(Boolean)
    .map((p) => ({ dir: resolve(p), kind: 'builtin' as const, removable: false }));
  const repo = [join(__dirname, '..', '..', 'builtin'), join(process.cwd(), 'builtin')]
    .filter((d) => existsSync(d))
    .map((d) => ({ dir: d, kind: 'builtin' as const, removable: false }));
  const unpacked = materializeAssets('builtin');
  const embedded: RegistryRoot[] = unpacked ? [{ dir: unpacked, kind: 'builtin', removable: false }] : [];
  const seen = new Set<string>();
  return [...fromEnv, ...repo, ...embedded].filter((r) => {
    const key = r.dir.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

export async function main(opts: MainOptions = {}): Promise<{ base: string; close: () => Promise<void> }> {
  const port = Number(process.env.PANEL_PORT ?? 7310);
  const host = process.env.PANEL_HOST ?? '127.0.0.1';
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
    appVersion: '0.6.0-workspace',
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

  // ---- Stage 10 · user-code profiler (Python cProfile / Go pprof) ----
  let profiler: ProfilerService | undefined;
  try {
    profiler = new ProfilerService(kernel, {
      pythonBin: process.env.PYTHON_BIN,
      goBin: process.env.GO_BIN,
    });
    profiler.registerCommands();
    kernel.logger.root().info('Profiler ready', {
      python: profiler.python.binary,
      go: profiler.go.binary,
      goAvailable: profiler.go.available,
    });
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

  const hub = new PanelHub(kernel, { pushIntervalMs: 1000 });
  hub.install();
  hub.start();

  /**
   * Wire one client to the engine. Everything below is transport-agnostic: the
   * router only knows `send` / `onMessage` / `onClose`, which is why the same
   * code serves a browser tab and the Tauri sidecar unchanged.
   *
   * `label` is for logging only; `key` is this client's identity for the
   * interactive-execution state (terminal child, run stdin sink).
   */
  const attachClient = (transport: Transport, label: string, key: object): void => {
    const clientId = hub.allocateClientId();
    const reply = (payload: unknown): void => transport.send(payload);

    hub.addClient({ id: clientId, send: reply } as PanelSink);
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
    kernel.logger.root().info('Client connected', { client: label, clients: hub.clientCount() });

    transport.onMessage((raw: string) => {
      const msg = parseFrame(raw);
      if (!msg) {
        reply({ kind: 'error', message: 'invalid JSON' });
        return;
      }
      switch (msg.kind) {
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
            .then((r) => reply({ kind: 'profileResult', ...r }))
            .catch((err: unknown) =>
              reply({ kind: 'profileResult', ok: false, error: (err as Error).message, hotspots: [], sampleCount: 0 }),
            );
          break;
        }

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
    const extensionsHtml = renderExtensionsHtml(port);
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
        if (url === '/extensions') return html(extensionsHtml), true;
        if (url === '/pycharm' || url === '/ide-pycharm') return html(pycharmHtml), true;
        if (url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              clients: hub.clientCount(),
              appVersion: kernel.appVersion,
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
    await pythonLoop?.stop();
    await workspace.close();
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

  return { base, close: shutdown };
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
const connState = new Map<unknown, { runSink?: (d: string) => void; termChild?: ChildProcess }>();
function stateFor(conn: unknown): { runSink?: (d: string) => void; termChild?: ChildProcess } {
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
