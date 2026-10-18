//! Nolanguage native uninstaller.
//!
//! Delivered next to the app as `<installDir>\uninstall.exe` and referenced by
//! the `UninstallString` registry value, so "Settings → Apps" and a double-click
//! both run a normal Windows uninstaller instead of a PowerShell script.
//!
//! # Two-phase self-delete
//!
//! Windows cannot delete an executable that is currently running, and the
//! uninstaller lives *inside* the directory it must remove. Phase 1 copies
//! itself to `%TEMP%\nl-uninstall-<pid>\uninstall.exe`, spawns phase 2 there
//! with the original install directory, and exits. Phase 2 then kills the app,
//! deletes the install directory, and schedules its own temp copy for cleanup.
//!
//! Zero third-party crates: every privileged action is an OS command
//! (`taskkill`, `reg`) or the standard library, so this builds offline and stays
//! tiny.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// `CREATE_NO_WINDOW`: never flash a console for the helper processes.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const APP_EXE: &str = "Nolanguage.exe";
const WEBVIEW_HOST: &str = "msedgewebview2.exe";
const REG_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nolanguage";

fn main() {
    let args: Vec<String> = env::args().collect();

    // ---------------------------------------------------------------- phase 2
    if let Some(pos) = args.iter().position(|a| a == "--from-temp") {
        let dir = args.get(pos + 1).map(PathBuf::from);
        std::process::exit(match dir {
            Some(d) => run_uninstall(&d),
            None => 2,
        });
    }

    // ---------------------------------------------------------------- phase 1
    let exe = match env::current_exe() {
        Ok(p) => p,
        Err(_) => std::process::exit(1),
    };
    let install_dir = match exe.parent() {
        Some(p) => p.to_path_buf(),
        None => std::process::exit(1),
    };

    // Copy ourselves outside the target directory, then relaunch from there.
    let temp = env::temp_dir().join(format!("nl-uninstall-{}", std::process::id()));
    let temp_exe = temp.join("uninstall.exe");
    let copied = fs::create_dir_all(&temp).is_ok() && fs::copy(&exe, &temp_exe).is_ok();
    if !copied {
        // No temp copy: uninstall in place. The directory delete may then fail
        // on our own exe, but everything else still runs.
        std::process::exit(run_uninstall(&install_dir));
    }

    let mut cmd = Command::new(&temp_exe);
    cmd.arg("--from-temp").arg(&install_dir);
    hide(&mut cmd);
    match cmd.spawn() {
        Ok(_) => std::process::exit(0),
        Err(_) => std::process::exit(run_uninstall(&install_dir)),
    }
}

fn run_uninstall(install_dir: &Path) -> i32 {
    // Let phase 1 (the original uninstall.exe) fully exit first.
    thread::sleep(Duration::from_millis(1200));

    // The app holds its own exe; WebView2 child processes hold the cache.
    kill(APP_EXE);
    kill(WEBVIEW_HOST);
    thread::sleep(Duration::from_secs(2));

    // Restore PATH *before* the directory goes away: the receipt-based helper
    // lives inside it, and it knows the exact value PATH had before install.
    restore_path(install_dir);

    // WebView2's shared `msedge` runtime may still hold cache files; retry so a
    // later release of the handle is picked up without failing the uninstall.
    delete_dir_retry(install_dir, 6);

    cleanup_links_path_registry();
    schedule_temp_cleanup();
    0
}

/// Best-effort `taskkill /IM <name> /F /T` (a missing binary or process is fine).
fn kill(name: &str) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/IM", name, "/F", "/T"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide(&mut cmd);
    let _ = cmd.status();
}

fn delete_dir_retry(dir: &Path, attempts: usize) {
    for _ in 0..attempts {
        if !dir.exists() {
            return;
        }
        let _ = fs::remove_dir_all(dir);
        if !dir.exists() {
            return;
        }
        thread::sleep(Duration::from_secs(1));
    }
}

/// Undo the PATH entry the installer added.
///
/// Preferred path: the shipped `path-tool.ps1`, which restores the exact value
/// recorded in `%LOCALAPPDATA%\Nolanguage\install-receipt.json`. That matters
/// when other installers appended entries after us — replaying our `before`
/// would silently drop them, so the helper only restores verbatim when the tail
/// still matches and otherwise removes just our token.
///
/// Fallback (installs made by older builds, or a missing helper): remove the
/// install directory as a *path token*. Never match substrings — a directory
/// called `Nolanguage-notes` belongs to somebody else.
fn restore_path(install_dir: &Path) {
    let helper = install_dir.join("path-tool.ps1");
    if helper.exists() {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&helper)
        .args(["-Action", "remove", "-InstallDir"])
        .arg(install_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        hide(&mut cmd);
        if cmd.status().map(|s| s.success()).unwrap_or(false) {
            return;
        }
    }

    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$dir = $env:NL_UNINSTALL_DIR
if (-not $dir) { exit 0 }
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($k) {
  try { $kind = $k.GetValueKind('Path') } catch { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $raw = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kept = @($raw -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $dir.TrimEnd('\')) })
  $k.SetValue('Path', ($kept -join ';'), $kind)
  $k.Close()
}
Remove-Item -Force (Join-Path $env:LOCALAPPDATA 'Nolanguage\install-receipt.json')
"#;

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ])
    .env("NL_UNINSTALL_DIR", install_dir)
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    hide(&mut cmd);
    let _ = cmd.status();
}

/// Start Menu folder, desktop shortcut and the uninstall key.
fn cleanup_links_path_registry() {
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nolanguage'
if (Test-Path $sm) { Remove-Item -Recurse -Force $sm }
$dl = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nolanguage.lnk'
if (Test-Path $dl) { Remove-Item -Force $dl }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nolanguage'
if (Test-Path $key) { Remove-Item -Recurse -Force $key }
"#;

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    hide(&mut cmd);
    let _ = cmd.status();

    // A direct `reg delete` as well: it is the canonical cleanup and does not
    // depend on PowerShell being healthy.
    let mut reg = Command::new("reg");
    reg.args(["delete", REG_KEY, "/f"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide(&mut reg);
    let _ = reg.status();
}

/// Delete this process's own temp directory after it exits.
fn schedule_temp_cleanup() {
    if let Some(dir) = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        let script = format!("timeout /t 3 >nul & rmdir /s /q \"{}\"", dir.display());
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/c", &script]).stdout(Stdio::null()).stderr(Stdio::null());
        hide(&mut cmd);
        let _ = cmd.spawn();
    }
}

#[cfg(windows)]
fn hide(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide(_cmd: &mut Command) {}
