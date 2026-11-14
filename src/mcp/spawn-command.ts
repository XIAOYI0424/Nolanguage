/**
 * Turn an `mcp.json` `command` into something `spawn()` can actually launch.
 *
 * # Why this exists
 *
 * Every MCP config in the wild — including the starter file `mcpInitConfig`
 * writes — says `"command": "npx"`. On Windows that cannot be spawned:
 *
 *   spawn('npx')               -> ENOENT  (CreateProcess does not consult
 *                                          PATHEXT, so the `.cmd` shim is
 *                                          never found)
 *   spawn('npx.cmd')           -> EINVAL  (a `.cmd` is a script for cmd.exe,
 *                                          not an image the loader can start)
 *   spawn('npx', {shell:true}) -> works
 *
 * So the client has to do what a shell does: resolve the name against `PATH`
 * and `PATHEXT`, and route `.cmd`/`.bat` through `cmd.exe`. Without this the
 * MCP panel is dead on Windows for the most common config there is — which is
 * what a local run found (`process error: spawn npx ENOENT`).
 *
 * # Scope
 *
 * Only Windows behaviour changes. A command that is already an `.exe`, or a
 * path with a separator, is passed through untouched, so a config that works
 * today cannot regress. Anything unresolvable is also passed through, so the
 * failure stays the honest `ENOENT` the user can act on.
 *
 * Deliberately pure apart from one `existsSync` probe (env injected), so the
 * resolution and quoting rules are unit-testable without a real npm install.
 */
import { existsSync } from 'node:fs';

/** How to hand this command to `spawn()`. */
export interface SpawnPlan {
  /** Executable to spawn (an absolute path when we resolved one). */
  command: string;
  /** Arguments, already quoted when `shell` is true. */
  args: string[];
  /** True only when the resolved target is a `.cmd`/`.bat` shim. */
  shell: boolean;
}

/** The default Windows search order when `PATHEXT` is not set. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** True when the path names a shell script rather than a loadable image. */
export function isCmdScript(p: string): boolean {
  return /\.(cmd|bat)$/i.test(p);
}

/**
 * Quote one argument for `cmd.exe`.
 *
 * Only applied on the `shell: true` path, where Node joins arguments with
 * spaces verbatim — an unquoted `C:/my dir` would arrive as two arguments.
 * Double quotes are the only escape cmd understands, and doubling them is what
 * the target program's C runtime un-does.
 */
export function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  // Nothing special: pass through so the common case stays readable.
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

/**
 * Resolve `command` the way a Windows shell would.
 *
 * @param command the raw `command` from `mcp.json`.
 * @param args    the raw `args`.
 * @param env     overrides for tests; defaults to the real process.
 */
export function planMcpSpawn(
  command: string,
  args: string[],
  env: { platform?: NodeJS.Platform; PATH?: string; PATHEXT?: string } = {},
): SpawnPlan {
  const platform = env.platform ?? process.platform;
  const passthrough: SpawnPlan = { command, args, shell: false };
  if (platform !== 'win32') return passthrough;

  // Already a path, or already carries an extension: the caller was specific.
  if (command.includes('/') || command.includes('\\') || /\.[A-Za-z0-9]+$/.test(command)) {
    return isCmdScript(command) ? { command, args: args.map(quoteCmdArg), shell: true } : passthrough;
  }

  const path = env.PATH ?? process.env.PATH ?? '';
  const exts = (env.PATHEXT ?? process.env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);

  // Always `;` here — this branch only runs on win32. Splitting on `:` would
  // cut a drive letter in half the moment PATH holds a single entry
  // (`D:\tools` has no `;` at all, so an "infer the separator" heuristic
  // picks `:` and looks for `D` and `\tools`).
  for (const dir of path.split(';')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}\\${command}${ext}`;
      if (!existsSync(candidate)) continue;
      return isCmdScript(candidate)
        ? { command: candidate, args: args.map(quoteCmdArg), shell: true }
        : { command: candidate, args, shell: false };
    }
  }
  return passthrough;
}
