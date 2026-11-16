/**
 * The one thing a windowless failure owes the user: a window.
 *
 * # Why this exists
 *
 * `Nolanguage.exe` is a GUI-subsystem binary. When start-up throws — an embedded
 * asset that cannot be written, a port already held, a corrupt profile — the
 * process printed the error to a stderr nobody is attached to and exited with
 * code 1. From the outside that is indistinguishable from "double-click does
 * nothing": no window, no dialog, no trace.
 *
 * That is not hypothetical. A failed `%TEMP%` write aborted a launch this way,
 * and the only way to find out why was to run the binary from a terminal by
 * hand. The logs exist now, but a user does not know to look for them.
 *
 * # Why PowerShell and not a native binding
 *
 * The project has zero runtime dependencies and no native addons. A message box
 * is one line of .NET, and Windows always has PowerShell. The child is spawned
 * **detached** so the dialog outlives the process that is about to exit, and
 * `windowsHide` keeps a console window from flashing behind it.
 *
 * The text goes through a file rather than `-Command`: quoting an arbitrary
 * stack trace into a command line is how you get a dialog that shows half a
 * message, or none.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appDataPath } from '../util/appData.js';

/** How much of the log a dialog shows before it becomes unreadable. */
const MAX_DIALOG_CHARS = 1800;
const LOG_TAIL_LINES = 12;

/**
 * Last few lines of a log file, or `undefined` when it is absent.
 *
 * The tail is what matters: the interesting lines are the ones right before the
 * failure, and the head of a rotated file is a week old.
 */
function tail(path: string, lines = LOG_TAIL_LINES): string | undefined {
  try {
    const text = readFileSync(path, 'utf8').trimEnd();
    if (!text) return undefined;
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return undefined;
  }
}

/** Render the failure into the text a dialog shows, and keep a copy on disk. */
export function describeFailure(err: unknown, appVersion: string): { text: string; file: string } {
  const e = err as Error | undefined;
  const message = e?.message ?? String(err);
  const stack = (e?.stack ?? '').split('\n').slice(1, 6).join('\n');
  const logs = appDataPath('logs');

  const parts = [
    `Nolanguage ${appVersion} could not start.`,
    '',
    message,
    stack ? `\n${stack}` : '',
  ];

  const boot = tail(join(logs, 'boot.log'));
  if (boot) parts.push('', '--- logs/boot.log (last lines) ---', boot);
  const kernel = tail(join(logs, 'app.log'), 8);
  if (kernel) parts.push('', '--- logs/app.log (last lines) ---', kernel);

  const full = parts.filter((p) => p !== '').join('\n');
  const text = full.length > MAX_DIALOG_CHARS ? full.slice(0, MAX_DIALOG_CHARS) + '\n…(truncated)' : full;

  // The file keeps the whole thing: the dialog is a pointer, the file is the
  // record. Capping both would throw away the part that got cut.
  const file = join(logs, 'last-error.txt');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${new Date().toISOString()}\n${full}\n`, 'utf8');
  } catch {
    /* the dialog is still worth showing */
  }
  return { text, file };
}

/**
 * Show the failure in a native message box and resolve once it is on screen.
 *
 * Resolving on the child's `spawn` event (not on its exit) is deliberate: the
 * dialog must outlive this process, so there is nothing to wait for beyond
 * "it started". The timeout covers the case where PowerShell never spawns.
 */
export async function showFatalError(err: unknown, appVersion: string): Promise<void> {
  const { text, file } = describeFailure(err, appVersion);

  // A test or CI run must not leave a modal dialog holding the job open.
  if (process.env.NOLANGUAGE_NO_DIALOG === '1' || process.env.CI) {
    process.stderr.write(`[fatal] ${text}\n`);
    return;
  }
  if (process.platform !== 'win32') {
    process.stderr.write(`[fatal] ${text}\n`);
    return;
  }

  // The text travels as base64, not as a file path: the directory that just
  // failed to be written is very often the app data dir itself, and a dialog that
  // depends on it would show nothing exactly when it is needed most.
  const payload = Buffer.from(text, 'utf8').toString('base64');
  const script =
    'Add-Type -AssemblyName PresentationFramework;' +
    `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'));` +
    "[System.Windows.MessageBox]::Show($t, 'Nolanguage', 'OK', 'Error') | Out-Null";

  // Two mechanisms, because the first depends on WPF being loadable: a stripped
  // or policy-restricted image may refuse PresentationFramework. The second needs
  // nothing but COM. Whichever runs is recorded, so a "no dialog appeared" report
  // has something concrete to point at.
  const attempts: Array<[string, string]> = [
    ['messagebox', script],
    [
      'popup',
      `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'));` +
        "$w = New-Object -ComObject WScript.Shell; $w.Popup($t, 0, 'Nolanguage', 16) | Out-Null",
    ],
  ];

  for (const [name, command] of attempts) {
    const pid = await launchDialog(command);
    recordAttempt(name, pid);
    if (pid) {
      // One line on stderr as well, so a terminal launch still sees something
      // even if the dialog is dismissed unread.
      process.stderr.write(`[fatal] ${err instanceof Error ? err.message : String(err)}\n`);
      return;
    }
  }
  process.stderr.write(`[fatal] ${text}\n`);
}

/**
 * Spawn one dialog process and resolve with its pid once it is up.
 *
 * Resolving on `spawn` (plus a short grace) rather than on `exit` is deliberate:
 * the dialog must outlive this process, so there is nothing to wait for beyond
 * "it started". `undefined` means the mechanism could not be started at all.
 */
function launchDialog(command: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', command], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      const timer = setTimeout(() => resolve(child.pid), 1500);
      child.once('spawn', () => {
        clearTimeout(timer);
        setTimeout(() => resolve(child.pid), 400);
      });
      child.once('error', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Note which dialog mechanism was tried, and whether a process came up. */
function recordAttempt(mechanism: string, pid: number | undefined): void {
  try {
    const file = appDataPath('logs', 'fatal-history.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} dialog=${mechanism} pid=${pid ?? 'none'}\n`, 'utf8');
  } catch {
    /* diagnostics must never be the thing that fails */
  }
}

/** Append a note next to the dialog copy, for the "it happened again" case. */
export function recordFatal(err: unknown): void {
  try {
    const file = appDataPath('logs', 'fatal-history.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${err instanceof Error ? err.message : String(err)}\n`, 'utf8');
  } catch {
    /* diagnostics must never be the thing that fails */
  }
}
