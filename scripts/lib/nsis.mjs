/**
 * Where is `makensis`?
 *
 * Shared by `installer/build-setup.mjs` (which needs it to build the installer)
 * and `scripts/ensure-nsis.mjs` (which installs it on a machine that has none).
 * One resolver, so "not found" means the same thing in both places — the two
 * used to keep separate candidate lists, which is how a path gets fixed in one
 * and silently stays broken in the other.
 *
 * Order matters: an explicit `%NSIS_MAKENSIS%` wins, then the copy the Tauri CLI
 * downloads, then a normal install, then `PATH`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Every place we look, in priority order. Exported so the error message can list them. */
export function makensisCandidates() {
  const local = process.env.LOCALAPPDATA ?? '';
  return [
    process.env.NSIS_MAKENSIS,
    local && join(local, 'tauri', 'NSIS', 'makensis.exe'),
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ].filter(Boolean);
}

/** First existing `makensis.exe` among the known locations, or undefined. */
export function findMakensis() {
  for (const candidate of makensisCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  // A bare `where` lookup last: a scoop/choco install lands somewhere we did
  // not hard-code, and PATH is the only thing that knows.
  const which = spawnSync('where', ['makensis'], { encoding: 'utf8', windowsHide: true });
  const found = (which.stdout ?? '').split(/\r?\n/).find((line) => line.trim().length > 0);
  return found ? found.trim() : undefined;
}
