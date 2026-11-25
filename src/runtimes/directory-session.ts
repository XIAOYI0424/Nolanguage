/**
 * `directory-session` runtime — a *module directory* rather than a namespace.
 *
 * Compiled, package-oriented languages need a stable directory: a module
 * manifest, maybe sibling files, and a working directory the toolchain
 * recognises. There is no state to carry between runs other than the files
 * themselves, so "session" here means "a directory that survives".
 *
 * Like every runtime in this directory, it is language-blind: the scaffold
 * files, the build command and the run command all come from the manifest.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ulid } from '../util/ulid.js';
import { materialiseSource, planFor, runSteps } from './steps.js';
import { splitCommand, substitute } from './proc.js';
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
  scaffolded: boolean;
}

export class DirectorySessionRunner implements Runner {
  private sessions = new Map<string, Session>();
  private readonly command: string[];

  constructor(
    private config: RunConfig,
    private ctx: HostContext,
  ) {
    this.command = (config.command ?? []).map((c) =>
      c.replace(/\{toolchain\}/g, ctx.toolchain || config.discovery?.commands?.[0] || ''),
    );
  }

  get binary(): string {
    if (this.command[0]) return this.command[0];
    const first = splitCommand(this.config.steps?.[0]?.cmd ?? '')[0] ?? '';
    return first.replace(/\{toolchain\}/g, this.ctx.toolchain || this.config.discovery?.commands?.[0] || '');
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
    const s: Session = { id, dir, scaffolded: false };
    this.sessions.set(id, s);
    this.ctx.kernel.logger
      .forExecution('execution.session', id)
      .info('Directory session created', { sessionId: id, dir, languageId: this.ctx.languageId });
    return s;
  }

  /** Write `scaffold.onFirstRun` entries that are missing. Idempotent. */
  private async scaffold(session: Session): Promise<void> {
    if (session.scaffolded) return;
    session.scaffolded = true;
    const files = this.config.scaffold?.onFirstRun ?? [];
    for (const f of files) {
      const target = join(session.dir, f.file);
      if (existsSync(target)) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, substitute(f.template, {
        file: '',
        workdir: session.dir,
        basename: '',
        data: this.ctx.dataDir,
      }), 'utf8');
      this.ctx.kernel.logger
        .forExecution(`execution.${this.ctx.languageId}`, session.id)
        .info('Scaffolded', { file: f.file });
    }
  }

  async run(opts: RunRequest): Promise<RunOutcome> {
    const session = await this.session(opts.sessionId);
    await this.scaffold(session);

    const mode = opts.mode ?? 'run';
    const ext = this.config.sourceExt ?? '.txt';
    // `test`-style modes often need a different file name pattern; the plugin
    // names it, so the runtime stays generic.
    const defaultName = mode === 'run' ? `main${ext}` : `main_${mode}${ext}`;
    const file = await materialiseSource(opts, session.dir, defaultName);
    // A session directory is shared by every mode, and a stale file from the
    // previous mode would be compiled into this one (a leftover `main.go` with
    // a deliberate error makes `go test` fail to build instead of reporting the
    // failing test). Drop the other modes' entry points, keep anything the
    // plugin scaffolded.
    if (opts.code !== undefined) {
      const stale = new Set<string>([`main${ext}`]);
      for (const name of Object.keys(this.config.modes ?? {})) stale.add(`main_${name}${ext}`);
      stale.delete(defaultName);
      for (const name of stale) {
        await rm(join(session.dir, name), { force: true }).catch(() => undefined);
      }
    }
    const runId = `run-${ulid().slice(-10)}`;
    const plan = planFor(this.config, mode, opts.timeoutMs);

    return runSteps({
      plan,
      vars: { file, workdir: session.dir, basename: defaultName, data: this.ctx.dataDir },
      cwd: opts.cwd ?? session.dir,
      env: { ...process.env, ...this.config.env, ...opts.env },
      sessionId: session.id,
      runId,
      binary: this.binary,
      ctx: this.ctx,
      onData: opts.onData,
      onStdinReady: opts.onStdinReady,
      signal: opts.signal,
      filter: opts.filter,
      classpath: opts.classpath,
      mainClass: opts.mainClass,
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
    this.sessions.clear();
  }
}

export class DirectorySessionRuntime implements RuntimeExtension {
  readonly id = 'directory-session';
  readonly version = '1.0.0';
  /** fixed step list; argv belongs to the manifest. */
  readonly supportsArgs = false;

  validate(config: RunConfig): ValidationResult {
    const errors: string[] = [];
    const hasSteps = (config.steps?.length ?? 0) > 0;
    const hasModeSteps = Object.values(config.modes ?? {}).some((m) => (m.steps?.length ?? 0) > 0);
    if (!hasSteps && !hasModeSteps) {
      errors.push('`directory-session` needs `run.steps` or at least one `run.modes.<mode>.steps`');
    }
    if (!config.sourceExt) errors.push('`run.sourceExt` is required (e.g. ".go")');
    for (const [mode, cfg] of Object.entries(config.modes ?? {})) {
      if (cfg.steps && !cfg.steps.length) errors.push(`run.modes.${mode}.steps is empty`);
    }
    return { ok: errors.length === 0, errors };
  }

  createRunner(config: RunConfig, ctx: HostContext): Runner {
    return new DirectorySessionRunner(config, ctx);
  }
}
