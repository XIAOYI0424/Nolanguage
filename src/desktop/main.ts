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
import { openSystemBrowser, openWebView, webViewProfileDir, type WebViewHandle } from './WebViewHost.js';
import {
  clearSession,
  closeRecordedWindow,
  closeStaleWindows,
  findWindowProcesses,
  killTree,
  logDesktop,
  patchSession,
  readSession,
} from './session.js';

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

/**
 * Port the server will bind — the same default `server.ts` uses.
 *
 * A function, not a module-level `const`, because the entry dispatch above runs
 * *before* the bottom of this module is evaluated: `main()` reaches the probe
 * synchronously, and a `const` declared further down is either in its temporal
 * dead zone (a `ReferenceError`) or — once bundled, where it becomes `var` —
 * silently `undefined`, which produced requests to `127.0.0.1:undefined`.
 */
function serverPort(): number {
  return Number(process.env.PANEL_PORT ?? 7310);
}

/**
 * The address of an already-running instance, or `undefined`.
 *
 * The bound port *is* the single-instance lock: it cannot be taken twice, and
 * `/health` proves the listener is this app rather than some unrelated service
 * that happens to sit on 7310. Without this probe a second double-click dies
 * with `EADDRINUSE` — or, when the leftover window still holds the profile,
 * adds one more window to it, which is exactly the "several windows every
 * time" report.
 */
async function runningInstance(): Promise<string | undefined> {
  const base = `http://127.0.0.1:${serverPort()}`;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { status?: string };
    return body?.status === 'ok' ? base : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const running = await runningInstance();
  if (running) {
    // Nothing to open: the user already has this workspace. Saying so is all a
    // GUI build can do without native window-focus APIs.
    process.stdout.write(`\n  Nolanguage is already running -> ${running}/\n\n`);
    return;
  }

  patchSession({ serverPid: process.pid, port: serverPort() });

  const { main: startServer } = await import('../panel/server.js');
  const server = await startServer();
  const base = server.base;

  // The window is a *managed* child: it is opened after the server is
  // listening, and torn down when this process exits.
  let view: WebViewHandle | undefined;
  /** Profile of the window we opened; the watchdog sweeps it when clients vanish. */
  let windowProfile: string | undefined;
  /** The process that actually hosts the window — not necessarily the one we spawned. */
  let windowPid: number | undefined;

  if (openBrowser) {
    openSystemBrowser(`${base}/`);
  } else if (!noWindow) {
    const profile = webViewProfileDir();
    windowProfile = profile;
    logDesktop('launch', { port: serverPort(), profile, pid: process.pid });

    // Sweep **every** window still holding our profile before spawning.
    //
    // A clean exit releases the profile, so nothing is swept and the launch
    // stays cheap. A crash, a hard kill, or the installer's `taskkill` on
    // upgrade leaves the detached Edge window alive: it still owns the
    // profile, Chromium hands the new `--app` URL to that old process, one
    // extra window flashes and the process we spawned exits at once — the
    // "多余的弹窗弹出又自动关闭" report. Killing the stale window first makes
    // this process the browser root, which is what lets us own and watch it.
    const previous = readSession();
    const wasClean = previous?.cleanExit === true;
    // Consume the marker now: a crash before the next clean exit must not be
    // mistaken for "nothing to clean".
    patchSession({ cleanExit: undefined });

    const recorded = await closeRecordedWindow(profile);
    const swept = wasClean ? [] : await closeStaleWindows(profile);
    const closed = Array.from(new Set([...(recorded ? [recorded] : []), ...swept]));
    logDesktop('previous-window', { pid: recorded ?? null, swept });
    if (closed.length) {
      process.stdout.write(`  Closed the window left by the previous session (pid ${closed.join(', ')})\n`);
    }
    view = openWebView({ url: `${base}/`, size: '1280,860', quiet: true });
    if (view.engine === 'none') openSystemBrowser(`${base}/`);
    else windowPid = await discoverWindow(profile);
  }

  // Same resolution the store itself uses, so the banner never advertises a
  // path the database does not actually occupy.
  const { telemetryDbPath } = await import('../store/SqliteStore.js');
  const store = telemetryDbPath();

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
      `  ${openBrowser || noWindow ? 'Press Ctrl+C to stop the server.' : 'Close the app window to stop the server.'}\n\n`,
  );

  /**
   * Find the process that actually hosts the window.
   *
   * `msedge.exe --app=…` does **not** reliably stay the browser process: on this
   * Edge version the process we spawn hands the profile over to a relaunched
   * browser and exits with code 0 within ~100 ms, so the window belongs to a
   * pid we never saw. Treating "the spawned pid exited" as "the user closed the
   * window" therefore shuts the server down under a perfectly healthy window —
   * the "窗口显示连不上" report — so the pid is discovered instead, by asking
   * which process is holding our profile.
   */
  async function discoverWindow(profile: string): Promise<number | undefined> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const pids = await findWindowProcesses(profile);
      if (pids.length > 0) {
        logDesktop('window-discovered', { pid: pids[0], pids });
        patchSession({ browserPid: pids[0], profile });
        return pids[0];
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    logDesktop('window-missing', { profile });
    // A window that never appears is worse than a browser tab: give the user
    // something to click.
    openSystemBrowser(`${base}/`);
    return undefined;
  }

  /**
   * Liveness. With the window living in a process we do not own, the WebSocket
   * hub is the only proof that a UI is still showing the app.
   *
   * Deliberately slow and confirmatory: a reload, a lock screen or a suspended
   * laptop all drop the socket for a while, and killing the server on the first
   * quiet second would turn "the UI blinked" into "连不上". Only after 10 quiet
   * seconds **and** a profile sweep that finds no window at all does this
   * conclude the user is gone.
   */
  let shuttingDown = false;
  if (view && view.engine !== 'none') {
    let everConnected = false;
    let quietSeconds = 0;
    setInterval(() => {
      if (shuttingDown) return;
      if (server.clientCount() > 0) {
        everConnected = true;
        quietSeconds = 0;
        return;
      }
      if (!everConnected) return;
      if (++quietSeconds < 10) return;
      quietSeconds = 0;
      void (async () => {
        const alive = windowProfile ? await findWindowProcesses(windowProfile) : [];
        logDesktop('watchdog-check', { windowsAlive: alive.length, pids: alive });
        if (alive.length === 0) shutdown('no-window');
      })();
    }, 1000).unref?.();
  }

  /**
   * Stop everything, in the order that leaves nothing behind.
   *
   * The window goes first (it must never outlive the server it points at), then
   * `server.close()` runs the real teardown — sandbox workers, LSP children,
   * the SQLite flush — and exits. The previous revision called
   * `process.exit(0)` directly, which skipped all of that and is why language
   * servers and the telemetry database outlived the app.
   *
   * Declared as a function so the `onClosed` handler can be wired before this
   * point; both paths (user closes window, SIGINT/SIGTERM) converge here and
   * only the first one runs.
   */
  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logDesktop('shutdown', { reason, port: serverPort(), windowPid: windowPid ?? null });
    // `windowPid` is the process that really hosts the window; `view.close()`
    // only reaches the launcher we spawned (usually already gone).
    killTree(windowPid);
    view?.close();
    // Record a clean exit instead of dropping the record: the profile is
    // released, so the next launch can skip the PowerShell sweep. The marker is
    // removed on the next launch (and by the abnormal-exit handler below).
    patchSession({ browserPid: undefined, cleanExit: true });
    void server.close().catch(() => process.exit(0));
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  // `*Monitor` instead of a plain listener on purpose: it records the failure
  // without swallowing Node's own crash handling (a plain `uncaughtException`
  // handler would keep a broken process alive).
  process.on('uncaughtExceptionMonitor', (err) => {
    logDesktop('uncaught', { name: err?.name, message: err?.message });
  });
  // Last resort for an abnormal exit (an unhandled rejection, a crash): the
  // window and the session record must not survive it.
  process.once('exit', () => {
    killTree(windowPid);
    view?.close();
    // A clean shutdown already recorded `cleanExit`; only an abnormal exit
    // drops the record, which is what tells the next launch to sweep.
    if (!shuttingDown) clearSession();
  });
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
