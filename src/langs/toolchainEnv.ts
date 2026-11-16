/**
 * The toolchain's directory, prepended to a child process's PATH.
 *
 * Split out of `lspLaunch.ts` because the manager adapter needs the same rule and
 * `lspLaunch` already imports the manager's types — two modules reaching for one
 * helper is cheaper than one of them owning it.
 */
import { delimiter, dirname } from 'node:path';

/**
 * Put the language's toolchain on the server's PATH.
 *
 * Several servers are not self-contained: gopls shells out to `go`, and a
 * toolchain found through `manifest.run.discovery` may live somewhere PATH does
 * not cover (a known path, an env var). Without this, gopls starts, then answers
 * every request with "no views" — which reads as "gopls is broken" rather than
 * "gopls cannot find go".
 *
 * Returns undefined when there is nothing to add, so callers can omit `env`
 * entirely and inherit the parent environment unchanged.
 */
export function toolchainEnv(toolchain: string | undefined, base = process.env): Record<string, string> | undefined {
  if (!toolchain) return undefined;
  const dir = dirname(toolchain);
  const current = base.PATH ?? base.Path ?? '';
  const parts = current.split(delimiter).filter(Boolean);
  // Case-insensitive on Windows: `D://Go//bin` and `d://go//bin` are one entry.
  const same = (a: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === dir.toLowerCase() : a === dir;
  if (parts.some(same)) return undefined;
  return { PATH: [dir, current].filter(Boolean).join(delimiter) };
}
