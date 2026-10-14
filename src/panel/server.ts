/**
 * Dev server: kernel + PanelHub + WebSocket, hosting two UIs.
 *
 *   /            Workspace (IDE) — write & run Python/Go, see problems/perf/logs
 *   /monitor     live monitoring panel (metrics, slow paths, log stream)
 *   /health      JSON status
 *
 * The WebSocket endpoint is shared by both pages: every client receives the
 * metrics digest / slow paths / log stream, and IDE clients additionally get
 * run / check / completion responses.
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
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Kernel } from '../kernel/Kernel.js';
import { LogLevel } from '../log/LogLevel.js';
import { WebSocketServer, type WebSocketConnection } from './WebSocketServer.js';
import { PanelHub, type PanelFilter, type PanelSink } from './PanelHub.js';
import { renderPanelHtml } from './ui.js';
import { renderIdeHtml } from './ide.js';
import { SAMPLES, LANGUAGES, type LanguageId } from './samples.js';
import { startTraffic } from './traffic.js';
import { WorkspaceService } from './WorkspaceService.js';

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

/** Validate a language id coming off the wire, defaulting to Python. */
function asLanguage(v: unknown): LanguageId {
  return LANGUAGES.some((l) => l.id === v) ? (v as LanguageId) : 'python';
}

export async function main(): Promise<{ base: string; close: () => Promise<void> }> {
  const port = Number(process.env.PANEL_PORT ?? 7310);
  const host = process.env.PANEL_HOST ?? '127.0.0.1';
  const withDemo = process.env.PANEL_NO_DEMO !== '1';
  const withPython = process.env.PANEL_WITH_PYTHON === '1';

  const kernel = new Kernel({
    appVersion: '0.6.0-workspace',
    slowThresholdMs: Number(process.env.PANEL_SLOW_MS ?? 60),
    logLevel: LogLevel.TRACE,
    logPretty: true,
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

  // ---- the editor backend (one slot per language) ----
  const workspace = new WorkspaceService(kernel, {
    pythonBin: process.env.PYTHON_BIN,
    goBin: process.env.GO_BIN,
    runTimeoutMs: process.env.PANEL_RUN_TIMEOUT ? Number(process.env.PANEL_RUN_TIMEOUT) : undefined,
    // Opt-in eager start for every server (useful for benchmarking startup).
    eagerLsp: process.env.PANEL_EAGER_LSP === '1',
  });
  await workspace.init();
  const wsStatus = workspace.status();
  kernel.logger.root().info('Workspace ready', {
    python: wsStatus.pythonBin,
    languages: wsStatus.languages
      .map((l) => `${l.id}${l.available ? '' : '(unavailable)'}`)
      .join(', '),
    lsp: wsStatus.lsp.serverName,
    lspAvailable: wsStatus.lsp.available,
  });

  const hub = new PanelHub(kernel, { pushIntervalMs: 1000 });
  hub.install();
  hub.start();

  const ideHtml = renderIdeHtml(port, SAMPLES, LANGUAGES);
  const monitorHtml = renderPanelHtml(port);

  const ws = new WebSocketServer({
    port,
    host,
    onRequest: (req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      const html = (body: string): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      };
      if (url === '/' || url === '/index.html' || url === '/ide') return html(ideHtml), true;
      if (url === '/monitor' || url === '/panel') return html(monitorHtml), true;
      if (url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            clients: hub.clientCount(),
            appVersion: kernel.appVersion,
            workspace: workspace.status(),
          }),
        );
        return true;
      }
      return false;
    },
  });

  ws.on('connection', (conn: WebSocketConnection) => {
    const remote = conn.remoteAddress + ':' + Math.floor(Math.random() * 1e6);
    const clientId = hub.allocateClientId();
    const reply = (payload: unknown): void => {
      // A client can vanish at any moment (closed tab, killed process). Sending
      // to it must never propagate — one dead socket should not disturb the
      // server or the other clients.
      try {
        conn.send(JSON.stringify(payload));
      } catch {
        /* client gone */
      }
    };
    hub.addClient({ id: clientId, send: reply } as PanelSink);
    // Tell IDE clients what the workspace can do (languages, samples, servers).
    reply({
      kind: 'workspace',
      status: workspace.status(),
      languages: LANGUAGES,
      samples: SAMPLES.map((s) => ({ id: s.id, name: s.name, languageId: s.languageId, mode: s.mode })),
    });
    kernel.logger.root().info('Client connected', { client: remote, clients: hub.clientCount() });

    conn.on('message', (raw: string) => {
      let msg: { kind?: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
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

        // ---------- IDE ----------
        case 'run':
          void handleRun(conn, workspace, msg, reply);
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

        case 'resetSession': {
          const sessionId = String(msg.sessionId ?? 'ide');
          const language = asLanguage(msg.language);
          void workspace.resetSession(language, sessionId).then((reset) => {
            reply({ kind: 'session', sessionId, language, reset });
          });
          break;
        }

        default:
          reply({ kind: 'error', message: `unknown message kind: ${String(msg.kind)}` });
      }
    });

    conn.on('close', () => {
      hub.removeClient(clientId);
      kernel.logger.root().info('Client disconnected', { client: remote, clients: hub.clientCount() });
    });
  });

  const addr = await ws.listen();
  const base = `http://${addr.host}:${addr.port}`;

  kernel.logger.root().info('Dev server ready', {
    workspace: `${base}/`,
    monitor: `${base}/monitor`,
    ws: `ws://${addr.host}:${addr.port}/`,
  });

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

  // The desktop entry (`src/desktop/main.ts`) prints its own banner.
  if (process.env.NOLANGUAGE_QUIET !== '1') {
    if (telemetry) process.stdout.write(`  Telemetry (SQLite)  ->  ${telemetry.path}\n`);
    process.stdout.write(
      `\n  Python Workspace  ->  ${base}/\n` +
        `  Monitor panel     ->  ${base}/monitor\n\n`,
    );
  }

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
    await ws.close();
    await kernel.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  void readFile(join(__dirname, 'ide.ts')).catch(() => undefined); // keep import graph warm

  return { base, close: shutdown };
}

/**
 * True when this module was launched directly — either `node src/panel/server.ts`
 * in development or the packaged `Nolanguage.exe`. The desktop entry
 * (`src/desktop/main.ts`) imports `main()` itself, so it must not double-boot.
 */
const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (!arg) return false; // SEA: no script argument is passed to the entry script
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

async function handleRun(
  conn: WebSocketConnection,
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : 'ide';
  const language = asLanguage(msg.language);
  // `mode` selects `go test` over `go run`; ignored by Python.
  const mode = msg.mode === 'test' ? 'test' : 'run';
  try {
    // Announce the run so the UI can show a busy state before the toolchain boots.
    reply({ kind: 'runStart', runId: `pending-${Date.now()}`, sessionId, language, mode });
    const result = await workspace.run(language, code, {
      sessionId,
      reset: msg.reset === true,
      mode,
    });
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
  const language = asLanguage(msg.language);
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
  const language = asLanguage(msg.language);
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
  const language = asLanguage(msg.language);
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
