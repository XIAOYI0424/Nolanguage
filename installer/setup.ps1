# ===========================================================================
# Nolanguage — per-user installer (no third-party toolchain required).
#
#   powershell -ExecutionPolicy Bypass -File installer/setup.ps1
#
# Copies the standalone Nolanguage.exe found next to this script into
#   $LOCALAPPDATA\Programs\Nolanguage
# and creates two Start Menu shortcuts:
#   Nolanguage (Web)     -> Nolanguage.exe --open-browser   (default browser)
#   Nolanguage (Desktop) -> Nolanguage.exe                  (native WebView window)
# plus a Desktop shortcut and an Uninstall entry.
#
# If `uninstaller.exe` sits next to this script it is installed as
# `<installDir>\uninstall.exe` and the registry points at it — a normal Windows
# uninstaller. Without it, a PowerShell `uninstall.ps1` is generated as a
# fallback so nothing regresses.
#
# To build a self-contained distribution folder, copy this script together with
# the rebuilt Nolanguage.exe (and, ideally, uninstaller.exe) into one folder.
# ===========================================================================

[CmdletBinding()]
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Nolanguage",
  [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$SourceExe = Join-Path $ScriptDir 'Nolanguage.exe'
$SourceUninst = Join-Path $ScriptDir 'uninstaller.exe'
if (-not (Test-Path $SourceUninst)) {
  $alt = Join-Path $ScriptDir 'payload\uninstaller.exe'
  if (Test-Path $alt) { $SourceUninst = $alt }
}

if (-not (Test-Path $SourceExe)) {
  Write-Error "Nolanguage.exe not found next to this script ($SourceExe).`nRebuild it with 'npm run build:exe' (or run installer\build-nsis.bat) and copy dist\Nolanguage.exe next to setup.ps1 first."
  exit 2
}

Write-Host "Installing Nolanguage to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $SourceExe (Join-Path $InstallDir 'Nolanguage.exe')

# `nlg` (the bundled CLI shim) and the receipt-based PATH helper travel with the
# app; without them a fresh install has no command-line entry point at all.
foreach ($extra in 'nlg.cmd', 'path-tool.ps1') {
  $src = Join-Path $ScriptDir $extra
  if (Test-Path $src) { Copy-Item -Force $src (Join-Path $InstallDir $extra) }
}

$appExe = Join-Path $InstallDir 'Nolanguage.exe'
$ws = New-Object -ComObject WScript.Shell

function New-Shortcut($path, $args_, $target = $appExe) {
  $sc = $ws.CreateShortcut($path)
  $sc.TargetPath = $target
  $sc.Arguments = $args_
  $sc.WorkingDirectory = $InstallDir
  $sc.Description = 'Nolanguage — unified multi-language workspace'
  $sc.Save()
}

# --- Start Menu: Web + Desktop ---
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nolanguage'
New-Item -ItemType Directory -Force -Path $sm | Out-Null
New-Shortcut (Join-Path $sm 'Nolanguage (Web).lnk') '--open-browser'
New-Shortcut (Join-Path $sm 'Nolanguage (Desktop).lnk') ''

# --- Desktop shortcut (Desktop = native window) ---
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nolanguage.lnk') ''

# --- Uninstaller: native exe when available, PowerShell fallback otherwise ---
$hasNative = Test-Path $SourceUninst
if ($hasNative) {
  $uninstExe = Join-Path $InstallDir 'uninstall.exe'
  Copy-Item -Force $SourceUninst $uninstExe
  $uninstCmd = '"' + $uninstExe + '"'
  $unsc = $ws.CreateShortcut((Join-Path $sm 'Uninstall Nolanguage.lnk'))
  $unsc.TargetPath = $uninstExe
  $unsc.WorkingDirectory = $InstallDir
  $unsc.Save()
} else {
  $uninst = Join-Path $InstallDir 'uninstall.ps1'
  $uninstContent = @'
$proc = Get-Process -Name 'Nolanguage' -ErrorAction SilentlyContinue
if ($proc) {
  & taskkill.exe /IM 'Nolanguage.exe' /F /T | Out-Null
  & taskkill.exe /IM 'msedgewebview2.exe' /F | Out-Null
  Start-Sleep -Seconds 3
}
$InstallDir = '{{INSTALLDIR}}'
# Restore PATH from the install receipt before the helper is deleted with the
# directory below. path-tool.ps1 drops its own receipt afterwards.
$pathTool = Join-Path $InstallDir 'path-tool.ps1'
if (Test-Path $pathTool) {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $pathTool -Action remove -InstallDir $InstallDir | Out-Null
}
$attempt = 0
while ((Test-Path $InstallDir) -and ($attempt -lt 5)) {
  Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) { Start-Sleep -Seconds 1 }
  $attempt++
}
if (Test-Path $InstallDir) {
  Write-Host "note: some files under $InstallDir are still held by the WebView2 runtime; they will be removed when it releases them (or on next restart). Uninstall is otherwise complete."
}
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nolanguage'
if (Test-Path $sm) { Remove-Item -Recurse -Force $sm }
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nolanguage.lnk'
if (Test-Path $desktop) { Remove-Item -Force $desktop }
$uninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nolanguage'
if (Test-Path $uninstKey) { Remove-Item -Recurse -Force $uninstKey }
Write-Host 'Nolanguage uninstalled.'
'@
  $uninstContent = $uninstContent.Replace('{{INSTALLDIR}}', $InstallDir)
  Set-Content -Path $uninst -Value $uninstContent -Encoding UTF8
  $uninstCmd = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$uninst`""
  $unsc = $ws.CreateShortcut((Join-Path $sm 'Uninstall Nolanguage.lnk'))
  $unsc.TargetPath = 'powershell.exe'
  $unsc.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$uninst`""
  $unsc.WorkingDirectory = $InstallDir
  $unsc.Save()
}

# --- PATH: add the install dir so `nlg` resolves, with a receipt for undo ---
$pathTool = Join-Path $InstallDir 'path-tool.ps1'
if ($NoPath) {
  Write-Host "Skipping PATH (nlg stays at $(Join-Path $InstallDir 'nlg.cmd'))"
} elseif (Test-Path $pathTool) {
  Write-Host 'Adding nlg to the user PATH (recorded in a receipt for exact restore)'
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $pathTool -Action add -InstallDir $InstallDir | Out-Null
} else {
  Write-Host 'path-tool.ps1 not found next to setup.ps1; PATH left unchanged'
}

# --- Registry uninstall entry ---
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nolanguage'
New-Item -Force -Path $key | Out-Null
Set-ItemProperty -Path $key -Name 'DisplayName' -Value 'Nolanguage'
Set-ItemProperty -Path $key -Name 'UninstallString' -Value $uninstCmd
Set-ItemProperty -Path $key -Name 'QuietUninstallString' -Value $uninstCmd
Set-ItemProperty -Path $key -Name 'DisplayIcon' -Value ('"' + $appExe + '"')
Set-ItemProperty -Path $key -Name 'DisplayVersion' -Value '0.7.11'
Set-ItemProperty -Path $key -Name 'Publisher' -Value 'Nolanguage'
Set-ItemProperty -Path $key -Name 'InstallLocation' -Value $InstallDir
Set-ItemProperty -Path $key -Name 'EstimatedSize' -Value 90000

Write-Host "Done. Launch from the Start Menu: 'Nolanguage (Web)' or 'Nolanguage (Desktop)'."
