/**
 * `repl-session` runtime — a process per run, a *persistent session directory*
 * across runs.
 *
 * This is the generic form of what used to be `PythonRunner`'s hardcoded
 * behaviour. The runtime knows three things, none of which is a language:
 *
 *   1. where the session directory is (stable per `sessionId`),
 *   2. where the source file is written (its extension comes from the manifest),
 *   3. that an optional plugin-supplied `bootstrap` script can persist state.
 *
 * The persistence *mechanism* (pickle, marshal, a serialised heap…) lives in
 * the plugin as `bootstrap.py` / `bootstrap.js` — that is the whole point of
 * the extraction. `repl-session` never imports anything language-specific.
 *
 * Environment contract handed to the bootstrap:
 *
 *   NL_SESSION_DIR   stable directory for this session
 *   NL_SOURCE_FILE   the snippet the user just ran
 *   NL_GLOBALS_FILE  where the bootstrap may persist state
 *   NL_LANGUAGE      the plugin id (for diagnostics)
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from '../util/ulid.js';
import { capture } from './proc.js';
import type {
  HostContext,
  RunConfig,
  Runner,
  RunOutcome,
  RunRequest,
  RuntimeExtension,
  ValidationResult,
} from './types.js';

interface Session {
  id: string;
  dir: string;
  globalsPath: string;
}

export class ReplSessionRunner implements Runner {
  private sessions = new Map<string, Session>();
  private readonly command: string[];
  private readonly timeoutMs: number;

  constructor(
    private config: RunConfig,
    private ctx: HostContext,
  ) {
    this.command = (config.command ?? []).map((c) =>
      // An unresolved `{toolchain}` falls back to the manifest's first
      // discovery command, so `binary` still names something the user can
      // install instead of rendering as an empty string.
      c.replace(/\{toolchain\}/g, ctx.toolchain || config.discovery?.commands?.[0] || ''),
    );
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  get binary(): string {
    return this.command[0] ?? '';
  }

  /** False when the plugin declares a toolchain and discovery did not find it. */
  get available(): boolean {
    if (this.config.discovery && !this.ctx.toolchain) return false;
    return this.binary.length > 0;
  }

  private async session(sessionId?: string): Promise<Session> {
    const id = sessionId ?? `sess-${ulid().slice(-10)}`;
    const hit = this.sessions.get(id);
    if (hit) return hit;
    const dir = join(this.ctx.dataDir, 'sessions', id);
    await mkdir(dir, { recursive: true });
    const s: Session = { id, dir, globalsPath: join(dir, '.nl_globals.bin') };
    this.sessions.set(id, s);
    this.ctx.kernel.logger
      .forExecution('execution.session', id)
      .info('Session created', { sessionId: id, dir, languageId: this.ctx.languageId });
    return s;
  }

  async run(opts: RunRequest): Promise<RunOutcome> {
    const session = await this.session(opts.sessionId);
    const runId = `run-${ulid().slice(-10)}`;
    const ext = this.config.sourceExt ?? '.txt';
    const log = this.ctx.kernel.logger.forExecution(`execution.${this.ctx.languageId}`, session.id);
    const span = this.ctx.kernel.tracer.startSpan('execution.run', {
      attributes: { languageId: this.ctx.languageId, sessionId: session.id, runId },
    });

    // `file` wins only when the caller has no buffer to send (running an
    // on-disk file); otherwise the editor's text is the source of truth.
    const sourcePath =
      opts.code === undefined && opts.file ? opts.file : join(session.dir, `snippet${ext}`);
    if (opts.code !== undefined || !opts.file) {
      await writeFile(sourcePath, opts.code ?? '', 'utf8');
    }

    const bootstrap = this.config.bootstrap ? join(this.ctx.pluginDir, this.config.bootstrap) : '';
    const [bin, ...baseArgs] = this.command;
    const argv = bootstrap && existsSync(bootstrap) ? [...baseArgs, bootstrap] : [...baseArgs, sourcePath];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.config.env,
      ...opts.env,
      NL_SESSION_DIR: session.dir,
      NL_SOURCE_FILE: sourcePath,
      NL_GLOBALS_FILE: session.globalsPath,
      NL_LANGUAGE: this.ctx.languageId,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    };

    log.info('Running snippet', { source: sourcePath, command: this.binary, bootstrap: bootstrap || undefined });

    const res = await capture(bin, argv, {
      cwd: opts.cwd ?? session.dir,
      env,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      log,
      userLog: this.ctx.kernel.logger.forUserCode?.(this.ctx.languageId, session.id),
      logScope: this.ctx.languageId,
      runId,
      onData: opts.onData,
      onStdinReady: opts.onStdinReady,
      captureLines: true,
    });

    const metrics = this.ctx.kernel.perfMetrics();
    metrics.record('execution.run', res.durationMs);
    metrics.record(`execution.${this.ctx.languageId}.run`, res.durationMs);
    metrics.record('execution.lines', res.logLines);
    span.setAttribute('exitCode', res.exitCode).end();

    return {
      sessionId: session.id,
      runId,
      exitCode: res.exitCode,
      signal: res.signal,
      durationMs: res.durationMs,
      stdout: res.stdout,
      stderr: res.stderr,
      timedOut: res.timedOut,
      logLines: res.logLines,
      binary: this.binary,
    };
  }

  async resetSession(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    await rm(s.globalsPath, { force: true }).catch(() => undefined);
    this.sessions.delete(sessionId);
    this.ctx.kernel.logger.forExecution('execution.session', sessionId).info('Session reset', { sessionId });
    return true;
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }
}

export class ReplSessionRuntime implements RuntimeExtension {
  readonly id = 'repl-session';
  readonly version = '1.0.0';

  validate(config: RunConfig): ValidationResult {
    const errors: string[] = [];
    if (!config.command?.length) errors.push('`run.command` is required (e.g. ["{toolchain}"])');
    if (!config.sourceExt) errors.push('`run.sourceExt` is required (e.g. ".py")');
    if (config.steps?.length) errors.push('`repl-session` does not use `run.steps` — use `template` for that');
    return { ok: errors.length === 0, errors };
  }

  createRunner(config: RunConfig, ctx: HostContext): Runner {
    return new ReplSessionRunner(config, ctx);
  }
}

/** Read a bootstrap asset a plugin ships (used by tests and diagnostics). */
export async function readBootstrap(ctx: HostContext, config: RunConfig): Promise<string | null> {
  if (!config.bootstrap) return null;
  try {
    return await readFile(join(ctx.pluginDir, config.bootstrap), 'utf8');
  } catch {
    return null;
  }
}
