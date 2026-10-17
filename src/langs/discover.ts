/**
 * Generic toolchain discovery.
 *
 * Every language used to own a `discover.ts` with its own precedence rules
 * (`PYTHON_BIN` → PATH → known dirs; `GO_BIN` → PATH → install dirs; …). The
 * rules were never language-specific — they were *policy*, and policy belongs
 * in the manifest:
 *
 *   env var  →  known absolute paths  →  PATH lookup
 *
 * The env var comes first because that is the documented escape hatch when a
 * machine has several toolchains installed. `knownPaths` come next because a
 * Windows install frequently does not touch PATH at all (this machine's Go is
 * `D:\Go lang`, never added to PATH). PATH is last because it is the least
 * specific answer.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { commandExists } from '../lsp/LspClient.js';
import type { BinaryDiscoverySpec } from '../runtimes/types.js';

export interface BinaryResolution {
  /** Resolved path, or the bare command name when only PATH matched. */
  bin: string;
  /** Which rule matched: `env:GO_BIN` / `known` / `path` / `missing`. */
  source: string;
}

/** Expand `~` and make relative known-paths absolute against `cwd`. */
export function expandPath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

/** Resolve a toolchain from a manifest discovery block. Synchronous and cheap. */
export function discoverBinary(spec: BinaryDiscoverySpec | undefined): BinaryResolution {
  if (!spec) return { bin: '', source: 'missing' };

  for (const name of spec.envVars ?? []) {
    const value = process.env[name];
    if (value && value.trim()) {
      const p = expandPath(value.trim());
      if (existsSync(p)) return { bin: p, source: `env:${name}` };
    }
  }

  for (const known of spec.knownPaths ?? []) {
    const p = expandPath(known);
    if (existsSync(p)) return { bin: p, source: 'known' };
  }

  for (const cmd of spec.commands ?? []) {
    if (commandExists(cmd)) return { bin: cmd, source: 'path' };
  }

  return { bin: spec.commands?.[0] ?? '', source: 'missing' };
}

/**
 * Probe a binary's version with a short, non-blocking run.
 *
 * Async `spawn` on purpose: `spawnSync` is blocked in this environment and
 * would freeze the panel while a toolchain boots.
 */
export function probeVersion(bin: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolvePromise) => {
    if (!bin) {
      resolvePromise(null);
      return;
    }
    let settled = false;
    const done = (v: string | null): void => {
      if (!settled) {
        settled = true;
        resolvePromise(v);
      }
    };
    // Imported lazily so this module stays usable from a browser-ish context.
    void import('node:child_process').then(({ spawn }) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, args, { windowsHide: true });
      } catch {
        done(null);
        return;
      }
      let out = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(null);
      }, timeoutMs);
      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.stderr?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        done(out.trim().split('\n')[0] ?? null);
      });
    });
  });
}
