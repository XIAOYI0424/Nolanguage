/**
 * Python runner (Stage 3, execution side of the closed loop).
 *
 * Spawns `python` on a snippet or file, captures stdout/stderr line-by-line as
 * `user-code` LogRecords (spec 18.2 · UserCodeLogCollector), times the run into
 * `execution.run` metrics, and supports **session persistence**: multiple
 * snippets in one session share a working directory and an accumulated variable
 * namespace (via a small prelude that pickles the globals between runs).
 *
 * Everything shares the sessionId correlation key, so a run's logs, its perf
 * record and its source location can be cross-queried (spec 二十二).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ulid } from '../util/ulid.js';
import { OutputDecoder } from '../util/encoding.js';
import type { Kernel } from '../kernel/Kernel.js';
import type { Logger } from '../log/Logger.js';

export interface RunOptions {
  /** Snippet source. Mutually exclusive with `file`. */
  code?: string;
  /** Run an existing file instead of a snippet. */
  file?: string;
  /** Session id: reuse to share namespace + working dir across runs. */
  sessionId?: string;
  /** Extra argv for the script. */
  args?: string[];
  /** Hard timeout in ms. */
  timeoutMs?: number;
  /** Working directory override (else the session's temp dir). */
  cwd?: string;
  /** Capture each stdout line as a log record (default true). */
  captureOutput?: boolean;
  /** Stream each stdout/stderr chunk live (e.g. to surface prompts / partial output). */
  onData?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Called once the child is spawned; feed its stdin via the sink (interactive `input()`). */
  onStdinReady?: (sink: (data: string) => void) => void;
}

export interface RunResult {
  sessionId: string;
  runId: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Lines emitted, already turned into log records. */
  logLines: number;
  pythonBin: string;
  scriptPath?: string;
}

interface Session {
  id: string;
  dir: string;
  globalsPath: string;
}

const SESSION_PRELUDE = `# --- nolanguage session prelude (auto-generated) ---
import os as _os, sys as _sys, pickle as _pickle, types as _types
_G = _os.environ.get("NOLANGUAGE_GLOBALS")
if _G and _os.path.exists(_G):
    try:
        with open(_G, "rb") as _f:
            globals().update(_pickle.load(_f))
    except Exception as _e:
        print(f"[session] failed to restore state: {_e}", file=_sys.stderr)
`;

const SESSION_EPILOGUE = `
# --- nolanguage session epilogue ---
_G = _os.environ.get("NOLANGUAGE_GLOBALS")
if _G:
    # Persist only *data* that survives a round-trip. Functions/classes/modules
    # are pickled by reference and cannot be restored into a different
    # __main__, so they are skipped — snippets re-declare their own helpers.
    _SKIP = (
        _types.ModuleType, _types.FunctionType, _types.BuiltinFunctionType,
        _types.MethodType, _types.LambdaType, type,
    )
    _keep = {}
    for _k, _v in list(globals().items()):
        if _k.startswith("_"):
            continue
        if isinstance(_v, _SKIP):
            continue
        try:
            _pickle.loads(_pickle.dumps(_v))
        except Exception:
            continue
        _keep[_k] = _v
    try:
        with open(_G, "wb") as _f:
            _pickle.dump(_keep, _f)
    except Exception as _e:
        print(f"[session] failed to persist state: {_e}", file=_sys.stderr)
`;

export class PythonRunner {
  private sessions = new Map<string, Session>();
  private readonly pythonBin: string;

  constructor(private kernel: Kernel, pythonBin = process.env.PYTHON_BIN ?? 'python') {
    this.pythonBin = pythonBin;
  }

  get binary(): string {
    return this.pythonBin;
  }

  /** Create (or fetch) a persistent session: shared dir + variable namespace. */
  async session(sessionId?: string): Promise<Session> {
    const id = sessionId ?? `sess-${ulid().slice(-10)}`;
    let s = this.sessions.get(id);
    if (!s) {
      const dir = await mkdtemp(join(tmpdir(), 'nolanguage-'));
      s = { id, dir, globalsPath: join(dir, '.nolanguage_globals.pickle') };
      this.sessions.set(id, s);
      this.kernel.logger
        .forExecution('execution.session', id)
        .info('Session created', { sessionId: id, dir });
    }
    return s;
  }

  /**
   * Drop a session: its persisted namespace and temp directory are discarded,
   * so the next run starts from a clean interpreter state.
   */
  async resetSession(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    await rm(s.globalsPath, { force: true }).catch(() => undefined);
    this.sessions.delete(sessionId);
    this.kernel.logger
      .forExecution('execution.session', sessionId)
      .info('Session reset', { sessionId });
    return true;
  }

  /** Number of live sessions (for the UI status bar). */
  sessionCount(): number {
    return this.sessions.size;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const session = await this.session(opts.sessionId);
    const runId = `run-${ulid().slice(-10)}`;
    const log = this.kernel.logger
      .forExecution(`execution.python`, session.id)
      .withContext({ sessionId: session.id, requestId: runId });

    const span = this.kernel.tracer.startSpan('execution.run', {
      attributes: { languageId: 'python', sessionId: session.id, runId },
    });
    const runLog = log.span(span);

    // Materialise the script (with session prelude/epilogue for snippets).
    let scriptPath: string | undefined;
    if (opts.code !== undefined) {
      scriptPath = join(session.dir, `${runId}.py`);
      await writeFile(scriptPath, SESSION_PRELUDE + '\n' + opts.code + '\n' + SESSION_EPILOGUE, 'utf8');
    } else if (opts.file) {
      scriptPath = opts.file;
    } else {
      throw new Error('PythonRunner.run requires either `code` or `file`');
    }

    const cwd = opts.cwd ?? session.dir;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const t0 = performance.now();

    runLog.info('Running Python', {
      script: scriptPath,
      cwd,
      sessionId: session.id,
      python: this.pythonBin,
    });

    const child = spawn(this.pythonBin, ['-u', scriptPath, ...(opts.args ?? [])], {
      cwd,
      env: { ...process.env, NOLANGUAGE_GLOBALS: session.globalsPath, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const decoders = { stdout: new OutputDecoder(), stderr: new OutputDecoder() };
    let logLines = 0;
    const capture = opts.captureOutput !== false;
    const userLog = this.kernel.logger.forUserCode('python', session.id);

    const onLine = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      const text = decoders[stream].push(chunk);
      (stream === 'stdout' ? stdoutChunks : stderrChunks).push(text);
      opts.onData?.(stream, text);
      if (!capture) return;
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        logLines++;
        const fields = { stream, runId, line: logLines };
        if (stream === 'stderr') {
          // Python tracebacks surface as errors; plain prints as info.
          if (/^(Traceback|\s+File "|\w*Error:|\w*Exception:)/.test(line) || /Error:/.test(line)) {
            userLog.error(line, fields);
          } else {
            userLog.warn(line, fields);
          }
        } else {
          userLog.info(line, fields);
        }
      }
    };
    child.stdout.on('data', onLine('stdout'));
    child.stderr.on('data', onLine('stderr'));
    // Keep stdin open and hand the caller a writer so interactive `input()`
    // works — the panel can pipe a user's keystrokes straight into the process.
    if (opts.onStdinReady) {
      const sink = (d: string): void => {
        try { child.stdin?.write(d); } catch { /* closed */ }
      };
      opts.onStdinReady(sink);
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      runLog.error('Execution timed out', { timeoutMs, sessionId: session.id });
      child.kill('SIGKILL');
    }, timeoutMs);

    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('error', (err) => {
        runLog.error('Failed to spawn Python', { python: this.pythonBin }, err);
        resolve({ code: -1, signal: null });
      });
      child.on('close', (code, signal) => resolve({ code, signal: signal ?? null }));
    });
    clearTimeout(timer);

    const durationMs = performance.now() - t0;
    const m = this.kernel.perfMetrics();
    m.record('execution.run', durationMs);
    m.record(`execution.run.python`, durationMs);
    m.record('execution.lines', logLines);

    const stdout = stdoutChunks.join('') + decoders.stdout.flush();
    const stderr = stderrChunks.join('') + decoders.stderr.flush();
    const ok = exit.code === 0 && !timedOut;
    if (ok) {
      runLog.info('Python finished', { durationMs: Math.round(durationMs), lines: logLines, exitCode: exit.code });
    } else {
      runLog.error('Python failed', {
        durationMs: Math.round(durationMs),
        exitCode: exit.code,
        signal: exit.signal,
        timedOut,
      });
    }
    span.setAttribute('exitCode', exit.code).end();

    // Clean up the generated snippet but keep the session dir + globals.
    if (opts.code !== undefined && scriptPath) {
      await rm(scriptPath, { force: true }).catch(() => undefined);
    }

    return {
      sessionId: session.id,
      runId,
      exitCode: exit.code,
      signal: exit.signal,
      durationMs,
      stdout,
      stderr,
      timedOut,
      logLines,
      pythonBin: this.pythonBin,
      scriptPath: opts.file,
    };
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) {
      await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.sessions.clear();
  }
}
