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

$lastCode = 0
$lastMessage = ''
function Write-StopDiagnostic {
  param([int]$Code, [string]$Message)
  $diag = Join-Path $env:TEMP 'nl-stop-instance.log'
  $clean = ($Message -replace '[\r\n]+', ' ').Trim()
  "$(Get-Date -Format o)  target=$target  hresultLowWord=$Code  message=[$clean]  seen=[$($seen -join ', ')]" | Out-File -FilePath $diag -Append -Encoding utf8
}

# Test whether the exe is locked by a process, or whether this installer simply
# cannot write here. Those are different failures. Low-integrity launchers (the
# process TEMP ends in `Temp\Low`) get ACCESS_DENIED even when no process holds
# the file; claiming "locked" made the old installer wait 12s and then fail in
# the payload extractor with a misleading file-in-use dialog.
function Test-Writable {
  try {
    $f = [System.IO.File]::Open($target, 'Open', 'ReadWrite', 'None')
    $f.Close()
    return $true
  } catch {
    $script:lastCode = $_.Exception.HResult -band 0xffff
    $script:lastMessage = $_.Exception.Message
    return $false
  }
}

if (-not (Test-Writable) -and $lastCode -eq 5) {
  Write-StopDiagnostic -Code $lastCode -Message $lastMessage
  exit 2
}

# The process path was unreadable, but a Nolanguage process is present and the
# target is sharing-locked. Do not guess which same-name process owns this
# install: return the lock verdict immediately and let NSIS use the app's exact
# server.pid. That PID is recorded by this install, whereas killing an unreadable
# candidate here could close a portable copy or the install-smoke process.
if ($unknown.Count -and $lastCode -ne 5) {
  Write-StopDiagnostic -Code $lastCode -Message $lastMessage
  exit 1
}

# Wait for the lock, not for the process: Stop-Process returns before the image is
# unmapped, and Windows can take a few seconds to finish tearing the process down.
# 40 x 300 ms, returning as soon as the file is free instead of always paying it.
#
# Exit 1 only for a real sharing/lock violation after the target process was
# stopped. Exit 2 above means this context cannot write to the directory at all;
# exit 0 means the payload's destination is ready.
for ($i = 0; $i -lt 40; $i++) {
  if (Test-Writable) { exit 0 }
  if ($lastCode -eq 5) {
    Write-StopDiagnostic -Code $lastCode -Message $lastMessage
    exit 2
  }
  Start-Sleep -Milliseconds 300
}
Write-StopDiagnostic -Code $lastCode -Message $lastMessage
exit 1
