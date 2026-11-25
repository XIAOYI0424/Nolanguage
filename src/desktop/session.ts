/**
 * Desktop session bookkeeping: which process owns the window, and how to end it.
 *
 * ## Why a pid file at all
 *
 * The desktop build is a Node SEA with **no native window** — the UI is an Edge
 * app window spawned as a *detached* child. Windows therefore has no parent /
 * child lifetime link to lean on:
 *
 *   - closing the window does not stop the server (nothing observes the window);
 *   - stopping the server does not close the window (`child.kill()` terminates
 *     the launcher only when it is still the browser root, never the tree);
 *   - a crashed session leaves a browser process holding the profile, and the
 *     next launch hands its `--app` URL to that *old* process, which opens one
 *     more window on top of the stale ones — the "several windows every time"
 *     report.
 *
 * So the session is recorded on disk: the server pid, the browser root pid it
 * spawned, and the profile that ties the two together. A later launch reads it
 * and can clean up exactly what its predecessor left behind, instead of
 * guessing with `tasklist`.
 *
 * The file lives next to the telemetry database (`appDataDir()`), never in the
 * install directory — see `src/util/appData.ts` for why.
 */
import { isAlive, killTree } from '../util/killTree.js';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appDataPath } from '../util/appData.js';
import { decodeOutput } from '../util/encoding.js';

/**
 * Append one line to `%LOCALAPPDATA%\Nolanguage\desktop.log`.
 *
 * The GUI build has no console, so when a user reports "窗口说连不上" there is
 * otherwise *nothing* to look at: the kernel log lives in SQLite and stops at
 * whatever was flushed. These lines cover the gap between "process started" and
 * "process vanished" — who spawned the window, whether a previous window was
 * collected, and which event asked for shutdown.
 *
 * Never throws: diagnostics must not be able to break a launch.
 */
export function logDesktop(event: string, detail?: Record<string, unknown>): void {
  try {
    const file = appDataPath('desktop.log');
    mkdirSync(appDataPath(), { recursive: true });
    // Bounded at ~256 KiB, but **rotated, not deleted**. The old code removed
    // the file and started over, so the entries that explain a failure — the
    // ones just before it — were the first thing thrown away.
    if (existsSync(file) && statSync(file).size > 256 * 1024) {
      renameSync(file, `${file}.1`);
    }
    const line = `${new Date().toISOString()} ${event}${detail ? ' ' + JSON.stringify(detail) : ''}\n`;
    appendFileSync(file, line, 'utf8');
  } catch (err) {
    // Still never throws — diagnostics must not break a launch. But swallowing
    // the failure entirely is how a whole afternoon was spent wondering why
    // desktop.log had no entries: the writes were being denied and nothing said
    // so. Report it once, on stderr, and keep going.
    if (!desktopLogBroken) {
      desktopLogBroken = true;
      try {
        process.stderr.write(`[desktop] cannot write ${appDataPath('desktop.log')}: ${(err as Error).message}\n`);
      } catch {
        /* stderr may be gone too */
      }
    }
  }
}

/** Set after the first write failure, so the warning appears exactly once. */
let desktopLogBroken = false;

/** Everything a launch needs to know about the session that came before it. */
export interface SessionState {
  /** The Node process serving the workspace. */
  serverPid?: number;
  /** The Edge browser *root* process that hosts the app window. */
  browserPid?: number;
  /** `--user-data-dir` the window was started with. */
  profile?: string;
  /** Port the server bound, for the "already running" probe. */
  port?: number;
  /**
   * Set by `shutdown()` when the user closed the window (or Ctrl+C): the
   * profile was released, so the next launch need not sweep it. A crash, a
   * hard kill or the installer's `taskkill` never sets it, which is exactly
   * when a stale Edge window is still holding the profile.
   */
  cleanExit?: boolean;
}

function sessionFile(): string {
  return appDataPath('desktop-session.json');
}

/**
 * The server pid as a bare number, for readers that cannot parse JSON.
 *
 * `desktop-session.json` already records it, but the process that most needs to
 * stop this one is the NSIS installer, and NSIS can read a line — not JSON. A
 * one-line file next to the session is the whole interface, and it is what lets
 * an upgrade close the app even when the PowerShell helper is unavailable.
 */
function pidFile(): string {
  return appDataPath('server.pid');
}

export function writeServerPid(pid: number = process.pid): void {
  try {
    mkdirSync(appDataPath(), { recursive: true });
    writeFileSync(pidFile(), String(pid), 'utf8');
  } catch {
    /* bookkeeping must never block a launch */
  }
}

export function clearServerPid(): void {
  try {
    rmSync(pidFile(), { force: true });
  } catch {
    /* nothing to clean */
  }
}

/** Recorded session, or `undefined` when there is none or it is unreadable. */
export function readSession(): SessionState | undefined {
  try {
    const raw = readFileSync(sessionFile(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed as SessionState;
  } catch {
    return undefined;
  }
}

/** Merge a partial update into the recorded session. Never throws. */
export function patchSession(patch: Partial<SessionState>): void {
  try {
    const file = sessionFile();
    mkdirSync(appDataPath(), { recursive: true });
    const merged = { ...(readSession() ?? {}), ...patch };
    // Undefined fields would serialise away, which is what "forget this pid"
    // means, so drop them explicitly rather than writing `null`.
    for (const key of Object.keys(merged) as Array<keyof SessionState>) {
      if (merged[key] === undefined) delete merged[key];
    }
    writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
  } catch {
    /* bookkeeping must never block a launch */
  }
}

/** Drop the record. Called on a clean exit; a stale one is harmless. */
export function clearSession(): void {
  try {
    const file = sessionFile();
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

// Moved to `util` so the language client can use it too: a `.cmd` shim leaves
// the real server holding the pipes, and killing only the wrapper keeps the
// parent alive. Re-exported here because every desktop caller imports it from
// this module, and that is a public surface of its own.
export { isAlive, killTree };

/**
 * End the window recorded by the previous session, without querying anything.
 *
 * The common case after a crash is "the pid we wrote down is still there", and
 * killing it needs no PowerShell — which matters: a fresh unsigned binary that
 * spawns `powershell -Command` at every launch is exactly what behaviour
 * blockers (Kaspersky and friends) flag. The expensive sweep in
 * `closeStaleWindows` is reserved for the rare case where the recorded pid is
 * not the window after all.
 */
export async function closeRecordedWindow(profile: string): Promise<number | undefined> {
  const recorded = readSession();
  if (!recorded?.browserPid || recorded.profile !== profile) return undefined;
  if (!isAlive(recorded.browserPid)) return undefined;
  const pid = recorded.browserPid;
  killTree(pid);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return pid;
}

/**
 * Pids of Edge processes that render *our* window for *profile*.
 *
 * The app uses a dedicated `--user-data-dir`, so that exact profile path is the
 * identity marker — including Chromium's background/profile process that has no
 * `--app=` argument but makes the next launch delegate, flash a window, then
 * retry into a second window. The URL/port is a fallback when Edge normalises the
 * profile path. No ordinary Edge profile is touched.
 */
export async function findWindowProcesses(profile: string, port?: number): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const quoted = profile.replace(/'/g, "''");
  // `.Contains()` is case-sensitive and the browser normalises the profile
  // path, so an exact match misses the very process that makes Edge delegate.
  // Match case-insensitively, and accept the loopback --app URL as a second
  // marker: it is unique to this app even if the profile string differs.
  //
  // The URL marker carries *our* port. `--app=` alone matched every Edge app
  // window on the machine, including ones the user opened for other sites on
  // localhost — and the caller kills what this returns.
  const url = port ? `--app=http://127\\.0\\.0\\.1:${port}([/?"]|$)` : '--app=http://127\\.0\\.0\\.1:';
  const script = [
    `$p = '${quoted}';`,
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='msedgewebview2.exe'" |`,
    `  Where-Object { $_.CommandLine -and (($_.CommandLine.IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.CommandLine -match '${url}')) } |`,,
    '  ForEach-Object { $_.ProcessId }',
  ].join(' ');
  return await new Promise<number[]>((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve([]);
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      out += decodeOutput(chunk);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    child.on('error', () => resolve([]));
    child.on('close', () => {
      // The timer is only a failure guard; leaving it armed made every healthy
      // launch log a "window-probe-timeout" eight seconds later.
      if (timer) clearTimeout(timer);
      resolve(
        out
          .split(/\r?\n/)
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isFinite(pid) && pid > 0),
      );
    });
    // A hung probe must not hang the launch. The timeout is deliberately
    // generous: a cold CIM query on a busy machine can exceed 4 s, and a
    // missed result is exactly what lets Edge delegate to a stale window.
    timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
      logDesktop('window-probe-timeout', { profile });
      resolve([]);
    }, 8000);
    timer.unref?.();
  });
}

/**
 * Pids among `pids` that own a visible top-level window.
 *
 * `findWindowProcesses` proves a browser *process* carries our `--app` command
 * line; it cannot prove a window exists. Some Edge builds create the whole
 * process tree (browser, GPU, renderers) and never show the app window — the
 * "网页进程在跑，但窗口没出现" report. `MainWindowHandle === 0` is the
 * difference, and it is what lets the launcher fall back to a browser tab
 * instead of trusting an invisible process.
 */
export async function findVisibleWindows(pids: number[]): Promise<number[]> {
  if (process.platform !== 'win32' || !pids.length) return [];
  const ids = pids.filter((pid) => Number.isFinite(pid) && pid > 0).join(',');
  if (!ids) return [];
  const script =
    `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id }`;
  return await new Promise<number[]>((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve([]);
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      out += decodeOutput(chunk);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    child.on('error', () => resolve([]));
    child.on('close', () => {
      if (timer) clearTimeout(timer);
      resolve(
        out
          .split(/\r?\n/)
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isFinite(pid) && pid > 0),
      );
    });
    // A window check is cheaper than a CIM sweep but still a child process;
    // a hung probe must not hold the launch. Four seconds is enough for a
    // warm query and short enough that the browser fallback stays snappy.
    timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
      resolve([]);
    }, 4000);
    timer.unref?.();
  });
}

/**
 * Remove windows left behind by a previous session for *profile* and wait until
 * their processes are gone.
 *
 * This has to happen **before** spawning: Chromium resolves `--user-data-dir`
 * against an already-running browser and delegates to it, which would (a) put a
 * second window on screen and (b) make the freshly spawned process exit at once,
 * so the window would look closed while it is not.
 */
export async function closeStaleWindows(profile: string, port?: number): Promise<number[]> {
  const pids = await findWindowProcesses(profile, port);
  for (const pid of pids) killTree(pid);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && pids.some((pid) => isAlive(pid))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return pids;
}
