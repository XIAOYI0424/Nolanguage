/**
 * Execution plane (Stage 9 · 沙箱预热池).
 *
 * A process-based warm-worker pool: persistent interpreter processes (Python /
 * Node) that stay alive across runs, so a run never re-pays the cold-spawn cost
 * every time. What "stays warm" *means* differs per language: Python keeps its
 * namespace (state carries over), Node reuses the process but runs each snippet
 * in a fresh vm context (see `workerSource.ts` for why that is deliberate), and
 * Go cannot keep interpreter state at all — its "warm" worker is a scratch
 * directory that persists the module + written files between runs (the
 * toolchain is resolved once, up-front).
 *
 * This is the L1 execution plane of 方案.md §七 — the layer the IDE's Run and
 * (later) the AI MCP tools (`code.run` / `sandbox.create` / `sandbox.reset`)
 * sit on. It is intentionally separate from `PythonRunner` / `GoRunner` (the
 * simple cold runners the IDE Run button still uses) so it can evolve the warm
 * pool without regressing the existing paths.
 *
 * Every run is correlated by `sessionId` and lands on the two spines:
 *   - metrics: `sandbox.warm.hit` / `sandbox.cold.start` / `sandbox.worker.spawn`
 *              / `sandbox.idle.recycle` / `sandbox.run` / `sandbox.workers`
 *   - logs:    `SandboxLogCollector` turns worker stdout/stderr into `user-code`
 *              LogRecords tagged with the sessionId (spec §七: "stdout/stderr 捕获").
 */

export type SandboxLanguage = 'python' | 'javascript' | 'go';

export interface SandboxRunOptions {
  languageId: SandboxLanguage;
  /** Reuse a session to keep variables / files. Generated when omitted. */
  sessionId?: string;
  code: string;
  args?: string[];
  mode?: 'run' | 'test';
  /** Hard timeout in ms (kills + recycles a misbehaving worker). */
  timeoutMs?: number;
}

export interface SandboxRunResult {
  languageId: SandboxLanguage;
  sessionId: string;
  runId: string;
  /** True when the run reused an already-alive worker (no cold spawn). */
  warm: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  /** True when the in-worker execution raised (Python) or errored (Node). */
  ok: boolean;
  /** Worker-side traceback / error text, if any. */
  error?: string | null;
  /** Output lines replayed onto the log spine as `user-code` records. */
  logLines: number;
  /** True when telemetry line cap dropped some output lines. */
  logLinesTruncated?: boolean;
  timedOut: boolean;
  mode: 'run' | 'test';
  /** Go only: which phase produced the outcome. */
  phase?: 'build' | 'run' | 'test';
  compileError?: boolean;
  buildMs?: number;
  binary?: string;
}

export interface SandboxSessionInfo {
  sessionId: string;
  languageId: SandboxLanguage;
  /** Whether a warm worker / scratch dir is currently held for the session. */
  warm: boolean;
  runs: number;
}

export interface SandboxCreateResult {
  sessionId: string;
  languageId: SandboxLanguage;
  warm: boolean;
}

/** Per-language pool tuning (spec: ~90ms cold → warm reuse). */
export interface SandboxPoolOptions {
  /** Pre-warm this many idle workers per persistent language at start. */
  minSize?: number;
  /** Never hold more than this many idle workers per language. */
  maxSize?: number;
  /** Maximum retained runtime sessions/workers across languages; excess named sessions fail clearly. */
  maxWorkers?: number;
  /** Expire unnamed/ephemeral sessions after this much idleness (default 5 minutes). */
  maxSessionIdleMs?: number;
  /** Recycle an idle warm worker after this many ms. */
  maxIdleMs?: number;
  /** Default per-run timeout. */
  runTimeoutMs?: number;
  /** Python binary (else PYTHON_BIN / `python`). */
  pythonBin?: string;
  /** Go binary (else resolveGoBin). */
  goBin?: string;
  /** Node binary for the JS worker (else `node`). */
  nodeBin?: string;
}
