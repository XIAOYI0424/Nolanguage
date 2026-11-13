/**
 * Process plumbing shared by every runtime extension.
 *
 * Two rules inherited from the rest of the engine, both learned the hard way:
 *
 *  - **Never `spawnSync`.** It is blocked (EBUSY) in this environment and it
 *    freezes the UI thread. Everything here is async `spawn`.
 *  - **`windowsHide: true` always.** A language toolchain must never flash a
 *    console window over the editor.
 */
import { spawn } from 'node:child_process';
import type { RuntimeLogger, RunStep } from './types.js';

export interface CaptureOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  log?: RuntimeLogger;
  /**
   * Where *program* output goes. Defaults to `log`; runtimes pass the kernel's
   * `user-code` scope so the Logs tab can separate "what the user's program
   * printed" from "what the engine did".
   */
  userLog?: RuntimeLogger;
  logScope?: string;
  runId?: string;
  onData?: (stream: 'stdout' | 'stderr', text: string) => void;
  onStdinReady?: (sink: (data: string) => void) => void;
  /** Count non-empty lines into the log (used for `execution.lines`). */
  captureLines?: boolean;
  /** Maximum retained stdout/stderr bytes per stream (default 4 MiB). */
  maxCaptureBytes?: number;
  /** Optional independent limits, used to cap a multi-step run across steps. */
  maxStdoutCaptureBytes?: number;
  maxStderrCaptureBytes?: number;
  /** Maximum output lines copied into telemetry (default 10,000 total). */
  maxLogLines?: number;
  /**
   * Cancellation from the host (the IDE's Stop button). Aborting kills the
   * child with SIGKILL — a runaway program must not outlive the button that
   * asked it to die — and resolves the promise as `cancelled`.
   */
  signal?: AbortSignal;
}

export interface CaptureResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  logLinesTruncated: boolean;
  timedOut: boolean;
  /** True when the host aborted the run rather than the program exiting. */
  cancelled: boolean;
  logLines: number;
  durationMs: number;
}

/**
 * Split a command template into argv, honouring double quotes so a plugin can
 * write `"{workdir}/my program"` on Windows.
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '"') {
      quoted = !quoted;
      has = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

export interface Substitutions {
  file: string;
  workdir: string;
  basename: string;
  data: string;
  /** Resolved toolchain path, for `{toolchain}` in a step command. */
  toolchain?: string;
}

/** Replace `{file}` / `{workdir}` / `{basename}` / `{exe}` / `{data}` / `{toolchain}`. */
export function substitute(text: string, vars: Substitutions): string {
  const exe = process.platform === 'win32' ? '.exe' : '';
  return text
    .replace(/\{file\}/g, vars.file)
    .replace(/\{workdir\}/g, vars.workdir)
    .replace(/\{basename\}/g, vars.basename)
    .replace(/\{data\}/g, vars.data)
    .replace(/\{toolchain\}/g, vars.toolchain ?? '')
    .replace(/\{exe\}/g, exe);
}

/** True when a step's command is fully specified (non-empty). */
export function isRunnableStep(step: RunStep): boolean {
  return typeof step.cmd === 'string' && step.cmd.trim().length > 0;
}

/** Spawn, capture, time out. Never throws on a non-zero exit. */
export function capture(command: string, argv: string[], opts: CaptureOptions): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolve) => {
    const started = Date.now();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const defaultCaptureLimit = opts.maxCaptureBytes ?? 4 * 1024 * 1024;
    const stdoutCaptureLimit = Math.max(0, Math.floor(opts.maxStdoutCaptureBytes ?? defaultCaptureLimit));
    const stderrCaptureLimit = Math.max(0, Math.floor(opts.maxStderrCaptureBytes ?? defaultCaptureLimit));
    const logLineLimit = Math.max(0, Math.floor(opts.maxLogLines ?? 10_000));
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let logLines = 0;
    let logLinesTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal,
        stdout: stdout.join('') + (stdoutTruncated ? `\n[stdout truncated at ${stdoutCaptureLimit} bytes]\n` : ''),
        stderr: stderr.join('') + (stderrTruncated ? `\n[stderr truncated at ${stderrCaptureLimit} bytes]\n` : ''),
        stdoutBytes,
        stderrBytes,
        stdoutTruncated,
        stderrTruncated,
        logLinesTruncated,
        timedOut,
        cancelled,
        logLines,
        durationMs: Date.now() - started,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, argv, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    } catch (err) {
      stderr.push(`${(err as Error).message}\n`);
      finish(-1, null);
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      opts.log?.error('Execution timed out', { timeoutMs: opts.timeoutMs, command });
      child.kill('SIGKILL');
    }, Math.max(250, opts.timeoutMs));

    /** The host aborted (Stop button): kill first, let `close` resolve. */
    function onAbort(): void {
      if (settled) return;
      cancelled = true;
      opts.log?.info('Execution cancelled', { runId: opts.runId, command });
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const onChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const list = stream === 'stdout' ? stdout : stderr;
      const used = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const streamLimit = stream === 'stdout' ? stdoutCaptureLimit : stderrCaptureLimit;
      const remaining = Math.max(0, streamLimit - used);
      const bytes = Buffer.byteLength(text);
      let accepted = text;
      if (bytes > remaining) {
        let lo = 0, hi = text.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (Buffer.byteLength(text.slice(0, mid)) <= remaining) lo = mid;
          else hi = mid - 1;
        }
        accepted = text.slice(0, lo);
        if (stream === 'stdout') stdoutTruncated = true; else stderrTruncated = true;
      }
      if (accepted) list.push(accepted);
      const acceptedBytes = Buffer.byteLength(accepted);
      if (stream === 'stdout') stdoutBytes += acceptedBytes; else stderrBytes += acceptedBytes;
      // Cap the live WebSocket stream as well as the retained result. The UI
      // adds a visible truncation notice when the final runResult arrives.
      if (accepted) opts.onData?.(stream, accepted);
      if (!opts.captureLines) return;
      const sink = opts.userLog ?? opts.log;
      if (!sink) return;
      for (const raw of accepted.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        if (logLines >= logLineLimit) { logLinesTruncated = true; continue; }
        let logged = line;
        if (logged.length > 16 * 1024) { logged = logged.slice(0, 16 * 1024) + '… [line truncated]'; logLinesTruncated = true; }
        logLines++;
        const fields = { stream, runId: opts.runId, line: logLines };
        if (stream === 'stderr') sink.warn(logged, fields);
        else sink.info(logged, fields);
      }
    };

    child.stdout?.on('data', onChunk('stdout'));
    child.stderr?.on('data', onChunk('stderr'));
    if (opts.onStdinReady && child.stdin) {
      opts.onStdinReady((data) => child.stdin?.write(data));
      child.stdin.on('error', () => undefined);
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      stderr.push(`${err.message}\n`);
      opts.log?.error('Failed to spawn', { command }, err);
      finish(-1, null);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish(code, signal);
    });
  });
}
