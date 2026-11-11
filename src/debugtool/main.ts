/**
 * `ndebug` — the standalone debug observatory.
 *
 *   ndebug samples/py/app.py            # attach, serve the page, open a browser
 *   ndebug app.py --hz 20 --port 7320 --no-open
 *   ndebug app.py --record run.ndlog    # keep the session on disk
 *   ndebug --replay run.ndlog --speed 4 # watch it again, no target needed
 *
 * The app owns three things: a `DebugSession` (the socket the agent talks to),
 * a `WebSocketServer` (the page), and the child process (the program being
 * observed). It deliberately does *not* own the program's lifecycle semantics —
 * no breakpoints, no pause — so a crash in the observatory can never strand the
 * target in a weird state; the worst case is that sampling stops.
 *
 * Live and replay share the same page-serving path on purpose. A replay that
 * rendered through different code would be a different tool, and the point of a
 * recording is to see exactly what the live session showed.
 *
 * The agent sources are embedded as text and materialised into a temp directory
 * on every run. That is what makes the same code work from source and from a
 * packaged single-file executable, where `src/` does not exist on disk.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, extname, resolve } from 'node:path';
import agentJs from './agents/js/nlg_agent.js?raw';
import agentPy from './agents/python/nlg_agent.py?raw';
import sitecustomizePy from './agents/python/sitecustomize.py?raw';
import { DebugSession, type SessionView } from './session.js';
import { WebSocketServer, type WebSocketConnection } from '../panel/WebSocketServer.js';
import { renderDebugHtml } from './ui.js';
import { Recorder, describeRecording, playback, readRecording, type Playback, type Recording } from './recorder.js';
import { APP_VERSION } from '../version.js';

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
  /** Write every accepted agent line to this path. */
  record?: string;
}

export interface ReplayAppOptions {
  /** Recording to play back. */
  file: string;
  port?: number;
  /** 1 = real time, 0 = as fast as possible. */
  speed?: number;
  quiet?: boolean;
}

export interface DebugApp {
  url: string;
  port: number;
  session: DebugSession;
  language: string;
  /** Resolves when the target exits, or when a replay reaches its last line. */
  exited: Promise<number>;
  /** The recording being written, when `record` was given. */
  recorder?: Recorder;
  close(): Promise<void>;
}

/** Which runtime runs this file — and whether we can observe it at all. */
export function languageOf(file: string): DebugLanguage | null {
  const ext = extname(file).toLowerCase();
  if (ext === '.py' || ext === '.pyw') return 'python';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  return null;
}

interface Served {
  port: number;
  url: string;
  broadcast: (msg: unknown) => void;
  close: () => Promise<void>;
}

/**
 * Serve the page and push one aggregate at 4 Hz.
 *
 * 4 Hz is chosen against both ends: fast enough that a stall is visible while it
 * happens, slow enough that the page never has to merge partial updates and a
 * slow tab cannot make the engine drop agent events.
 */
async function serve(opts: {
  session: DebugSession;
  port: number;
  target: string;
  lang: string;
  onCommand: (msg: Record<string, unknown>, reply: (payload: unknown) => void) => void;
}): Promise<Served> {
  const { session } = opts;
  let boundPort = opts.port;

  const ws = new WebSocketServer({
    port: opts.port,
    host: '127.0.0.1',
    pingIntervalMs: 15_000,
    // The page and the health probe are the only HTTP routes; everything else
    // 404s, so a stray request cannot enumerate anything.
    onRequest: (req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        // Rendered per request so the footer shows the port the OS actually
        // bound (port 0 means "pick one"), not the one that was requested.
        res.end(renderDebugHtml({ port: boundPort, target: opts.target, lang: opts.lang }));
        return true;
      }
      if (url === '/health') {
        const view = session.view();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          state: view.state,
          samples: view.samples,
          target: view.target ?? '',
          ...(view.replay ? { replay: view.replay } : {}),
        }));
        return true;
      }
      return false;
    },
  });

  const bound = await ws.listen();
  boundPort = bound.port;

  const broadcast = (msg: unknown): void => ws.broadcast(JSON.stringify(msg));
  const ticker = setInterval(() => broadcast({ kind: 'view', view: session.view() }), 250);
  ticker.unref?.();

  ws.on('connection', (conn: WebSocketConnection) => {
    conn.send(JSON.stringify({ kind: 'view', view: session.view() }));
    conn.on('message', (text: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      opts.onCommand(msg, broadcast);
    });
  });

  return {
    port: bound.port,
    url: `http://127.0.0.1:${bound.port}/`,
    broadcast,
    close: async () => {
      clearInterval(ticker);
      await ws.close();
    },
  };
}

/** Start the observatory and the target. Does not open a browser. */
export async function startDebugApp(opts: DebugAppOptions): Promise<DebugApp> {
  const script = resolve(opts.script);
  const language = languageOf(script);
  if (!language) {
    throw new Error(
      `cannot observe ${basename(script)}: supported languages are Python (.py) and JavaScript (.js/.mjs/.cjs).`,
    );
  }

  // The session is built first so the recording can carry the token the agent
  // will be given; a recording without it would not survive its own handshake.
  const session = new DebugSession({ hz: opts.hz ?? 10 });
  const recorder = opts.record
    ? Recorder.open({
        path: opts.record,
        header: {
          tool: 'ndebug',
          version: APP_VERSION,
          lang: language,
          target: basename(script),
          hz: opts.hz ?? 10,
          redact: [],
          token: session.token,
        },
      })
    : undefined;
  if (recorder) session.attachRecorder(recorder);
  await session.listen();

  const agentDir = materialiseAgent();
  const child = spawnTarget(language, script, opts.args ?? [], session, agentDir);

  let served: Served;
  try {
    served = await serve({
      session,
      port: opts.port ?? 7320,
      target: basename(script),
      lang: language,
      onCommand: (msg, reply) => handleCommand(session, msg, reply),
    });
  } catch (err) {
    // The child is already running at this point: a busy port must not leave an
    // orphaned program and a temp agent directory behind.
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await session.close();
    recorder?.close();
    removeAgentDir(agentDir);
    throw new Error(`cannot serve the page on port ${opts.port ?? 7320}: ${(err as Error).message}`);
  }

  session.on('attached', () => served.broadcast({ kind: 'view', view: session.view() }));
  session.on('snapshot', (snapshot) => served.broadcast({ kind: 'snapshot', snapshot }));

  const exited = new Promise<number>((resolveExit) => {
    child.on('close', (code) => {
      // The agent's `bye` usually lands first; give the socket a tick so the
      // final view is the detached one, then settle.
      setTimeout(() => {
        served.broadcast({ kind: 'view', view: session.view() });
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
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    await served.close();
    await session.close();
    recorder?.close();
    removeAgentDir(agentDir);
  };

  return {
    url: served.url,
    port: served.port,
    session,
    language,
    exited,
    ...(recorder ? { recorder } : {}),
    close,
  };
}

/**
 * Play a recording back through the same page.
 *
 * No agent, no child process, no socket: the recorded lines are handed to a
 * `DebugSession` exactly as the agent would have sent them, which is why the
 * page needs no replay-specific code.
 */
export async function startReplayApp(opts: ReplayAppOptions): Promise<DebugApp & { recording: Recording }> {
  const recording = readRecording(opts.file);
  const speed = opts.speed ?? 1;
  // Reuse the recorded token: the `hello` in the file carries it, and the
  // handshake would otherwise reject the recording it came from.
  const session = new DebugSession({
    hz: recording.header.hz || 10,
    ...(recording.header.token ? { token: recording.header.token } : {}),
  });
  session.beginReplay({ file: basename(recording.path), total: recording.lines.length, speed });

  const served = await serve({
    session,
    port: opts.port ?? 7320,
    target: recording.header.target || basename(recording.path),
    lang: recording.header.lang || '?',
    // Nothing to ask: the target is gone. Accepting the command would leave the
    // page waiting for a value that can never arrive.
    onCommand: (msg, reply) => {
      // Nothing to evaluate: the target is gone. Diffing recorded values is the
      // one thing that still makes sense, so that is the only command accepted.
      if (msg.kind === 'ping') return;
      if (msg.kind === 'diff') {
        const view = session.diff(String(msg.id ?? 'live-locals'));
        if (view) reply({ kind: 'diff', diff: view });
        return;
      }
      if (msg.kind === 'baseline') session.setBaseline(String(msg.id ?? 'live-locals'));
      if (msg.kind === 'baseline-clear') session.clearBaseline(typeof msg.id === 'string' ? msg.id : undefined);
      if (msg.kind === 'baseline' || msg.kind === 'baseline-clear') {
        reply({ kind: 'view', view: session.view() });
      }
    },
  });

  let player: Playback | undefined;
  const exited = new Promise<number>((resolveExit) => {
    player = playback(recording, {
      speed,
      onLine: (line) => session.ingest(line),
      onProgress: (position) => session.advanceReplay(position, position >= recording.lines.length),
      onDone: () => {
        session.advanceReplay(recording.lines.length, true);
        served.broadcast({ kind: 'view', view: session.view() });
        if (!opts.quiet) {
          process.stdout.write(`\n  replay finished — ${recording.lines.length} events; the page keeps the last state\n`);
        }
        resolveExit(0);
      },
    });
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    player?.stop();
    await served.close();
    await session.close();
  };

  return {
    url: served.url,
    port: served.port,
    session,
    language: recording.header.lang || '?',
    exited,
    recording,
    close,
  };
}

function handleCommand(
  session: DebugSession,
  msg: Record<string, unknown>,
  reply: (payload: unknown) => void,
): void {
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
    case 'baseline': {
      const id = typeof msg.id === 'string' && msg.id ? msg.id : 'live-locals';
      session.setBaseline(id);
      // The page needs to see the baseline in `view.baselines` before it can
      // enable the diff button; waiting for the next 4 Hz tick makes the button
      // feel broken for a quarter second.
      reply({ kind: 'view', view: session.view() });
      return;
    }
    case 'diff': {
      const view = session.diff(typeof msg.id === 'string' && msg.id ? msg.id : 'live-locals');
      // `undefined` means "no baseline yet", which is a state the page already
      // reflects by disabling the button; answering with an error would be noise.
      if (view) reply({ kind: 'diff', diff: view });
      return;
    }
    case 'baseline-clear':
      session.clearBaseline(typeof msg.id === 'string' ? msg.id : undefined);
      reply({ kind: 'view', view: session.view() });
      return;
    case 'ping':
      return;
    default:
      return;
  }
}

/**
 * Delete the agent directory, tolerating Windows' short-lived file locks.
 *
 * A killed interpreter can still hold `sitecustomize.py` open for a few
 * milliseconds after exit (the module is memory-mapped), so an immediate
 * `rmSync` fails with EBUSY and the directory survives every run. Retrying is
 * the fix; failing to clean up must never surface as an error.
 */
function removeAgentDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  } catch {
    /* best effort: a leftover temp directory is not worth failing a session */
  }
}

/**
 * The node binary to run a JS target with.
 *
 * `process.execPath` is the right answer from source and the **wrong** answer
 * when packaged: it points at NDebug.exe, which would re-run the observatory
 * instead of the user's script. So it is only trusted when it really is node.
 */
function nodeBinary(): string {
  if (process.env.NODE_BIN) return process.env.NODE_BIN;
  const own = process.execPath;
  return /(^|[\\/])node(\.exe)?$/i.test(own) ? own : 'node';
}

/** Write the embedded agent into a temp dir; returns its path. */
function materialiseAgent(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ndebug-agent-'));
  writeFileSync(resolve(dir, 'nlg_agent.py'), agentPy, 'utf8');
  writeFileSync(resolve(dir, 'sitecustomize.py'), sitecustomizePy, 'utf8');
  writeFileSync(resolve(dir, 'nlg_agent.js'), agentJs, 'utf8');
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

  const isJs = language === 'javascript';
  const bin = isJs ? nodeBinary() : process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  // Python: `-u` unbuffered, injected through PYTHONPATH + sitecustomize.
  // Node: `--require` the agent; argv and the script itself stay untouched.
  // cwd stays the caller's: `ndebug sub/app.py` should behave like
  // `python sub/app.py` from where it was typed.
  const argv = isJs
    ? ['--require', resolve(agentDir, 'nlg_agent.js'), script, ...args]
    : ['-u', script, ...args];
  const child = spawn(bin, argv, {
    cwd: process.cwd(),
    env,
    windowsHide: true,
    // stdin is **inherited**, not ignored: a program that calls `input()` must
    // still work under the observatory, otherwise attaching changes behaviour
    // (and `input()` on a closed stdin raises EOFError immediately).
    // stdout/stderr stay piped so we can forward them unchanged.
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  return child;
}

/** The last view, for tests that do not want to speak WebSocket. */
export function summarise(view: SessionView): string {
  return `${view.state} · ${view.samples} samples · ${view.hot.length} stacks · ${view.watches.length} watches`;
}

/** Re-exported so the CLI can describe a recording without importing two modules. */
export { describeRecording };
