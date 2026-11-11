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
import { dumpToStackLines, parseGoroutineDump, pprofUrl } from './agents/go/pprof.js';
import { goAttachGuide } from './agents/go/guide.js';
import { defaultConfig, mergeConfig, type RedactConfig } from './redact.js';
import { normaliseEngineUrl } from './perfLink.js';
import { APP_VERSION } from '../version.js';

export type DebugLanguage = 'python' | 'javascript' | 'go';

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
  /**
   * Redaction rules. Merged over the defaults, so a caller can add names or
   * exempt a field but cannot accidentally un-redact `password`.
   */
  redact?: Partial<RedactConfig>;
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
  /** How the events arrive: a spawned target, a recording, or a pprof endpoint. */
  mode: 'live' | 'replay' | 'attach';
  /** Resolves when the target exits, or when a replay reaches its last line. */
  exited: Promise<number>;
  /** The recording being written, when `record` was given. */
  recorder?: Recorder;
  /** The redaction rules in effect, for the banner. */
  redactConfig: RedactConfig;
  close(): Promise<void>;
}

/** Which runtime runs this file — and whether we can observe it at all. */
export function languageOf(file: string): DebugLanguage | null {
  const ext = extname(file).toLowerCase();
  if (ext === '.py' || ext === '.pyw') return 'python';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  // Go is recognised so `ndebug app.go` can explain what to do instead of
  // claiming the language is unknown. Attaching needs `--attach`; there is no
  // in-process hook to install.
  if (ext === '.go') return 'go';
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
  /** Read at render time: the engine may come up after this page was served. */
  engineUrl?: () => string | undefined;
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
        const engineUrl = opts.engineUrl?.();
        res.end(renderDebugHtml({ port: boundPort, target: opts.target, lang: opts.lang, ...(engineUrl ? { engineUrl } : {}) }));
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
      `cannot observe ${basename(script)}: supported are Python (.py), JavaScript (.js/.mjs/.cjs), and Go via --attach.`,
    );
  }
  if (language === 'go') {
    // Not an error message but a set of instructions: Go cannot be attached from
    // outside, and saying "unsupported" would leave the user with nowhere to go.
    throw new Error(goAttachGuide(script));
  }

  // The session is built first so the recording can carry the token the agent
  // will be given; a recording without it would not survive its own handshake.
  const redactConfig = mergeConfig(defaultConfig(), opts.redact);
  const session = new DebugSession({ hz: opts.hz ?? 10, redact: redactConfig.names, redactAllow: redactConfig.allow });
  const recorder = opts.record
    ? Recorder.open({
        path: opts.record,
        header: {
          tool: 'ndebug',
          version: APP_VERSION,
          lang: language,
          target: basename(script),
          hz: opts.hz ?? 10,
          redact: redactConfig.names,
          token: session.token,
        },
      })
    : undefined;
  if (recorder) session.attachRecorder(recorder);
  await session.listen();

  const agentDir = materialiseAgent();
  const child = spawnTarget(language, script, opts.args ?? [], session, agentDir);

  // The engine is optional and usually absent. Probing in the background keeps
  // startup fast and keeps the link honest: it appears only if /health answered.
  let engineUrl: string | undefined;
  void probeEngine().then((url) => {
    engineUrl = url;
  });

  let served: Served;
  try {
    served = await serve({
      session,
      port: opts.port ?? 7320,
      target: basename(script),
      lang: language,
      engineUrl: () => engineUrl,
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
    mode: 'live',
    exited,
    redactConfig,
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
    mode: 'replay',
    exited,
    recording,
    redactConfig: mergeConfig(defaultConfig()),
    close,
  };
}

export interface AttachAppOptions {
  /** Anything the user might paste: host:port, the pprof index, or the dump URL. */
  url: string;
  port?: number;
  hz?: number;
  quiet?: boolean;
}

export interface AttachApp extends DebugApp {
  /** The normalised dump address actually being polled. */
  dumpUrl: string;
}

/**
 * Observe a Go program through its pprof endpoint.
 *
 * The polling loop *is* the agent here: it produces the same `stack` events an
 * in-process agent would, through the same NDJSON path, so a Go session is
 * recorded, replayed and diffed by exactly the same code as a Python one.
 *
 * The one thing it cannot do is read values, so `caps` is `['stack']` and the
 * page says why instead of showing an empty Inspector.
 */
export async function startAttachApp(opts: AttachAppOptions): Promise<AttachApp> {
  const dumpUrl = pprofUrl(opts.url);
  const hz = opts.hz ?? 10;
  const session = new DebugSession({ hz });

  // A local client faking the handshake. It goes through `ingest` on purpose:
  // the alternative (setting session state directly) would give this path a
  // second, untested way into the engine.
  const hello = (): void => {
    session.ingest(JSON.stringify({
      v: 1,
      t: 'hello',
      token: session.token,
      lang: 'go',
      pid: 0,
      target: dumpUrl,
      agentVersion: 'pprof',
      // No `locals`, no `snapshot`: a dump carries stacks only.
      caps: ['stack'],
    }));
  };
  hello();

  const served = await serve({
    session,
    port: opts.port ?? 7320,
    target: dumpUrl,
    lang: 'go',
    // Same read-only surface as replay: there is no process to evaluate in.
    onCommand: (msg, reply) => {
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

  let busy = false;
  let failures = 0;
  let detached = false;
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      const res = await fetch(dumpUrl, { signal: AbortSignal.timeout(Math.max(1000, Math.round(2000 / hz))) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const goroutines = parseGoroutineDump(await res.text());
      const at = Date.now();
      for (const line of dumpToStackLines(goroutines, at)) session.ingest(line);
      failures = 0;
      // The endpoint came back: say so, instead of leaving the page frozen on
      // "agent exited" for the rest of the session.
      if (detached) {
        detached = false;
        hello();
      }
    } catch {
      failures += 1;
      // Three misses is a real outage, not a slow request. Marking it detached is
      // the difference between "the page is stale" and "the page is wrong".
      if (failures >= 3 && !detached) {
        detached = true;
        session.ingest(JSON.stringify({ v: 1, t: 'bye', reason: `pprof unreachable: ${dumpUrl}` }));
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void poll(), Math.max(50, Math.round(1000 / hz)));
  timer.unref?.();
  void poll();

  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopped = true;
    clearInterval(timer);
    await served.close();
    await session.close();
    resolveExit(0);
  };

  return {
    url: served.url,
    port: served.port,
    session,
    language: 'go',
    mode: 'attach',
    dumpUrl,
    exited,
    redactConfig: mergeConfig(defaultConfig()),
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
 * Is a Nolanguage engine running next to us?
 *
 * 800 ms is a local round-trip with room for a busy machine; a longer wait would
 * delay the page for a feature that is optional. `NOLANGUAGE_ENGINE_URL`
 * overrides the address for a non-default port.
 */
async function probeEngine(): Promise<string | undefined> {
  const base = normaliseEngineUrl(process.env.NOLANGUAGE_ENGINE_URL ?? 'http://127.0.0.1:7310');
  if (!base) return undefined;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true ? base : undefined;
  } catch {
    return undefined;
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
