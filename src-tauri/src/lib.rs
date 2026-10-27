//! Application wiring.
//!
//! The window loads the bundled shell (`frontend/dist/index.html`, produced by
//! `scripts/build-frontend.mjs` from the very same `renderPyCharmHtml()` the dev
//! server returns), and the engine sidecar is started once the app is ready so
//! the first message it sends is already on the wire when the shell boots.

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, WindowEvent};

// `#[macro_use]` is required, not decoration: `#[tauri::command]` generates the
// `__cmd__*` / `__tauri_command_name_*` helper macros *next to the function*, and
// `generate_handler!` must see them in this module's scope. A glob `use` does not
// re-export them (rustc says so, and points here).
#[macro_use]
mod engine;

// The macros arrive through `#[macro_use]`; the function itself still has to be
// named for `generate_handler!`.
use engine::engine_send;

/// One timestamped line in the shell log.
///
/// A GUI-subsystem process has no console, so "the window is black" or "the
/// buttons do nothing" would be undiagnosable: the kernel log only covers the
/// engine, and it stops the moment the page stops talking to it. These lines
/// live in `%LOCALAPPDATA%\Nolanguage\tauri-shell.log` (256 KiB cap) and
/// separate "no window was ever created" from "the page never loaded" — which
/// look identical from the outside. Never allowed to break the app.
fn shell_log(event: &str, detail: impl std::fmt::Display) {
    use std::io::Write;
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from) else {
        return;
    };
    let dir = local.join("Nolanguage");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("tauri-shell.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 256 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "{} {} {}", secs, event, detail);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    shell_log("run", format!("start pid={}", std::process::id()));
    // Set by the page once it finishes loading; the watchdog below turns its
    // absence into a log line instead of a silently empty window.
    let page_loaded = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // The two consumers need their own handle: both closures must be `'static`.
    let loaded = std::sync::Arc::clone(&page_loaded);
    let watchdog = std::sync::Arc::clone(&page_loaded);
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // The native file pickers (Open / Open Folder / Save As) are real OS
        // dialogs — the one piece of browser-native UI the shell is allowed to
        // use, because there is no self-drawn equivalent.
        .plugin(tauri_plugin_dialog::init())
        // A second launch focuses the existing window instead of starting a
        // second app (and therefore a second engine). Without this, a
        // double-click on the exe while it is running looks exactly like "the
        // program started repeatedly".
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Reveal the hidden window once the document has finished loading.
        // `visible: false` in tauri.conf.json is what prevents the white flash;
        // the 1.5 s timer in `setup` below stays as the fallback for a page that
        // never reports back. This lives in Rust on purpose: the page keeps
        // exactly one IPC call (`engine_send`), asserted by
        // `scripts/verify-pycharm.ts` ("every message is an engine_send invoke").
        .on_page_load(move |webview, payload| {
            if webview.label() != "main" {
                return;
            }
            // `Started` is the first proof the WebView2 browser process exists
            // and is navigating; without it the window stays empty forever.
            match payload.event() {
                PageLoadEvent::Started => shell_log("page-load", "started"),
                PageLoadEvent::Finished => {
                    loaded.store(true, std::sync::atomic::Ordering::SeqCst);
                    shell_log("page-load", "finished");
                    // Harden *after* the page exists: `with_webview` touches
                    // CoreWebView2 on the UI thread, and doing that from `setup`
                    // races the browser process (the window then stays blank with
                    // no crash dump — see the 20 s watchdog line in the log).
                    #[cfg(windows)]
                    harden_webview(webview);
                    let _ = webview.window().show();
                }
            }
        })
        .setup(move |app| {
            shell_log("setup", "enter");
            // Spawning here (rather than lazily on the first invoke) means the
            // engine's greeting is already queued by the time the shell is up.
            if let Err(e) = engine::spawn(app.handle()) {
                shell_log("engine-spawn", format!("failed: {e}"));
                return Err(e.into());
            }
            shell_log("engine-spawn", "ok");
            #[cfg(windows)]
            {
                match app.get_webview_window("main") {
                    Some(window) => {
                        // The window is created hidden (no white flash). The page
                        // calls show() once fonts/first paint are ready, and this
                        // safety net guarantees it appears even if that never runs
                        // — a page that fails to load leaves a dark rectangle that
                        // is indistinguishable from "nothing happened".
                        let w = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(1500));
                            let _ = w.show();
                            shell_log("window", "shown by 1.5s fallback");
                        });
                    }
                    None => shell_log("window", "missing at setup"),
                }
                // Watchdog: a page that never finishes leaves a dark window with
                // no other symptom. Say so, once, in the log.
                let seen = std::sync::Arc::clone(&watchdog);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    if !seen.load(std::sync::atomic::Ordering::SeqCst) {
                        shell_log("page-load", "never finished within 20s");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine_send])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // `expect` here would panic with no console and no trace: the log is
            // the only record of *why* the app never came up.
            shell_log("build", format!("failed: {e}"));
            std::process::exit(1);
        })
        .run(|app_handle, event| {
            // Closing the window must end the process *and* its engine. Both
            // halves have failed before:
            //
            //   - `app.exit(0)` alone did not terminate the shell: after a
            //     window close the process was still alive 20 s later (observed),
            //     so a watchdog force-exits below;
            //   - the engine sidecar is a child the shell owns, and it kept
            //     running after the shell's window was gone — the "点了关闭后台
            //     还在跑" report.
            if let RunEvent::ExitRequested { .. } = event {
                shell_log("run-event", "exit requested");
                shutdown(app_handle);
            }
            if let RunEvent::WindowEvent { event, .. } = &event {
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    shell_log("window", "close requested");
                    shutdown(app_handle);
                }
            }
        });
    shell_log("run", "returned");
}

/// Shut the app down: engine first, then the shell, then make sure it happened.
///
/// The order matters. `Engine::release()` drops the sidecar handle, which closes
/// its stdin — and a closed pipe is exactly how the engine learns the UI is gone
/// (`StdioTransport.onClose`), so this is the *graceful* path: kernel stop, LSP
/// children, SQLite flush. Whatever the event loop is still waiting on after
/// that, the watchdog terminates the process outright, because an app whose
/// window is gone has no reason to exist.
fn shutdown(app: &tauri::AppHandle) {
    if SHUTTING_DOWN.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return; // re-entrant: ExitRequested fires from our own exit() call
    }
    shell_log("shutdown", "begin");
    if let Some(engine) = app.try_state::<engine::Engine>() {
        engine.release();
    }
    app.exit(0);
    std::thread::spawn(|| {
        // Long enough for the graceful path (the engine flushes and exits on
        // EOF), short enough that nobody clicks X twice wondering what happened.
        std::thread::sleep(std::time::Duration::from_secs(3));
        shell_log("shutdown", "forcing exit");
        std::process::exit(0);
    });
}

/// Guards `shutdown` against re-entry: `app.exit()` emits `ExitRequested`, which
/// arrives back here while the first call is still running.
static SHUTTING_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Suppress the browsing behaviours a packaged desktop app should not expose.
///
/// `tauri.conf.json` covers window chrome (`decorations`, `devtools`, zoom
/// hotkeys, background colour); these settings are only reachable through the
/// WebView2 COM API, so they are applied to the main window here:
///
///   - default context menu (right-click) — the shell draws its own
///   - DevTools / browser accelerators (F5, Ctrl+R, Ctrl+P, Alt+←, …)
///   - Ctrl+wheel zoom and the status bar
///   - script dialogs (`alert`/`confirm`/`prompt`) at the engine level
///
/// Everything is best-effort: a setting that fails must never stop the app.
#[cfg(windows)]
fn harden_webview(win: &tauri::Webview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let _ = win.with_webview(|webview| {
        let controller = webview.controller();
        unsafe {
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            let Ok(settings) = core.Settings() else {
                return;
            };
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
            let _ = settings.SetAreDevToolsEnabled(false);
            let _ = settings.SetIsZoomControlEnabled(false);
            let _ = settings.SetIsStatusBarEnabled(false);
            let _ = settings.SetAreDefaultScriptDialogsEnabled(false);
            // Browser accelerator keys (F5, Ctrl+R, Ctrl+P, Alt+← …) live on the
            // Settings3 extension interface, not the base settings object.
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    });
}
