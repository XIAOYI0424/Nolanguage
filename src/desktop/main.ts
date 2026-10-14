/**
 * Desktop entry (packaged build).
 *
 * This is the module bundled into `Nolanguage.exe` (Node Single Executable
 * Application). It boots the workspace server and opens the system browser, so
 * double-clicking the exe gives the same experience as `npm run ide`.
 *
 * Unlike `src/panel/server.ts` it never auto-runs on import: the build script
 * points the SEA blob at this file, so importing it *is* the launch.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { main as startServer } from '../panel/server.js';

/** Set by the build script so runtime defaults follow the executable. */
process.env.NOLANGUAGE_PACKAGED ??= '1';

// The desktop entry prints its own banner, so the server's is suppressed.
process.env.NOLANGUAGE_QUIET ??= '1';

// Desktop-friendly defaults: bind to loopback only, and skip the synthetic
// demo traffic so the panel shows what the user actually does.
process.env.PANEL_HOST ??= '127.0.0.1';
process.env.PANEL_NO_DEMO ??= '1';

/**
 * `--no-browser` (or NOLANGUAGE_NO_BROWSER=1) runs the server only: nothing
 * is opened, the addresses are just printed.
 */
const noBrowser =
  process.env.NOLANGUAGE_NO_BROWSER === '1' || process.argv.some((a) => a === '--no-browser');

async function main(): Promise<void> {
  const { base } = await startServer();
  if (!noBrowser) openAppWindow(`${base}/`);

  const store = process.env.NOLANGUAGE_DB
    ?? join(dirname(process.execPath), '.nolanguage', 'telemetry.db');

  process.stdout.write(
    `\n` +
      `  ┌──────────────────────────────────────────────────────────┐\n` +
      `  │  Nolanguage — unified multi-language workspace           │\n` +
      `  └──────────────────────────────────────────────────────────┘\n` +
      `\n` +
      `  Workspace   ->  ${base}/\n` +
      `  Monitor     ->  ${base}/monitor\n` +
      `  Telemetry   ->  ${store}\n` +
      `\n` +
      `  ${noBrowser ? 'Browser launch disabled — open the Workspace address above.' : 'A lightweight app window should have opened.'}\n` +
      `  ${noBrowser ? '' : `If it did not, visit ${base}/ manually.`}\n` +
      `\n` +
      `  Close this window (or press Ctrl+C) to stop the server.\n\n`,
  );
}

/**
 * Open the workspace in the lightest possible window.
 *
 * Order of preference:
 *  1. Edge in **app mode** (`--app=`): a chromeless single-purpose window —
 *     no tabs, no address bar, no extensions — using the WebView2 runtime that
 *     ships with Windows. This is the "runs like a local program" experience
 *     without a browser (Chrome/WebView2 SDK) dependency.
 *  2. The OS default browser via `start` — the universal fallback.
 *
 * Errors are never fatal: the console always prints the address.
 */
function openAppWindow(url: string): void {
  const edge = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));

  const cmd = edge
    ? { file: edge, args: [`--app=${url}`, '--no-first-run', '--no-default-browser-check'] }
    : { file: 'cmd', args: ['/d', '/s', '/c', `start "" ${url.replace(/&/g, '^&')}`] };

  try {
    const child = spawn(cmd.file, cmd.args, { stdio: 'ignore', detached: true, windowsHide: !edge });
    child.on('error', () => {
      process.stdout.write(`\n  (could not open a window — open ${url} manually)\n`);
    });
    child.unref();
  } catch {
    process.stdout.write(`\n  (could not open a window — open ${url} manually)\n`);
  }
}

main().catch((err) => {
  console.error('Nolanguage desktop failed to start:', err);
  process.exit(1);
});
