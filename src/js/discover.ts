/**
 * JavaScript runtime + language-server discovery.
 *
 * JavaScript's "toolchain" is Node itself, and there is no bundled fallback
 * language server (unlike Python, which ships `pyrightServer.py`). So this
 * module answers two questions and never throws:
 *
 *   resolveNodeBin()    → which `node` will actually execute the code
 *   discoverJsServer()  → a `typescript-language-server` launch spec, or null
 *
 * The resolution order deliberately mirrors `WarmWorker` (the process the
 * execution plane spawns): `NODE_BIN` → `node` on PATH. There is no
 * "known install dir" branch on purpose — reporting `available: true` for a
 * binary the warm worker would not find is exactly the silent lie the Go
 * discovery docs warn about, so the two must agree on the same two sources.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commandExists, type LspLaunchSpec } from '../lsp/LspClient.js';

export interface NodeBinResolution {
  /** Absolute path (or bare name when found on PATH) of the node executable. */
  bin: string;
  /** How it was found — surfaced in the UI so the choice is never a mystery. */
  source: 'NODE_BIN' | 'PATH' | 'missing';
  /** Directories probed when nothing matched, for the error message. */
  searched: string[];
}

const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * Locate the `node` executable.
 *
 * An explicit path is authoritative: when the caller set `NODE_BIN` and it does
 * not exist, that is a misconfiguration worth reporting rather than papering
 * over with a different runtime.
 *
 * @param preferred explicit path (e.g. from the `NODE_BIN` env var).
 */
export function resolveNodeBin(preferred?: string): NodeBinResolution {
  const searched: string[] = [];
  const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of paths) searched.push(join(dir, `node${EXE}`));

  if (preferred) {
    // A bare name (`node`) is a PATH lookup, not a path; `commandExists`
    // already draws that line the same way the rest of the platform does.
    if (commandExists(preferred)) return { bin: preferred, source: 'NODE_BIN', searched };
    // Explicit but wrong — stop here rather than falling back.
    return { bin: preferred, source: 'missing', searched };
  }

  if (commandExists('node')) return { bin: 'node', source: 'PATH', searched };

  return { bin: `node${EXE}`, source: 'missing', searched };
}

export interface JsServerResolution {
  launch: LspLaunchSpec | null;
  /** `typescript-language-server` when found, `none` when JS degrades to run-only. */
  serverName: string;
  /** Where the server was found, for the status bar. */
  source: 'JS_LSP' | 'PATH' | 'npm-global' | 'none';
  searched: string[];
  /** Populated when the server is missing, to explain the consequence. */
  note?: string;
}

/**
 * Locate `typescript-language-server`.
 *
 * Order: an explicit path → PATH (a global npm install puts a shim there) →
 * npm's global prefix bin dir (that shim is not always on PATH, especially on
 * Windows where it lands in `%APPDATA%\npm`).
 *
 * Returns `launch: null` when the server is absent; the caller degrades to
 * execution-only rather than failing.
 */
export function discoverJsServer(preferred?: string): JsServerResolution {
  const searched: string[] = [];
  const spec = (command: string): LspLaunchSpec => ({
    languageId: 'javascript',
    serverName: 'typescript-language-server',
    command,
    args: ['--stdio'],
  });

  if (preferred) {
    searched.push(preferred);
    if (existsSync(preferred)) {
      return { launch: spec(preferred), serverName: 'typescript-language-server', source: 'JS_LSP', searched };
    }
  }

  if (commandExists('typescript-language-server')) {
    return { launch: spec('typescript-language-server'), serverName: 'typescript-language-server', source: 'PATH', searched };
  }

  const npmPrefix = process.platform === 'win32' ? process.env.APPDATA : '/usr/local';
  if (npmPrefix) {
    const candidate = join(npmPrefix, 'npm', `typescript-language-server${process.platform === 'win32' ? '.cmd' : ''}`);
    searched.push(candidate);
    if (existsSync(candidate)) {
      return { launch: spec(candidate), serverName: 'typescript-language-server', source: 'npm-global', searched };
    }
  }

  return {
    launch: null,
    serverName: 'none',
    source: 'none',
    searched,
    note:
      'typescript-language-server not found — JavaScript code still runs, but Check/completion are disabled. ' +
      'Install it with:  npm i -g typescript-language-server typescript',
  };
}
