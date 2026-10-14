/**
 * Go toolchain + language-server discovery.
 *
 * Go is unusual in that both the compiler and its language server can live
 * anywhere the user chose — this project installs into `D:\Go lang`, but a
 * machine that used the MSI would have `C:\Program Files\Go`, and one that used
 * a package manager would have it on PATH. So discovery walks a fixed order of
 * candidates and reports *where* it found things, which the UI surfaces in the
 * status bar (a silent fallback is how you end up debugging the wrong binary).
 *
 *   resolveGoBin()      → the `go` executable
 *   discoverGoServer()  → a `gopls` launch spec, or null
 *   goVersion()         → `go version` output (async, see below)
 *
 * Nothing here throws: a missing toolchain is a normal, reportable state.
 *
 * **No `spawnSync`.** Probing is filesystem-only, and the one call that needs a
 * process (`go version`) is async. `spawnSync` is unusable under some sandboxes
 * (it fails with EBUSY while async `spawn` succeeds), and a synchronous probe
 * would block the event loop on the UI thread anyway.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { commandExists, type LspLaunchSpec } from '../lsp/LspClient.js';

export interface GoBinResolution {
  /** Absolute path (or bare name when found on PATH) of the go executable. */
  bin: string;
  /** How it was found — surfaced in the UI so the choice is never a mystery. */
  source: 'GO_BIN' | 'PATH' | 'GOROOT' | 'known-dir' | 'missing';
  /** Directories probed when nothing matched, for the error message. */
  searched: string[];
}

const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * Well-known install locations, most specific first. `D:\Go lang` is listed
 * first because that is where this project's installer puts the toolchain.
 */
function knownGoDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.GOROOT) dirs.push(process.env.GOROOT);
  if (process.platform === 'win32') {
    dirs.push(
      'D:\\Go lang',
      'C:\\Go',
      'C:\\Program Files\\Go',
      'D:\\Go',
      'D:\\Program Files\\Go',
      join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Go'),
      join(process.env.USERPROFILE ?? '', 'scoop', 'apps', 'go', 'current'),
    );
  } else {
    dirs.push('/usr/local/go', '/usr/lib/go', '/opt/go', join(process.env.HOME ?? '', 'go'));
  }
  return dirs.filter(Boolean);
}

/**
 * Locate the `go` executable.
 *
 * An explicit `preferred` path is authoritative: if the caller set GO_BIN and
 * it does not exist, that is a misconfiguration worth reporting, not something
 * to paper over by silently using a different toolchain. Only when no explicit
 * path is given do we search PATH and the known install dirs.
 *
 * @param preferred explicit path (e.g. from the GO_BIN env var) to trust first.
 */
export function resolveGoBin(preferred?: string): GoBinResolution {
  const searched: string[] = [];

  if (preferred) {
    searched.push(preferred);
    if (existsSync(preferred)) return { bin: preferred, source: 'GO_BIN', searched };
    // Explicit but wrong — stop here rather than falling back.
    return { bin: preferred, source: 'missing', searched };
  }

  // A bare `go` on PATH is the normal case for a system-wide install.
  if (commandExists('go')) return { bin: 'go', source: 'PATH', searched };

  for (const dir of knownGoDirs()) {
    const candidate = join(dir, 'bin', `go${EXE}`);
    searched.push(candidate);
    if (existsSync(candidate)) return { bin: candidate, source: 'known-dir', searched };
  }

  return { bin: `go${EXE}`, source: 'missing', searched };
}

/** The directory holding the toolchain's helper binaries. */
export function goBinDir(res: GoBinResolution): string {
  return res.source === 'PATH' ? '' : dirname(res.bin);
}

export interface GoServerResolution {
  launch: LspLaunchSpec | null;
  /** `gopls` when found, `none` when the user gets the degraded path. */
  serverName: string;
  /** Where gopls was found, for the status bar. */
  source: 'PATH' | 'GOPATH' | 'go-env' | 'go-bin-dir' | 'none';
  searched: string[];
  /** Populated when gopls is missing, to explain the consequence. */
  note?: string;
}

/**
 * Locate `gopls`. Order:
 *  1. PATH — a system install.
 *  2. `<go bin dir>/gopls` — side-by-side with the toolchain.
 *  3. `$GOPATH/bin/gopls`, then the conventional `~/go/bin` (`go install`
 *     without an explicit GOPATH puts binaries exactly there).
 *
 * Returns `launch: null` when gopls is absent; the caller degrades to
 * execution-only rather than failing.
 */
export function discoverGoServer(go?: GoBinResolution): GoServerResolution {
  const searched: string[] = [];
  const res = go ?? resolveGoBin();

  if (commandExists('gopls')) {
    return {
      launch: {
        languageId: 'go',
        serverName: 'gopls',
        command: 'gopls',
        args: ['serve'],
        // gopls on PATH does not imply `go` is on PATH; be explicit.
        env: goServerEnv(res),
      },
      serverName: 'gopls',
      source: 'PATH',
      searched,
    };
  }

  const candidates: Array<{ path: string; source: GoServerResolution['source'] }> = [];

  // Alongside the toolchain.
  if (res.source !== 'PATH' && res.source !== 'missing') {
    candidates.push({ path: join(dirname(res.bin), `gopls${EXE}`), source: 'go-bin-dir' });
  }
  // An explicit GOPATH …
  if (process.env.GOPATH) {
    candidates.push({ path: join(process.env.GOPATH, 'bin', `gopls${EXE}`), source: 'GOPATH' });
  }
  // … and the conventional default that `go install` uses when GOPATH is unset.
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) candidates.push({ path: join(home, 'go', 'bin', `gopls${EXE}`), source: 'go-env' });

  for (const c of candidates) {
    searched.push(c.path);
    if (existsSync(c.path)) {
      return {
        launch: {
          languageId: 'go',
          serverName: 'gopls',
          command: c.path,
          args: ['serve'],
          env: goServerEnv(res),
        },
        serverName: 'gopls',
        source: c.source,
        searched,
      };
    }
  }

  return {
    launch: null,
    serverName: 'none',
    source: 'none',
    searched,
    note:
      'gopls not found — Go code still builds and runs, but Check/completion are disabled. ' +
      'Install it with:  go install golang.org/x/tools/gopls@latest',
  };
}

/**
 * Environment for gopls.
 *
 * gopls is not self-contained — it shells out to `go list`/`go env` to compute
 * the build graph. If the toolchain is not on PATH (exactly the case when Go
 * lives in a non-standard directory like `D:\Go lang`), gopls starts happily
 * and then answers every request with "no active builds contain <file>".
 * Handing it PATH + GOROOT is what makes it actually work.
 */
function goServerEnv(res: GoBinResolution): Record<string, string> {
  const env: Record<string, string> = {};
  if (res.source === 'PATH' || res.source === 'missing') return env;
  const binDir = dirname(res.bin);
  const sep = process.platform === 'win32' ? ';' : ':';
  env.PATH = binDir + sep + (process.env.PATH ?? '');
  // GOROOT is the parent of bin/ for every standard Go distribution.
  env.GOROOT = dirname(binDir);
  if (process.env.GOTOOLCHAIN) env.GOTOOLCHAIN = process.env.GOTOOLCHAIN;
  return env;
}

/**
 * `go version` output, or null when the toolchain cannot be invoked.
 *
 * Async on purpose: this spawns a process, and the UI polls `status()`. Callers
 * cache the result rather than awaiting it per render.
 */
export function goVersion(goBin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(goBin, ['version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.on('error', () => done(null));
      child.on('close', (code) => done(code === 0 ? out.trim() || null : null));
      setTimeout(() => {
        child.kill();
        done(null);
      }, 10_000).unref?.();
    } catch {
      done(null);
    }
  });
}
