/**
 * marksman discovery — the Markdown language server.
 *
 * marksman is a single self-contained binary with no toolchain dependency
 * (unlike gopls, which needs `go` on PATH), so discovery is simpler: find the
 * executable, point the LSP client at it, done. It is still *optional* —
 * without it the editor keeps the built-in heading outline and the live
 * preview, and only LSP-powered features (link completion, workspace-wide
 * rename, hover) degrade.
 *
 * Nothing here throws, and nothing here spawns: a missing marksman is a
 * normal, reportable state, exactly like a missing gopls. The verification
 * suite asserts the *skip* semantics, so "not installed" must stay a
 * graceful `launch: null`, never a failure.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commandExists, type LspLaunchSpec } from '../lsp/LspClient.js';

const EXE = process.platform === 'win32' ? '.exe' : '';

export interface MarksmanResolution {
  /** Absolute path (or bare name when found on PATH) of the marksman binary. */
  bin: string;
  source: 'MARKSMAN' | 'PATH' | 'known-dir' | 'missing';
  searched: string[];
}

export interface MarksmanServerResolution {
  launch: LspLaunchSpec | null;
  serverName: 'marksman' | 'none';
  source: 'PATH' | 'known-dir' | 'none';
  searched: string[];
  /** Populated when marksman is missing, to explain the consequence. */
  note?: string;
}

/**
 * Well-known install locations. marksman ships as a GitHub release zip, so
 * users extract it everywhere; these cover the package-manager conventions.
 */
function knownMarksmanDirs(): string[] {
  const dirs: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? '';
    const home = process.env.USERPROFILE ?? '';
    dirs.push(
      join(local, 'Microsoft', 'WinGet', 'Links'),
      join(home, 'scoop', 'shims'),
      'C://ProgramData//chocolatey//bin',
      join(local, 'Programs', 'marksman'),
      join(home, 'marksman'),
    );
  } else {
    const home = process.env.HOME ?? '';
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/marksman', join(home, '.local', 'bin'), join(home, 'bin'));
  }
  return dirs.filter(Boolean);
}

/**
 * Locate the `marksman` executable.
 *
 * An explicit `preferred` path (the MARKSMAN env var) is authoritative: if it
 * does not exist that is a misconfiguration worth reporting, not something to
 * paper over by silently using a different binary.
 */
export function resolveMarksman(preferred?: string): MarksmanResolution {
  const searched: string[] = [];

  if (preferred) {
    searched.push(preferred);
    if (existsSync(preferred)) return { bin: preferred, source: 'MARKSMAN', searched };
    return { bin: preferred, source: 'missing', searched };
  }

  if (commandExists('marksman')) return { bin: 'marksman', source: 'PATH', searched };

  for (const dir of knownMarksmanDirs()) {
    const candidate = join(dir, `marksman${EXE}`);
    searched.push(candidate);
    if (existsSync(candidate)) return { bin: candidate, source: 'known-dir', searched };
  }

  return { bin: `marksman${EXE}`, source: 'missing', searched };
}

/**
 * A launch spec for the LSP client, or null when marksman is absent.
 *
 * `marksman server` (newer builds) and the bare default both work; the args
 * list is left empty so an older binary that only understands the default
 * subcommand is not broken by `server`.
 */
export function discoverMarksmanServer(env?: string): MarksmanServerResolution {
  const res = resolveMarksman(env);
  if (res.source === 'missing') {
    return {
      launch: null,
      serverName: 'none',
      source: 'none',
      searched: res.searched,
      note:
        'marksman not found — Markdown preview, outline and structure still work; ' +
        'LSP link completion and hover are disabled. Install it from ' +
        'https://github.com/artempyanykh/marksman/releases (or: winget install marksman).',
    };
  }
  return {
    launch: {
      languageId: 'markdown',
      serverName: 'marksman',
      command: res.bin,
      args: [],
    },
    serverName: 'marksman',
    source: res.source === 'PATH' ? 'PATH' : 'known-dir',
    searched: res.searched,
  };
}
