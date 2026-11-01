/**
 * `ndebug` — the standalone debug observatory.
 *
 *   ndebug samples/py/app.py            # attach, serve the page, open a browser
 *   ndebug app.py --hz 20 --port 7320 --no-open
 *
 * The app owns three things: a `DebugSession` (the socket the agent talks to),
 * a `WebSocketServer` (the page), and the child process (the program being
 * observed). It deliberately does *not* own the program's lifecycle semantics —
 * no breakpoints, no pause — so a crash in the observatory can never strand the
 * target in a weird state; the worst case is that sampling stops.
 *
 * The agent sources are embedded as text and materialised into a temp directory
 * on every run. That is what makes the same code work from source and from a
 * packaged single-file executable, where `src/` does not exist on disk.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, extname, resolve } from 'node:path';
import agentPy from './agents/python/nlg_agent.py?raw';
import sitecustomizePy from './agents/python/sitecustomize.py?raw';
import { DebugSession, type SessionView } from './session.js';
import { WebSocketServer, type WebSocketConnection } from '../panel/WebSocketServer.js';
import { renderDebugHtml } from './ui.js';

export type DebugLanguage = 'python' | 'javascript';

export interface DebugAppOptions {
  /** Script to observe. Resolved against the caller's cwd. */
  script: string;
  /** Page port; 0 lets the OS pick (tests use this). */
  port?: number;
  /** Sampling rate handed to the agent. */
  hz?: number;
  /** Open a browser window once the page is up. */
  open?: boolean;
  /** Extra arguments for the target, after `--`. */
  args?: string[];
  /** Suppress the CLI banner (tests). */
  quiet?: boolean;
}

export interface DebugApp {
  url: string;
  port: number;
  session: DebugSession;
  language: DebugLanguage;
  /** Resolves with the target's exit code (or 1 when it could not start). */
  exited: Promise<number>;
  close(): Promise<void>;
}

/** Which runtime runs this file — and whether we can observe it at all. */
export function languageOf(file: string): DebugLanguage | null {
  const ext = extname(file).toLowerCase();
  if (ext === '.py' || ext === '.pyw') return 'python';
  // The JS agent (inspector window sampling) is M2; refusing is better than
  // attaching and showing nothing.
  return null;
}

/** Start the observatory and the target. Does not open a browser. */
export async function startDebugApp(opts: DebugAppOptions): Promise<DebugApp> {
  const script = resolve(opts.script);
  const language = languageOf(script);
  if (!language) {
    throw new Error(
      `cannot observe ${basename(script)}: only Python is supported so far (the JS agent is M2). ` +
        `Supported: .py`,
    );
  }

  const session = new DebugSession({ hz: opts.hz ?? 10 });
  await session.listen();

  const agentDir = materialiseAgent();
  const child = spawnTarget(language, script, opts.args ?? [], session, agentDir);

  const port = opts.port ?? 7320;
  const html = renderDebugHtml({ port, target: basename(script), lang: language });
  const ws = new WebSocketServer({
    port,
    host: '127.0.0.1',
    pingIntervalMs: 15_000,
    // The page and the health probe are the only HTTP routes; everything else
    // 404s, so a stray request cannot enumerate anything.
    onRequest: (req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return true;
      }
      if (url === '/health') {
        const view = session.view();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: view.state, samples: view.samples, target: view.target ?? '' }));
        return true;
      }
      return false;
    },
  });
  const bound = await ws.listen();

  // One aggregate at 4 Hz: cheap to compute, small on the wire, and the page
  // never has to merge partial updates.
  const ticker = setInterval(() => broadcast(ws, { kind: 'view', view: session.view() }), 250);
  ticker.unref?.();

  session.on('attached', () => broadcast(ws, { kind: 'view', view: session.view() }));
  session.on('snapshot', (snapshot) => broadcast(ws, { kind: 'snapshot', snapshot }));

  ws.on('connection', (conn: WebSocketConnection) => {
    conn.send(JSON.stringify({ kind: 'view', view: session.view() }));
    conn.on('message', (text: string) => handleCommand(session, text));
  });

  const exited = new Promise<number>((resolveExit) => {
    child.on('close', (code) => {
      // The agent's `bye` usually lands first; give the socket a tick so the
      // final view is the detached one, then settle.
      setTimeout(() => {
        broadcast(ws, { kind: 'view', view: session.view() });
        resolveExit(typeof code === 'number' ? code : 1);
      }, 150);
    });
    child.on('error', (err) => {
      if (!opts.quiet) console.error(`[ndebug] failed to start ${basename(script)}: ${err.message}`);
      resolveExit(1);
    });
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    await ws.close();
    await session.close();
    rmSync(agentDir, { recursive: true, force: true });
  };

  return {
    url: `http://127.0.0.1:${bound.port}/`,
    port: bound.port,
    session,
    language,
    exited,
    close,
  };
}

function broadcast(ws: WebSocketServer, msg: unknown): void {
  ws.broadcast(JSON.stringify(msg));
}

function handleCommand(session: DebugSession, text: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (msg.kind) {
    case 'watch-add': {
      const expr = typeof msg.expr === 'string' ? msg.expr : '';
      if (!expr) return;
      const current = session.view().watches.map((w) => w.expr);
      session.setWatches([...current, expr]);
      return;
    }
    case 'watch-remove': {
      const expr = typeof msg.expr === 'string' ? msg.expr : '';
      session.setWatches(session.view().watches.map((w) => w.expr).filter((w) => w !== expr));
      return;
    }
    case 'snapshot':
      session.requestSnapshot(typeof msg.path === 'string' && msg.path ? msg.path : 'locals');
      return;
    case 'ping':
      return;
    default:
      return;
  }
}

/** Write the embedded agent into a temp dir; returns its path. */
function materialiseAgent(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ndebug-agent-'));
  writeFileSync(resolve(dir, 'nlg_agent.py'), agentPy, 'utf8');
  writeFileSync(resolve(dir, 'sitecustomize.py'), sitecustomizePy, 'utf8');
  return dir;
}

function spawnTarget(
  language: DebugLanguage,
  script: string,
  args: string[],
  session: DebugSession,
  agentDir: string,
): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, ...session.agentEnv() };
  // Keep the user's own PYTHONPATH: a project that relies on it must not break
  // because we attached.
  const existing = process.env.PYTHONPATH;
  env.PYTHONPATH = existing ? agentDir + delimiter + existing : agentDir;

  const bin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  // `-u`: unbuffered, so the program's own output interleaves honestly with the
  // observatory's log lines. cwd stays the caller's: `ndebug sub/app.py` should
  // behave like `python sub/app.py` from where it was typed.
  const child = spawn(bin, ['-u', script, ...args], {
    cwd: process.cwd(),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  return child;
}

/** The last view, for tests that do not want to speak WebSocket. */
export function summarise(view: SessionView): string {
  return `${view.state} · ${view.samples} samples · ${view.hot.length} stacks · ${view.watches.length} watches`;
}
