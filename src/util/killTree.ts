/**
 * End a process **and its children**.
 *
 * `child.kill()` on Windows is `TerminateProcess` on one pid, and that is not
 * enough in the two places this product needs it:
 *
 * - Edge keeps its renderer/GPU/crashpad processes alive, so a killed launcher
 *   leaves a window's worth of processes behind and the profile stays locked.
 * - A `.cmd` shim — pyright and tsserver both launch as `cmd /d /s /c node …` —
 *   leaves the real server running when only the wrapper is killed. The server
 *   still holds the stdio pipes, so the *parent* never sees the child exit and
 *   never exits either. That is not theoretical: a verification suite printed its
 *   summary and then hung, with two `cmd.exe` handles still open.
 *
 * `taskkill /T /F` walks the tree instead.
 *
 * Lives in `util` (layer 0) because both the desktop shell and the language
 * client need it, and `lsp` (layer 6) may not import from `desktop` (layer 13).
 */
import { spawn } from 'node:child_process';

/** Is this pid still running? Signal 0 asks without delivering anything. */
export function isAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process and everything it spawned. Fire-and-forget on purpose: the
 * caller is usually on an exit path and has nothing left to do with the result.
 */
export function killTree(pid: number | undefined): void {
  if (!isAlive(pid)) return;
  try {
    if (process.platform === 'win32') {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => undefined);
      child.unref();
    } else {
      process.kill(pid!, 'SIGKILL');
    }
  } catch {
    /* already gone, or not ours to kill */
  }
}
