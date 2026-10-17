/**
 * JavaScript runner — the IDE's Run path for `.js` / `.mjs` / `.cjs`.
 *
 * There is deliberately **no second process manager here**. A run is delegated
 * to the execution plane (Stage 9 warm pool), which already keeps persistent
 * `node` workers and carries a session's globals between runs — the same
 * machinery `sandbox.run` / `code.run` use. Duplicating it would mean two
 * owners for `node` processes and two answers to "what is a session?".
 *
 * The pool is constructed *after* the workspace (see `panel/server.ts`), so the
 * runner is created empty and handed the plane by `WorkspaceService.setExec()`.
 * Until then `run()` says so explicitly instead of failing obscurely.
 *
 * **What a JavaScript snippet is allowed to be.** The worker executes it in a
 * `vm` context inside the shared process, not in a fresh one, and the context's
 * `process` is a read-only stub. Consequences worth knowing:
 *
 *   - `console.log` / `console.error` are captured (stdout / stderr).
 *   - An **uncaught `throw` is the non-zero exit**, exactly the way a Python
 *     traceback is. There is no `process.exit()` to call.
 *   - Execution is **synchronous per run**: the worker answers the moment the
 *     script's top-level returns, so output produced from a `setTimeout` /
 *     promise callback after that point is not part of the result.
 *   - **Runs are independent.** The process is reused (no respawn), but each run
 *     gets a fresh vm context, so nothing carries over between runs — that is
 *     what keeps an ordinary snippet with a top-level `const` re-runnable (a
 *     shared context would fail the second Run with "already been declared").
 *     So unlike Python, a JS session is a warm process, not a live namespace.
 */
import type { Kernel } from '../kernel/Kernel.js';
import type { ExecService } from '../exec/ExecService.js';
import { resolveNodeBin, type NodeBinResolution } from './discover.js';

export interface JsRunOptions {
  code: string;
  /**
   * Session id. Reusing one keeps the warm worker, so a sequence of runs pays
   * the cold start once — it does not carry state between runs.
   */
  sessionId?: string;
  /** Hard timeout in ms (kills + recycles the worker). */
  timeoutMs?: number;
}

export interface JsRunResult {
  sessionId: string;
  runId: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Output lines, already replayed onto the log spine by the pool. */
  logLines: number;
  nodeBin: string;
  /** True when the run reused an already-alive worker (no cold spawn). */
  warm: boolean;
}

/**
 * Prefix for the pool's session keys. The pool indexes sessions by `sessionId`
 * alone, so a workspace run must not share an id with a sandbox client that
 * happens to pick the same one — hence one language-scoped namespace.
 */
const NS = 'js:';

export class JsRunner {
  private exec?: ExecService;
  private readonly known = new Set<string>();
  private readonly resolved: NodeBinResolution;

  constructor(_kernel: Kernel, nodeBin?: string) {
    this.resolved = resolveNodeBin(nodeBin ?? process.env.NODE_BIN);
  }

  /**
   * Attach the execution plane. Called by `WorkspaceService.setExec()` once the
   * host has constructed it.
   */
  attachExec(exec: ExecService): void {
    this.exec = exec;
  }

  get binary(): string {
    return this.resolved.bin;
  }

  /** Where the runtime was found (for the status bar / diagnostics). */
  get discovery(): NodeBinResolution {
    return this.resolved;
  }

  get available(): boolean {
    return this.resolved.source !== 'missing';
  }

  /** Number of live sessions (for the UI status bar). */
  sessionCount(): number {
    return this.known.size;
  }

  async run(opts: JsRunOptions): Promise<JsRunResult> {
    if (!this.exec) {
      throw new Error('JavaScript execution plane is unavailable — Run needs the sandbox pool (WorkspaceService.setExec)');
    }
    const sessionId = opts.sessionId ?? 'ide';
    const key = NS + sessionId;
    const r = await this.exec.run({
      languageId: 'javascript',
      sessionId: key,
      code: opts.code,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
    this.known.add(key);
    return {
      sessionId,
      runId: r.runId,
      exitCode: r.exitCode,
      signal: r.signal,
      durationMs: r.durationMs,
      stdout: r.stdout,
      // The worker reports a thrown stack separately from stderr; fold it in so
      // the Output tab shows the failure the way a Python traceback appears.
      stderr: r.error ? (r.stderr ? r.stderr + '\n' : '') + r.error : r.stderr,
      timedOut: r.timedOut,
      logLines: r.logLines,
      nodeBin: this.resolved.bin,
      warm: r.warm,
    };
  }

  /** Drop a session: its warm worker is disposed, so the next run starts cold. */
  async resetSession(sessionId: string): Promise<boolean> {
    const key = NS + sessionId;
    const existed = this.known.delete(key);
    const reset = (await this.exec?.reset(key)) ?? false;
    return existed || reset;
  }

  /** The pool owns the workers, so there is nothing of our own to dispose. */
  async close(): Promise<void> {
    /* the execution plane owns worker lifetime */
  }
}
