# ===========================================================================
# Install Nolanguage from this checkout — one command, and it verifies itself.
#
#   npm run install:app
#   npm run install:app -- -Dir D:\Nolanguage
#   npm run install:app -- -DryRun
#
# Why this exists: running `installer\Nolanguage-Setup.exe` **from inside the
# repository** is unreliable on at least one machine. The same binary copied to
# `%TEMP%`, to `D:\`, or to the parent directory installs in one to three
# seconds; from the checkout it can sit for ninety seconds and write nothing.
# A 39 KB minimal NSIS installer reproduces it, so it is the environment, not
# the payload — `smoke-install.ps1` has carried the same note for months and
# works around it the same way.
#
# That leaves a rule nobody can see ("don't double-click it in the repo"), which
# is exactly the kind of rule that gets forgotten. So this script encodes it:
# copy to a temp directory, install from there, then prove the result by asking
# the installed exe for /health.
#
# What it does NOT do: decide whether you want the upgrade. It installs the
# build that is currently in `installer\`, over whatever is at the target.
# ===========================================================================
[CmdletBinding()]
param(
  # Target directory. Defaults to the existing install (from the uninstall
  # registry key), then to the per-user default the installer itself uses.
  [string]$Dir,
  # Port for the post-install health probe. Deliberately not 7310: a running
  # instance would answer for us, and we would verify nothing.
  [int]$Port = 7391,
  # An unsigned 93 MB payload can take a while to land through a scanner.
  [int]$TimeoutSec = 240,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$setup = Join-Path $root 'installer\Nolanguage-Setup.exe'
if (-not (Test-Path $setup)) {
  throw "installer missing: $setup (run: npm run build:setup)"
}

$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nolanguage'

function Resolve-TargetDir {
  if ($Dir) { return $Dir.TrimEnd('\') }
  if (Test-Path $regKey) {
    $existing = (Get-ItemProperty $regKey -ErrorAction SilentlyContinue).InstallLocation
    if ($existing) { return ([string]$existing).TrimEnd('\') }
  }
  return (Join-Path $env:LOCALAPPDATA 'Programs\Nolanguage')
}

$target = Resolve-TargetDir
$payload = Join-Path $target 'Nolanguage.exe'

if ($DryRun) {
  "installer : $setup"
  "target    : $target"
  "payload   : $payload"
  "probe port: $Port"
  "timeout   : ${TimeoutSec}s"
  exit 0
}

# ---- 1. run a copy, never the checkout ------------------------------------
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$work = Join-Path $tempRoot ("nl-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$run = Join-Path $work 'Setup.exe'
Copy-Item -LiteralPath $setup -Destination $run -Force

$startedAt = Get-Date
try {
  # ---- 2. install ---------------------------------------------------------
  Write-Host "Installing to $target ..."
  # `/D` must be the last argument and unquoted — NSIS parses the tail itself.
  $proc = Start-Process -FilePath $run -ArgumentList '/S', "/D=$target" -Wait -PassThru -ErrorAction Stop
  if ($proc.ExitCode -ne 0) { throw "installer exited with $($proc.ExitCode)" }

  # The installer returns before every byte is flushed on a slow disk; wait for
  # a plausible payload rather than a zero-byte placeholder.
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path $payload) -and ((Get-Item $payload).Length -gt 10MB)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path $payload)) { throw "no payload at $payload after $($TimeoutSec)s" }
  $sizeMb = [Math]::Round((Get-Item $payload).Length / 1MB, 1)
  if ($sizeMb -lt 10) { throw "payload looks truncated: ${sizeMb} MB at $payload" }
  $elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
  Write-Host "  payload: ${sizeMb} MB in ${elapsed}s"

  # ---- 3. the install is registered --------------------------------------
  if (-not (Test-Path $regKey)) { throw "no uninstall entry at $regKey" }
  $reg = Get-ItemProperty $regKey
  if (([string]$reg.InstallLocation).TrimEnd('\') -ne $target) {
    throw "registry points at '$($reg.InstallLocation)', not '$target'"
  }
  Write-Host "  registered: $($reg.DisplayName) $($reg.DisplayVersion)"

  $uninstaller = Join-Path $target 'uninstall.exe'
  if (-not (Test-Path $uninstaller)) { throw "no uninstaller at $uninstaller" }

  $menu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Nolanguage"
  $shortcut = Join-Path $menu 'Nolanguage.lnk'
  if (-not (Test-Path $shortcut)) { throw "no Start Menu shortcut at $shortcut" }
  Write-Host "  shortcuts: $menu"

  # ---- 4. it actually starts and serves ---------------------------------
  # This is the part a file-existence check cannot tell you: the payload can be
  # present and the app still fail before it binds a port.
  $previousPort = $env:PANEL_PORT
  $env:PANEL_PORT = [string]$Port
  $app = $null
  try {
    $app = Start-Process -FilePath $payload -ArgumentList '--no-open' -PassThru
    $health = $null
    $healthDeadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $healthDeadline) {
      Start-Sleep -Milliseconds 700
      try {
        $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3
        if ($health.status -eq 'ok') { break }
      } catch { }
    }
    if (-not $health -or $health.status -ne 'ok') {
      throw "the installed app did not answer /health on port $Port"
    }
    Write-Host "  health: status=$($health.status) version=$($health.build.appVersion) pid=$($health.build.pid)"
  } finally {
    if ($app -and -not $app.HasExited) {
      Get-Process -Id $app.Id -ErrorAction SilentlyContinue | Stop-Process -Force
    }
    # Children (LSP, extension host) are separate processes; the app normally
    # takes them down with it, but a force-stop can leave them behind.
    Get-Process -Name Nolanguage -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $payload } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    $env:PANEL_PORT = $previousPort
  }

  Write-Host ''
  Write-Host "installed: $payload"
  Write-Host "launch   : Start Menu -> Nolanguage, or double-click $payload"
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
