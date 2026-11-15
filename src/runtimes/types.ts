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

/**
 * A project file that declares the toolchain version — `.python-version`,
 * `.nvmrc`, `package.json`'s `engines.node`, `go.mod`'s `go` line, or a
 * `pyproject.toml` key. Read-only: Nolanguage never switches versions, it only
 * uses the declaration to pick among already-installed toolchains.
 */
export interface VersionFileSpec {
  /** Project-relative path (absolute paths are also accepted). */
  path: string;
  /**
   * `plain` = first non-empty line; `json` = dot-path (`engines.node`);
   * `toml` = a single `key = "value"` line (not a full TOML parser);
   * `regex` = capture group 1 of `pattern`.
   */
  format: 'plain' | 'json' | 'toml' | 'regex';
  /** JSON dot-path or TOML key. */
  key?: string;
  /** Regex source for `format: 'regex'`. */
  pattern?: string;
}

/** How to find a toolchain binary. All fields optional; the first hit wins. */
export interface BinaryDiscoverySpec {
  /** Executable names looked up on PATH. */
  commands?: string[];
  /** Environment variables holding an explicit path. */
  envVars?: string[];
  /** Absolute or `~`-relative paths to probe; a single `*` segment is expanded. */
  knownPaths?: string[];
  /**
   * Version declarations read before `knownPaths`: a `.python-version` of
   * `3.11.4` makes `~/.pyenv/versions/STAR/bin/python3` prefer the 3.11.4 entry.
   * An explicit `envVars` path still wins over any version file.
   */
  versionFiles?: VersionFileSpec[];
}

/** A plugin's `manifest.run` block, validated and ready to drive a runtime. */
/**
 * How to find SDKs and environments for one language.
 *
 * Declared by the plugin (`run.interpreters`) so a third-party language can
 * offer the SDK picker without an engine change. Every field is optional: a
 * plugin that only wants PATH discovery declares `exeNames` and nothing else.
 *
 * This is *not* `run.discovery`. That one answers "which binary do I run";
 * this one answers "which environments exist on this machine" — venv, conda,
 * pyenv/nvm/volta installs, each with a version probe.
 */
export interface InterpretersSpec {
  /** Project-relative directory names that hold a self-contained environment. */
  envDirs?: string[];
  /** Executable paths inside an environment directory (first that exists wins). */
  envBins?: string[];
  /** File whose presence proves the directory really is an environment. */
  marker?: string;
  /** Executable names to look for on PATH. */
  exeNames?: string[];
  /** Version-manager roots, relative to the user's home. */
  versionDirs?: string[];
  /** Executable paths inside a version-manager install. */
  versionBins?: string[];
  /** File listing environments (conda), relative to the user's home. */
  envListFile?: string;
  /** Arguments that print a version. */
  versionArgs?: string[];
  /**
   * Prefix an IDE uses when naming the SDK (`"Python 3.11.9"`, `"Go 1.21"`).
   * Used to match a project's recorded SDK name against a discovered candidate.
   */
  sdkPrefix?: string;
}

export interface RunConfig {
  /** Runtime id — `template` | `repl-session` | `directory-session` | `inline-vm` | `script-host`. */
  mode: string;
  /** Runtime version constraints, e.g. `["template@^1.0.0"]`. */
  requires?: string[];
  /** Default timeout for one run. */
  timeoutMs?: number;
  /**
   * The plugin ships line coverage for this language.
   *
   * Declared rather than inferred: coverage needs an instrumented run, which is
   * a per-language implementation detail. Before this field the panel compared
   * `language !== 'python'`, so a second language could never opt in without
   * editing the panel.
   */
  coverage?: boolean;
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
  /** Where to look for SDKs/environments. Falls back to the engine's table. */
  interpreters?: InterpretersSpec;
  /**
   * `script-host`: optional OS-level memory cap as a human string
   * (`"256MB"`, `"1GB"`). Overridden by `NOLANGUAGE_SCRIPT_HOST_MEM_LIMIT`.
   * Clamped to the safe range [64MB, 4GB]; default 256MB. The cap is enforced
   * two ways: a V8 `--max-old-space-size` (heap) and a child-side RSS watchdog
   * that self-terminates the process past the cap (Node exposes no portable
   * `setrlimit`, so this is a soft but cross-platform limit with zero deps).
   */
  memoryHint?: string;
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
  /** Host cancellation (the IDE's Stop button). Runtimes race it against the child. */
  signal?: AbortSignal;
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
  /** True when process output exceeded the bounded capture budget. */
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  logLinesTruncated?: boolean;
  timedOut: boolean;
  /** True when the host stopped the run (Stop button) instead of it exiting. */
  cancelled?: boolean;
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
