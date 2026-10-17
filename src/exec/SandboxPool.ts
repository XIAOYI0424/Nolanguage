/**
 * SandboxPool — the L1 execution plane (spec §七: 沙箱 Worker 预热池).
 *
 * Keeps a small pool of idle warm workers per persistent language (Python /
 * Node) and reuses them across runs, so a session avoids a cold spawn. A run
 * that reuses an alive worker is a "warm hit"; one that must spawn a new
 * process is a "cold start". Go has no interpreter state, so its warm worker is
 * a `GoRunner` session whose scratch module dir persists between runs.
 *
 * The pool owns the metrics + lifecycle; `SandboxLogCollector` owns output
 * capture. Both feed the two spines via the kernel.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '../util/ulid.js';
import type { Kernel } from '../kernel/Kernel.js';
import type { GoRunner } from '../go/GoRunner.js';
import { WarmWorker } from './WarmWorker.js';
import { collectSandboxOutput } from './SandboxLogCollector.js';
import type {
  SandboxLanguage,
  SandboxPoolOptions,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxSessionInfo,
} from './types.js';

interface Assigned {
  languageId: SandboxLanguage;
  worker: WarmWorker;
  runs: number;
}

export class SandboxPool {
  private freeWarm = new Map<SandboxLanguage, WarmWorker[]>();
  private assigned = new Map<string, Assigned>();
  private goSessions = new Map<string, number>(); // sessionId -> run count
  private idleTimer?: NodeJS.Timeout;

  // Counters — plain fields so tests can assert warm reuse directly.
  warmHits = 0;
  coldStarts = 0;
  workerSpawns = 0;
  idleRecycles = 0;
  runs = 0;

  constructor(
    private kernel: Kernel,
    private opts: SandboxPoolOptions = {},
    private goRunner?: GoRunner,
  ) {
    const minSize = opts.minSize ?? 1;
    if (minSize > 0) {
      for (const lang of ['python', 'javascript'] as const) {
        for (let i = 0; i < minSize; i++) this.spawnFree(lang);
      }
    }
    const maxIdle = opts.maxIdleMs ?? 60_000;
    if (maxIdle > 0) {
      this.idleTimer = setInterval(() => this.recycleIdle(maxIdle), Math.min(maxIdle, 15_000));
      // Do not keep the event loop alive just for idle recycling.
      if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
    }
  }

  /** Spawn a worker and register it as idle (pre-warm / top-up). */
  private spawnFree(lang: 'python' | 'javascript'): WarmWorker {
    const w = this.spawnWorker(lang);
    const list = this.freeWarm.get(lang) ?? [];
    list.push(w);
    this.freeWarm.set(lang, list);
    return w;
  }

  /**
   * Spawn a worker that is *not* idle.
   *
   * A cold start must not go through the idle list: doing so left the new
   * worker in `freeWarm` *and* in `assigned`, so the next `takeFree` handed a
   * worker to a second session that another session already owned (sharing one
   * context behind two `sessionId`s), and `recycleIdle` could kill a worker
   * that was still in use.
   */
  private spawnWorker(lang: 'python' | 'javascript'): WarmWorker {
    const w = new WarmWorker(this.kernel, lang, {
      pythonBin: this.opts.pythonBin,
      nodeBin: this.opts.nodeBin,
      onExit: () => this.onWorkerExit(lang, w),
    });
    this.workerSpawns++;
    return w;
  }

  private onWorkerExit(lang: 'python' | 'javascript', w: WarmWorker): void {
    // Remove from the free list if it was idle-crashed.
    const list = this.freeWarm.get(lang);
    if (list) this.freeWarm.set(lang, list.filter((x) => x !== w));
  }

  private takeFree(lang: 'python' | 'javascript'): WarmWorker | undefined {
    const list = this.freeWarm.get(lang);
    if (!list || list.length === 0) return undefined;
    // Prefer an alive worker; drop dead ones discovered here.
    while (list.length) {
      const w = list.shift()!;
      if (w.isAlive) return w;
    }
    return undefined;
  }

  private async acquire(lang: SandboxLanguage, sessionId: string): Promise<{ worker?: WarmWorker; warm: boolean }> {
    if (lang === 'go') {
      const existed = this.goSessions.has(sessionId);
      if (!existed) this.goSessions.set(sessionId, 0);
      return { warm: existed };
    }
    const existing = this.assigned.get(sessionId);
    if (existing && existing.worker.isAlive) {
      this.warmHits++;
      return { worker: existing.worker, warm: true };
    }
    let worker = this.takeFree(lang);
    let warm = false;
    if (worker) {
      this.warmHits++;
      warm = true;
    } else {
      worker = this.spawnWorker(lang);
      this.coldStarts++;
      warm = false;
    }
    await worker.ready;
    this.assigned.set(sessionId, { languageId: lang, worker, runs: 0 });
    return { worker, warm };
  }

  async run(opts: SandboxRunOptions): Promise<SandboxRunResult> {
    const sessionId = opts.sessionId ?? `sb-${ulid().slice(-10)}`;
    const runId = `run-${ulid().slice(-10)}`;
    const timeoutMs = opts.timeoutMs ?? this.opts.runTimeoutMs ?? 15_000;
    const t0 = performance.now();
    const span = this.kernel.tracer.startSpan('sandbox.run', {
      attributes: { languageId: opts.languageId, sessionId, runId },
    });
    const runLog = this.kernel.logger.forExecution('sandbox.run', sessionId).span(span);

    if (opts.languageId === 'go') {
      if (!this.goRunner) {
        span.end();
        throw new Error('Go toolchain unavailable in this sandbox pool');
      }
      const r = await this.goRunner.run({
        code: opts.code,
        sessionId,
        mode: opts.mode,
        timeoutMs,
      });
      this.runs++;
      this.goSessions.set(sessionId, (this.goSessions.get(sessionId) ?? 0) + 1);
      const durationMs = performance.now() - t0;
      this.kernel.perfMetrics().record('sandbox.run', durationMs);
      const lines = collectSandboxOutput(this.kernel, 'go', sessionId, runId, r.stdout, r.stderr);
      runLog.info('Go sandbox run', { warm: false, durationMs: Math.round(durationMs), lines, exitCode: r.exitCode });
      span.setAttribute('exitCode', r.exitCode).end();
      return {
        languageId: 'go',
        sessionId,
        runId,
        warm: false,
        exitCode: r.exitCode,
        signal: r.signal,
        durationMs,
        stdout: r.stdout,
        stderr: r.stderr,
        ok: r.exitCode === 0 && !r.timedOut,
        logLines: lines,
        timedOut: r.timedOut,
        mode: r.mode,
        phase: r.phase,
        compileError: r.compileError,
        buildMs: r.buildMs,
        binary: r.goBin,
      };
    }

    const { worker, warm } = await this.acquire(opts.languageId, sessionId);
    if (!worker) {
      span.end();
      throw new Error(`sandbox worker for ${opts.languageId} unavailable`);
    }
    let res;
    try {
      res = await worker.run(opts.code, timeoutMs);
    } catch (err) {
      // Worker died mid-run (timeout kills it) — recycle and report failure.
      this.idleRecycles++;
      await worker.recycle().catch(() => undefined);
      this.assigned.delete(sessionId);
      const durationMs = performance.now() - t0;
      this.kernel.perfMetrics().record('sandbox.run', durationMs);
      span.setAttribute('exitCode', -1).end();
      return {
        languageId: opts.languageId,
        sessionId,
        runId,
        warm,
        exitCode: -1,
        signal: null,
        durationMs,
        stdout: '',
        stderr: (err as Error).message,
        ok: false,
        error: (err as Error).message,
        logLines: 0,
        timedOut: true,
        mode: opts.mode ?? 'run',
      };
    }
    worker.release();
    const a = this.assigned.get(sessionId);
    if (a) a.runs++;

    const durationMs = performance.now() - t0;
    this.runs++;
    this.kernel.perfMetrics().record('sandbox.run', durationMs);
    this.recordWorkerGauge();
    const lines = collectSandboxOutput(
      this.kernel,
      opts.languageId,
      sessionId,
      runId,
      res.stdout,
      res.stderr,
    );
    runLog.info('Sandbox run', {
      warm,
      durationMs: Math.round(durationMs),
      lines,
      ok: res.ok,
      pid: worker.pid,
    });
    span.setAttribute('exitCode', res.ok ? 0 : 1).end();
    return {
      languageId: opts.languageId,
      sessionId,
      runId,
      warm,
      exitCode: res.ok ? 0 : 1,
      signal: null,
      durationMs,
      stdout: res.stdout,
      stderr: res.stderr,
      ok: res.ok,
      error: res.error,
      logLines: lines,
      timedOut: false,
      mode: opts.mode ?? 'run',
    };
  }

  private recordWorkerGauge(): void {
    let alive = 0;
    for (const list of this.freeWarm.values()) alive += list.filter((w) => w.isAlive).length;
    for (const a of this.assigned.values()) if (a.worker.isAlive) alive++;
    this.kernel.perfMetrics().record('sandbox.workers', alive);
  }

  private recycleIdle(maxIdleMs: number): void {
    for (const lang of ['python', 'javascript'] as const) {
      const list = this.freeWarm.get(lang);
      if (!list) continue;
      const keep: WarmWorker[] = [];
      for (const w of list) {
        if (w.isAlive && w.idleMs() > maxIdleMs) {
          this.idleRecycles++;
          void w.recycle().catch(() => undefined);
        } else if (w.isAlive) {
          keep.push(w);
        }
      }
      this.freeWarm.set(lang, keep);
    }
  }

  /** Dispose a session's worker (or Go scratch dir) and forget it. */
  async reset(sessionId: string): Promise<boolean> {
    const a = this.assigned.get(sessionId);
    if (a) {
      this.assigned.delete(sessionId);
      await a.worker.recycle().catch(() => undefined);
      return true;
    }
    if (this.goSessions.has(sessionId)) {
      this.goSessions.delete(sessionId);
      await this.goRunner?.resetSession(sessionId);
      return true;
    }
    return false;
  }

  list(): SandboxSessionInfo[] {
    const out: SandboxSessionInfo[] = [];
    for (const [sessionId, a] of this.assigned) {
      out.push({ sessionId, languageId: a.languageId, warm: a.worker.isAlive, runs: a.runs });
    }
    for (const [sessionId, runs] of this.goSessions) {
      out.push({ sessionId, languageId: 'go', warm: true, runs });
    }
    return out;
  }

  /** Number of currently-alive persistent workers (for the status bar). */
  workerCount(): number {
    let n = 0;
    for (const list of this.freeWarm.values()) n += list.filter((w) => w.isAlive).length;
    for (const a of this.assigned.values()) if (a.worker.isAlive) n++;
    return n;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const list of this.freeWarm.values()) {
      for (const w of list) await w.recycle().catch(() => undefined);
    }
    for (const a of this.assigned.values()) await a.worker.recycle().catch(() => undefined);
    this.freeWarm.clear();
    this.assigned.clear();
  }
}
