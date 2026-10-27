<#
.SYNOPSIS
  Sign the built executables (Authenticode), or report their signature status.

.DESCRIPTION
  Three signer sources, checked in this order:

    -Pfx <file> [-PfxPassword <pw>]   a real code-signing certificate (.pfx)
    -Thumbprint <sha1>                a certificate already in Cert:\CurrentUser\My
    -SelfSigned                       a local development certificate

  With none of them the script refuses to pretend: it prints what is missing and
  exits 2. An unsigned build is a legitimate state; a build everyone *believes*
  is signed is not.

  -Verify only reads: it prints Status + signer for each target and exits 0, so
  CI and `nlg doctor` can share one code path.

  Signing uses Set-AuthenticodeSignature (CryptoAPI), which is part of Windows —
  no Windows SDK / signtool install is required. When signtool *is* available it
  is not needed for correctness; this script deliberately has no such dependency.

.EXAMPLE
  npm run sign -- -SelfSigned

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File installer\sign.ps1 -Verify
#>
[CmdletBinding()]
param(
  [string[]]$Path = @('dist\Nolanguage.exe', 'installer\Nolanguage-Setup.exe'),
  [string]$Pfx,
  [string]$PfxPassword,
  [string]$Thumbprint,
  [switch]$SelfSigned,
  [string]$Timestamp = 'http://timestamp.digicert.com',
  [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Resolve-Target([string]$p) {
  if ([System.IO.Path]::IsPathRooted($p)) { return $p }
  return (Join-Path $root $p)
}

$targets = @()
foreach ($p in $Path) {
  $full = Resolve-Target $p
  if (Test-Path -LiteralPath $full) {
    $targets += $full
  } else {
    Write-Host "  missing  $p" -ForegroundColor DarkYellow
  }
}
if ($targets.Count -eq 0) {
  Write-Host 'nothing to sign — build first (npm run build:exe / build:setup)' -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------- verify mode
if ($Verify) {
  $bad = 0
  foreach ($t in $targets) {
    $sig = Get-AuthenticodeSignature -LiteralPath $t
    $subject = '-'
    if ($sig.SignerCertificate) { $subject = $sig.SignerCertificate.Subject }
    Write-Host ("  {0,-14} {1}" -f $sig.Status, (Split-Path -Leaf $t))
    Write-Host ("                 {0}" -f $subject) -ForegroundColor DarkGray
    if ($sig.Status -ne 'Valid') { $bad++ }
  }
  if ($bad -gt 0) {
    Write-Host ("{0} file(s) without a valid signature" -f $bad) -ForegroundColor Yellow
  }
  exit 0
}

# ---------------------------------------------------------------- pick a signer
$cert = $null
$temporary = $false
if ($Pfx) {
  $pw = ConvertTo-SecureString -String $PfxPassword -AsPlainText -Force
  $cert = Import-PfxCertificate -FilePath (Resolve-Target $Pfx) -CertStoreLocation Cert:\CurrentUser\My -Password $pw
  $temporary = $true
} elseif ($Thumbprint) {
  $cert = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $Thumbprint.Replace(' ', ''))
} elseif ($SelfSigned) {
  $existing = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq 'CN=Nolanguage Dev' } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if ($existing) {
    $cert = $existing
  } else {
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Nolanguage Dev' `
      -KeyUsage DigitalSignature -KeyExportPolicy Exportable `
      -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(2)
    Write-Host ("  created development certificate {0}" -f $cert.Thumbprint) -ForegroundColor DarkGray
  }
  Write-Host '  NOTE: a self-signed certificate proves only "unchanged since signing".' -ForegroundColor Yellow
  Write-Host '        SmartScreen keeps warning until a publicly trusted CA signs the build.' -ForegroundColor Yellow
} else {
  Write-Host 'no signing certificate supplied — nothing was signed.' -ForegroundColor Red
  Write-Host '  -Pfx <file> [-PfxPassword <pw>]   real certificate'
  Write-Host '  -Thumbprint <sha1>                certificate in Cert:\CurrentUser\My'
  Write-Host '  -SelfSigned                       local development certificate'
  exit 2
}

# ---------------------------------------------------------------- sign
$failed = 0
foreach ($t in $targets) {
  $name = Split-Path -Leaf $t
  try {
    $sig = $null
    try {
      $sig = Set-AuthenticodeSignature -LiteralPath $t -Certificate $cert -TimestampServer $Timestamp -HashAlgorithm SHA256
    } catch {
      # Offline or the TSA is unreachable: sign without a timestamp rather than
      # leaving the build unsigned. The status line says which happened.
      Write-Host ("  no timestamp for {0} — signing without one" -f $name) -ForegroundColor DarkYellow
      $sig = Set-AuthenticodeSignature -LiteralPath $t -Certificate $cert -HashAlgorithm SHA256
    }
    if ($sig.Status -eq 'Valid' -or $sig.Status -eq 'UnknownError') {
      Write-Host ("  signed   {0}  [{1}]" -f $name, $sig.Status) -ForegroundColor Green
    } else {
      Write-Host ("  FAILED   {0}  {1} {2}" -f $name, $sig.Status, $sig.StatusMessage) -ForegroundColor Red
      $failed++
    }
  } catch {
    Write-Host ("  FAILED   {0}  {1}" -f $name, $_.Exception.Message) -ForegroundColor Red
    $failed++
  }
}

if ($temporary -and $cert) {
  Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue
}
if ($failed -gt 0) { exit 1 }
Write-Host ("signed {0} file(s)" -f $targets.Count) -ForegroundColor Green
exit 0
