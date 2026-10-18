/**
 * Test stub for `node:sqlite`.
 *
 * Vite 5 (the bundler inside vitest 1.x) has a hard-coded builtin list that
 * predates `node:sqlite`: it strips the `node:` prefix, then fails to resolve a
 * bare `sqlite` package, so the whole suite dies while collecting imports —
 * before a single test runs.
 *
 * `vitest.config.ts` aliases `node:sqlite` here so collection always succeeds.
 * The kernel unit tests never open a database (they construct `new Kernel()`
 * with the default `store: false`), so the stub only needs the shape; any
 * attempt to actually query throws a message that names the cause instead of
 * producing a confusing "not a function".
 */
export class DatabaseSync {
  constructor(readonly path?: string) {}

  exec(_sql: string): void {
    throw new Error('node:sqlite stub: unit tests run without a database (pass store:false)');
  }

  prepare(_sql: string): never {
    throw new Error('node:sqlite stub: unit tests run without a database (pass store:false)');
  }

  close(): void {}
}

export default { DatabaseSync };
