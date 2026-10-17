/**
 * Dev entry for the extension host child process.
 *
 *   node --experimental-transform-types src/extensions/host-main.ts \
 *     --manifest <manifest.json> --extension <entry.js>
 *
 * The packaged build reaches the same code through
 * `Nolanguage.exe --extension-host …` (see src/desktop/main.ts).
 */
import { readFileSync } from 'node:fs';
import { HostRunner } from './HostRunner.js';
import { parseManifest } from './Manifest.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const manifestPath = arg('manifest');
const entryPath = arg('extension');
if (!manifestPath || !entryPath) {
  process.stderr.write('usage: host-main --manifest <path> --extension <path>\n');
  process.exit(2);
}

const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
const runner = new HostRunner({
  extensionId: manifest.id,
  entryPath,
  // Placeholders only: the real values arrive in the `activate` request, when
  // the parent tells the child which kernel/session it belongs to.
  kernelVersion: arg('kernel-version') ?? '0.0.0',
  sessionId: arg('session') ?? 'host',
});
process.stderr.write(`[extension-host] ${manifest.id} up (pid ${process.pid})\n`);
void runner.run();
