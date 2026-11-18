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

Get-Process -Name 'Nolanguage' | ForEach-Object {
  $path = $null
  try { $path = $_.Path } catch { }
  if ($path -and ([System.IO.Path]::GetFullPath($path) -eq $target)) {
    Stop-Process -Id $_.Id -Force
  }
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
exit 1
