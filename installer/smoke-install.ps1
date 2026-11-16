# Silent install → start → /health → uninstall, the way CI does it.
#
# This lived inline in `.github/workflows/ci.yml`, which meant the only place it
# could ever run was a GitHub runner — so "the installer works" was a claim
# nobody could check locally. As a file it is one command either way:
#
#   npm run ci:install-smoke
#
# Two things it does deliberately, both learned by running it:
#
# 1. **It runs a copy of the installer, from the temp directory.** Executed
#    directly out of the checkout, NSIS aborts before its first section (exit
#    code 2, nothing written) on at least one machine — a 39 KB minimal NSIS
#    installer reproduces it, so it is the environment, not this script or the
#    payload. Copying to `%TEMP%` first makes the smoke independent of where the
#    repository lives.
#
# 2. **It puts back whatever install was already there.** The installer writes
#    one HKCU uninstall key, one receipt and a Start Menu folder, so a smoke run
#    on a machine with a real install would otherwise delete that install's
#    registration and leave the real directory orphaned. Snapshot before,
#    restore in `finally` — all three, because the Start Menu was the one that
#    got forgotten and every run left a shortcut folder behind.
#
# While it runs it does touch the machine (registry, Start Menu, a temp install
# directory), so it is not part of the default suite.

$ErrorActionPreference = 'Stop'

$setup = 'installer/Nolanguage-Setup.exe'
if (-not (Test-Path $setup)) { throw "installer missing: $setup (run npm run build:setup)" }

$regKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nolanguage'
$receipt = Join-Path $env:LOCALAPPDATA 'Nolanguage\install-receipt.json'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nolanguage'

# ---- snapshot whatever is already installed ----
$hadKey = Test-Path $regKey
$savedValues = @{}
if ($hadKey) {
  $props = Get-ItemProperty $regKey
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Name -like 'PS*') { continue }
    $savedValues[$p.Name] = $p.Value
  }
}
$hadReceipt = Test-Path $receipt
$savedReceipt = if ($hadReceipt) { Get-Content $receipt -Raw } else { $null }

# The installer creates four Start Menu shortcuts and the uninstaller deletes
# them, but a run that dies between the two (or an uninstaller that cannot
# remove a locked .lnk) leaves the folder behind. Snapshotting it means a smoke
# run can never change what the user sees in the Start Menu — before this, the
# folder survived every run and ended up holding an "Uninstall Nolanguage"
# shortcut pointing at a directory that no longer existed.
$hadStartMenu = Test-Path $startMenu
$savedStartMenu = $null
if ($hadStartMenu) {
  $savedStartMenu = Join-Path ([System.IO.Path]::GetTempPath()) ("nl-smoke-startmenu-" + [guid]::NewGuid().ToString('N'))
  try {
    Copy-Item -LiteralPath $startMenu -Destination $savedStartMenu -Recurse -Force -ErrorAction Stop
  } catch {
    # A restricted shell (or a policy that denies writes under the Start Menu)
    # must not turn "cannot snapshot" into "installer is broken". Skip the
    # restore and say so.
    Write-Warning "could not snapshot the Start Menu folder: $($_.Exception.Message)"
    $savedStartMenu = $null
  }
}

# ---- run a copy, not the checkout ----
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$dir = Join-Path $temp 'nl-smoke'
$run = Join-Path $temp 'nl-smoke-setup.exe'
Copy-Item $setup $run -Force

try {
  if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }

  # `/D` overrides InstallDirRegKey, so the target does not depend on whatever a
  # previous install remembered. It must be the last argument.
  $p = Start-Process -FilePath $run -ArgumentList '/S', "/D=$dir" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "installer exited with $($p.ExitCode)" }

  $exe = Join-Path $dir 'Nolanguage.exe'
  if (-not (Test-Path $exe)) { throw "install did not produce $exe" }

  # Consoleless build: no window, so probe the HTTP surface instead.
  Start-Process -FilePath $exe -ArgumentList '--no-open'

  $health = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $health = Invoke-RestMethod 'http://127.0.0.1:7310/health' -TimeoutSec 2
      if ($health.status -eq 'ok') { break }
    } catch { }
  }
  if (-not $health -or $health.status -ne 'ok') { throw 'health check failed' }

  # The payload's `build` block is { appVersion, pid, exePath, exeSize, startedAt }.
  # It has no `sha256` — the CI version of this line read `build.sha256` and threw
  # "You cannot call a method on a null-valued expression" the first time it was
  # ever executed. Assert on what is really there.
  if (-not $health.build -or -not $health.build.appVersion) { throw 'health payload has no build.appVersion' }
  Write-Host "health: status=$($health.status) version=$($health.build.appVersion) pid=$($health.build.pid) exeSize=$($health.build.exeSize)"

  Get-Process Nolanguage -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Start-Process -FilePath (Join-Path $dir 'uninstall.exe') -ArgumentList '/S' -Wait
  Start-Sleep -Seconds 2
  if (Test-Path (Join-Path $dir 'Nolanguage.exe')) { throw 'uninstall left the executable behind' }
}
finally {
  # ---- put the previous install back ----
  if ($hadKey) {
    if (-not (Test-Path $regKey)) { New-Item -Path $regKey -Force | Out-Null }
    foreach ($name in $savedValues.Keys) {
      New-ItemProperty -Path $regKey -Name $name -Value $savedValues[$name] -PropertyType ($(if ($savedValues[$name] -is [int]) { 'DWord' } else { 'String' })) -Force | Out-Null
    }
  } elseif (Test-Path $regKey) {
    Remove-Item -Path $regKey -Recurse -Force
  }
  if ($hadReceipt) {
    $dirOf = Split-Path $receipt -Parent
    if (-not (Test-Path $dirOf)) { New-Item -ItemType Directory -Path $dirOf -Force | Out-Null }
    Set-Content -Path $receipt -Value $savedReceipt -NoNewline -Encoding utf8
  } elseif (Test-Path $receipt) {
    Remove-Item -Path $receipt -Force
  }
  # Start Menu: put back exactly what was there, or remove what we created.
  #
  # Best effort on purpose — a restore that cannot write must warn, never throw:
  # the `finally` block must not replace the real verdict with a cleanup error.
  #
  # But one attempt is not enough, and both reasons are structural rather than
  # bad luck:
  #
  #   - a silent NSIS uninstaller copies itself to %TEMP% and returns, so `-Wait`
  #     on the stub is not the end of the uninstall. The real one keeps deleting
  #     the Start Menu folder for a moment afterwards.
  #   - Windows holds a .lnk it has just written for a few hundred milliseconds.
  #
  # Losing that race is not cosmetic: the uninstaller deletes *every* shortcut in
  # the folder, so a failed restore leaves the user with the installer's
  # shortcuts pointing at a %TEMP% directory that no longer exists. That is
  # exactly what happened on the first machine this ran on — hence retry, and
  # verify the result instead of assuming the copy worked.
  $restoreStartMenu = {
    if ($savedStartMenu) {
      if (Test-Path $startMenu) { Remove-Item -LiteralPath $startMenu -Recurse -Force -ErrorAction SilentlyContinue }
      # Copy the *contents*, not the folder: `Copy-Item <dir> -Destination <dir>`
      # nests the source inside the destination when the destination survives the
      # Remove-Item above (a locked .lnk is enough), which produced
      # `Nolanguage\nl-smoke-startmenu-<guid>\Nolanguage.lnk`.
      New-Item -ItemType Directory -Path $startMenu -Force -ErrorAction Stop | Out-Null
      Copy-Item -Path (Join-Path $savedStartMenu '*') -Destination $startMenu -Recurse -Force -ErrorAction Stop
      $want = @(Get-ChildItem -LiteralPath $savedStartMenu -File).Count
      $got = @(Get-ChildItem -LiteralPath $startMenu -File).Count
      if ($got -lt $want) { throw "only $got of $want shortcut(s) came back" }
    } elseif (-not $hadStartMenu -and (Test-Path $startMenu)) {
      Remove-Item -LiteralPath $startMenu -Recurse -Force -ErrorAction Stop
      if (Test-Path $startMenu) { throw 'the Start Menu folder survived removal' }
    }
  }
  $restoreError = $null
  for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
      & $restoreStartMenu
      $restoreError = $null
      break
    } catch {
      $restoreError = $_.Exception.Message
      Start-Sleep -Milliseconds 400
    }
  }
  if ($restoreError) {
    Write-Warning "could not restore the Start Menu folder after 12 attempts: $restoreError"
  }
  if ($savedStartMenu) { Remove-Item -LiteralPath $savedStartMenu -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -Path $run -Force -ErrorAction SilentlyContinue
  if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host 'install smoke: ok'
