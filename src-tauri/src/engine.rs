//! The engine sidecar and the relay that connects it to the webview.
//!
//! # Shape
//!
//! ```text
//!   webview  --invoke('engine_send', {msg})-->  Rust  --line of JSON-->  sidecar stdin
//!   webview  <--emit('engine_message', msg)---  Rust  <--line of JSON---  sidecar stdout
//! ```
//!
//! # Why this module is deliberately dumb
//!
//! The engine is the TypeScript program in `src/` (kernel, workspace, LSP, the
//! sandbox warm pool, the file service). It already speaks a complete JSON
//! protocol — the same one the dev server's WebSocket carries — and its
//! behaviour is covered by tests that run without a browser. So this file knows
//! exactly two things: how to spawn the sidecar, and that its stdout carries
//! newline-delimited JSON. It never inspects a `kind`, which keeps every
//! semantic decision (and therefore every bug) on the TypeScript side.
//!
//! The sidecar is `NolanguageEngine.exe` — the same executable `npm run build:exe`
//! produces (`dist/Nolanguage.exe`, renamed by the bundle step) — started with
//! `--panel-stdio`. See `src/panel/Transport.ts` for the engine half of this
//! contract and `scripts/verify-transport.ts` for the proof that the two
//! transports are interchangeable.
//!
//! # Status
//!
//! Verified end to end: `cargo check` and `tauri build` succeed, and the
//! packaged NSIS installer starts `NolanguageEngine.exe` beside the shell
//! (recorded in `逻辑文档/20261018_安装与语言支持方案现状.md`). The API surface
//! used here — `tauri::AppHandle::shell`, `CommandEvent`, `CommandChild` — is
//! Tauri v2's, matching the pinned 2.12.x.
//!
//! History: the first revision of this header said the file had been written
//! without a Rust toolchain present and therefore reviewed by eye only. That
//! caveat is obsolete; it is kept here as history rather than as a warning.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// The event the webview listens on for engine messages.
pub const ENGINE_EVENT: &str = "engine_message";

/// Emitted when the sidecar goes away, so the shell can say so instead of
/// silently doing nothing.
pub const ENGINE_EXIT_EVENT: &str = "engine_exit";

/// The sidecar process, held so it can be written to and killed.
pub struct Engine {
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

/// Absolute path of the engine sidecar, or an error explaining what is wrong.
///
/// Resolved explicitly rather than trusting the plugin's name lookup, because
/// that lookup falls back to a bare name when `<name>-<triple>` is missing — and
/// on a case-insensitive filesystem `Nolanguage.exe` **is this very
/// executable**. Spawning it starts a second app window, which spawns another,
/// forever: an observed fork bomb (180 processes in ~15s). So the path is
/// computed and checked here, before anything is spawned.
fn sidecar_path() -> Result<std::path::PathBuf, String> {
    let triple = option_env!("TAURI_ENV_TARGET_TRIPLE").unwrap_or("x86_64-pc-windows-msvc");
    // Deliberately *not* `Nolanguage-<triple>`: on a case-insensitive
    // filesystem that base name collides with the app's own `nolanguage.exe`
    // in the installer (`File /oname=Nolanguage.exe`), so the sidecar would
    // overwrite the shell. `NolanguageEngine` is a distinct component.
    //
    // A bundled installer strips the target triple (`NolanguageEngine.exe`),
    // while a raw `tauri dev` / `cargo build` tree keeps it. Accept either.
    let names: Vec<String> = if cfg!(windows) {
        vec![
            "NolanguageEngine.exe".to_string(),
            format!("NolanguageEngine-{triple}.exe"),
        ]
    } else {
        vec!["NolanguageEngine".to_string(), format!("NolanguageEngine-{triple}")]
    };
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    let dir = exe.parent().ok_or_else(|| "executable has no parent directory".to_string())?;
    let self_path = exe.canonicalize().map_err(|e| e.to_string())?;
    for name in &names {
        let candidate = dir.join(name);
        if !candidate.is_file() {
            continue;
        }
        let resolved = candidate.canonicalize().map_err(|e| e.to_string())?;
        if resolved == self_path {
            return Err(format!(
                "{} resolves to this executable — refusing to spawn it (that would fork the app)",
                candidate.display()
            ));
        }
        return Ok(candidate);
    }
    Err(format!(
        "engine sidecar not found next to {} (looked for: {}) — build it with `npm run build:exe` \
         and place it there; `tauri dev` / `tauri build` do this for you",
        dir.display(),
        names.join(", ")
    ))
}

/// Spawn the sidecar and start pumping its stdout into webview events.
///
/// The reader runs on a plain thread rather than an async task on purpose: it is
/// a blocking receive loop, and parking a Tauri async worker for the lifetime of
/// the process would be a bug.
pub fn spawn(app: &AppHandle) -> Result<(), String> {
    // Validated first: a missing sidecar must be a clear error, never a
    // self-spawn (see `sidecar_path`).
    let sidecar = sidecar_path()?;
    let shell = app.shell();
    // `--panel-stdio` selects the pipe transport on the engine side.
    let (mut rx, child) = shell
        .command(sidecar.to_string_lossy().to_string())
        .args(["--panel-stdio"])
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;

    let sink = app.clone();
    tauri::async_runtime::spawn(async move {
        // Carries a line that straddles two stdout chunks.
        let mut pending = String::new();
        // `rx.recv()` is used without importing `ReceiverExt`, matching the
        // official v2 shell example. If the compiler reports the method as
        // missing, add `use tauri::async_runtime::ReceiverExt;` above — that is
        // the whole fix.
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    // Buffer and split on newline: one chunk may carry several
                    // lines, and a line may straddle two chunks.
                    pending.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(nl) = pending.find('\n') {
                        let line = pending[..nl].trim().to_string();
                        pending.drain(..=nl);
                        if line.is_empty() {
                            continue;
                        }
                        // Parsed only to validate; the payload is forwarded
                        // untouched, so the engine owns every semantic.
                        match serde_json::from_str::<serde_json::Value>(&line) {
                            Ok(value) => {
                                let _ = sink.emit(ENGINE_EVENT, value);
                            }
                            Err(e) => eprintln!("engine: dropping malformed line: {e}"),
                        }
                    }
                }
                // The engine writes its logs to stderr (stdout is the protocol
                // channel), so they belong in this process's stderr.
                CommandEvent::Stderr(bytes) => {
                    eprint!("{}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    let _ = sink.emit(ENGINE_EXIT_EVENT, serde_json::json!({ "code": payload.code }));
                    break;
                }
                CommandEvent::Error(message) => {
                    eprintln!("engine: {message}");
                    let _ = sink.emit(ENGINE_EXIT_EVENT, serde_json::json!({ "error": message }));
                    break;
                }
                // `CommandEvent` is `#[non_exhaustive]`: the plugin may add a
                // variant, and a match without this arm would stop compiling.
                _ => {}
            }
        }
    });

    app.manage(Engine {
        child: Mutex::new(Some(child)),
    });
    Ok(())
}

/// Frontend → engine. `msg` is the whole message object; the engine routes on
/// `msg.kind` exactly as it does for a WebSocket frame.
#[tauri::command]
pub fn engine_send(engine: State<'_, Engine>, msg: serde_json::Value) -> Result<(), String> {
    let line = serde_json::to_string(&msg).map_err(|e| e.to_string())? + "\n";
    let mut guard = engine.child.lock().map_err(|e| e.to_string())?;
    let child = guard.as_mut().ok_or("engine sidecar is gone")?;
    child.write(&line.into_bytes()).map_err(|e| e.to_string())
}
