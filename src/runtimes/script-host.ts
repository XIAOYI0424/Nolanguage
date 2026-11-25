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
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { ulid } from '../util/ulid.js';
import { OutputDecoder, decodeOutput } from '../util/encoding.js';

/**
 * `script-host` OS-level memory budget.
 *
 * The V8 `--max-old-space-size` flag caps only the *old space heap*; the
 * child-side RSS watchdog (see `script-host-watchdog.mjs`) is the real
 * OS-level cap. The user delegated a "sensible default range", so we pick
 * **64 MB – 4 GB, default 256 MB** — enough headroom for real programs, tight
 * enough to contain a runaway script on a shared machine. The range is a
 * clamp: a plugin or operator cannot ask for less than 64 MB (V8 will not boot
 * reliably) or more than 4 GB (the heap flag is ignored past ~4 GB anyway).
 */
const MB = 1024 * 1024;
const SCRIPT_HOST_MEM_MIN = 64 * MB;
const SCRIPT_HOST_MEM_MAX = 4 * 1024 * MB;
const SCRIPT_HOST_MEM_DEFAULT = 256 * MB;
const V8_HEAP_CAP_MAX = 4096; // `--max-old-space-size` is ignored past ~4 GB.

/** Parse a human memory string (`"256MB"`, `"1GB"`, `"512"`) to bytes. */
export function parseHumanBytes(hint: string | undefined): number | null {
  if (!hint) return null;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*([a-zA-Z]*)\s*$/.exec(String(hint));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'b').toLowerCase();
  const factor: Record<string, number> = {
    b: 1, k: 1024, kb: 1024,
    m: MB, mb: MB,
    g: 1024 * MB, gb: 1024 * MB,
  };
  const mult = factor[unit];
  if (!mult) return null;
  return Math.round(n * mult);
}

/**
 * Resolve the effective memory cap in bytes.
 * Priority: `NOLANGUAGE_SCRIPT_HOST_MEM_LIMIT` env → manifest `memoryHint` →
 * default. A bad/empty hint never disables the cap (unlike the budget parser,
 * where 0 means "free"); here it falls back to the default.
 */
export function resolveMemLimitBytes(config: RunConfig, env: NodeJS.ProcessEnv): number {
  const raw =
    parseHumanBytes(env.NOLANGUAGE_SCRIPT_HOST_MEM_LIMIT) ??
    parseHumanBytes(config.memoryHint);
  let bytes = raw ?? SCRIPT_HOST_MEM_DEFAULT;
  if (bytes < SCRIPT_HOST_MEM_MIN) bytes = SCRIPT_HOST_MEM_MIN;
  if (bytes > SCRIPT_HOST_MEM_MAX) bytes = SCRIPT_HOST_MEM_MAX;
  return bytes;
}

/**
 * Absolute path to the RSS watchdog, or `null` when it is unavailable (e.g. an
 * unusual build where the sibling `.mjs` is not on disk). The V8 heap cap still
 * applies in that case, so skipping the watchdog is safe.
 */
function resolveWatchdogPath(): string | null {
  try {
    const p = fileURLToPath(new URL('./script-host-watchdog.mjs', import.meta.url));
    if (existsSync(p)) return p;
  } catch {
    // `import.meta.url` can be a non-file URL in some builds (e.g. SEA).
  }
  return null;
}
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
  /** Live runtime.js children; `close()` must kill them, not just forget them. */
  private children = new Set<ChildProcess>();
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

    // Resolve the OS-level cap once per run (env can change between runs).
    const memLimitBytes = resolveMemLimitBytes(this.config, process.env);
    const heapMiB = Math.min(
      V8_HEAP_CAP_MAX,
      Math.max(64, Math.floor(memLimitBytes / MB)),
    );
    const watchdog = resolveWatchdogPath();

    const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      let settled = false;
      const done = (code: number | null, to: boolean): void => {
        if (settled) return;
        settled = true;
        resolve({ code, timedOut: to });
      };

      let child: ReturnType<typeof spawn>;
      try {
        // Heap cap first (cheap, fast OOM), then the RSS watchdog as the real
        // OS-level cap. `-r` must come before the script argument.
        const nodeArgs = [`--max-old-space-size=${heapMiB}`];
        if (watchdog) nodeArgs.push('-r', watchdog);
        nodeArgs.push(script);
        child = spawn(process.execPath, nodeArgs, {
          cwd: session.dir,
          env: {
            ...process.env,
            NL_SESSION_DIR: session.dir,
            NL_SOURCE_FILE: sourcePath,
            NL_LANGUAGE: this.ctx.languageId,
            NL_DATA_DIR: this.ctx.dataDir,
            NL_MEM_LIMIT_BYTES: String(memLimitBytes),
          },
          windowsHide: true,
        });
      } catch (err) {
        stderr.push(`${(err as Error).message}\n`);
        done(-1, false);
        return;
      }

      this.children.add(child);
      child.on('close', () => this.children.delete(child));

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

      const stdoutDecoder = new OutputDecoder();
      const stderrDecoder = new OutputDecoder();
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += stdoutDecoder.push(chunk);
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          handleLine(buffer.slice(0, nl), false);
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => handleLine(stderrDecoder.push(chunk).replace(/\r?\n$/, ''), true));
      child.on('error', (err) => {
        clearTimeout(timer);
        stderr.push(`${err.message}\n`);
        done(-1, false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        buffer += stdoutDecoder.flush();
        const errTail = stderrDecoder.flush();
        if (errTail) handleLine(errTail.replace(/\r?\n$/, ''), true);
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
    // Exit 137 (128 + SIGKILL) is the RSS watchdog's "exceeded the OS memory
    // cap" signal. Surface it as a readable error instead of a bare code.
    if (exitCode === 137) {
      const mb = Math.round(memLimitBytes / MB);
      stderr.push(`\n[script-host] process killed: exceeded OS memory cap of ${mb} MB (RSS watchdog).\n`);
      log.warn('script-host exceeded memory cap', { memLimitBytes, mb });
    }
    const durationMs = Date.now() - started;
    const outText = stdout.join('');
    const errText = stderr.join('');
    const logLines = (outText + errText).split('\n').filter((l) => l.trim()).length;
    const metrics = this.ctx.kernel.perfMetrics();
    metrics.record('execution.run', durationMs);
    metrics.record('execution.lines', logLines);
    metrics.record('execution.memLimit', memLimitBytes);
    log.info('script-host finished', {
      durationMs, exitCode, timedOut, script,
      memLimitBytes, heapMiB, watchdog: !!watchdog,
    });

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
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    this.children.clear();
    this.sessions.clear();
  }
}

export class ScriptHostRuntime implements RuntimeExtension {
  readonly id = 'script-host';
  readonly version = '1.0.0';
  /** the entry script parses its own arguments. */
  readonly supportsArgs = false;

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
