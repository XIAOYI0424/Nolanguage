# Stop the instance this installer is about to overwrite — and only that one.
#
# `taskkill /IM Nolanguage.exe /F /T` kills every Nolanguage on the machine. On a
# normal upgrade that is invisible (there is one), but it also means:
#
#   - installing a copy somewhere else (a smoke test in %TEMP%, a portable
#     install) closes the editor the user has open;
#   - an uninstaller run from a copy takes the real install down with it.
#
# The file being replaced is the only one that has to be unlocked, so the filter
# is the image path, not the process name. `-Wait` on Stop-Process is not enough
# either: Windows unmaps the image a moment later, and the extractor runs in the
# next NSIS statement, so this polls the file until it can be opened for writing.
param(
  [Parameter(Mandatory = $true)][string]$Exe
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not (Test-Path -LiteralPath $Exe)) { exit 0 }
$target = [System.IO.Path]::GetFullPath($Exe)

# What we saw, in the one case where the answer matters. A failed upgrade is the
# only time anyone reads this, and "which process was holding it, and what path
# did it think it had" is the whole question — the installer's own message can
# only say "still locked".
$seen = @()
$unknown = @()
Get-Process -Name 'Nolanguage' | ForEach-Object {
  $path = $null
  try { $path = $_.Path } catch { }
  $seen += "$($_.Id)=$path"
  if ($path -and ([System.IO.Path]::GetFullPath($path) -eq $target)) {
    Stop-Process -Id $_.Id -Force
  } elseif (-not $path) {
    # The path is not readable (the process belongs to another integrity level,
    # or this shell is more restricted than the app). It is still a candidate:
    # remember it for the fallback below rather than pretending it is not there.
    $unknown += $_.Id
  }
}

# Fallback: nothing matched by path, the file is still locked, and there are
# processes whose path we could not read. Refusing to act leaves the upgrade
# permanently blocked by an app the user cannot even see in Task Manager's
# details — so close those, and only those. A process whose path *is* readable
# and differs from ours is never touched: that is the portable copy and the
# install-smoke, which must survive.
function Test-Writable {
  try {
    $f = [System.IO.File]::Open($target, 'Open', 'ReadWrite', 'None')
    $f.Close()
    return $true
  } catch {
    return $false
  }
}
if ($unknown.Count -and -not (Test-Writable)) {
  $seen += "fallback-kill=[$($unknown -join ',')]"
  foreach ($procId in $unknown) { Stop-Process -Id $procId -Force }
}

# Wait for the lock, not for the process: Stop-Process returns before the image is
# unmapped, and Windows can take a few seconds to finish tearing the process down.
# 40 x 300 ms, returning as soon as the file is free instead of always paying it.
#
# Exit 1 only when it is certain: the process is gone and the file still will not
# open for writing. The installer turns exactly that into "close the app and try
# again"; any other outcome (no file, opened fine) is 0.
for ($i = 0; $i -lt 40; $i++) {
  try {
    $fs = [System.IO.File]::Open($target, 'Open', 'ReadWrite', 'None')
    $fs.Close()
    exit 0
  } catch {
    Start-Sleep -Milliseconds 300
  }
}

$diag = Join-Path $env:TEMP 'nl-stop-instance.log'
"$(Get-Date -Format o)  target=$target  seen=[$($seen -join ', ')]" | Out-File -FilePath $diag -Append -Encoding utf8
exit 1
