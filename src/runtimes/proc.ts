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
}

export interface CaptureResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
    let logLines = 0;
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        signal,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        timedOut,
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

    const onChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      (stream === 'stdout' ? stdout : stderr).push(text);
      opts.onData?.(stream, text);
      if (!opts.captureLines) return;
      const sink = opts.userLog ?? opts.log;
      if (!sink) return;
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        logLines++;
        const fields = { stream, runId: opts.runId, line: logLines };
        if (stream === 'stderr') sink.warn(line, fields);
        else sink.info(line, fields);
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
