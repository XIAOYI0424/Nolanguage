/**
 * The log that exists before the kernel does.
 *
 * Lives in `util` (layer 0) rather than `log` (layer 2) because `assets` has to
 * call it from the extractor, and `assets` is also layer 0 — an import from
 * there into `log` is an upward edge the architecture gate rejects.
 *
 * # The gap this closes
 *
 * `FileTransport` is installed by the kernel, so anything that fails **before**
 * the kernel is constructed leaves no record at all — only a stack trace on a
 * stderr nobody is reading. That is not hypothetical: a launch died with
 *
 *   EPERM: operation not permitted, open
 *   '…\Temp\nolanguage-embedded\extensions\examples\faulty\extension.json'
 *
 * during embedded-asset extraction, which runs before the kernel exists. The
 * app's own `desktop.log` recorded nothing, `logs/app.log` was never created,
 * and the only evidence was the console output of a GUI process.
 *
 * So: a tiny sink with no dependencies, written to before anything else can
 * fail, and wired into the two places early code actually breaks — the crash
 * hook and the asset extractor.
 *
 * # Why a separate file
 *
 * `logs/app.log` promises "first line is a process header", and the smoke test
 * asserts exactly that. Writing boot lines into it first would break the
 * invariant for every reader. `logs/boot.log` sits next to it and holds only the
 * few lines that describe a launch.
 *
 * # Opt-in, like the kernel log
 *
 * Only writes when `NOLANGUAGE_LOG_FILE` names a file (the desktop entry sets
 * it). A bare suite run leaves it unset and this module stays silent, so nothing
 * lands in a user's app data because a test booted a kernel.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Rotate once the file passes this; a launch writes a handful of lines. */
const MAX_BYTES = 64 * 1024;

let appVersion = '';
let installed = false;
let headerWritten = false;
let broken = false;
/** Target of the last write, so a different path starts a fresh file. */
let lastPath: string | undefined;

/** `logs/boot.log` beside the configured kernel log, or `undefined` if disabled. */
export function bootLogPath(): string | undefined {
  const configured = process.env.NOLANGUAGE_LOG_FILE;
  if (!configured || configured === '0' || configured.toLowerCase() === 'off') return undefined;
  return join(dirname(configured), 'boot.log');
}

function write(entry: Record<string, unknown>): void {
  if (broken) return;
  const path = bootLogPath();
  if (!path) return;
  // A different target is a different file: it needs its own header, and a
  // failure recorded against the old path must not silence the new one.
  if (path !== lastPath) {
    lastPath = path;
    headerWritten = false;
    broken = false;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!headerWritten) {
      headerWritten = true;
      const header = {
        '#': 'boot',
        version: 1,
        app: appVersion,
        platform: `${process.platform}/${process.arch}`,
        startedAt: new Date().toISOString(),
        pid: process.pid,
        argv: process.argv.slice(1),
      };
      appendFileSync(path, JSON.stringify(header) + '\n', 'utf8');
    } else if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    // A logger that can take the process down is worse than no logger — but
    // stop retrying, or a read-only profile turns every line into an exception.
    broken = true;
  }
}

/** Record a milestone. Cheap enough to call from a boot path. */
export function bootLog(event: string, detail?: Record<string, unknown>): void {
  write(detail ? { ev: event, ...detail } : { ev: event });
}

/**
 * Record a failure with enough shape to act on.
 *
 * `errno`/`code`/`syscall`/`path` are carried explicitly because they are the
 * parts that identify *which* write was denied — the message alone said
 * "operation not permitted" and the stack pointed at bundled code.
 */
export function bootLogError(event: string, err: unknown, detail?: Record<string, unknown>): void {
  const e = err as NodeJS.ErrnoException | undefined;
  write({
    ev: event,
    lvl: 'ERROR',
    ...detail,
    error: {
      name: e?.name,
      message: e?.message,
      code: e?.code,
      errno: e?.errno,
      syscall: e?.syscall,
      path: e?.path,
      stack: e?.stack?.split('\n').slice(0, 6).join('\n'),
    },
  });
}

/**
 * Install the boot sink: header + a crash hook that observes without changing
 * how Node handles the crash.
 *
 * `uncaughtExceptionMonitor` rather than `uncaughtException` on purpose — a
 * plain listener keeps a broken process alive, which is how an app ends up
 * running with no window instead of exiting and telling you why.
 */
export function installBootLog(opts: { app?: string } = {}): void {
  if (installed) return;
  installed = true;
  appVersion = opts.app ?? '';
  bootLog('boot');
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    bootLogError('uncaught', err, { origin });
  });
}
