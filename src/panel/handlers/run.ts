/**
 * Execution: the script runner, Run, Stop, environment creation, and the run
 * timeout.
 *
 * The modules next door own the rest of the same feature: `terminal.ts` the
 * attached shell, `debug.ts` the DAP session, `tests.ts` the test tree. What is
 * left here is the pipeline a Run button drives, plus the one helper that decides
 * how long a client may let it run.
 *
 * Nothing here branches on a language: the run block and the interpreter plan all
 * come from the language plugin's manifest.
 */
import {
  classpathProblem,
  mainClassProblem,
  parseEnv,
  splitArgs,
} from '../../scaffold/runConfigs.js';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { environmentExecutable, planEnvironment } from '../../langs/interpreters.js';
import { OutputDecoder, decodeOutput } from '../../util/encoding.js';
import type { WorkspaceService } from '../WorkspaceService.js';
import { stateFor } from '../conn-state.js';
import { asLanguage } from './languages.js';

/**
 * Command-palette script runner (the server side of `nlg run <script> -- <args>`).
 *
 * Mirrors the `nlg` wrapper exactly: it resolves `<script>` to `scripts/<script>.ts`
 * (run through the resolve-loader) or `<script>.mjs` (run directly), then spawns
 * Node with the user's args. The script name is whitelisted to `[A-Za-z0-9_-]+`
 * and must exist on disk, so a palette entry can never reach an arbitrary path.
 * Output streams back live as `scriptOut`; a final `scriptResult` carries the
 * exit code.
 */
export function handleRunScript(
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
  projectRoot: string,
): void {
  const script = typeof msg.script === 'string' ? msg.script : '';
  if (!/^[A-Za-z0-9_-]+$/.test(script)) {
    reply({ kind: 'scriptResult', ok: false, code: -1, ms: 0, error: `invalid script name: ${JSON.stringify(script)}` });
    return;
  }
  const args = Array.isArray(msg.args) ? (msg.args as unknown[]).map((a) => String(a)) : [];
  const tsPath = join(projectRoot, 'scripts', `${script}.ts`);
  const mjsPath = join(projectRoot, 'scripts', `${script}.mjs`);
  const useTs = existsSync(tsPath);
  const entry = useTs ? tsPath : mjsPath;
  if (!useTs && !existsSync(mjsPath)) {
    reply({ kind: 'scriptResult', ok: false, code: -1, ms: 0, error: `script not found: scripts/${script}.(ts|mjs)` });
    return;
  }
  const nodeArgs = useTs
    ? ['--experimental-transform-types', '--experimental-loader', pathToFileURL(join(projectRoot, 'resolve-loader.mjs')).href, entry, ...args]
    : [entry, ...args];
  const started = Date.now();
  let bytes = 0;
  const CAP = 4 * 1024 * 1024;
  const child = spawn(process.execPath, nodeArgs, {
    cwd: projectRoot,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cap = (d: Buffer): void => {
    bytes += d.length;
    if (bytes > CAP) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };
  const outDecoder = new OutputDecoder();
  const errDecoder = new OutputDecoder();
  child.stdout?.on('data', (d) => { cap(d); reply({ kind: 'scriptOut', stream: 'stdout', text: outDecoder.push(d) }); });
  child.stderr?.on('data', (d) => { cap(d); reply({ kind: 'scriptOut', stream: 'stderr', text: errDecoder.push(d) }); });
  child.on('error', (err) => {
    reply({ kind: 'scriptResult', ok: false, code: 1, ms: Date.now() - started, error: String(err) });
  });
  child.on('close', (code) => {
    reply({ kind: 'scriptResult', ok: code === 0, code: code ?? null, ms: Date.now() - started });
  });
}

export async function handleRun(
  client: object,
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : 'ide';
  const language = asLanguage(msg.language, workspace);
  // `mode` selects a manifest-declared mode: `test` for Go, `project` for a
  // multi-module JVM project with an explicit classpath and entry class.
  // Which modes actually do something is the manifest's business; the host only
  // validates the two free-form fields a project run must never inject.
  const mode = msg.mode === 'test' ? 'test' : msg.mode === 'project' ? 'project' : 'run';
  const classpath = typeof msg.classpath === 'string' ? msg.classpath.trim() : '';
  const mainClass = typeof msg.mainClass === 'string' ? msg.mainClass.trim() : '';
  if (mode === 'project') {
    const cpProblem = classpathProblem(classpath);
    if (cpProblem) { reply({ kind: 'error', language, message: `run failed: ${cpProblem}` }); return; }
    const mainProblem = mainClassProblem(mainClass);
    if (mainProblem) { reply({ kind: 'error', language, message: `run failed: ${mainProblem}` }); return; }
  }
  // A client may bound the run; an unusable value means "use the manifest
  // default" rather than "fire immediately" (see run-timeout.ts).
  const timeoutMs = boundedRunTimeout(msg.timeoutMs);
  try {
    // Announce the run so the UI can show a busy state before the toolchain boots.
    const st = stateFor(client);
    reply({ kind: 'runStart', runId: `pending-${Date.now()}`, sessionId, language, mode });
    // A run configuration's arguments and environment. Parsed here rather than in
    // the UI so the CLI and the panel share one definition of "an argument".
    const extraArgs = typeof msg.args === 'string' ? splitArgs(msg.args) : [];
    const extraEnv = typeof msg.env === 'string' ? parseEnv(msg.env) : {};
    // Only an explicit run-configuration cwd may move the runner out of its
    // session directory. Snippet runners build a self-contained module there;
    // silently using the project root makes `go test` run the host project
    // instead of the code the editor just sent.
    const cwd = typeof msg.cwd === 'string' && msg.cwd.trim() ? msg.cwd.trim() : undefined;
    const result = await workspace.run(language, code, {
      sessionId,
      reset: msg.reset === true,
      mode,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      onData: (stream, text) => reply({ kind: 'runOut', stream, text }),
      onStdinReady: (sink) => { st.runSink = sink; },
      ...(extraArgs.length ? { args: extraArgs } : {}),
      ...(Object.keys(extraEnv).length ? { env: extraEnv } : {}),
      ...(cwd ? { cwd } : {}),
      ...(mode === 'project' ? { classpath, mainClass } : {}),
    });
    st.runSink = undefined;
    reply({
      kind: 'runResult',
      language,
      mode: result.mode,
      runId: result.runId,
      sessionId: result.sessionId,
      exitCode: result.exitCode,
      signal: result.signal,
      cancelled: result.cancelled,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      logLinesTruncated: result.logLinesTruncated,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      logLines: result.logLines,
      binary: result.binary,
      phase: result.phase,
      compileError: result.compileError,
      buildMs: result.buildMs,
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `run failed: ${(err as Error).message}` });
  }
}

/**
 * Stop: cancel the live run of one session *and* any debug session this
 * connection owns. Both are reported because the Stop button is shared — the
 * UI shows "stopped" once either thing actually stopped.
 */
export function handleStop(
  client: object,
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): void {
  const sessionId = String(msg.sessionId ?? 'ide');
  const st = stateFor(client);
  const debugStopped = !!st.dap;
  if (st.dap) {
    void st.dap.stop().catch(() => undefined);
    st.dap = undefined;
  }
  const cancelled = workspace.cancel(sessionId);
  reply({ kind: 'stopped', sessionId, cancelled, debugStopped });
}

/** Env creation is slower than a run (conda resolves a solver), but not unbounded. */
const ENV_CREATE_TIMEOUT_MS = 300_000;
/** `python -m venv` prints little; conda can print a lot. Cap it like the terminal. */
const ENV_CREATE_OUTPUT_LIMIT = 256 * 1024;

/**
 * Create an environment from the plugin's `run.interpreters.create` block.
 *
 * Everything about *which* command runs comes from the manifest; this function
 * decides only the parts the engine does own: where the directory may be (inside
 * the project, and empty), that the spawn happens in one place, and that the
 * caller gets the resulting interpreter path so the picker can switch to it.
 *
 * Refusing a non-empty directory is the important guard: pointing `venv` at the
 * project root is not an exotic mistake, and its failure mode is a half-populated
 * tree that looks like a broken project rather than a bad dialog entry.
 */
export async function handleEnvCreate(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
  projectRoot?: string,
): Promise<void> {
  const reqId = Number(msg.reqId ?? 0);
  const language = asLanguage(msg.language, workspace);
  const root = projectRoot ?? workspace.projectRoot();
  const interpreters = workspace.manifestOf(language)?.run?.interpreters;
  let plan: ReturnType<typeof planEnvironment>;
  try {
    plan = planEnvironment({
      create: interpreters?.create,
      provider: typeof msg.provider === 'string' ? msg.provider : undefined,
      root,
      dir: typeof msg.path === 'string' ? msg.path : '',
      version: typeof msg.version === 'string' ? msg.version : undefined,
      toolchain: workspace.toolchainFor(language),
    });
    if (existsSync(plan.dir) && readdirSync(plan.dir).length > 0) {
      throw new Error(`${plan.dir} is not empty`);
    }
  } catch (err) {
    reply({ kind: 'envDone', reqId, language, ok: false, error: (err as Error).message });
    return;
  }

  reply({ kind: 'envStarted', reqId, language, provider: plan.provider, dir: plan.dir, display: plan.display });
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(plan.command[0], plan.command.slice(1), {
      cwd: root,
      windowsHide: true,
      env: process.env,
    });
  } catch (err) {
    reply({ kind: 'envDone', reqId, language, ok: false, error: (err as Error).message });
    return;
  }

  let sent = 0;
  const envDecoders = { stdout: new OutputDecoder(), stderr: new OutputDecoder() };
  const stream = (d: Buffer, which: 'stdout' | 'stderr'): void => {
    if (sent > ENV_CREATE_OUTPUT_LIMIT) return;
    sent += d.length;
    reply({ kind: 'envOut', reqId, stream: which, text: envDecoders[which].push(d) });
  };
  child.stdout?.on('data', (d: Buffer) => stream(d, 'stdout'));
  child.stderr?.on('data', (d: Buffer) => stream(d, 'stderr'));
  const timer = setTimeout(() => {
    reply({ kind: 'envOut', reqId, stream: 'stderr', text: `\nenvironment creation timed out after ${ENV_CREATE_TIMEOUT_MS / 1000}s; killing it\n` });
    child.kill();
  }, ENV_CREATE_TIMEOUT_MS);
  child.on('error', (err) => {
    clearTimeout(timer);
    reply({ kind: 'envDone', reqId, language, ok: false, dir: plan.dir, error: String(err) });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const ok = code === 0;
    reply({
      kind: 'envDone',
      reqId,
      language,
      ok,
      code: code ?? null,
      provider: plan.provider,
      dir: plan.dir,
      // Only meaningful on success: a failed create leaves no interpreter, and
      // handing back a path that does not exist would switch the project to it.
      executable: ok ? environmentExecutable(plan.dir, interpreters?.envBins) : undefined,
      error: ok ? undefined : `the ${plan.provider} command exited with ${code ?? 'no code'}`,
    });
  });
}

/** Below this, a run is being aborted before it could plausibly start. */
export const RUN_TIMEOUT_MIN_MS = 500;

/** Above this, a "timeout" stops protecting anything (10 minutes). */
export const RUN_TIMEOUT_MAX_MS = 10 * 60_000;

/**
 * Normalise a client-supplied run timeout.
 *
 * @param raw whatever arrived on the wire (`msg.timeoutMs`).
 * @returns a millisecond budget inside [MIN, MAX], or `undefined` to mean
 *          "not specified — use the language manifest's default".
 */
export function boundedRunTimeout(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  // `true`/`false` and arrays coerce to numbers in surprising ways; only a
  // number or a numeric string is a timeout.
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(RUN_TIMEOUT_MAX_MS, Math.max(RUN_TIMEOUT_MIN_MS, Math.round(n)));
}
