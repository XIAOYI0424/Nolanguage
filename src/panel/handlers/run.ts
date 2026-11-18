/**
 * Interactive execution: the terminal, the script runner, Run and Debug.
 *
 * Split out of `server.ts` because these are the handlers that own *processes* —
 * a shell, a spawned Node, a DAP adapter — while the server itself only routes
 * messages. The connection state they mutate lives in `../conn-state.ts`.
 *
 * Nothing here branches on a language: the run block, the debug adapter and its
 * launch template all come from the language plugin's manifest.
 */
import { parseEnv, splitArgs } from '../../scaffold/runConfigs.js';
import { exec as execCb, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Kernel } from '../../kernel/Kernel.js';
import { DapClient, type DapScope, type DapStackFrame, type DapVariable } from '../../dap/DapClient.js';
import { discoverBinary } from '../../langs/discover.js';
import { environmentExecutable, planEnvironment } from '../../langs/interpreters.js';
import type { WorkspaceService } from '../WorkspaceService.js';
import { stateFor, dropDap, peekConnection } from '../conn-state.js';
import { boundedRunTimeout } from '../run-timeout.js';
import { asLanguage } from './languages.js';

const execAsync = promisify(execCb);

/**
 * Substitute `{placeholder}` tokens in one string.
 *
 * A manifest is data, not code, so the only way it can describe "debug the
 * binary the build just produced" is by naming it. Unknown placeholders are
 * left alone rather than blanked — a typo should be visible in the adapter's
 * error, not silently become an empty path.
 */
function dbgVarsReduce(s: string, vars: Record<string, string>): string {
  let out = String(s);
  for (const [k, v] of Object.entries(vars)) out = out.split(k).join(v);
  return out;
}

/**
 * Build a DAP payload from the manifest's `launch` template.
 *
 * String values go through placeholder substitution; `{args}` / `{env}` /
 * `{cwd}` expand to the *typed* values from the run configuration, because an
 * adapter wants a real array and object, not their string forms. Any other
 * value (number, boolean, object) is passed through verbatim, which is how
 * adapter-specific constants like `MIMode: 'lldb'` are declared.
 */
function dbgVarsReduceRecord(
  tpl: Record<string, unknown>,
  vars: Record<string, string>,
  typed: { args?: string[]; env?: Record<string, string>; cwd?: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(tpl)) {
    if (typeof raw !== 'string') { out[k] = raw; continue; }
    const key = raw.trim();
    if (key === '{args}') { out[k] = typed.args ?? []; continue; }
    if (key === '{env}') { if (typed.env) out[k] = typed.env; continue; }
    if (key === '{cwd}') { if (typed.cwd) out[k] = typed.cwd; continue; }
    if (key === '{stopOnEntry}') { out[k] = vars['{stopOnEntry}'] === 'true'; continue; }
    out[k] = dbgVarsReduce(raw, vars);
  }
  return out;
}

/**
 * Everything the debugger views need for one stop: the call stack plus each
 * scope's variables. Collected together so the UI never has to ask twice —
 * a stop that showed a stack but no variables looks like a broken debugger.
 */
async function collectStopState(dap: DapClient, threadId: number): Promise<{
  frames: DapStackFrame[];
  scopes: Array<{ name: string; variablesReference: number; variables: DapVariable[] }>;
}> {
  let frames: DapStackFrame[] = [];
  try {
    frames = await dap.stackTrace(threadId);
  } catch {
    /* the adapter may have no stack for this stop */
  }
  const scopes: Array<{ name: string; variablesReference: number; variables: DapVariable[] }> = [];
  if (frames.length) {
    let raw: DapScope[] = [];
    try {
      raw = await dap.scopes(frames[0].id);
    } catch {
      raw = [];
    }
    for (const s of raw) {
      let variables: DapVariable[] = [];
      const ref = Number(s.variablesReference ?? 0);
      if (ref > 0) {
        try {
          variables = await dap.variables(ref);
        } catch {
          variables = [];
        }
      }
      scopes.push({ name: s.name, variablesReference: ref, variables });
    }
  }
  return { frames, scopes };
}

/**
 * Terminal command execution for the PyCharm-style shell. Spawns an attached
 * shell child (piped stdin/stdout/stderr) so the terminal can drive interactive
 * programs — e.g. `python main.py` that calls `input()`, or a long-running
 * server. Output streams back live as `termOut` frames; the child stays attached
 * until it exits, when a `termResult` frame arrives. While attached, the UI sends
 * `termInput` to feed the child's stdin. A 4 MiB output cap kills a runaway
 * producer so it can't wedge the panel.
 */
export function handleTerm(cmd: string, reply: (p: unknown) => void, conn: unknown, cwd: string): void {
  const st = stateFor(conn);
  if (st.termChild) return; // already attached; ignore stray commands
  const started = Date.now();
  let bytes = 0;
  const CAP = 4 * 1024 * 1024;
  const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
  const args = process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd];
  const child = spawn(shell, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  st.termChild = child;
  const cap = (d: Buffer): void => {
    bytes += d.length;
    if (bytes > CAP) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };
  child.stdout?.on('data', (d) => { cap(d); reply({ kind: 'termOut', text: d.toString('utf8'), stream: 'stdout' }); });
  child.stderr?.on('data', (d) => { cap(d); reply({ kind: 'termOut', text: d.toString('utf8'), stream: 'stderr' }); });
  child.on('error', (err) => {
    st.termChild = undefined;
    reply({ kind: 'termResult', cmd, stdout: '', stderr: String(err), code: 1, ms: Date.now() - started });
  });
  child.on('close', (code, signal) => {
    st.termChild = undefined;
    reply({ kind: 'termResult', cmd, stdout: '', stderr: '', code: code ?? null, ms: Date.now() - started });
  });
}

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
  child.stdout?.on('data', (d) => { cap(d); reply({ kind: 'scriptOut', stream: 'stdout', text: d.toString('utf8') }); });
  child.stderr?.on('data', (d) => { cap(d); reply({ kind: 'scriptOut', stream: 'stderr', text: d.toString('utf8') }); });
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
  // `mode` selects `go test` over `go run`; ignored by Python.
  const mode = msg.mode === 'test' ? 'test' : 'run';
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
 * Start a debug session for one document.
 *
 * The adapter is declared by the language plugin (`manifest.debug`), so this
 * function contains no language branching: it discovers the adapter, launches
 * it over DAP, applies the breakpoints the editor already renders, and streams
 * output/stopped frames back. When discovery fails, the reply says exactly
 * what is missing — a Debug button that silently does nothing is worse than a
 * Debug button that explains why it cannot start.
 */
export async function handleDebug(
  client: object,
  workspace: WorkspaceService,
  kernel: Kernel,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const code = typeof msg.code === 'string' ? msg.code : '';
  const st = stateFor(client);
  if (st.dap) {
    reply({ kind: 'debugState', ok: false, state: 'running', error: 'a debug session is already running' });
    return;
  }
  const manifest = workspace.manifestOf(language);
  const spec = manifest?.debug;
  if (!spec) {
    reply({
      kind: 'debugState',
      ok: false,
      error: `"${language}" does not declare a debug adapter (manifest.debug)`,
    });
    return;
  }
  const resolved = discoverBinary(spec.discovery, { root: workspace.root });
  if (!resolved.bin || resolved.source === 'missing') {
    reply({
      kind: 'debugState',
      ok: false,
      adapter: spec.adapter,
      error: spec.degradedNote || `${spec.serverName ?? spec.adapter} is not installed`,
      hint: `install ${spec.adapter} or point ${(spec.discovery?.envVars ?? [])[0] ?? 'its discovery env var'} at the adapter`,
      install: spec.install,
    });
    return;
  }
  const template = spec.command?.length ? spec.command : ['{resolved}'];
  const [head, ...rest] = template;
  const command = head.replace('{resolved}', resolved.bin);
  const args = [...rest, ...(spec.args ?? [])].map((a) => a.replace('{resolved}', resolved.bin));

  // Extra launch fields from the configuration: program arguments, environment
  // overrides and a working directory. All optional; adapters ignore what they
  // do not understand.
  const cfgArgs = Array.isArray(msg.args)
    ? msg.args.map((a) => String(a))
    : typeof msg.args === 'string' && msg.args
      ? msg.args.split(/\s+/).filter(Boolean)
      : [];
  const cfgEnv = msg.env && typeof msg.env === 'object' ? (msg.env as Record<string, string>) : undefined;
  // A debug adapter's `cwd` must be absolute — debugpy/dlv spawn the target with
  // it verbatim. Imported `.idea` configurations carry a *project-relative*
  // working directory (`$PROJECT_DIR$/src` -> `src`), so resolve it here rather
  // than handing the adapter a path that does not exist.
  const rawCwd = typeof msg.cwd === 'string' && msg.cwd.trim() ? msg.cwd.trim() : undefined;
  const cfgCwd = rawCwd ? resolve(workspace.root, rawCwd) : undefined;
  const attach = String(msg.request ?? 'launch') === 'attach';

  // ---- attach: connect to a target that is already running ----
  // Nothing is started, built or written here: the target owns its own program,
  // and handing an attach a `program` would make the adapter launch a second
  // copy (or fail saying it cannot).
  if (attach) {
    if (!spec.supportsAttach) {
      reply({
        kind: 'debugState',
        ok: false,
        adapter: spec.adapter,
        error: `${spec.serverName ?? spec.adapter} cannot attach (manifest.debug.supportsAttach is not set)`,
        hint: 'use a launch configuration, or declare supportsAttach in the language manifest',
      });
      return;
    }
    const port = Number(msg.port ?? 0);
    const processId = Number(msg.processId ?? 0);
    const host = typeof msg.host === 'string' && msg.host.trim() ? msg.host.trim() : 'localhost';
    if (!port && !processId) {
      reply({
        kind: 'debugState',
        ok: false,
        adapter: spec.adapter,
        error: 'attach needs a port or a process id',
        hint: 'set Port or Process ID in the Run/Debug configuration',
      });
      return;
    }
    const attachArgs: Record<string, unknown> = { type: spec.type ?? spec.adapter };
    if (port) attachArgs.port = port;
    if (processId) attachArgs.processId = processId;
    if (!processId) attachArgs.host = host;
    const dapAttach = new DapClient(
      kernel,
      { command, args, adapterId: spec.type ?? spec.adapter, cwd: cfgCwd ?? workspace.root, attach: true, attachArgs },
      {
        onStopped: (info) => {
          void (async () => {
            const tid = Number(info.threadId) || 1;
            st.dapThreadId = tid;
            const stop = await collectStopState(dapAttach, tid);
            reply({
              kind: 'debugState', ok: true, state: 'stopped', reason: info.reason,
              threadId: tid, frames: stop.frames, scopes: stop.scopes,
            });
          })();
        },
        onOutput: (text, category) => reply({ kind: 'debugOut', text, category }),
        onTerminated: () => {
          dropDap(client);
          reply({ kind: 'debugState', ok: true, state: 'terminated' });
        },
      },
    );
    st.dap = dapAttach;
    try {
      await dapAttach.start();
      reply({ kind: 'debugState', ok: true, state: 'running', adapter: spec.adapter, request: 'attach' });
    } catch (err) {
      st.dap = undefined;
      reply({
        kind: 'debugState', ok: false, adapter: spec.adapter,
        error: `debug adapter failed: ${(err as Error).message}`,
      });
    }
    return;
  }

  // ---- launch ----
  // A debug configuration may name the entry script explicitly (VS Code's
  // launch.json `program`). When it does, debug that file on disk; otherwise
  // fall back to the language's scratch buffer (the original behaviour).
  const requestedProgram = typeof msg.program === 'string' && msg.program ? msg.program : '';
  const program = requestedProgram ? join(workspace.root, requestedProgram) : workspace.bufferPath(language);
  if (!program) {
    reply({ kind: 'debugState', ok: false, error: `no program path for "${language}"` });
    return;
  }
  // `serverReads` means the script already exists on disk (e.g. a configuration
  // pointing at a file that is not the open buffer) — launch it as-is. When code
  // is supplied (an open, possibly dirty buffer) we flush it to disk first, the
  // same way an IDE saves before launching.
  const serverReads = requestedProgram !== '' && msg.serverReads === true;
  let effectiveCode = code;
  if (serverReads && !effectiveCode) {
    try {
      effectiveCode = await readFile(program, 'utf8');
    } catch {
      /* missing file — the adapter will report a clean error */
    }
  }
  // A `preLaunch` step (compiled languages) may rewrite the artifact, so the
  // source is flushed *before* the build, not after it.
  if (effectiveCode) await writeFile(program, effectiveCode, 'utf8').catch(() => undefined);

  // Compile first when the manifest asks for it: C/C++/Rust have no
  // source-level debug target, and handing the adapter a `.cpp` yields a
  // session that starts and then never stops anywhere.
  const pre = spec.preLaunch?.cmd;
  // `{toolchain}` lets a `preLaunch` compile with the very compiler the run
  // block discovered, instead of assuming one is on PATH under a fixed name.
  const toolchain = manifest?.run?.discovery
    ? discoverBinary(manifest.run.discovery, { root: workspace.root }).bin
    : '';
  const dbgVars: Record<string, string> = {
    '{resolved}': resolved.bin,
    '{toolchain}': toolchain,
    '{program}': program,
    '{file}': program,
    '{workdir}': workspace.root,
    '{cwd}': cfgCwd ?? workspace.root,
    '{args}': cfgArgs.join(' '),
    '{stopOnEntry}': msg.stopOnEntry !== false ? 'true' : 'false',
    '{exe}': process.platform === 'win32' ? '.exe' : '',
  };
  if (pre) {
    const cmdLine = dbgVarsReduce(pre, dbgVars);
    try {
      const out = await execAsync(cmdLine, {
        cwd: cfgCwd ?? workspace.root,
        timeout: spec.preLaunch?.timeoutMs ?? 60_000,
        windowsHide: true,
      });
      if (out.stdout) reply({ kind: 'debugOut', text: String(out.stdout), category: 'stdout' });
      if (out.stderr) reply({ kind: 'debugOut', text: String(out.stderr), category: 'stderr' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      reply({
        kind: 'debugState',
        ok: false,
        adapter: spec.adapter,
        error: `build before debug failed: ${e.message ?? 'unknown error'}`,
        hint: [e.stdout, e.stderr].filter(Boolean).join('').trim().split('\n').slice(-6).join('\n') || undefined,
      });
      return;
    }
  }

  // The `launch` payload. With a manifest template every field is declared
  // (Java's mainClass, cppdbg's MIMode, Node's runtimeExecutable …); without
  // one we fall back to the shape debugpy and delve both accept, so existing
  // manifests need no change.
  const launchArgs = spec.launch
    ? dbgVarsReduceRecord(spec.launch, dbgVars, { args: cfgArgs, env: cfgEnv, cwd: cfgCwd })
    : {
        program,
        stopOnEntry: msg.stopOnEntry !== false,
        // Compiled-language adapters (dlv dap) need the build mode; ignored by
        // adapters that do not know the field.
        mode: 'debug',
        ...(cfgArgs.length ? { args: cfgArgs } : {}),
        ...(cfgEnv ? { env: cfgEnv } : {}),
        ...(cfgCwd ? { cwd: cfgCwd } : {}),
      };

  const dap = new DapClient(
    kernel,
    {
      command,
      args,
      adapterId: spec.type ?? spec.adapter,
      cwd: cfgCwd ?? workspace.root,
      launchArgs,
    },
    {
      onStopped: (info) => {
        void (async () => {
          const tid = Number(info.threadId) || 1;
          st.dapThreadId = tid;
          const stop = await collectStopState(dap, tid);
          reply({
            kind: 'debugState',
            ok: true,
            state: 'stopped',
            reason: info.reason,
            threadId: tid,
            frames: stop.frames,
            scopes: stop.scopes,
          });
        })();
      },
      onOutput: (text, category) => reply({ kind: 'debugOut', text, category }),
      onTerminated: () => {
        dropDap(client);
        reply({ kind: 'debugState', ok: true, state: 'terminated' });
      },
    },
  );
  st.dap = dap;
  try {
    const breakpoints = Array.isArray(msg.breakpoints)
      ? (msg.breakpoints as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    // Breakpoints go in before the handshake finishes (configurationDone), not
    // after: the adapter does not start the target until configurationDone, so a
    // setBreakpoints that lands later is too late when stopOnEntry is false.
    await dap.start(breakpoints.length ? { file: program, lines: breakpoints } : undefined);
    reply({ kind: 'debugState', ok: true, state: 'running', adapter: spec.adapter, program });
  } catch (err) {
    st.dap = undefined;
    reply({
      kind: 'debugState',
      ok: false,
      adapter: spec.adapter,
      error: `debug adapter failed: ${(err as Error).message}`,
    });
  }
}

/** One debugger command from the toolbar (continue / step / stack / stop). */
export async function handleDebugCmd(
  client: object,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const st = peekConnection(client);
  const dap = st?.dap;
  if (!dap) {
    reply({ kind: 'debugState', ok: false, error: 'no debug session is running' });
    return;
  }
  const cmd = String(msg.cmd ?? '');
  // Every continuation has to name the thread the adapter stopped on; a wrong
  // (or defaulted) thread id is the classic "the step button does nothing".
  const tid = st.dapThreadId ?? 1;
  try {
    if (cmd === 'continue') {
      await dap.continue_(tid);
      reply({ kind: 'debugState', ok: true, state: 'running' });
      return;
    }
    // Pause lands as its own `stopped` event, so this only acknowledges it.
    if (cmd === 'pause') {
      await dap.pause(tid);
      reply({ kind: 'debugState', ok: true, state: 'pausing', threadId: tid });
      return;
    }
    if (cmd === 'next' || cmd === 'stepIn' || cmd === 'stepOut') {
      if (cmd === 'next') await dap.stepOver(tid);
      else if (cmd === 'stepIn') await dap.stepIn(tid);
      else await dap.stepOut(tid);
      const stop = await collectStopState(dap, tid);
      reply({
        kind: 'debugState',
        ok: true,
        state: 'stopped',
        reason: cmd,
        threadId: tid,
        frames: stop.frames,
        scopes: stop.scopes,
      });
      return;
    }
    if (cmd === 'stack') {
      const stop = await collectStopState(dap, tid);
      reply({ kind: 'debugState', ok: true, state: 'stopped', threadId: tid, frames: stop.frames, scopes: stop.scopes });
      return;
    }
    // Watch list / debugger console.
    if (cmd === 'evaluate') {
      const expr = typeof msg.expression === 'string' ? msg.expression : '';
      const frameId = typeof msg.frameId === 'number' ? msg.frameId : undefined;
      const r = await dap.evaluate(expr, frameId);
      reply({
        kind: 'debugEval',
        ok: true,
        expression: expr,
        result: r.result,
        type: r.type,
        variablesReference: r.variablesReference,
      });
      return;
    }
    // Expanding one structured variable.
    if (cmd === 'vars') {
      const ref = Number(msg.variablesReference ?? 0);
      const variables = ref > 0 ? await dap.variables(ref) : [];
      reply({ kind: 'debugVars', ok: true, variablesReference: ref, variables });
      return;
    }
    if (cmd === 'stop') {
      await dap.stop();
      dropDap(client);
      reply({ kind: 'debugState', ok: true, state: 'terminated' });
      return;
    }
    reply({ kind: 'debugState', ok: false, error: `unknown debug command: ${cmd}` });
  } catch (err) {
    reply({ kind: 'debugState', ok: false, error: (err as Error).message });
  }
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
): Promise<void> {
  const reqId = Number(msg.reqId ?? 0);
  const language = asLanguage(msg.language, workspace);
  const interpreters = workspace.manifestOf(language)?.run?.interpreters;
  let plan: ReturnType<typeof planEnvironment>;
  try {
    plan = planEnvironment({
      create: interpreters?.create,
      provider: typeof msg.provider === 'string' ? msg.provider : undefined,
      root: workspace.root,
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
      cwd: workspace.root,
      windowsHide: true,
      env: process.env,
    });
  } catch (err) {
    reply({ kind: 'envDone', reqId, language, ok: false, error: (err as Error).message });
    return;
  }

  let sent = 0;
  const stream = (d: Buffer, which: 'stdout' | 'stderr'): void => {
    if (sent > ENV_CREATE_OUTPUT_LIMIT) return;
    sent += d.length;
    reply({ kind: 'envOut', reqId, stream: which, text: d.toString('utf8') });
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

