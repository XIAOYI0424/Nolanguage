/**
 * The OS file dialog, without Tauri.
 *
 * The client's pickers call `__TAURI_INTERNALS__`, which does not exist in the
 * shipped Edge `--app` build — so File > Open Folder showed "the native folder
 * picker is available in the desktop app" *inside the desktop app*, and there was
 * no way to change the project root except typing a path into the import dialog.
 *
 * This is the replacement: the panel asks Windows for the dialog through
 * PowerShell, on the machine the user is already looking at. `-EncodedCommand`
 * (base64 UTF-16LE) rather than `-Command`, because the script contains quotes,
 * braces and a user-supplied title, and every one of them would otherwise be an
 * escaping bug.
 *
 * The dialog used to have no owner. Windows then treated the hidden PowerShell
 * process as the owner, so its modal picker could open *behind* the app window.
 * The desktop entry now passes the discovered WebView process PID in
 * NOLANGUAGE_WINDOW_PID; this script wraps its HWND in IWin32Window and supplies
 * that as the dialog owner. If no visible app window is available (browser
 * fallback, early startup), it safely falls back to the unowned dialog.
 */
import { spawn } from 'node:child_process';

export interface PickFilter {
  name: string;
  extensions: string[];
}

export interface PickOptions {
  /** `directory` picks a folder; `save` allows a path that does not exist yet. */
  mode?: 'file' | 'directory' | 'save';
  title?: string;
  defaultPath?: string;
  filters?: PickFilter[];
}

/** PowerShell single-quoted literal: the only escape is doubling the quote. */
function psQuote(text: string): string {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

/** `Source|*.py;*.js` — the WinForms filter format, one pair per entry. */
function psFilter(filters: PickFilter[] | undefined): string {
  const parts: string[] = [];
  for (const f of filters ?? []) {
    const exts = (f.extensions ?? []).map((e) => '*.' + String(e).replace(/^\*?\.?/, '')).filter((e) => e !== '*');
    if (!exts.length) continue;
    parts.push(`${f.name || 'Files'}|${exts.join(';')}`);
  }
  parts.push('All files|*.*');
  return parts.join('|');
}

/**
 * The script PowerShell runs. Pure: the tests assert its shape, and the only
 * thing that is not testable is whether Windows shows a dialog.
 */
export function buildPickerScript(opts: PickOptions): string {
  const mode = opts.mode ?? 'file';
  const title = psQuote(opts.title || (mode === 'directory' ? 'Open Folder' : 'Open File'));
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    "Add-Type -ReferencedAssemblies ([System.Windows.Forms.Form].Assembly.Location) -TypeDefinition 'using System; using System.Windows.Forms; public sealed class NolanguageDialogOwner : IWin32Window { public IntPtr Handle { get; private set; } public NolanguageDialogOwner(IntPtr handle) { Handle = handle; } }' | Out-Null",
    'function Show-NolanguageDialog($dialog) {',
    '  $ownerPid = 0',
    '  if ([int]::TryParse($env:NOLANGUAGE_WINDOW_PID, [ref]$ownerPid) -and $ownerPid -gt 0) {',
    '    $ownerProcess = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue',
    '    if ($ownerProcess -and $ownerProcess.MainWindowHandle -ne [IntPtr]::Zero) {',
    '      $owner = [NolanguageDialogOwner]::new([IntPtr]$ownerProcess.MainWindowHandle)',
    '      return $dialog.ShowDialog($owner)',
    '    }',
    '  }',
    '  return $dialog.ShowDialog()',
    '}',
  ];

  if (mode === 'directory') {
    lines.push(
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = ${title}`,
      '$d.ShowNewFolderButton = $true',
      opts.defaultPath ? `$d.SelectedPath = ${psQuote(opts.defaultPath)}` : '',
      'if ((Show-NolanguageDialog $d) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    );
  } else if (mode === 'save') {
    lines.push(
      '$d = New-Object System.Windows.Forms.SaveFileDialog',
      `$d.Title = ${title}`,
      `$d.Filter = ${psQuote(psFilter(opts.filters))}`,
      opts.defaultPath ? `$d.FileName = ${psQuote(opts.defaultPath)}` : '',
      'if ((Show-NolanguageDialog $d) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
    );
  } else {
    lines.push(
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Title = ${title}`,
      `$d.Filter = ${psQuote(psFilter(opts.filters))}`,
      '$d.CheckFileExists = $true',
      opts.defaultPath ? `$d.InitialDirectory = ${psQuote(opts.defaultPath)}` : '',
      'if ((Show-NolanguageDialog $d) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
    );
  }

  return lines.filter(Boolean).join('\n');
}

/**
 * What the script printed, or null when the user cancelled.
 *
 * A cancelled dialog prints nothing, so "no output" is a real answer and must not
 * be reported as an error. PowerShell can still emit a warning line first, so the
 * last non-empty line wins.
 */
export function parsePickerOutput(stdout: string): string | null {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? last : null;
}

/** base64 of UTF-16LE, which is what `-EncodedCommand` expects. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Show the dialog and resolve with the chosen path (or null when cancelled).
 *
 * Ten minutes is a ceiling, not a budget: a dialog nobody answers would otherwise
 * keep a promise alive forever. It is long enough that a real user never hits it.
 */
export function pickPath(opts: PickOptions, timeoutMs = 600_000): Promise<string | null> {
  const script = buildPickerScript(opts);
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'powershell',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)],
        { windowsHide: true, shell: false },
      );
    } catch (e) {
      reject(new Error(`could not start the dialog helper: ${(e as Error).message}`));
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(() => reject(new Error('the dialog was left open for 10 minutes')));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      err += String(d);
    });
    child.on('error', (e) => finish(() => reject(new Error(`dialog helper failed: ${e.message}`))));
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0 && !out.trim()) {
          reject(new Error(err.trim().split(/\r?\n/).slice(-1)[0] || `dialog helper exited with ${code}`));
          return;
        }
        resolve(parsePickerOutput(out));
      });
    });
  });
}
