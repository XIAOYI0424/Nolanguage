/**
 * WarmWorker — one persistent interpreter process for a sandbox session.
 *
 * A fresh process per snippet is what we are avoiding, so we keep ONE alive and
 * feed it requests over a length-prefixed JSON stdin/stdout protocol. Reusing it
 * is the "warm" half of the warm pool: the ~90ms cold-spawn is paid once per
 * session (spec §七, 90ms cold start). What survives inside the process is
 * per-language — Python's namespace does, Node's per-run vm context does not
 * (see `workerSource.ts`).
 *
 * The worker handles exactly one request at a time; the pool only calls `run`
 * when the worker is idle, so there is never overlapping in-flight work. A run
 * that exceeds `timeoutMs` kills the worker (it is misbehaving — e.g. an
 * infinite loop) and the pool recycles a fresh one on the next acquire.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kernel } from '../kernel/Kernel.js';
import type { SandboxLanguage } from './types.js';
import { PYTHON_WORKER_SRC, NODE_WORKER_SRC } from './workerSource.js';
import { decodeOutput } from '../util/encoding.js';

export interface WorkerResult {
  id: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  error: string | null;
  durationMs: number;
}

export interface WarmWorkerOptions {
  pythonBin?: string;
  nodeBin?: string;
  /** Called when the OS process exits on its own (crash / snippet kill). */
  onExit?: (code: number | null, signal: string | null) => void;
}

interface Pending {
  resolve: (r: WorkerResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

// Materialise each worker script once per process (no asset embedding needed).
const WORKER_FILES = new Map<SandboxLanguage, string>();

async function workerFile(lang: SandboxLanguage): Promise<string> {
  const cached = WORKER_FILES.get(lang);
  if (cached) return cached;
  const dir = join(tmpdir(), `nolanguage-workers-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, lang === 'python' ? 'py-worker.py' : 'node-worker.mjs');
  await writeFile(file, lang === 'python' ? PYTHON_WORKER_SRC : NODE_WORKER_SRC, 'utf8');
  WORKER_FILES.set(lang, file);
  return file;
}

export class WarmWorker {
  private child: ChildProcess | null = null;
  private buf = Buffer.alloc(0);
  private seq = 0;
  private pending: Pending | null = null;
  private busy = false;
  private dead = false;
  readonly startedAt = Date.now();
  private lastUsedAt = Date.now();
  private readonly binary: string;
  /** Resolves once the OS process is spawned and listening on stdin/stdout. */
  readonly ready: Promise<void>;

  constructor(
    private kernel: Kernel,
    readonly languageId: 'python' | 'javascript',
    private opts: WarmWorkerOptions = {},
  ) {
    this.binary =
      languageId === 'python'
        ? opts.pythonBin ?? process.env.PYTHON_BIN ?? 'python'
        : opts.nodeBin ?? process.env.NODE_BIN ?? 'node';
    this.ready = this.spawn().catch((err) => {
      this.dead = true;
      throw err;
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isAlive(): boolean {
    return this.child !== null && !this.dead;
  }

  /** True while the startup promise is outstanding and has not failed. */
  get isStarting(): boolean {
    return this.child === null && !this.dead;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Idle duration in ms (since last release). */
  idleMs(): number {
    return Date.now() - this.lastUsedAt;
  }

  /** Mark released back to the pool (resets the idle clock). */
  release(): void {
    this.lastUsedAt = Date.now();
  }

  private async spawn(): Promise<void> {
    const file = await workerFile(this.languageId);
    const args = this.languageId === 'python' ? [file] : [file];
    this.child = spawn(this.binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    this.dead = false;
    this.buf = Buffer.alloc(0);

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    // Worker diagnostics (broken bootstrap etc.) go to the execution log.
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = decodeOutput(chunk).trim();
      if (text) this.kernel.logger.forExecution('sandbox.worker', this.languageId).warn('worker stderr', { text });
    });
    this.child.on('error', (err) => {
      this.kernel.logger.forExecution('sandbox.worker', this.languageId).error('worker spawn failed', {}, err);
    });
    this.child.on('exit', (code, signal) => {
      const wasBusy = this.busy;
      this.child = null;
      this.dead = true;
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        this.busy = false;
        clearTimeout(p.timer);
        p.reject(new Error(`sandbox worker exited (code=${code}, signal=${signal})`));
      }
      // A self-inflicted exit while idle is a crash the pool must recycle.
      if (!wasBusy) this.opts.onExit?.(code, signal);
    });
  }

  private drain(): void {
    while (true) {
      const nl = this.buf.indexOf(0x0a);
      if (nl === -1) return;
      const len = parseInt(this.buf.subarray(0, nl).toString('utf8').trim(), 10);
      if (!Number.isFinite(len)) {
        this.buf = this.buf.subarray(nl + 1);
        continue;
      }
      if (this.buf.length < nl + 1 + len) return;
      const json = this.buf.subarray(nl + 1, nl + 1 + len);
      this.buf = this.buf.subarray(nl + 1 + len);
      if (!this.pending) continue; // stray frame; ignore
      let res: WorkerResult;
      try {
        res = JSON.parse(json.toString('utf8')) as WorkerResult;
      } catch {
        continue;
      }
      const p = this.pending;
      this.pending = null;
      this.busy = false;
      clearTimeout(p.timer);
      p.resolve(res);
    }
  }

  /** Send one request; resolves with the worker's framed result. */
  run(code: string, timeoutMs: number): Promise<WorkerResult> {
    if (this.dead || !this.child || !this.child.stdin) {
      return Promise.reject(new Error('sandbox worker is dead'));
    }
    if (this.busy) return Promise.reject(new Error('sandbox worker is busy'));
    this.busy = true;
    const req = { id: `w${++this.seq}`, code };
    const payload = Buffer.from(JSON.stringify(req), 'utf8');
    const frame = Buffer.concat([Buffer.from(`${payload.length}\n`, 'utf8'), payload]);
    return new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.busy = false;
        this.dead = true;
        this.kernel.logger
          .forExecution('sandbox.worker', this.languageId)
          .error('worker run timed out', { timeoutMs });
        this.child?.kill('SIGKILL');
        reject(new Error(`sandbox worker timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      try {
        this.child!.stdin!.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        this.busy = false;
        reject(err as Error);
      }
    });
  }

  /** Kill the worker (idle recycle or shutdown). */
  async recycle(): Promise<void> {
    if (!this.child && this.dead) return;
    if (!this.child) {
      try { await this.ready; } catch { return; }
    }
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.dead = true;
    const done = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1500);
      child.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await done;
  }
}
