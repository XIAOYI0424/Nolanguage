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
#    one HKCU uninstall key and one receipt, so a smoke run on a machine with a
#    real install would otherwise delete that install's registration and leave
#    the real directory orphaned. Snapshot before, restore in `finally`.
#
# It does modify the machine while it runs (registry, Start Menu shortcuts), so
# it is not part of the default suite.

$ErrorActionPreference = 'Stop'

$setup = 'installer/Nolanguage-Setup.exe'
if (-not (Test-Path $setup)) { throw "installer missing: $setup (run npm run build:setup)" }

$regKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nolanguage'
$receipt = Join-Path $env:LOCALAPPDATA 'Nolanguage\install-receipt.json'

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
  Remove-Item -Path $run -Force -ErrorAction SilentlyContinue
  if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host 'install smoke: ok'
