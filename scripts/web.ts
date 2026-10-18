/**
 * `nlg web` — launch the workspace and open it in the system's default browser.
 *
 * This is the "web" face of Nolanguage: a local HTTP+WebSocket server rendered
 * by whatever browser the OS prefers. The packaged `Nolanguage.exe --open-browser`
 * reaches the same place; this script is the dev/CLI twin.
 *
 *   nlg web            start the server and open the default browser
 *   nlg web --no-open  start the server only (CI / headless — prints the URL)
 */
import { main as startServer } from '../src/panel/server.js';
import { openSystemBrowser } from '../src/desktop/WebViewHost.js';

process.env.NOLANGUAGE_QUIET ??= '1';

const noOpen = process.argv.includes('--no-open');

async function run(): Promise<void> {
  const { base } = await startServer();
  if (!noOpen) openSystemBrowser(`${base}/`);
  process.stdout.write(
    `\n` +
      `  Nolanguage (web) — workspace served at ${base}/\n` +
      `    Monitor   ${base}/monitor\n` +
      `    Perf     ${base}/perf\n` +
      `\n` +
      `  Close this window (Ctrl+C) to stop the server.\n\n`,
  );
}

run().catch((err: unknown) => {
  process.stderr.write(`nlg web failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
