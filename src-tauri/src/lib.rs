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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = webview.window().show();
            }
        })
        .setup(|app| {
            // Spawning here (rather than lazily on the first invoke) means the
            // engine's greeting is already queued by the time the shell is up.
            engine::spawn(app.handle())?;
            #[cfg(windows)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    harden_webview(&window);
                    // The window is created hidden (no white flash). The page
                    // calls show() once fonts/first paint are ready, but this
                    // safety net guarantees it appears even if that never runs.
                    let w = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        let _ = w.show();
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine_send])
        .build(tauri::generate_context!())
        .expect("error while building Nolanguage")
        .run(|app_handle, event| {
            // Closing the window must end the process: the engine sidecar is a
            // child, and a windowless app that keeps running looks like a
            // duplicate launch and leaves the engine orphaned.
            if let RunEvent::ExitRequested { .. } = event {
                app_handle.exit(0);
            }
            if let RunEvent::WindowEvent { event, .. } = &event {
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    app_handle.exit(0);
                }
            }
        });
}

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
fn harden_webview(win: &tauri::WebviewWindow) {
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
