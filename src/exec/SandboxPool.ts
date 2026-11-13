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
  /** Only generated-ID sessions may be evicted automatically. */
  ephemeral: boolean;
}

interface RequestedSession {
  languageId: SandboxLanguage;
  ephemeral: boolean;
}

export class SandboxPool {
  private freeWarm = new Map<SandboxLanguage, WarmWorker[]>();
  private assigned = new Map<string, Assigned>();
  private requestedSessions = new Map<string, RequestedSession>(); // created but not yet running Python/JS sessions
  private goSessions = new Map<string, number>(); // sessionId -> run count
  private ephemeralGo = new Set<string>();
  private goLastUsed = new Map<string, number>();
  /** FIFO tails for each stateful session; unrelated sessions still run in parallel. */
  private sessionTails = new Map<string, Promise<void>>();
  /** Serializes global capacity decisions while session execution remains parallel. */
  private capacityTail: Promise<void> = Promise.resolve();
  private pendingCapacity = 0;
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
    const minSize = Math.max(0, Math.floor(opts.minSize ?? 1));
    const idleMax = Math.max(0, Math.floor(opts.maxSize ?? 2));
    const workerMax = Math.max(1, Math.floor(opts.maxWorkers ?? 8));
    if (minSize > 0) {
      for (const lang of ['python', 'javascript'] as const) {
        for (let i = 0; i < Math.min(minSize, idleMax) && this.workerCount() < workerMax; i++) this.spawnFree(lang);
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

  /**
   * Serialize mutations of one session from acquisition through release.
   *
   * A worker speaks one request at a time, and Python sessions share a namespace.
   * Without this queue, simultaneous first calls both observe an unassigned id,
   * spawn separate workers and overwrite the map entry; simultaneous later calls
   * hit WarmWorker's `busy` rejection, which the caller mistakes for worker death.
   * Different session ids have different tails, so they remain concurrent.
   */
  private serializeSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.sessionTails.set(sessionId, tail);
    return previous.then(operation).finally(() => {
      release();
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    });
  }

  private takeFree(lang: 'python' | 'javascript'): WarmWorker | undefined {
    const list = this.freeWarm.get(lang);
    if (!list || list.length === 0) return undefined;
    // Prefer an alive worker; drop dead ones discovered here.
    while (list.length) {
      const w = list.shift()!;
      if (w.isAlive || w.isStarting) return w;
    }
    return undefined;
  }

  private maxWorkers(): number { return Math.max(1, Math.floor(this.opts.maxWorkers ?? 8)); }

  private sessionCount(): number { return this.workerCount() + this.goSessions.size + this.requestedSessions.size; }

  /**
   * Make room only by reclaiming an idle session that the caller did not name.
   * Named Python/JS sessions can contain user state and are never silently
   * evicted. Callers that fill the cap with named sessions get an explicit error.
   */
  private async makeRoom(requestingSession: string): Promise<boolean> {
    const previous = this.capacityTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.capacityTail = previous.then(() => gate);
    await previous;
    try {
      const ownRequest = this.requestedSessions.has(requestingSession) ? 1 : 0;
      let occupied = this.sessionCount() - ownRequest + this.pendingCapacity;
      if (occupied >= this.maxWorkers()) {
        const workerCandidates = [...this.assigned.entries()]
          .filter(([id, a]) => id !== requestingSession && a.ephemeral && !a.worker.isBusy && !this.sessionTails.has(id))
          .sort((a, b) => b[1].worker.idleMs() - a[1].worker.idleMs());
        const oldestWorker = workerCandidates[0];
        if (oldestWorker) {
          this.assigned.delete(oldestWorker[0]);
          this.idleRecycles++;
          await oldestWorker[1].worker.recycle().catch(() => undefined);
        } else {
          const oldestRequested = [...this.requestedSessions.entries()].find(([id, session]) => id !== requestingSession && session.ephemeral);
          if (oldestRequested) {
            this.requestedSessions.delete(oldestRequested[0]);
          } else {
            const oldestGo = [...this.ephemeralGo]
              .filter((id) => id !== requestingSession && !this.sessionTails.has(id))
              .sort((a, b) => (this.goLastUsed.get(a) ?? 0) - (this.goLastUsed.get(b) ?? 0))[0];
            if (!oldestGo) return false;
            this.ephemeralGo.delete(oldestGo);
            this.goSessions.delete(oldestGo);
            this.goLastUsed.delete(oldestGo);
            await this.goRunner?.resetSession(oldestGo);
          }
        }
        occupied = this.sessionCount() - ownRequest + this.pendingCapacity;
      }
      if (occupied >= this.maxWorkers()) return false;
      // Reserve synchronously before releasing the gate, so two distinct
      // session IDs cannot both pass the final slot check.
      this.pendingCapacity++;
      return true;
    } finally {
      release();
    }
  }

  private releaseCapacity(): void {
    this.pendingCapacity = Math.max(0, this.pendingCapacity - 1);
  }

  private async ensureGoSession(sessionId: string, ephemeral: boolean): Promise<boolean> {
    const requested = this.requestedSessions.get(sessionId);
    if (requested && requested.languageId !== 'go') {
      throw new Error(`sandbox session "${sessionId}" already belongs to ${requested.languageId}`);
    }
    if (this.assigned.has(sessionId)) {
      throw new Error(`sandbox session "${sessionId}" already belongs to ${this.assigned.get(sessionId)!.languageId}`);
    }
    if (this.goSessions.has(sessionId)) {
      this.goLastUsed.set(sessionId, Date.now());
      return true;
    }
    if (!this.goRunner) throw new Error('Go toolchain unavailable in this sandbox pool');
    if (!(await this.makeRoom(sessionId))) {
      throw new Error(`sandbox session limit reached (${this.maxWorkers()}); reset a named session or increase maxWorkers`);
    }
    try {
      await this.goRunner.session(sessionId);
      this.goSessions.set(sessionId, 0);
      if (ephemeral || requested?.ephemeral) this.ephemeralGo.add(sessionId);
      this.requestedSessions.delete(sessionId);
      this.goLastUsed.set(sessionId, Date.now());
      return false;
    } finally {
      this.releaseCapacity();
    }
  }

  createSession(languageId: SandboxLanguage, sessionId: string, ephemeral = false): Promise<{ warm: boolean }> {
    return this.serializeSession(sessionId, async () => {
      const assigned = this.assigned.get(sessionId);
      if (assigned && assigned.languageId !== languageId) {
        throw new Error(`sandbox session "${sessionId}" already belongs to ${assigned.languageId}`);
      }
      const goExists = this.goSessions.has(sessionId);
      if (goExists && languageId !== 'go') throw new Error(`sandbox session "${sessionId}" already belongs to go`);
      const requested = this.requestedSessions.get(sessionId);
      if (requested && requested.languageId !== languageId) {
        throw new Error(`sandbox session "${sessionId}" already belongs to ${requested.languageId}`);
      }
      if (languageId === 'go') return { warm: await this.ensureGoSession(sessionId, ephemeral) };
      if (assigned) return { warm: assigned.worker.isAlive };
      if (!requested) {
        if (!(await this.makeRoom(sessionId))) {
          throw new Error(`sandbox session limit reached (${this.maxWorkers()}); reset a named session or increase maxWorkers`);
        }
        try {
          this.requestedSessions.set(sessionId, { languageId, ephemeral });
        } finally {
          this.releaseCapacity();
        }
      }
      return { warm: false };
    });
  }

  private async acquire(lang: SandboxLanguage, sessionId: string, ephemeral: boolean): Promise<{ worker?: WarmWorker; warm: boolean }> {
    const existing = this.assigned.get(sessionId);
    const requested = this.requestedSessions.get(sessionId);
    if (requested && requested.languageId !== lang) {
      throw new Error(`sandbox session "${sessionId}" already belongs to ${requested.languageId}`);
    }
    ephemeral = ephemeral || !!requested?.ephemeral;
    if (lang === 'go') {
      const warm = await this.ensureGoSession(sessionId, ephemeral);
      return { warm };
    }
    if (this.goSessions.has(sessionId)) {
      throw new Error(`sandbox session "${sessionId}" already belongs to go`);
    }
    if (existing && existing.languageId !== lang) {
      throw new Error(`sandbox session "${sessionId}" already belongs to ${existing.languageId}`);
    }
    if (existing && existing.worker.isAlive) {
      this.warmHits++;
      return { worker: existing.worker, warm: true };
    }
    let worker = this.takeFree(lang);
    const warm = !!worker;
    if (worker) {
      this.warmHits++;
      // Taking a free worker temporarily removes it from the live count. Reserve
      // that slot during the hand-off so another session cannot over-admit.
      this.pendingCapacity++;
    } else {
      if (!(await this.makeRoom(sessionId))) {
        throw new Error(`sandbox session limit reached (${this.maxWorkers()}); reset a named session or increase maxWorkers`);
      }
      this.coldStarts++;
    }
    try {
      if (!worker) worker = this.spawnWorker(lang);
      await worker.ready;
      this.assigned.set(sessionId, { languageId: lang, worker, runs: 0, ephemeral });
      this.requestedSessions.delete(sessionId);
      return { worker, warm };
    } finally {
      this.releaseCapacity();
    }
  }

  run(opts: SandboxRunOptions): Promise<SandboxRunResult> {
    const ephemeral = opts.sessionId == null;
    const sessionId = opts.sessionId ?? `sb-${ulid().slice(-10)}`;
    const runId = `run-${ulid().slice(-10)}`;
    const queuedAt = performance.now();
    const span = this.kernel.tracer.startSpan('sandbox.run', {
      attributes: { languageId: opts.languageId, sessionId, runId },
    });
    const runLog = this.kernel.logger.forExecution('sandbox.run', sessionId).span(span);
    return this.serializeSession(sessionId, () => this.runInSession(opts, sessionId, runId, queuedAt, span, runLog, ephemeral)).catch((err) => {
      span.setAttribute('error', true).end();
      throw err;
    });
  }

  private async runInSession(
    opts: SandboxRunOptions,
    sessionId: string,
    runId: string,
    queuedAt: number,
    span: ReturnType<Kernel['tracer']['startSpan']>,
    runLog: ReturnType<Kernel['logger']['forExecution']>,
    ephemeral: boolean,
  ): Promise<SandboxRunResult> {
    const t0 = queuedAt;
    const queueWaitMs = performance.now() - queuedAt;
    const timeoutMs = opts.timeoutMs ?? this.opts.runTimeoutMs ?? 15_000;

    if (opts.languageId === 'go') {
      if (!this.goRunner) {
        throw new Error('Go toolchain unavailable in this sandbox pool');
      }
      await this.ensureGoSession(sessionId, ephemeral);
      const r = await this.goRunner.run({
        code: opts.code,
        sessionId,
        mode: opts.mode,
        timeoutMs,
      });
      this.runs++;
      this.goSessions.set(sessionId, (this.goSessions.get(sessionId) ?? 0) + 1);
      this.goLastUsed.set(sessionId, Date.now());
      const durationMs = performance.now() - t0;
      this.kernel.perfMetrics().record('sandbox.run', durationMs);
      const lines = collectSandboxOutput(this.kernel, 'go', sessionId, runId, r.stdout, r.stderr);
      runLog.info('Go sandbox run', { warm: false, durationMs: Math.round(durationMs), queueWaitMs: Math.round(queueWaitMs), lines, exitCode: r.exitCode });
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
        stdoutTruncated: r.stdoutTruncated,
        stderrTruncated: r.stderrTruncated,
        logLinesTruncated: r.logLinesTruncated,
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

    const { worker, warm } = await this.acquire(opts.languageId, sessionId, ephemeral);
    if (!worker) {
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
      queueWaitMs: Math.round(queueWaitMs),
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
      stdoutTruncated: res.stdoutTruncated,
      stderrTruncated: res.stderrTruncated,
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
        } else if (w.isAlive || w.isStarting) {
          keep.push(w);
        }
      }
      this.freeWarm.set(lang, keep);
    }
    const sessionIdleMs = Math.max(0, this.opts.maxSessionIdleMs ?? 5 * 60_000);
    if (sessionIdleMs > 0) {
      for (const [sessionId] of this.requestedSessions) {
        if (this.sessionTails.has(sessionId)) continue;
        this.requestedSessions.delete(sessionId);
        this.kernel.logger.forExecution('sandbox.session', sessionId).info('Unused named sandbox session expired after idle timeout', { idleMs: sessionIdleMs });
      }
      for (const [sessionId, session] of this.assigned) {
        if (!session.ephemeral || session.worker.isBusy || this.sessionTails.has(sessionId) || session.worker.idleMs() <= sessionIdleMs) continue;
        this.assigned.delete(sessionId);
        this.idleRecycles++;
        this.kernel.logger.forExecution('sandbox.session', sessionId).info('Unnamed sandbox session expired after idle timeout', { idleMs: session.worker.idleMs(), runs: session.runs });
        void session.worker.recycle().catch(() => undefined);
      }
      const now = Date.now();
      for (const sessionId of this.ephemeralGo) {
        const idleMs = now - (this.goLastUsed.get(sessionId) ?? now);
        if (this.sessionTails.has(sessionId) || idleMs <= sessionIdleMs) continue;
        this.ephemeralGo.delete(sessionId);
        this.goSessions.delete(sessionId);
        this.goLastUsed.delete(sessionId);
        this.kernel.logger.forExecution('sandbox.session', sessionId).info('Unnamed Go sandbox session expired after idle timeout', { idleMs });
        void this.goRunner?.resetSession(sessionId);
      }
    }
  }

  /** Dispose a session's worker (or Go scratch dir) and forget it. */
  reset(sessionId: string): Promise<boolean> {
    return this.serializeSession(sessionId, async () => {
      if (this.requestedSessions.delete(sessionId)) return true;
      const a = this.assigned.get(sessionId);
      if (a) {
        this.assigned.delete(sessionId);
        await a.worker.recycle().catch(() => undefined);
        return true;
      }
      if (this.goSessions.has(sessionId)) {
        this.goSessions.delete(sessionId);
        this.ephemeralGo.delete(sessionId);
        this.goLastUsed.delete(sessionId);
        await this.goRunner?.resetSession(sessionId);
        return true;
      }
      return false;
    });
  }

  list(): SandboxSessionInfo[] {
    const out: SandboxSessionInfo[] = [];
    for (const [sessionId, requested] of this.requestedSessions) {
      out.push({ sessionId, languageId: requested.languageId, warm: false, runs: 0 });
    }
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
    for (const list of this.freeWarm.values()) n += list.filter((w) => w.isAlive || w.isStarting).length;
    for (const a of this.assigned.values()) if (a.worker.isAlive || a.worker.isStarting) n++;
    return n;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const list of this.freeWarm.values()) {
      for (const w of list) await w.recycle().catch(() => undefined);
    }
    for (const a of this.assigned.values()) await a.worker.recycle().catch(() => undefined);
    for (const id of this.goSessions.keys()) await this.goRunner?.resetSession(id).catch(() => false);
    this.freeWarm.clear();
    this.assigned.clear();
    this.requestedSessions.clear();
    this.goSessions.clear();
    this.ephemeralGo.clear();
    this.goLastUsed.clear();
    this.sessionTails.clear();
  }
}
