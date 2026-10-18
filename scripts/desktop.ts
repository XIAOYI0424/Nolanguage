/**
 * `nlg desktop` — launch the workspace in a native, chrome-less WebView window
 * (the zero-dependency desktop shell described in the project report, §3.9).
 *
 * It reuses the exact entry the packaged `Nolanguage.exe` boots: importing
 * `src/desktop/main.ts` runs its launch dispatch, which opens the WebView window
 * unless `--no-open` / `--no-browser` is passed.
 *
 *   nlg desktop            start the server and open the native window
 *   nlg desktop --no-open  start the server only (CI / headless)
 */
process.env.NOLANGUAGE_QUIET ??= '1';

void import('../src/desktop/main.js').catch((err: unknown) => {
  process.stderr.write(`nlg desktop failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
