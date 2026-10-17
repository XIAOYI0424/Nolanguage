//! Application wiring.
//!
//! The window loads the bundled shell (`frontend/dist/index.html`, produced by
//! `scripts/build-frontend.mjs` from the very same `renderPyCharmHtml()` the dev
//! server returns), and the engine sidecar is started once the app is ready so
//! the first message it sends is already on the wire when the shell boots.

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
        .setup(|app| {
            // Spawning here (rather than lazily on the first invoke) means the
            // engine's greeting is already queued by the time the shell is up.
            engine::spawn(app.handle())?;
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
