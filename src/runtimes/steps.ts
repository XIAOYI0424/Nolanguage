/**
 * The step engine behind `template` and `directory-session`.
 *
 * A run is a *sequence of shell commands* with placeholder substitution, and
 * nothing else. That is enough for every compiled language: build then run.
 * The engine is deliberately ignorant of what the commands do — it only reads
 * `step.role` to decide how to report a failure.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { capture, isRunnableStep, splitCommand, substitute, type Substitutions } from './proc.js';
import type { HostContext, RunConfig, RunOutcome, RunRequest, RunStep } from './types.js';

export interface StepPlan {
  steps: RunStep[];
  timeoutMs: number;
}

/** Which steps apply to `mode`, and what the timeout is. */
export function planFor(config: RunConfig, mode: string, overrideTimeout?: number): StepPlan {
  const modeCfg = config.modes?.[mode];
  const steps = modeCfg?.steps ?? config.steps ?? [];
  return {
    steps,
    timeoutMs: overrideTimeout ?? modeCfg?.timeoutMs ?? config.timeoutMs ?? 20_000,
  };
}

export interface StepRunInput {
  plan: StepPlan;
  vars: Substitutions;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  runId: string;
  binary: string;
  ctx: HostContext;
  onData?: (stream: 'stdout' | 'stderr', text: string) => void;
  onStdinReady?: (sink: (data: string) => void) => void;
  /** Host cancellation, forwarded to every step's `capture`. */
  signal?: AbortSignal;
  /**
   * Extra argv for the *program* step — the last runnable one.
   *
   * A run configuration's arguments belong to the thing being run, not to the
   * build step that precedes it (`go build` with `-v` is not what the user typed).
   */
  args?: string[];
  /** Test selector substituted into `{filter}`, already validated by the host. */
  filter?: string;
  /** Project-mode values substituted into `{classpath}` / `{mainClass}`. */
  classpath?: string;
  mainClass?: string;
}

/**
 * Execute a plan. Stops at the first failing step and reports *which* role
 * failed, so the UI can say "compile error" rather than showing a bare exit
 * code from a program that never ran.
 */
export async function runSteps(input: StepRunInput): Promise<RunOutcome> {
  const { plan, vars, ctx, runId, sessionId } = input;
  const log = ctx.kernel.logger.forExecution(`execution.${ctx.languageId}`, sessionId);
  const span = ctx.kernel.tracer.startSpan('execution.run', {
    attributes: { languageId: ctx.languageId, sessionId, runId, mode: plan.steps[0]?.role ?? 'run' },
  });

  const started = Date.now();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runCaptureLimit = 4 * 1024 * 1024;
  const runLogLineLimit = 10_000;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let logLinesTruncated = false;
  let logLines = 0;
  let buildMs = 0;

  const finish = (extra: Partial<RunOutcome>): RunOutcome => {
    span.end();
    return {
      sessionId,
      runId,
      exitCode: 0,
      signal: null,
      durationMs: Date.now() - started,
      stdout: stdout.join('') + (stdoutTruncated ? `\n[stdout truncated at ${runCaptureLimit} bytes]\n` : ''),
      stderr: stderr.join('') + (stderrTruncated ? `\n[stderr truncated at ${runCaptureLimit} bytes]\n` : ''),
      stdoutTruncated,
      stderrTruncated,
      logLinesTruncated,
      timedOut: false,
      logLines,
      binary: input.binary,
      ...extra,
    };
  };

  const runnable = plan.steps.filter((step) => isRunnableStep(step));
  const programStep = runnable[runnable.length - 1];
  for (const step of plan.steps) {
    if (!isRunnableStep(step)) continue;
    const line = substitute(step.cmd, {
      ...vars,
      toolchain: input.ctx.toolchain,
      filter: input.filter ?? '',
      classpath: input.classpath ?? '',
      mainClass: input.mainClass ?? '',
    });
    const argv = splitCommand(line);
    const command = argv.shift() ?? '';
    // Arguments go on the program, never on a build step.
    if (step === programStep && input.args?.length) argv.push(...input.args);
    log.info('Running step', { role: step.role, command, args: argv.join(' ') });

    const res = await capture(command, argv, {
      cwd: input.cwd,
      env: input.env,
      timeoutMs: step.timeoutMs ?? plan.timeoutMs,
      log,
      userLog: ctx.kernel.logger.forUserCode?.(ctx.languageId, sessionId),
      logScope: ctx.languageId,
      runId,
      onData: input.onData,
      onStdinReady: input.onStdinReady,
      captureLines: true,
      maxStdoutCaptureBytes: Math.max(0, runCaptureLimit - stdoutBytes),
      maxStderrCaptureBytes: Math.max(0, runCaptureLimit - stderrBytes),
      maxLogLines: Math.max(0, runLogLineLimit - logLines),
      signal: input.signal,
    });

    stdout.push(res.stdout.replace(/\n\[stdout truncated at \d+ bytes\]\n$/, ''));
    stderr.push(res.stderr.replace(/\n\[stderr truncated at \d+ bytes\]\n$/, ''));
    stdoutBytes += res.stdoutBytes;
    stderrBytes += res.stderrBytes;
    stdoutTruncated ||= res.stdoutTruncated;
    stderrTruncated ||= res.stderrTruncated;
    logLinesTruncated ||= res.logLinesTruncated;
    logLines += res.logLines;
    if (step.role === 'build') buildMs += res.durationMs;

    if (res.cancelled) {
      return finish({
        exitCode: res.exitCode,
        signal: res.signal,
        cancelled: true,
        phase: step.role,
        buildMs: buildMs || undefined,
      });
    }

    if (res.exitCode !== 0 || res.timedOut) {
      const phase = step.role;
      return finish({
        exitCode: res.exitCode,
        signal: res.signal,
        timedOut: res.timedOut,
        phase,
        compileError: phase === 'build' && !res.timedOut,
        buildMs: buildMs || undefined,
      });
    }
  }

  const last = plan.steps.filter(isRunnableStep).pop();
  return finish({
    phase: last?.role === 'test' ? 'test' : 'run',
    buildMs: buildMs || undefined,
  });
}

/**
 * Materialise the source file a run is based on. `code` wins over `file`:
 * the editor always has the buffer, and a stale on-disk copy must not win.
 */
export async function materialiseSource(
  opts: RunRequest,
  workdir: string,
  defaultName: string,
): Promise<string> {
  if (typeof opts.file === 'string' && opts.file && opts.code === undefined) return opts.file;
  const target = opts.file && opts.code !== undefined ? opts.file : join(workdir, defaultName);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, opts.code ?? '', 'utf8');
  return target;
}
