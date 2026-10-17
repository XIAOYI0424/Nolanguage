/**
 * `inline-vm` runtime — an embedded VM, reset per run.
 *
 * Some languages are executed by a VM that already lives inside this process.
 * The runtime creates a fresh context for every run (which is what makes
 * re-running a snippet with a top-level `const` work at all), gives it a
 * minimal, read-only host surface, and enforces a wall-clock limit.
 *
 * Nothing here mentions a language: the source text is whatever the plugin's
 * `sourceExt` says it is, and the VM is `node:vm`. A plugin whose language is
 * not ECMAScript-shaped must use `script-host` instead.
 */
import { createContext, runInContext } from 'node:vm';
import { format } from 'node:util';
import { ulid } from '../util/ulid.js';
import type {
  HostContext,
  RunConfig,
  Runner,
  RunOutcome,
  RunRequest,
  RuntimeExtension,
  ValidationResult,
} from './types.js';

export class InlineVmRunner implements Runner {
  private sessions = new Set<string>();
  private readonly timeoutMs: number;

  constructor(
    private config: RunConfig,
    private ctx: HostContext,
  ) {
    this.timeoutMs = config.vmTimeoutMs ?? config.timeoutMs ?? 5_000;
  }

  get binary(): string {
    return process.execPath;
  }

  get available(): boolean {
    return true;
  }

  async run(opts: RunRequest): Promise<RunOutcome> {
    const sessionId = opts.sessionId ?? `sess-${ulid().slice(-10)}`;
    this.sessions.add(sessionId);
    const runId = `run-${ulid().slice(-10)}`;
    const log = this.ctx.kernel.logger.forExecution(`execution.${this.ctx.languageId}`, sessionId);
    const span = this.ctx.kernel.tracer.startSpan('execution.run', {
      attributes: { languageId: this.ctx.languageId, sessionId, runId, mode: 'inline-vm' },
    });

    const out: string[] = [];
    const err: string[] = [];
    const push = (target: string[]) => (...args: unknown[]) => {
      const text = format(...(args as [unknown, ...unknown[]])) + '\n';
      target.push(text);
      opts.onData?.(target === out ? 'stdout' : 'stderr', text);
    };

    const sandbox: Record<string, unknown> = {
      console: { log: push(out), info: push(out), debug: push(out), warn: push(err), error: push(err) },
      process: {
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        env: {},
        argv: [],
        cwd: () => this.ctx.dataDir,
      },
    };
    sandbox.globalThis = sandbox;

    const started = Date.now();
    let exitCode: number | null = 0;
    let timedOut = false;
    const code = opts.code ?? '';
    try {
      runInContext(code, createContext(sandbox), {
        timeout: opts.timeoutMs ?? this.timeoutMs,
        filename: opts.file ?? `snippet${this.config.sourceExt ?? '.js'}`,
        displayErrors: true,
      });
    } catch (e) {
      const err2 = e as Error & { code?: string };
      timedOut = err2.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
      exitCode = timedOut ? null : 1;
      err.push(`${err2.name || 'Error'}: ${err2.message}\n`);
    }

    const durationMs = Date.now() - started;
    const logLines = (out.join('') + err.join('')).split('\n').filter((l) => l.trim()).length;
    const metrics = this.ctx.kernel.perfMetrics();
    metrics.record('execution.run', durationMs);
    metrics.record('execution.lines', logLines);
    span.setAttribute('exitCode', exitCode).end();
    log.info('Evaluated snippet', { durationMs, exitCode, timedOut });

    return {
      sessionId,
      runId,
      exitCode,
      signal: null,
      durationMs,
      stdout: out.join(''),
      stderr: err.join(''),
      timedOut,
      logLines,
      binary: this.binary,
    };
  }

  async resetSession(sessionId: string): Promise<boolean> {
    // Contexts are per-run; "reset" only means forgetting the session id.
    return this.sessions.delete(sessionId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }
}

export class InlineVmRuntime implements RuntimeExtension {
  readonly id = 'inline-vm';
  readonly version = '1.0.0';

  validate(config: RunConfig): ValidationResult {
    const errors: string[] = [];
    if (!config.sourceExt) errors.push('`run.sourceExt` is required (e.g. ".js")');
    if (config.steps?.length) errors.push('`inline-vm` does not use `run.steps`');
    if (config.command?.length) errors.push('`inline-vm` does not use `run.command` (it runs in-process)');
    return { ok: errors.length === 0, errors };
  }

  createRunner(config: RunConfig, ctx: HostContext): Runner {
    return new InlineVmRunner(config, ctx);
  }
}
