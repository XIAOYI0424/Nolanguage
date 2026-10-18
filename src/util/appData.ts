/**
 * Where the *application* keeps machine-local state: the telemetry database and
 * the WebView2 profile.
 *
 * Deliberately not the plugin home (`~/.nolanguage`, see `LanguageRegistry`) and
 * deliberately not the install directory. Putting a WebView2 profile under
 * `%LOCALAPPDATA%\Programs\Nolanguage` looked tidy ("unzip and run stays
 * self-contained") until uninstall: NSIS cannot remove files the WebView2
 * runtime still holds, so a stale `.nolanguage` folder survived every uninstall
 * and reinstall inherited a possibly corrupt profile.
 *
 * Layout:
 *   %LOCALAPPDATA%\Nolanguage\telemetry.db
 *   %LOCALAPPDATA%\Nolanguage\webview\
 *   %LOCALAPPDATA%\Nolanguage\install-receipt.json   (written by the installer)
 *
 * `NOLANGUAGE_DATA` overrides the directory wholesale, which is what tests and
 * portable deployments use.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root for app state; created on demand by whoever writes into it. */
export function appDataDir(): string {
  const override = process.env.NOLANGUAGE_DATA;
  if (override) return override;

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    return join(local || join(homedir(), 'AppData', 'Local'), 'Nolanguage');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Nolanguage');
  }
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg || join(homedir(), '.local', 'share'), 'nolanguage');
}

/** `appDataDir()` plus path segments, e.g. `appDataPath('telemetry.db')`. */
export function appDataPath(...parts: string[]): string {
  return join(appDataDir(), ...parts);
}
