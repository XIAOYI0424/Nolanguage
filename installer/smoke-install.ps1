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
  #
  # A dedicated port, because the default one is where the *user's* editor lives.
  # Probing 7310 while a real install is running made this smoke report "ok" for a
  # process it had not started, and then `Get-Process Nolanguage | Stop-Process`
  # below killed that editor. The port is the cheapest way to make the assertion
  # about the thing this script installed.
  $port = 7391
  $env:PANEL_PORT = "$port"
  # A home of its own. Sharing the user's `~/.nolanguage` meant this smoke wrote
  # into their plugin registry and run-config store — a test that mutates the
  # thing it is testing cannot be run casually, and it is not a cold install
  # either. Under `$dir` so the uninstall step removes it too.
  $env:NOLANGUAGE_HOME = (Join-Path $dir 'home-smoke')
  Start-Process -FilePath $exe -ArgumentList '--no-open'

  $health = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2
      if ($health.status -eq 'ok') { break }
    } catch { }
  }
  if (-not $health -or $health.status -ne 'ok') { throw "health check failed on port $port" }

  # And the process answering must be the one under $dir. Without this, any
  # leftover listener on that port turns a broken install into a green run.
  $served = [string]$health.build.exePath
  $expected = (Join-Path $dir 'Nolanguage.exe')
  if (-not $served -or [System.IO.Path]::GetFullPath($served) -ne [System.IO.Path]::GetFullPath($expected)) {
    throw "port $port is answered by '$served', not by the smoke install '$expected'"
  }

  # The payload's `build` block is { appVersion, pid, exePath, exeSize, startedAt }.
  # It has no `sha256` — the CI version of this line read `build.sha256` and threw
  # "You cannot call a method on a null-valued expression" the first time it was
  # ever executed. Assert on what is really there.
  if (-not $health.build -or -not $health.build.appVersion) { throw 'health payload has no build.appVersion' }
  Write-Host "health: status=$($health.status) version=$($health.build.appVersion) pid=$($health.build.pid) exeSize=$($health.build.exeSize)"

  # By pid, from the health payload: killing every Nolanguage process is how the
  # first version of this script closed the user's editor along with its own.
  if ($health.build.pid) { Stop-Process -Id $health.build.pid -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  # The uninstaller is not scoped to `$dir`: its script runs
  # `taskkill /IM Nolanguage.exe /F /T` and deletes the Start Menu folder, so on a
  # machine with a real install it closes the user's editor and rewrites their
  # shortcuts. Running it there is not a test, it is an attack on the host. On CI
  # (no install) it runs; here it says why it did not.
  if ($hadKey -or $hadReceipt) {
    Write-Host 'uninstall: skipped - a real install is present, and the uninstaller stops every Nolanguage process and rewrites the Start Menu'
  } else {
    Start-Process -FilePath (Join-Path $dir 'uninstall.exe') -ArgumentList '/S' -Wait
    Start-Sleep -Seconds 2
    if (Test-Path (Join-Path $dir 'Nolanguage.exe')) { throw 'uninstall left the executable behind' }
  }
}
finally {
  # ---- undo what the install did to the environment ----
  #
  # The installer appends `$dir` to the user PATH and writes a receipt for it.
  # When the uninstall phase runs, the uninstaller reverses that; when it is
  # skipped (a real install is present), nothing does — and the machine is left
  # with a PATH entry pointing at a %TEMP% directory this script is about to
  # delete. So the one environmental change is undone here, with the same helper
  # the uninstaller would have used. With the receipt still in place it restores
  # the exact previous value; without one it removes only that token.
  $pathTool = Join-Path $dir 'path-tool.ps1'
  if (Test-Path $pathTool) {
    try {
      & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $pathTool -Action remove -InstallDir $dir | Out-Null
    } catch {
      Write-Warning "could not undo the PATH entry: $($_.Exception.Message)"
    }
  }

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
  # Per file, never by deleting the folder.
  #
  # The folder-level version (`Remove-Item -Recurse`, then copy everything back)
  # failed on this machine with "access denied" on one .lnk: Explorer or the Start
  # Menu host holds a shortcut for a moment, Remove-Item is best-effort with
  # -ErrorAction SilentlyContinue, and the copy then runs into the file that
  # survived. The result was three shortcuts pointing at `%TEMP%\nl-smoke` — the
  # user's real ones gone, replaced by dead links to a directory the script
  # deletes. Overwriting each file in place is the only version that cannot lose
  # the originals: a locked target is retried, and a rename is tried before giving
  # up, because Windows lets you rename a file it will not let you overwrite.
  $restoreStartMenu = {
    if ($savedStartMenu) {
      New-Item -ItemType Directory -Path $startMenu -Force -ErrorAction SilentlyContinue | Out-Null
      foreach ($src in @(Get-ChildItem -LiteralPath $savedStartMenu -File)) {
        $dst = Join-Path $startMenu $src.Name
        $done = $false
        for ($try = 0; $try -lt 8 -and -not $done; $try++) {
          try {
            Copy-Item -LiteralPath $src.FullName -Destination $dst -Force -ErrorAction Stop
            $done = $true
          } catch {
            # A surviving, locked file: move it aside, then write.
            try {
              $aside = "$dst.stale"
              if (Test-Path $aside) { Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue }
              Move-Item -LiteralPath $dst -Destination $aside -Force -ErrorAction Stop
              Copy-Item -LiteralPath $src.FullName -Destination $dst -Force -ErrorAction Stop
              Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue
              $done = $true
            } catch {
              Start-Sleep -Milliseconds 400
            }
          }
        }
        if (-not $done) { throw "could not restore $($src.Name)" }
      }
      # Anything the installer added that the user did not have.
      $keep = @(Get-ChildItem -LiteralPath $savedStartMenu -File | ForEach-Object { $_.Name })
      foreach ($extra in @(Get-ChildItem -LiteralPath $startMenu -File)) {
        if ($keep -notcontains $extra.Name) {
          Remove-Item -LiteralPath $extra.FullName -Force -ErrorAction SilentlyContinue
        }
      }
    } elseif (-not $hadStartMenu -and (Test-Path $startMenu)) {
      Remove-Item -LiteralPath $startMenu -Recurse -Force -ErrorAction SilentlyContinue
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
