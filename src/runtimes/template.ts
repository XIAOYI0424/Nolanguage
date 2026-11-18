/**
 * `template` runtime — command templates, executed in order.
 *
 * The simplest capability: write the source into a scratch directory, then run
 * a list of commands with `{file}` / `{workdir}` substituted. Covers every
 * "compile then run" toolchain (rustc, gcc, javac, dotnet) without the
 * substrate knowing any of them.
 *
 * There is no session state to preserve — a compiled program is rebuilt from
 * scratch each run — so the session directory is a scratch directory.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from '../util/ulid.js';
import { materialiseSource, planFor, runSteps } from './steps.js';
import { splitCommand } from './proc.js';
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
}

export class TemplateRunner implements Runner {
  private sessions = new Map<string, Session>();
  private readonly timeoutMs: number;

  constructor(
    private config: RunConfig,
    private ctx: HostContext,
  ) {
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  get binary(): string {
    const first = splitCommand(this.config.steps?.[0]?.cmd ?? '')[0] ?? '';
    return first.replace(/\{toolchain\}/g, this.ctx.toolchain || this.config.discovery?.commands?.[0] || '');
  }

  /** A template run reports a missing toolchain as a failed step, not as "unavailable". */
  get available(): boolean {
    return this.binary.length > 0;
  }

  private async session(sessionId?: string): Promise<Session> {
    const id = sessionId ?? `sess-${ulid().slice(-10)}`;
    const hit = this.sessions.get(id);
    if (hit) return hit;
    const dir = await mkdtemp(join(tmpdir(), `nolanguage-${this.ctx.languageId}-`));
    const s: Session = { id, dir };
    this.sessions.set(id, s);
    return s;
  }

  async run(opts: RunRequest): Promise<RunOutcome> {
    const session = await this.session(opts.sessionId);
    const runId = `run-${ulid().slice(-10)}`;
    const mode = opts.mode ?? 'run';
    const plan = planFor(this.config, mode, opts.timeoutMs);
    const ext = this.config.sourceExt ?? '.txt';
    const file = await materialiseSource(opts, session.dir, `main${ext}`);

    return runSteps({
      plan,
      vars: { file, workdir: session.dir, basename: `main${ext}`, data: this.ctx.dataDir },
      cwd: opts.cwd ?? session.dir,
      env: { ...process.env, ...this.config.env, ...opts.env },
      sessionId: session.id,
      runId,
      binary: this.binary,
      ctx: this.ctx,
      onData: opts.onData,
      onStdinReady: opts.onStdinReady,
      signal: opts.signal,
      ...(opts.args?.length ? { args: opts.args } : {}),
    });
  }

  async resetSession(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
    this.sessions.delete(sessionId);
    return true;
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    const dirs = [...this.sessions.values()].map((s) => s.dir);
    this.sessions.clear();
    for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class TemplateRuntime implements RuntimeExtension {
  readonly id = 'template';
  readonly version = '1.0.0';
  /** a real process; args land after the source file. */
  readonly supportsArgs = true;

  validate(config: RunConfig): ValidationResult {
    const errors: string[] = [];
    if (!config.steps?.length) errors.push('`run.steps` must list at least one command');
    for (const [i, step] of (config.steps ?? []).entries()) {
      if (!step.cmd) errors.push(`run.steps[${i}].cmd is required`);
      if (!step.role) errors.push(`run.steps[${i}].role is required`);
    }
    for (const [mode, cfg] of Object.entries(config.modes ?? {})) {
      if (cfg.steps && !cfg.steps.length) errors.push(`run.modes.${mode}.steps is empty`);
    }
    return { ok: errors.length === 0, errors };
  }

  createRunner(config: RunConfig, ctx: HostContext): Runner {
    return new TemplateRunner(config, ctx);
  }
}
