/**
 * Runtime extensions — the *only* place the substrate knows anything about
 * "running code".
 *
 * The point of this layer is that it knows **no language**. A runtime is
 * selected by a plugin's `manifest.run.mode` and driven entirely by that
 * plugin's `RunConfig`: a command template, a step list, a source extension, an
 * optional bootstrap script. `repl-session` does not know Python exists; it
 * knows "spawn this command with a stable session directory and a bootstrap".
 *
 * Adding a language therefore never touches this directory. Adding a *new kind
 * of execution* (say, a WASM host) adds exactly one file here.
 */

/** One step of a template/directory run: a command with placeholders. */
export interface RunStep {
  /**
   * What the step is for. `build` failures are reported as `compileError`
   * (the compiler rejected the source), which is what the IDE shows instead of
   * a confusing non-zero exit from the program itself.
   */
  role: 'build' | 'run' | 'test';
  /** Command template. Supports `{file}`, `{workdir}`, `{basename}`, `{exe}`, `{data}`. */
  cmd: string;
  /** Per-step timeout; falls back to the run-level timeout. */
  timeoutMs?: number;
}

/** A file a plugin wants to exist before the first run (a module manifest, a config). */
export interface ScaffoldFile {
  /** Path relative to the session directory. */
  file: string;
  /** Literal content; `{workdir}` / `{data}` are substituted. */
  template: string;
}

export interface ScaffoldSpec {
  /** True when the language cannot run without these files at all. */
  required?: boolean;
  /** Written once, before the first run of a session, when missing. */
  onFirstRun?: ScaffoldFile[];
  /** Files whose presence makes the LSP "fully capable". */
  projectFiles?: string[];
}

/** How to find a toolchain binary. All fields optional; the first hit wins. */
export interface BinaryDiscoverySpec {
  /** Executable names looked up on PATH. */
  commands?: string[];
  /** Environment variables holding an explicit path. */
  envVars?: string[];
  /** Absolute or `~`-relative paths to probe. */
  knownPaths?: string[];
}

/** A plugin's `manifest.run` block, validated and ready to drive a runtime. */
export interface RunConfig {
  /** Runtime id — `template` | `repl-session` | `directory-session` | `inline-vm` | `script-host`. */
  mode: string;
  /** Runtime version constraints, e.g. `["template@^1.0.0"]`. */
  requires?: string[];
  /** Default timeout for one run. */
  timeoutMs?: number;
  /** Command prefix, e.g. `["python"]`. The runtime appends the source/bootstrap. */
  command?: string[];
  /** Source file extension *with* the dot, e.g. `.py`. */
  sourceExt?: string;
  /**
   * Plugin-relative path to a bootstrap script that implements session
   * persistence. The runtime guarantees the session directory; the bootstrap
   * decides what to persist and how.
   */
  bootstrap?: string;
  /** Default step list (used by `template` and `directory-session`). */
  steps?: RunStep[];
  /** Per-mode overrides — `run` / `test` / anything the plugin names. */
  modes?: Record<string, { steps?: RunStep[]; timeoutMs?: number; command?: string[] }>;
  /** Extra environment for the child process. */
  env?: Record<string, string>;
  /** `inline-vm`: wall-clock limit for one evaluation. */
  vmTimeoutMs?: number;
  /** `script-host`: plugin-relative entry point. */
  script?: string;
  /** Files the plugin needs in the session directory before the first run. */
  scaffold?: ScaffoldSpec;
  /** Where the toolchain lives; `{toolchain}` in `command` resolves to it. */
  discovery?: BinaryDiscoverySpec;
  /** Args that make the toolchain print its version (`["-V"]`, `["version"]`). */
  versionArgs?: string[];
}

export interface RunRequest {
  code?: string;
  file?: string;
  sessionId?: string;
  /** Defaults to `run`; a plugin may declare more (Go uses `test`). */
  mode?: string;
  timeoutMs?: number;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  onData?: (stream: 'stdout' | 'stderr', text: string) => void;
  onStdinReady?: (sink: (data: string) => void) => void;
}

/**
 * Uniform result. Every runtime returns this, so `WorkspaceService` never
 * branches on language again.
 */
export interface RunOutcome {
  sessionId: string;
  runId: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  logLines: number;
  /** Which binary/command produced the output. */
  binary: string;
  /** Set when a multi-step run failed part-way. */
  phase?: 'build' | 'run' | 'test';
  /** True when a `build` step rejected the source. */
  compileError?: boolean;
  /** Wall time of the `build` step, when there was one. */
  buildMs?: number;
}

/** The interface a runtime hands back. */
export interface Runner {
  /** Resolved command/binary, for the status bar. */
  readonly binary: string;
  /** False when the toolchain is missing (the runner still answers, with an error). */
  readonly available: boolean;
  run(opts: RunRequest): Promise<RunOutcome>;
  resetSession(sessionId: string): Promise<boolean>;
  sessionCount(): number;
  close(): Promise<void>;
}

export interface ValidationResult {
  ok: boolean;
  /** Human-readable reasons when `ok` is false. */
  errors: string[];
}

/** What a runtime may use from the host. Deliberately small. */
export interface HostContext {
  /** Kernel for logging / metrics / tracing. Typed loosely to keep this layer standalone. */
  kernel: RuntimeKernel;
  languageId: string;
  /** Writable per-language data directory (`~/.nolanguage/data/<id>`). */
  dataDir: string;
  /** Read-only plugin directory (bootstrap / script assets live here). */
  pluginDir: string;
  /** Toolchain binary discovered from the manifest, if any. */
  toolchain?: string;
  /** Execution plane, when the host has one (used by `inline-vm`). */
  exec?: unknown;
}

/**
 * The slice of `Kernel` this layer needs. Narrow on purpose: a runtime is a
 * plugin-facing capability, so it must not reach into the whole kernel.
 */
export interface RuntimeKernel {
  logger: {
    forExecution(scope: string, id?: string): RuntimeLogger;
    /**
     * User-code scope: every stdout/stderr line a *program* prints becomes a
     * record here, which is what the Logs tab filters on. Optional so a bare
     * kernel stub in a test still works.
     */
    forUserCode?(languageId: string, sessionId?: string): RuntimeLogger;
  };
  perfMetrics(): { record(name: string, value: number): void };
  tracer: {
    startSpan(name: string, opts?: { attributes?: Record<string, unknown> }): RuntimeSpan;
  };
}

export interface RuntimeLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>, err?: unknown): void;
}

export interface RuntimeSpan {
  setAttribute(key: string, value: unknown): RuntimeSpan;
  end(): void;
}

/** A runtime capability. */
export interface RuntimeExtension {
  readonly id: string;
  readonly version: string;
  /** Check that a plugin's `RunConfig` is usable by this runtime. */
  validate(config: RunConfig, languageId: string): ValidationResult;
  createRunner(config: RunConfig, ctx: HostContext): Runner;
}
