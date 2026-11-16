/**
 * The manager behind a line-delimited JSON protocol on stdio.
 *
 * The panel drives the manager through WebSocket frames; a test (or a person at
 * a terminal) needs something with no browser in the loop. This is that: one
 * request per line in, one response per line out, no framing beyond `\n`.
 *
 *   node --experimental-transform-types --no-warnings \
 *     --experimental-loader ./resolve-loader.mjs scripts/lsp-manager-service.ts \
 *     --home .tmp/svc-home --workspace <project> --manifest <manifest.json>
 *
 *   {"id":1,"op":"completion","file":"/p/A.java","line":9,"character":14}
 *   {"id":1,"ok":true,"items":[...]}
 *
 * Ops: `open`, `completion`, `hover`, `definition`, `diagnostics`, `dirty`,
 * `syncDirty`, `symbols`, `cache`, `stats`, `entries`, `shutdown`.
 *
 * It is a *test* service in the honest sense: it exposes what the manager
 * exposes and nothing else. It does not pretend to be an editor.
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Kernel } from '../src/kernel/Kernel.js';
import { buildManagerPlugin } from '../src/langs/managerPlugins.js';
import type { LanguageManifest } from '../src/langs/manifest.js';
import { LspManager } from '../src/lsp/manager/LspManager.js';
import { pathToFileURL } from 'node:url';

function argOf(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function argsOf(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  }
  return out;
}

const HOME = argOf('home', join(process.cwd(), '.tmp', 'lsp-manager-service'));
const WORKSPACE = argOf('workspace', process.cwd());
const MANIFESTS = argsOf('manifest');

const kernel = new Kernel({ appVersion: 'lsp-manager-service', logSilent: true });
await kernel.start();
const manager = new LspManager({
  kernel,
  home: HOME,
  reapIntervalMs: 0,
  log: (message, meta) => process.stderr.write(`[mgr] ${message} ${meta ? JSON.stringify(meta) : ''}\n`),
});

for (const path of MANIFESTS) {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as LanguageManifest;
  const plugin = await buildManagerPlugin(manifest, { home: HOME, workspaceRoot: WORKSPACE });
  if (plugin) manager.register(plugin);
}

function entryFor(file: string) {
  const plugin = manager.pluginFor(file);
  if (!plugin) throw new Error(`no plugin owns ${file}`);
  const root = plugin.projectRoot(file) ?? WORKSPACE;
  const entry = manager.acquire(plugin.id, root);
  if (!entry) throw new Error(`no pooled entry for ${plugin.id}`);
  return { plugin, root, entry };
}

type Handler = (msg: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  async open(msg) {
    const file = String(msg.file);
    const { entry } = entryFor(file);
    const text = typeof msg.text === 'string' ? msg.text : readFileSync(file, 'utf8');
    const uri = pathToFileURL(file).href;
    await entry.openDocument(uri, text, entry.plugin.id);
    const ready = await entry.waitUntilReady(Number(msg.timeoutMs ?? 120_000));
    return { ready, ...entry.describe() };
  },
  async completion(msg) {
    const file = String(msg.file);
    const { entry } = entryFor(file);
    const items = await entry.completion(pathToFileURL(file).href, {
      line: Number(msg.line ?? 0),
      character: Number(msg.character ?? 0),
    });
    return { items };
  },
  async hover(msg) {
    const file = String(msg.file);
    const { entry } = entryFor(file);
    return entry.hover(pathToFileURL(file).href, {
      line: Number(msg.line ?? 0),
      character: Number(msg.character ?? 0),
    });
  },
  async definition(msg) {
    const file = String(msg.file);
    const { entry } = entryFor(file);
    return entry.definition(pathToFileURL(file).href, {
      line: Number(msg.line ?? 0),
      character: Number(msg.character ?? 0),
    });
  },
  async diagnostics(msg) {
    const file = String(msg.file);
    const { entry } = entryFor(file);
    return entry.waitForDiagnostics(pathToFileURL(file).href, Number(msg.timeoutMs ?? 30_000));
  },
  async dirty(msg) {
    const { plugin, root } = entryFor(String(msg.file));
    return manager.dirty(plugin.id, root, msg.threshold === undefined ? undefined : Number(msg.threshold));
  },
  async syncDirty(msg) {
    const { plugin, root } = entryFor(String(msg.file));
    return manager.syncDirty(plugin.id, root);
  },
  async symbols(msg) {
    return manager.symbols(String(msg.query ?? ''));
  },
  async cache(msg) {
    return manager.cacheState(String(msg.pluginId));
  },
  async stats() {
    return manager.stats();
  },
  async entries() {
    return manager.entries().map((e) => ({ plugin: e.plugin.id, root: e.root, ...e.describe() }));
  },
  async shutdown() {
    await manager.close();
    setTimeout(() => process.exit(0), 20);
    return { bye: true };
  },
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: `bad json: ${(err as Error).message}` })}\n`);
    return;
  }
  const handler = handlers[String(msg.op ?? '')];
  if (!handler) {
    process.stdout.write(`${JSON.stringify({ id: msg.id, ok: false, error: `unknown op ${String(msg.op)}` })}\n`);
    return;
  }
  void handler(msg).then(
    (result) => process.stdout.write(`${JSON.stringify({ id: msg.id, ok: true, ...(result as object) })}\n`),
    (err: Error) => process.stdout.write(`${JSON.stringify({ id: msg.id, ok: false, error: err.message })}\n`),
  );
});

rl.on('close', () => {
  void manager.close().finally(() => process.exit(0));
});
