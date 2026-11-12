# ===========================================================================
# Nolanguage — user-PATH installer with a receipt.
#
#   powershell -ExecutionPolicy Bypass -File path-tool.ps1 -Action add    -InstallDir <dir>
#   powershell -ExecutionPolicy Bypass -File path-tool.ps1 -Action remove -InstallDir <dir>
#   powershell -ExecutionPolicy Bypass -File path-tool.ps1 -Action inspect
#
# Why a receipt instead of "delete every entry that mentions Nolanguage":
# silently rewriting PATH is the one install-time action that is hard to undo by
# hand. The receipt records the *exact* value PATH had before this install, so
# uninstall restores it verbatim — other tools that were added later keep their
# entries, and an entry a user added themselves is never guessed at.
#
# The receipt lives in %LOCALAPPDATA%\Nolanguage\install-receipt.json, outside
# the install directory, so it survives the directory being deleted.
#
# `-DryRun` prints what would change without touching the environment; the
# installer smoke check uses it.
# ===========================================================================
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove', 'inspect')][string]$Action,
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Nolanguage",
  [string]$Receipt,
  [string]$Version = '0.7.15',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$InstallDir = $InstallDir.TrimEnd('\')
if (-not $Receipt) { $Receipt = Join-Path $env:LOCALAPPDATA 'Nolanguage\install-receipt.json' }
$Command = Join-Path $InstallDir 'nlg.cmd'

# The user PATH is a registry value, and its *type* matters: an entry like
# `%JAVA_HOME%\bin` only works while the value stays REG_EXPAND_SZ. Writing it
# through [Environment] can silently retype it to REG_SZ, so both helpers go to
# HKCU\Environment directly and preserve the existing kind.
function Get-UserPath {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
  if (-not $key) { return [string][Environment]::GetEnvironmentVariable('Path', 'User') }
  try {
    $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally {
    $key.Close()
  }
  if ($null -eq $raw) { return '' }
  return [string]$raw
}

function Set-UserPath([string]$value) {
  if ($DryRun) { return }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) {
    [Environment]::SetEnvironmentVariable('Path', $value, 'User')
    return
  }
  try {
    try { $kind = $key.GetValueKind('Path') }
    catch { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $key.SetValue('Path', $value, $kind)
  } finally {
    $key.Close()
  }
  # Best effort: tell running apps (Explorer, new terminals) that the environment
  # changed. Failure here only means a new shell has to be opened by hand.
  try {
    if (-not ('Win32.NativeMethods' -as [type])) {
      Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [void][Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
    # Environment broadcast is a convenience, never a failure.
  }
}

function Read-Receipt {
  if (-not (Test-Path $Receipt)) { return $null }
  try { return Get-Content -Raw -Path $Receipt | ConvertFrom-Json }
  catch { return $null }
}

<#
  Write the receipt atomically: a half-written JSON file would make a later
  uninstall unable to restore PATH. Same-directory temp file + Move-Item.
#>
function Write-Receipt($data) {
  if ($DryRun) { return }
  $dir = Split-Path -Parent $Receipt
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp = Join-Path $dir ('.receipt-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $data | ConvertTo-Json -Depth 6 | Set-Content -Path $tmp -Encoding UTF8
  Move-Item -Force -Path $tmp -Destination $Receipt
}

function Test-ContainsToken([string]$pathValue, [string]$token) {
  if (-not $pathValue) { return $false }
  foreach ($part in ($pathValue -split ';')) {
    if ($part -and ($part.TrimEnd('\') -ieq $token.TrimEnd('\'))) { return $true }
  }
  return $false
}

# Append without touching what is already there. `TrimEnd(';')` would eat a
# legitimate empty segment (`...;%VAR%;;...` is a real world PATH, and it is what
# our own receipt compares against), so the prefix is preserved verbatim.
function Add-Token([string]$pathValue, [string]$token) {
  if (-not $pathValue) { return $token }
  return ($pathValue + ';' + $token)
}

# Remove exactly one path token, keeping every other segment including empty
# ones. Dropping the empties here would make the "did anything else change?"
# comparison below fail on any PATH that contains `;;`, and the receipt's
# verbatim restore would silently degrade to a lossy rewrite.
function Remove-Token([string]$pathValue, [string]$token) {
  if (-not $pathValue) { return '' }
  $kept = @()
  foreach ($part in ($pathValue -split ';')) {
    if ($part -and ($part.TrimEnd('\') -ieq $token.TrimEnd('\'))) { continue }
    $kept += $part
  }
  return ($kept -join ';')
}

switch ($Action) {
  'inspect' {
    $receipt = Read-Receipt
    $current = Get-UserPath
    [pscustomobject]@{
      receipt      = $Receipt
      exists       = [bool]$receipt
      current      = $current
      recordedPath = if ($receipt) { $receipt.path.after } else { $null }
      installDir   = if ($receipt) { $receipt.installDir } else { $null }
    } | ConvertTo-Json -Depth 4
    exit 0
  }

  'add' {
    $current = Get-UserPath
    $existing = Read-Receipt
    # Reinstalling over the same directory must not overwrite the *original*
    # `before` value with the already-modified PATH — that would make the
    # receipt useless exactly when it is needed.
    $sameInstall = $existing -and ($existing.installDir -ieq $InstallDir)
    $before = if ($sameInstall -and $existing.path -and $null -ne $existing.path.before) {
      [string]$existing.path.before
    } else { [string]$current }

    $alreadyPresent = Test-ContainsToken $current $InstallDir
    $after = if ($alreadyPresent) { [string]$current } else { Add-Token $current $InstallDir }

    if (-not $alreadyPresent) { Set-UserPath $after }
    Write-Receipt ([pscustomobject]@{
        schemaVersion = 1
        installedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        version       = $Version
        installDir    = $InstallDir
        command       = $Command
        path          = [pscustomobject]@{
          scope  = 'user'
          value  = $InstallDir
          before = $before
          after  = $after
        }
        registryKeys  = @('HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nolanguage')
      })

    [pscustomobject]@{
      ok          = $true
      dryRun      = [bool]$DryRun
      changed     = -not $alreadyPresent
      installDir  = $InstallDir
      command     = $Command
      receipt     = $Receipt
      pathBefore  = $before
      pathAfter   = $after
    } | ConvertTo-Json -Depth 4
    exit 0
  }

  'remove' {
    $current = Get-UserPath
    $receipt = Read-Receipt
    if ($receipt -and $receipt.path -and $receipt.path.value) {
      $token = [string]$receipt.path.value
      # Exact restore when nothing else touched the entry we added; otherwise
      # drop just our token, leaving later additions alone.
      $restored = [string]$receipt.path.before
      if ((Test-ContainsToken $current $token) -and ($restored -ne $null)) {
        $withoutOurs = Remove-Token $current $token
        if ($withoutOurs -eq ($restored.TrimEnd(';'))) {
          Set-UserPath $restored
          Remove-Item -Force $Receipt -ErrorAction SilentlyContinue
          [pscustomobject]@{ ok = $true; restored = $true; path = $restored } | ConvertTo-Json
          exit 0
        }
      }
      $trimmed = Remove-Token $current $token
      Set-UserPath $trimmed
      if (-not $DryRun) { Remove-Item -Force $Receipt -ErrorAction SilentlyContinue }
      [pscustomobject]@{ ok = $true; restored = $false; path = $trimmed } | ConvertTo-Json
      exit 0
    }

    # No receipt (installed by an older build): remove *only* our directory as
    # a path token. Never match substrings — `C:\Tools\Nolanguage-notes` is not us.
    $trimmed = Remove-Token $current $InstallDir
    if ($trimmed -ne $current) { Set-UserPath $trimmed }
    [pscustomobject]@{ ok = $true; restored = $false; path = $trimmed } | ConvertTo-Json
    exit 0
  }
}
