/**
 * `script-host` runtime — the escape hatch for languages whose execution model
 * does not fit any of the four declarative runtimes.
 *
 * A plugin ships `runtime.js`; the substrate runs it in a **child process**
 * (never a Worker — a Worker shares the process and therefore shares the
 * heap, the crash domain and the `require` cache, which is not isolation) with:
 *
 *   - a heap cap (`--max-old-space-size`),
 *   - a wall-clock limit (SIGKILL on timeout),
 *   - a line-delimited JSON protocol on stdin/stdout — no ambient authority,
 *     no `require` of host modules beyond what the script itself imports.
 *
 * Protocol
 *   →  one JSON line on stdin:  { op: 'run', code, file, mode, sessionId, sessionDir, dataDir, timeoutMs }
 *   ←  zero or more JSON lines: { t: 'out', s: 'stdout'|'stderr', text }
 *                               { t: 'exit', code, timedOut? }
 *   Any non-JSON stdout line is treated as user output (a script that just
 *   prints is still usable).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

interface Session {
  id: string;
  dir: string;
}

export class ScriptHostRunner implements Runner {
  private sessions = new Map<string, Session>();
  private readonly timeoutMs: number;

  constructor(
    private config: RunConfig,
    private ctx: HostContext,
  ) {
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  get binary(): string {
    return process.execPath;
  }

  get available(): boolean {
    return !!this.config.script;
  }

  private async session(sessionId?: string): Promise<Session> {
    const id = sessionId ?? `sess-${ulid().slice(-10)}`;
    const hit = this.sessions.get(id);
    if (hit) return hit;
    const dir = join(this.ctx.dataDir, 'sessions', id);
    await mkdir(dir, { recursive: true });
    const s: Session = { id, dir };
    this.sessions.set(id, s);
    return s;
  }

  run(opts: RunRequest): Promise<RunOutcome> {
    return this.runInner(opts);
  }

  private async runInner(opts: RunRequest): Promise<RunOutcome> {
    const { spawn } = await import('node:child_process');
    const session = await this.session(opts.sessionId);
    const runId = `run-${ulid().slice(-10)}`;
    const log = this.ctx.kernel.logger.forExecution(`execution.${this.ctx.languageId}`, session.id);
    const script = join(this.ctx.pluginDir, this.config.script ?? 'runtime.js');

    const sourcePath = join(session.dir, `snippet${this.config.sourceExt ?? '.txt'}`);
    if (opts.code !== undefined) await writeFile(sourcePath, opts.code, 'utf8');

    const started = Date.now();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitCode: number | null = 0;
    let timedOut = false;

    const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      let settled = false;
      const done = (code: number | null, to: boolean): void => {
        if (settled) return;
        settled = true;
        resolve({ code, timedOut: to });
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, ['--max-old-space-size=256', script], {
          cwd: session.dir,
          env: {
            ...process.env,
            NL_SESSION_DIR: session.dir,
            NL_SOURCE_FILE: sourcePath,
            NL_LANGUAGE: this.ctx.languageId,
            NL_DATA_DIR: this.ctx.dataDir,
          },
          windowsHide: true,
        });
      } catch (err) {
        stderr.push(`${(err as Error).message}\n`);
        done(-1, false);
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, Math.max(250, opts.timeoutMs ?? this.timeoutMs));

      let buffer = '';
      const handleLine = (line: string, isErr: boolean): void => {
        const text = line.trim();
        if (text.startsWith('{')) {
          try {
            const msg = JSON.parse(text) as { t?: string; s?: string; text?: string; code?: number };
            if (msg.t === 'out' && typeof msg.text === 'string') {
              (msg.s === 'stderr' ? stderr : stdout).push(msg.text);
              opts.onData?.(msg.s === 'stderr' ? 'stderr' : 'stdout', msg.text);
              return;
            }
            if (msg.t === 'exit' && typeof msg.code === 'number') {
              done(msg.code, false);
              return;
            }
          } catch {
            // Not our protocol — fall through and treat it as user output.
          }
        }
        (isErr ? stderr : stdout).push(line + '\n');
        opts.onData?.(isErr ? 'stderr' : 'stdout', line + '\n');
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          handleLine(buffer.slice(0, nl), false);
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => handleLine(chunk.toString('utf8').replace(/\r?\n$/, ''), true));
      child.on('error', (err) => {
        clearTimeout(timer);
        stderr.push(`${err.message}\n`);
        done(-1, false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buffer.trim()) handleLine(buffer, false);
        done(code, timedOut);
      });

      const request = JSON.stringify({
        op: 'run',
        code: opts.code ?? '',
        file: sourcePath,
        mode: opts.mode ?? 'run',
        sessionId: session.id,
        sessionDir: session.dir,
        dataDir: this.ctx.dataDir,
        timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      });
      child.stdin?.write(request + '\n');
      child.stdin?.end();
    });

    exitCode = result.code;
    timedOut = result.timedOut;
    const durationMs = Date.now() - started;
    const outText = stdout.join('');
    const errText = stderr.join('');
    const logLines = (outText + errText).split('\n').filter((l) => l.trim()).length;
    const metrics = this.ctx.kernel.perfMetrics();
    metrics.record('execution.run', durationMs);
    metrics.record('execution.lines', logLines);
    log.info('script-host finished', { durationMs, exitCode, timedOut, script });

    return {
      sessionId: session.id,
      runId,
      exitCode,
      signal: null,
      durationMs,
      stdout: outText,
      stderr: errText,
      timedOut,
      logLines,
      binary: `script-host:${this.config.script ?? 'runtime.js'}`,
    };
  }

  async resetSession(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }
}

export class ScriptHostRuntime implements RuntimeExtension {
  readonly id = 'script-host';
  readonly version = '1.0.0';

  validate(config: RunConfig): ValidationResult {
    const errors: string[] = [];
    if (!config.script) errors.push('`run.script` is required (plugin-relative path to runtime.js)');
    if (!config.sourceExt) errors.push('`run.sourceExt` is required');
    return { ok: errors.length === 0, errors };
  }

  createRunner(config: RunConfig, ctx: HostContext): Runner {
    return new ScriptHostRunner(config, ctx);
  }
}
