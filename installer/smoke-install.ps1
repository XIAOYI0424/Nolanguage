# Silent install → start → /health → uninstall, the way CI does it.
#
# This lived inline in `.github/workflows/ci.yml`, which meant the only place it
# could ever run was a GitHub runner — so "the installer works" was a claim
# nobody could check locally. As a file it is one command either way:
#
#   npm run ci:install-smoke
#
# It installs into a throwaway directory and removes it again, but it does touch
# the machine while it runs (registry entries, Start Menu shortcuts), so it is
# not part of the default suite.

$ErrorActionPreference = 'Stop'

$setup = 'installer/Nolanguage-Setup.exe'
if (-not (Test-Path $setup)) { throw "installer missing: $setup (run npm run build:setup)" }

# `/D` overrides InstallDirRegKey, so the target does not depend on whatever a
# previous install on this machine remembered. It must be the last argument.
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$dir = Join-Path $temp 'nl-smoke'
if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
Start-Process -FilePath $setup -ArgumentList '/S', "/D=$dir" -Wait

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
Write-Host "health: status=$($health.status) version=$($health.appVersion) signature=$($health.build.sha256.Substring(0,12))"

Get-Process Nolanguage -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process -FilePath (Join-Path $dir 'uninstall.exe') -ArgumentList '/S' -Wait
Start-Sleep -Seconds 2
if (Test-Path (Join-Path $dir 'Nolanguage.exe')) { throw 'uninstall left the executable behind' }

Write-Host 'install smoke: ok'
