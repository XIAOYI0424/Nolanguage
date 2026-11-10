/**
 * Vitest configuration.
 *
 * The only non-obvious bit: `src/store/SqliteStore.ts` imports `node:sqlite`
 * (Node 22.5+, stable in 24). Vite's resolver does not treat `sqlite` as a
 * builtin (its list predates the module), so it strips the `node:` prefix and
 * then fails to resolve a bare `sqlite` package — the suite used to die with
 * "Failed to load url sqlite" before running a single test.
 *
 * Two layers of defence, because the failure mode differs by resolver path:
 *   1. `server.deps.external: [/^node:/]` — keep every `node:*` import external
 *      (never bundled, resolved by Node itself).
 *   2. `resolve.alias.sqlite -> node:sqlite` — if anything *does* get the prefix
 *      stripped, the bare specifier still points back at the builtin.
 *
 * `pool: 'forks'` instead of worker threads: `node:sqlite` opens native
 * handles, and a forked process isolates them from the runner.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite's transform cache defaults to a directory under the OS temp folder. On
  // this machine that write can be denied (sandbox, policy, another process), and
  // vitest then **drops the affected file silently**: the summary says "1 passed"
  // while a whole suite never ran. Keeping the cache inside the repo makes the
  // run deterministic and the failure impossible.
  cacheDir: '.tmp/vitest',
  // Vite 5's builtin list predates `node:sqlite`, so it strips the prefix and
  // then fails to resolve a bare `sqlite` package during collection. Declaring
  // `node:*` external and aliasing the module to a stub are both needed in
  // practice: external stops the transform, the alias keeps resolution from
  // ever asking the filesystem for `sqlite`.
  ssr: {
    external: [/^node:/],
  },
  resolve: {
    alias: {
      'node:sqlite': fileURLToPath(new URL('./tests/stubs/node-sqlite.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    server: {
      deps: {
        external: [/^node:/],
      },
    },
  },
});
