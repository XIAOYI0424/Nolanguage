/**
 * How to find a Python language server.
 *
 * # Why this is not in `src/lsp`
 *
 * `LspClient` is the generic client: framing, capabilities, request routing —
 * nothing in it should know what Python is. It used to also carry
 * `discoverPythonServer`, `canImportModule` and `fallbackServerSpec`, which
 * named Python's binaries, Python's module and Python's script path. The
 * `verify:langparity` gate counted them as the last language literals inside
 * `src/lsp`; moving them here takes that count to zero and means the next
 * language's discovery lives next to its own code instead of in the engine.
 *
 * Preference order, unchanged:
 *   1. `pyright-langserver` on PATH (the npm global).
 *   2. `python -m pyright.langserver`, but only when the `pyright` module is
 *      actually importable — a `python` on PATH is not proof pyright exists.
 *   3. The bundled `pyrightServer.py`, which speaks real LSP so the closed loop
 *      runs with no network and no pyright.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { embeddedAssetPath } from '../assets/embeddedAssets.js';
import { commandExists, type LspLaunchSpec } from '../lsp/LspClient.js';

/**
 * Discover a Python language server.
 *
 * Async because step 2 has to run the interpreter; see `canImportModule`.
 */
export async function discoverPythonServer(
  pythonBin = process.env.PYTHON_BIN ?? 'python',
): Promise<LspLaunchSpec> {
  if (commandExists('pyright-langserver')) {
    return { languageId: 'python', serverName: 'pyright', command: 'pyright-langserver', args: ['--stdio'] };
  }
  if (await canImportModule(pythonBin, 'pyright')) {
    return {
      languageId: 'python',
      serverName: 'pyright',
      command: pythonBin,
      args: ['-m', 'pyright.langserver', '--stdio'],
    };
  }
  return fallbackServerSpec(pythonBin);
}

/**
 * True if `python -c "import <mod>"` succeeds (used to verify pyright really
 * exists).
 *
 * Async `spawn` rather than `spawnSync`: the synchronous variant is blocked in
 * some sandboxed environments (it fails with EBUSY while async spawn succeeds),
 * which would silently downgrade every caller to the fallback server.
 */
export function canImportModule(pythonBin: string, module: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(pythonBin, ['-c', `import ${module}`], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
      setTimeout(() => {
        child.kill();
        done(false);
      }, 8000).unref?.();
    } catch {
      done(false);
    }
  });
}

/** The bundled server, used when neither real pyright is available. */
export function fallbackServerSpec(pythonBin: string): LspLaunchSpec {
  return {
    languageId: 'python',
    serverName: 'nolanguage-py',
    command: pythonBin,
    args: ['-u', fallbackServerPath()],
    cwd: process.cwd(),
  };
}

function fallbackServerPath(): string {
  // Packaged: the script ships inside the executable. Source: it sits next to
  // this module, which is why moving the function out of `src/lsp` also
  // simplified the relative path.
  const embedded = embeddedAssetPath('pyrightServer.py');
  if (embedded) return embedded;
  try {
    return fileURLToPath(new URL('./pyrightServer.py', import.meta.url));
  } catch {
    // A bundled module may not expose a file:// URL — nothing we can do here.
    return 'pyrightServer.py';
  }
}
