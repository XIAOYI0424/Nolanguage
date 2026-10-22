/**
 * Local WebView host (no native dependency).
 *
 * The workspace UI is rendered by the **system WebView engine** — the one
 * Windows already ships — rather than by a bundled browser.
 *
 * ## Why Edge ships the window, not `msedgewebview2.exe`
 *
 * A current Windows box has two Chromium engines installed, and it is tempting
 * to launch the WebView2 runtime binary directly:
 *
 *   - **WebView2 runtime** (`msedgewebview2.exe` under `EdgeWebView`/`EdgeCore`)
 *   - **Edge** (`msedge.exe`)
 *
 * `msedgewebview2.exe` cannot be used as a standalone renderer. It is a
 * *passive host*: it only creates a window when a caller drives it through
 * `ICoreWebView2Environment` (the COM API). Launched from a shell it exits
 * immediately with code 0, no output, and never even touches its
 * `--user-data-dir`. Verified on 151.0.4129.59 — an empty profile directory
 * and a zero exit are the tell. Driving it properly would mean shipping a
 * native addon with `WebView2Loader.dll`, which breaks the project's
 * zero-dependency rule.
 *
 * So `msedge.exe` — which shares that same engine and *is* directly
 * launchable — hosts the window, and the WebView2 runtime is used for what it
 * is actually good at here: **availability detection**. When it is present the
 * engine is guaranteed and the window needs no browser chrome; the launcher
 * reports which engine backs the window so the console banner can say so.
 *
 * The window is made to behave like an installed application rather than a
 * browser tab, which is what "本地化" actually buys:
 *
 *   - a **dedicated `--user-data-dir`** — its own profile, cookies, cache and
 *     history, completely separate from the user's browsing. This is also what
 *     gives it a distinct taskbar identity and window title.
 *   - `--app=<url>` — chromeless, no tabs, no address bar, no bookmarks.
 *   - `--no-first-run` / `--no-default-browser-check` — never a first-run
 *     wizard, never a "make default browser?" prompt.
 *   - feature switches that strip the shopping/sidebar/copilot surfaces.
 *
 * Everything is best-effort and non-fatal: if no engine is found, or the spawn
 * fails, the console still prints the address and the server keeps serving.
 *
 * ## Lifetime
 *
 * The window is a *detached* child, so Windows gives it no lifetime tie to this
 * process: without help, closing the window leaves the server listening and
 * killing the server leaves the window open (rendering a dead address) — the
 * "后台没关干净" report. Two things fix that here:
 *
 *   - `onClosed` fires when the browser **root** process exits, which is what
 *     "the user closed the window" looks like from this side;
 *   - `close()` ends the whole process *tree* (`taskkill /T`), because Chromium
 *     keeps renderer/GPU children alive when only the launcher is killed.
 *
 * The root only reports accurately when no *older* browser holds the profile,
 * otherwise Chromium delegates to that one and our newly spawned process exits
 * immediately. `session.ts#closeStaleWindows` clears such leftovers before the
 * launch; `main.ts` calls it first.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appDataPath } from '../util/appData.js';
import { isPackaged } from './embeddedAssets.js';
import { killTree, logDesktop, patchSession } from './session.js';

/** Where the WebView engine binaries typically live on Windows. */
const WEBVIEW2_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application',
  'C:\\Program Files\\Microsoft\\EdgeWebView\\Application',
  'C:\\Program Files (x86)\\Microsoft\\EdgeCore',
  'C:\\Program Files\\Microsoft\\EdgeCore',
];

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * Newest installed WebView2 runtime version, or `undefined` when the runtime is
 * absent. Only the runtime *directory* is inspected — its binary is not
 * launchable on its own (see the module header).
 *
 * The runtime is versioned (`.../Application/<version>/`) and several versions
 * coexist after an update, so the highest wins. Comparison is numeric per
 * segment rather than lexicographic.
 */
export function webView2Version(): string | undefined {
  let best: { name: string; parts: number[] } | undefined;
  for (const root of WEBVIEW2_CANDIDATES) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirNames(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^\d+(\.\d+)*$/.test(name)) continue;
      // The runtime ships its own msedgewebview2.exe; require it so a stray
      // version-shaped folder cannot be reported as an installed runtime.
      if (!existsSync(join(root, name, 'msedgewebview2.exe'))) continue;
      const parts = name.split('.').map((n) => Number(n) || 0);
      if (!best || compareVersions(parts, best.parts) > 0) best = { name, parts };
    }
  }
  return best?.name;
}

/** True when the WebView2 runtime is installed (i.e. the engine is guaranteed). */
export function hasWebView2(): boolean {
  return webView2Version() !== undefined;
}

/** Resolve an Edge shell binary, preferring the WebView2 sibling when present. */
export function findEdgeBinary(): string | undefined {
  const direct = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (direct) return direct;
  // Some installs only expose Edge through the WebView2/EdgeCore tree.
  for (const root of WEBVIEW2_CANDIDATES) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirNames(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const exe = join(root, name, 'msedge.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}

/** Numeric, segment-wise version compare: `a > b` -> positive. */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Profile directory for the app window.
 *
 * A dedicated profile is the difference between "a browser tab" and "an
 * application": it owns its own window title, taskbar entry and session, and it
 * cannot be disturbed by (or disturb) the user's real browsing profile.
 *
 * Location preference:
 *   - `NOLANGUAGE_WEBVIEW_PROFILE` when the operator wants to pin it;
 *   - `%LOCALAPPDATA%/Nolanguage/webview` — the app data root, the same one the
 *     telemetry database uses. It used to live beside the executable in a
 *     packaged build, which left a locked profile behind in the install
 *     directory on every uninstall;
 *   - temp, when the app data root cannot be created.
 */
export function webViewProfileDir(): string {
  const override = process.env.NOLANGUAGE_WEBVIEW_PROFILE;
  if (override) return override;

  let base = appDataPath('webview');
  try {
    mkdirSync(base, { recursive: true });
    return base;
  } catch {
    const fallback = join(tmpdir(), 'nolanguage-webview');
    try {
      mkdirSync(fallback, { recursive: true });
    } catch {
      /* give up silently — Chromium will pick its own default */
    }
    return fallback;
  }
}

export interface WebViewOptions {
  /** Absolute URL to render. */
  url: string;
  /** Window size, `W,H`. Ignored by engines that choose their own. */
  size?: string;
  /** Suppress the engine's own console noise. */
  quiet?: boolean;
  /**
   * Called once when the window goes away **without** `close()` having been
   * called — i.e. the user closed it. This is the only "the UI is gone" signal
   * a detached Edge window gives us, and it is what stops the server.
   *
   * `elapsedMs` is how long the browser root we spawned lived. A root that dies
   * in the first couple of seconds never owned a window: Chromium handed the
   * `--app` URL to an already-running browser on the same profile and exited.
   * Callers must not treat that as "the user closed the window" — that mistake
   * stops the server while a window is still on screen, which is exactly the
   * "窗口一直显示连不上" report.
   */
  onClosed?: (info: { elapsedMs: number; code: number | null }) => void;
}

export interface WebViewHandle {
  /** How the window was actually opened, for logging. */
  engine: 'webview2' | 'edge' | 'system-browser' | 'none';
  /**
   * The WebView2 runtime version backing this machine, when installed. Its
   * presence is what guarantees the Edge shell renders with the system engine
   * and is why the window can be chrome-free.
   */
  webview2Version?: string;
  /** The Edge binary that opened the window. */
  binary?: string;
  /** Kills the window. Safe to call more than once. */
  close: () => void;
}

/**
 * Shared Chromium switches for a chrome-less, prompt-less, app-like window.
 *
 * These are accepted by both `msedge.exe` and `msedgewebview2.exe` — they are
 * Chromium switches, not Edge-specific API surface, which is exactly why the
 * WebView2 runtime can stand in as a plain renderer here.
 */
function appSwitches(url: string, profile: string, size?: string): string[] {
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-sync',
    // A window that outlives `Nolanguage.exe` is the "后台没关干净" complaint, so
    // the browser must not keep running once its last window is gone. Without
    // this Edge keeps a background process (`--no-service-autorun` is not
    // enough), the profile stays locked, and the next launch delegates to it
    // instead of owning a window it can watch.
    '--disable-background-mode',
    // The app profile is private and cannot be updated by Edge's updater, so
    // Edge tries anyway, fails, and opens a "无法更新 Microsoft Edge" window on
    // every launch — the "unknown popup" report. These stop the background
    // network and component-update machinery that produces it; verified by the
    // window title becoming the app title again.
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    // This profile is force-closed on every exit, which Chromium records as an
    // unclean shutdown. Left alone it offers "restore pages?" — one of the
    // several extra bubbles reported at launch — and may restore old windows on
    // top of the new one.
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // Strip the surfaces that make an app window feel like a browser, and kill
    // the "translate this page?" bubble: the shell is written in English
    // (`<html lang="en">`), so on a Chinese Windows install Chromium offers to
    // translate it on every launch. `Translate` is the browser feature and
    // `TranslateUI` its bubble; both are needed to stop the prompt.
    '--disable-features=msEdgeSidebarV2,msEdgeShoppingAssistant,msEdgeCollections,msEdgeWorkspaces,msEdgeCopilot,Translate,TranslateUI',
  ];
  if (size) args.push(`--window-size=${size}`);
  return args;
}

/**
 * Launch the workspace in a local WebView window.
 *
 * Never throws and never blocks: the engine is spawned detached with stdio
 * ignored, so a missing or misbehaving engine degrades to "open the address
 * yourself" instead of taking the server down with it.
 *
 * `engine` reports `'webview2'` when the system runtime is installed (the
 * window is then backed by the OS engine) and `'edge'` when only the Edge
 * shell exists — in both cases Edge performs the launch, as explained above.
 */
export function openWebView(opts: WebViewOptions): WebViewHandle {
  const profile = webViewProfileDir();
  const wv2 = webView2Version();
  const edge = findEdgeBinary();
  const engine: WebViewHandle['engine'] = edge ? (wv2 ? 'webview2' : 'edge') : 'none';

  if (!edge) {
    return { engine: 'none', close: () => undefined };
  }

  try {
    const child: ChildProcess = spawn(edge, appSwitches(opts.url, profile, opts.size), {
      stdio: 'ignore',
      detached: true,
      // Deliberately *no* `windowsHide: true` here. Node implements that option
      // by setting `STARTF_USESHOWWINDOW` + `SW_HIDE` in the child's
      // `STARTUPINFO`, and Chromium uses that startup value as the initial
      // visibility of its first window. The result is a complete Edge process
      // tree (browser + GPU + renderers) with `MainWindowHandle == 0`: "网页
      // 进程在跑，但窗口没出现". Edge is a GUI program, so hiding a console is
      // not even useful — leave its startup show state alone.
      windowsHide: false,
    });
    // A detached child that cannot start reports through `error`, asynchronously.
    child.on('error', () => undefined);
    child.unref();

    // Recorded before the window can be closed: the pid is the only handle a
    // later launch (or a crash report from the user) has on this window.
    let closed = false;
    const startedAt = Date.now();
    if (child.pid) patchSession({ browserPid: child.pid, profile });
    logDesktop('window-spawned', { pid: child.pid, profile, engine });

    // The browser root lives as long as the window does, so its exit *is* the
    // user closing the window — unless it dies early, which means Chromium
    // delegated the URL to another browser instead of opening a window here.
    // `close()` sets `closed` first, which is what keeps a programmatic
    // teardown from being reported as a user action (that would re-enter
    // shutdown).
    child.on('exit', (code) => {
      if (closed) return;
      closed = true;
      const elapsedMs = Date.now() - startedAt;
      patchSession({ browserPid: undefined });
      logDesktop('window-process-exit', { pid: child.pid, code, elapsedMs });
      opts.onClosed?.({ elapsedMs, code });
    });

    return {
      engine,
      webview2Version: wv2,
      binary: edge,
      close: () => {
        if (closed) return;
        closed = true;
        // The tree, not the launcher: Chromium's renderer/GPU children would
        // survive a plain `kill()` and keep the profile locked, so the next
        // launch would delegate to a window that is no longer on screen.
        killTree(child.pid);
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        patchSession({ browserPid: undefined });
      },
    };
  } catch {
    return { engine: 'none', webview2Version: wv2, close: () => undefined };
  }
}

/**
 * Last-resort fallback: hand the URL to whatever the OS considers the default
 * browser. Only used when no WebView engine exists at all (rare on Windows 10+,
 * where the WebView2 runtime ships with the OS).
 */
export function openSystemBrowser(url: string): boolean {
  try {
    const child = spawn('cmd', ['/d', '/s', '/c', `start "" ${url.replace(/&/g, '^&')}`], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
