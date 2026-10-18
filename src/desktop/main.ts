/**
 * Desktop entry (packaged build).
 *
 * This is the module bundled into `Nolanguage.exe` (Node Single Executable
 * Application). It boots the workspace server and renders the UI in a local
 * **WebView** window — the system WebView2 runtime when present, Edge, or the
 * default browser as a last resort. See `WebViewHost.ts` for the engine
 * selection; double-clicking the exe therefore gives the same experience as
 * `npm run ide`, minus the browser chrome.
 *
 * Unlike `src/panel/server.ts` it never auto-runs on import: the build script
 * points the SEA blob at this file, so importing it *is* the launch.
 *
 * **Import order matters.** `server.ts` decides at *evaluation* time whether it
 * was launched directly, and in the SEA bundle both modules end up in one file
 * — so the check must already be answered by the time `server.js` is pulled in.
 * That is why the environment below is set first, and the import is dynamic.
 */

/**
 * Set by the build script so runtime defaults follow the executable.
 *
 * This is what stops `server.ts` from self-booting: in the SEA bundle the
 * "was this the entry script?" comparison resolves to the exe path on both
 * sides, so without this flag the server would start twice and the desktop
 * entry would lose the port race with `EADDRINUSE`.
 */
process.env.NOLANGUAGE_PACKAGED ??= '1';
// The desktop entry prints its own banner, so the server's is suppressed.
process.env.NOLANGUAGE_QUIET ??= '1';
// Desktop-friendly defaults: bind to loopback only, and skip the synthetic
// demo traffic so the panel shows what the user actually does.
process.env.PANEL_HOST ??= '127.0.0.1';
process.env.PANEL_NO_DEMO ??= '1';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openSystemBrowser, openWebView, type WebViewHandle } from './WebViewHost.js';

/**
 * Modes that share this executable:
 *
 *   Nolanguage.exe                              boot the workspace + open a window
 *   Nolanguage.exe --extension-host --manifest <m> --extension <e>
 *                                              run one extension in isolation
 *   Nolanguage.exe --panel-stdio                speak the panel protocol on
 *                                              stdin/stdout (the Tauri sidecar)
 *   Nolanguage.exe --dump-plugins               print where every language
 *                                              plugin was found, then exit
 *   Nolanguage.exe lang <verb> …                install/manage language plugins
 *                                              (same verbs as `nlg lang …`)
 *
 * The two CLI modes exist because the exe is a Node SEA: it already carries a
 * runtime, so a user who installed via `Setup.exe` can manage plugins without
 * installing Node or keeping a source checkout — `nlg` alone could not.
 *
 * The extension host re-uses the same binary so a packaged build needs no
 * second executable and no external `node` on PATH. The dispatch is inside an
 * async IIFE (not top-level await) because the SEA build is CommonJS.
 *
 * This block is the **only** entry point. Calling `main()` again at the bottom
 * of the file (as an earlier revision did, for a nicer error message) boots a
 * second server in the same process: the first owns the port and the second
 * dies with `EADDRINUSE`. Error handling therefore belongs here.
 */
if (process.argv.includes('--extension-host')) {
  runExtensionHost().catch((err: unknown) => {
    process.stderr.write(`extension host failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else if (process.argv.includes('--panel-stdio')) {
  // The Tauri shell's engine: no window, no port, no HTTP server — the panel
  // protocol goes over stdin/stdout instead. See `src/panel/Transport.ts`.
  runEngineStdio().catch((err: unknown) => {
    process.stderr.write(`engine (stdio) failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else if (process.argv[2] === 'lang') {
  runLangCli(process.argv.slice(3));
} else if (process.argv.includes('--dump-plugins')) {
  runDumpPlugins();
} else {
  // `main()` opens the window and prints the banner; it loads the server graph
  // lazily, because that graph pulls `node:sqlite` and a CLI invocation must not
  // pay for it (see `main`).
  main().catch((err: unknown) => {
    console.error('Nolanguage desktop failed to start:', err);
    process.exit(1);
  });
}

/**
 * `Nolanguage.exe lang …`. Loaded lazily: a normal boot must not pay for the
 * plugin catalogue/crypto-free CLI path, and the import would otherwise pull
 * the whole registry in before the window exists.
 */
function runLangCli(args: string[]): void {
  void (async () => {
    const { runLang } = await import('../cli/lang.js');
    process.exitCode = await runLang(args);
  })().catch((err: unknown) => {
    process.stderr.write(`lang failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

/** `Nolanguage.exe --dump-plugins` — a report, so it never starts the server. */
function runDumpPlugins(): void {
  void (async () => {
    const { dumpPlugins } = await import('../cli/dump.js');
    process.exitCode = await dumpPlugins();
  })().catch((err: unknown) => {
    process.stderr.write(`--dump-plugins failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

/**
 * Sidecar mode. `main()` picks the stdio transport from the argv flag, and the
 * process lives as long as the relay keeps stdin open — so this handler is only
 * here to report a startup failure and to keep the process alive deliberately
 * (an empty stdin handler would otherwise let it exit when nothing else does).
 */
async function runEngineStdio(): Promise<void> {
  const { main: startServer } = await import('../panel/server.js');
  await startServer({ transport: 'stdio' });
  // Nothing to open and nothing to print: stdout is the protocol channel.
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}

async function runExtensionHost(): Promise<void> {
  const argValue = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const manifestPath = argValue('manifest');
  const entryPath = argValue('extension');
  if (!manifestPath || !entryPath) {
    process.stderr.write('usage: --extension-host --manifest <path> --extension <path>\n');
    process.exit(2);
  }
  const { HostRunner } = await import('../extensions/HostRunner.js');
  const { parseManifest } = await import('../extensions/Manifest.js');
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  const runner = new HostRunner({
    extensionId: manifest.id,
    entryPath,
    kernelVersion: '0.0.0', // replaced by the parent's activate request
    sessionId: 'host',
  });
  await runner.run();
}

/**
 * How the UI is surfaced — the "web" vs "desktop" question:
 *
 *   Nolanguage.exe                  desktop — native WebView window (no chrome)
 *   Nolanguage.exe --open-browser   web     — the system's default browser
 *   --no-browser / --no-open        server only (CI, `nlg web --no-open`)
 *
 * The installer's "Nolanguage (Web)" shortcut passes `--open-browser`; the
 * default (no flag) is the desktop window. `openWebView` degrades to the system
 * browser when no WebView engine exists, so the UI stays reachable regardless.
 */
const openBrowser = process.argv.includes('--open-browser');
const noWindow =
  !openBrowser &&
  (process.env.NOLANGUAGE_NO_BROWSER === '1' ||
    process.argv.some((a) => a === '--no-browser' || a === '--no-open'));

async function main(): Promise<void> {
  const { main: startServer } = await import('../panel/server.js');
  const { base } = await startServer();

  // The window is a *managed* child: it is opened after the server is
  // listening, and torn down when this process exits, so closing the console
  // window never leaves an orphaned UI pointing at a dead port.
  let view: WebViewHandle | undefined;
  if (openBrowser) {
    openSystemBrowser(`${base}/`);
  } else if (!noWindow) {
    view = openWebView({ url: `${base}/`, size: '1280,860', quiet: true });
    if (view.engine === 'none') openSystemBrowser(`${base}/`);
  }

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
      `  Perf        ->  ${base}/perf\n` +
      `  Telemetry   ->  ${store}\n` +
      `\n` +
      `  ${describeWindow(view)}\n` +
      `\n` +
      `  Close this window (or press Ctrl+C) to stop the server.\n\n`,
  );

  // Keep the profile owning a live process: killing the engine with the server
  // avoids a window that renders a dead address until it is manually closed.
  const shutdown = (): void => {
    view?.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', () => view?.close());
}

/** Human-readable line describing how (or whether) the window was opened. */
function describeWindow(view: WebViewHandle | undefined): string {
  if (openBrowser) return 'Opened in the default browser — the workspace address above.';
  if (noWindow) return 'Window launch disabled — open the Workspace address above.';
  switch (view?.engine) {
    case 'webview2':
      return `Opened as a local app window — system WebView2 ${view.webview2Version}, no browser chrome.`;
    case 'edge':
      return 'Opened in an Edge app window (WebView2 runtime not found — using the Edge engine).';
    case 'system-browser':
      return 'No WebView engine found — opened in the default browser.';
    default:
      return 'Could not open a window — open the Workspace address above.';
  }
}
