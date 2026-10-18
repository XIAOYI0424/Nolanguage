/**
 * Nolanguage installer — packaged as a standalone Node SEA executable.
 *
 * On launch it copies the application executable from a sibling `payload/`
 * folder (next to this setup.exe) into the user's local AppData and creates two
 * Start Menu shortcuts:
 *
 *   Nolanguage (Web)     -> Nolanguage.exe --open-browser   (default browser)
 *   Nolanguage (Desktop) -> Nolanguage.exe                  (native WebView window)
 *
 * It also writes an uninstall registry entry + an uninstall.ps1, and adds the
 * install dir to the user PATH. Nothing else is required — no NSIS, no WiX, no
 * Rust toolchain. The only external artifact is the app exe in `payload/`.
 *
 * Build: node installer/build-setup.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const APP_NAME = 'Nolanguage';
const APP_EXE = 'Nolanguage.exe';

function fail(msg: string, code = 1): never {
  process.stderr.write(`setup: ${msg}\n`);
  process.exit(code);
}

/** PowerShell snippet that creates shortcuts, the uninstaller registry entry and
 * the PATH entry. Dynamic values are injected from Node (this is a template
 * literal, so every `${...}` below is a Node interpolation, not PowerShell). */
function psScript(installDir: string, noPath: boolean): string {
  const sm = join(
    process.env.LOCALAPPDATA ?? '',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    APP_NAME,
  );
  const desktop = join(process.env.USERPROFILE ?? '', 'Desktop');
  const uninstall = join(installDir, 'uninstall.ps1');
  return `
$ErrorActionPreference = 'Stop'
$noPath = ${noPath ? '$true' : '$false'}
$installDir = '${installDir}'
$appExe = Join-Path $installDir '${APP_EXE}'
$sm = '${sm}'
$desktop = '${desktop}'
$uninstall = '${uninstall}'
$ws = New-Object -ComObject WScript.Shell
function New-Shortcut($p, $a) {
  $s = $ws.CreateShortcut($p)
  $s.TargetPath = $appExe
  $s.Arguments = $a
  $s.WorkingDirectory = $installDir
  $s.Save()
}
New-Item -ItemType Directory -Force -Path $sm | Out-Null
New-Shortcut (Join-Path $sm '${APP_NAME} (Web).lnk') '--open-browser'
New-Shortcut (Join-Path $sm '${APP_NAME} (Desktop).lnk') ''
New-Shortcut (Join-Path $desktop '${APP_NAME}.lnk') ''
$uc = @'
if (Test-Path '${installDir}') { Remove-Item -Recurse -Force '${installDir}' }
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\${APP_NAME}'
if (Test-Path $sm) { Remove-Item -Recurse -Force $sm }
$dl = Join-Path ([Environment]::GetFolderPath('Desktop')) '${APP_NAME}.lnk'
if (Test-Path $dl) { Remove-Item -Force $dl }
$up = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($up -like '*${installDir}*') {
  $n = ($up -split ';' | Where-Object { $_ -and $_ -ne '${installDir}' }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $n, 'User')
}
Write-Host '${APP_NAME} uninstalled.'
'@
Set-Content -Path $uninstall -Value $uc -Encoding UTF8
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}'
New-Item -Force -Path $key | Out-Null
Set-ItemProperty -Path $key -Name DisplayName -Value '${APP_NAME}'
Set-ItemProperty -Path $key -Name UninstallString -Value "powershell.exe -ExecutionPolicy Bypass -File $uninstall"
Set-ItemProperty -Path $key -Name DisplayVersion -Value '0.6.0'
Set-ItemProperty -Path $key -Name Publisher -Value '${APP_NAME}'
Set-ItemProperty -Path $key -Name InstallLocation -Value $installDir
if (-not $noPath) {
  $up = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($up -notlike '*${installDir}*') {
    $n = if ($up) { "$up;$installDir" } else { $installDir }
    [Environment]::SetEnvironmentVariable('Path', $n, 'User')
  }
}
Write-Host 'shortcuts and uninstall entry created'
`;
}

function main(): void {
  const setupDir = dirname(process.execPath);
  const installDir =
    process.env.NOLANGUAGE_INSTALL_DIR ??
    join(
      process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'),
      'Programs',
      APP_NAME,
    );

  const src = join(setupDir, 'payload', APP_EXE);
  if (!existsSync(src)) {
    fail(
      `application executable not found at ${src}.\n` +
        `Place Nolanguage.exe in a 'payload' subfolder next to this setup ` +
        `(rebuild it with 'npm run build:exe').`,
    );
  }

  mkdirSync(installDir, { recursive: true });
  copyFileSync(src, join(installDir, APP_EXE));
  console.log(`installed ${APP_NAME} -> ${join(installDir, APP_EXE)}`);

  const noPath = process.argv.includes('--no-path');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript(installDir, noPath)], {
    stdio: 'inherit',
  });
  if (r.status !== 0) fail(`shortcut/registry step failed (exit ${r.status})`, r.status ?? 1);
  console.log(`done. Start Menu: '${APP_NAME} (Web)' / '${APP_NAME} (Desktop)'.`);
}

main();
