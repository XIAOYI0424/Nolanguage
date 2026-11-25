/**
 * Debug: the DAP adapter, the launch template, and the stop views.
 *
 * The adapter is declared by the language plugin (`manifest.debug`), so nothing
 * here branches on a language. The one thing this module does own is where the
 * debuggee may live — see `resolveLaunchProgram`.
 */
import { DapClient, type DapScope, type DapStackFrame, type DapVariable } from '../../dap/DapClient.js';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Kernel } from '../../kernel/Kernel.js';
import { parseEnv, splitArgs } from '../../scaffold/runConfigs.js';
import { discoverBinary } from '../../langs/discover.js';
import { dropDap, peekConnection, stateFor } from '../conn-state.js';
import { asLanguage } from './languages.js';
import type { WorkspaceService } from '../WorkspaceService.js';

const execFileAsync = promisify(execFile);

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
 * Turn a manifest's `preLaunch` declaration into an argv vector.
 *
 * The old shape was a shell string, so a compiler path or a filename with
 * `&`, `;` or a space could change what actually ran. `argv` is now the
 * preferred shape: every element is already one argument. The legacy `cmd`
 * form is still accepted, but it is tokenised locally and executed without a
 * shell — shell metacharacters remain literal characters in an argument.
 */
export function planPreLaunch(
  pre: { argv?: string[]; cmd?: string; timeoutMs?: number } | undefined,
  vars: Record<string, string>,
): { argv: string[]; timeoutMs?: number; legacy: boolean } | undefined {
  if (!pre) return undefined;
  if (Array.isArray(pre.argv) && pre.argv.length) {
    return {
      argv: pre.argv.map((part) => dbgVarsReduce(String(part), vars)),
      timeoutMs: pre.timeoutMs,
      legacy: false,
    };
  }
  const cmd = String(pre.cmd ?? '').trim();
  if (!cmd) return undefined;
  return { argv: splitArgs(dbgVarsReduce(cmd, vars)), timeoutMs: pre.timeoutMs, legacy: true };
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
 * Resolve a launch configuration's `program` against the workspace root.
 *
 * A launch configuration can be hand-edited and arrives over a client frame, and
 * the debug path *writes* the open buffer to that file before launching. Without
 * this check, `"program": "../../somewhere/x.py"` would flush editor content to
 * an arbitrary path outside the project. Lexical `..` is rejected, and because a
 * symlink inside the tree can still point outside it, an existing target is
 * resolved with `realpath` too.
 *
 * Returns `undefined` when the path escapes — callers answer with an error rather
 * than silently falling back to the scratch buffer, so the user learns the
 * configuration is wrong.
 */
export async function resolveLaunchProgram(root: string, requested: string): Promise<string | undefined> {
  const abs = resolve(root, requested);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(abs);
    const realRel = relative(realRoot, realFile);
    if (!realRel || realRel.startsWith('..') || isAbsolute(realRel)) return undefined;
  } catch {
    /* Not on disk yet: a brand-new file inside the root is fine. */
  }
  return abs;
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
  projectRoot?: string,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const root = projectRoot ?? workspace.projectRoot();
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
  const resolved = discoverBinary(spec.discovery, { root: root });
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
  const cfgCwd = rawCwd ? resolve(root, rawCwd) : undefined;
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
      { command, args, adapterId: spec.type ?? spec.adapter, cwd: cfgCwd ?? root, attach: true, attachArgs },
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
  const program = requestedProgram
    ? await resolveLaunchProgram(root, requestedProgram)
    : workspace.bufferPath(language);
  if (requestedProgram && !program) {
    reply({ kind: 'debugState', ok: false, error: `program escapes the workspace: ${requestedProgram}` });
    return;
  }
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
  // `{toolchain}` lets a `preLaunch` compile with the very compiler the run
  // block discovered, instead of assuming one is on PATH under a fixed name.
  const toolchain = manifest?.run?.discovery
    ? discoverBinary(manifest.run.discovery, { root: root }).bin
    : '';
  const dbgVars: Record<string, string> = {
    '{resolved}': resolved.bin,
    '{toolchain}': toolchain,
    '{program}': program,
    '{file}': program,
    '{workdir}': root,
    '{cwd}': cfgCwd ?? root,
    '{args}': cfgArgs.join(' '),
    '{stopOnEntry}': msg.stopOnEntry !== false ? 'true' : 'false',
    '{exe}': process.platform === 'win32' ? '.exe' : '',
  };
  const pre = planPreLaunch(spec.preLaunch, dbgVars);
  if (pre) {
    if (!pre.argv.length) {
      reply({ kind: 'debugState', ok: false, adapter: spec.adapter, error: 'preLaunch declares no command' });
      return;
    }
    try {
      // No shell: argv[0] is the program and every later element is one
      // argument, even when a project path contains spaces or punctuation.
      const out = await execFileAsync(pre.argv[0], pre.argv.slice(1), {
        cwd: cfgCwd ?? root,
        timeout: pre.timeoutMs ?? 60_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
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
      cwd: cfgCwd ?? root,
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
