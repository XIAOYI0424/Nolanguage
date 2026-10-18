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
# plus a Desktop shortcut and an Uninstall entry. Optionally adds the install
# directory to the user PATH.
#
# To build a self-contained distribution folder, copy this script together with
# the rebuilt Nolanguage.exe into one folder and ship that folder.
# ===========================================================================

[CmdletBinding()]
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Nolanguage",
  [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$SourceExe = Join-Path $ScriptDir 'Nolanguage.exe'

if (-not (Test-Path $SourceExe)) {
  Write-Error "Nolanguage.exe not found next to this script ($SourceExe).`nRebuild it with 'npm run build:exe' (or run installer\build-nsis.bat) and copy dist\Nolanguage.exe next to setup.ps1 first."
  exit 2
}

Write-Host "Installing Nolanguage to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $SourceExe (Join-Path $InstallDir 'Nolanguage.exe')

$appExe = Join-Path $InstallDir 'Nolanguage.exe'
$ws = New-Object -ComObject WScript.Shell

function New-Shortcut($path, $args_) {
  $sc = $ws.CreateShortcut($path)
  $sc.TargetPath = $appExe
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

# --- Uninstaller (generated next to the app) ---
$uninst = Join-Path $InstallDir 'uninstall.ps1'
$uninstContent = @'
$InstallDir = '{{INSTALLDIR}}'
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nolanguage'
if (Test-Path $sm) { Remove-Item -Recurse -Force $sm }
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nolanguage.lnk'
if (Test-Path $desktop) { Remove-Item -Force $desktop }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -like "*{{INSTALLDIR}}*") {
  $new = ($userPath -split ';' | Where-Object { $_ -and $_ -ne '{{INSTALLDIR}}' }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $new, 'User')
}
Write-Host 'Nolanguage uninstalled.'
'@
$uninstContent = $uninstContent.Replace('{{INSTALLDIR}}', $InstallDir)
Set-Content -Path $uninst -Value $uninstContent -Encoding UTF8

$unsc = $ws.CreateShortcut((Join-Path $sm 'Uninstall Nolanguage.lnk'))
$unsc.TargetPath = 'powershell.exe'
$unsc.Arguments = "-ExecutionPolicy Bypass -File `"$uninst`""
$unsc.WorkingDirectory = $InstallDir
$unsc.Save()

# --- PATH (user) ---
if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$InstallDir*") {
    $new = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    Write-Host "Added $InstallDir to the user PATH (restart terminals to pick it up)."
  }
}

# --- Registry uninstall entry ---
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nolanguage'
New-Item -Force -Path $key | Out-Null
Set-ItemProperty -Path $key -Name 'DisplayName' -Value 'Nolanguage'
Set-ItemProperty -Path $key -Name 'UninstallString' -Value "powershell.exe -ExecutionPolicy Bypass -File `"$uninst`""
Set-ItemProperty -Path $key -Name 'DisplayVersion' -Value '0.6.0'
Set-ItemProperty -Path $key -Name 'Publisher' -Value 'Nolanguage'
Set-ItemProperty -Path $key -Name 'InstallLocation' -Value $InstallDir

Write-Host "Done. Launch from the Start Menu: 'Nolanguage (Web)' or 'Nolanguage (Desktop)'."
