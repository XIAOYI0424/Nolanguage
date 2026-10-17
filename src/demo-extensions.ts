/**
 * Demo: extension host process end-to-end (spec 4.3 / 16.2 / 18.2).
 *
 * Boots a kernel, discovers the built-in `demo.hello` extension, activates it
 * in an isolated child process, and exercises it two ways:
 *   1. directly through `ExtensionManager.runCommand`
 *   2. through the kernel command bus proxy installed by `installCommands`
 *
 * The extension's logs arrive back in the parent as `scope: 'extension'`
 * records (see the console output), proving the cross-process log pipeline.
 */
import { Kernel } from './kernel/Kernel.js';
import { ExtensionManager } from './extensions/ExtensionManager.js';
import { LogLevel } from './log/LogLevel.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function main(): Promise<void> {
  const kernel = new Kernel({
    appVersion: '0.6.0-demo',
    slowThresholdMs: 50,
    store: false,
    logLevel: LogLevel.INFO,
  });
  await kernel.start();
  const log = kernel.logger.root();

  const examplesDir = join(dirname(fileURLToPath(import.meta.url)), 'extensions', 'examples');
  const manager = new ExtensionManager(kernel, { scanDirs: [examplesDir], activateOnStartup: true });
  manager.discoverAll();
  manager.installCommands();
  await manager.activateStartup();

  log.info('Discovered extensions', { count: manager.list().length });
  for (const e of manager.list()) {
    log.info('  extension', { id: e.manifest.id, name: e.manifest.name, compatible: e.compatible });
  }

  // 1. run through the manager
  const greet = await manager.runCommand('demo.hello.greet', 'Nolanguage');
  log.info('manager.runCommand(greet) ->', { result: String(greet) });

  const fib = await manager.runCommand('demo.hello.fib', 14);
  log.info('manager.runCommand(fib,14) ->', { result: String(fib) });

  // 2. run through the kernel command bus proxy (installCommands)
  const viaKernel = await kernel.commands.execute<string>('demo.hello.greet', 'Kernel');
  log.info('kernel.commands.execute(greet) ->', { result: String(viaKernel) });

  // let the host flush its batched logs + emit a heartbeat
  await new Promise((r) => setTimeout(r, 400));

  console.log('\n========== EXTENSION HOST STATUS ==========');
  for (const s of manager.statuses()) {
    console.log(
      `  ${s.extensionId.padEnd(14)} state=${s.state.padEnd(9)} pid=${String(s.pid ?? '-').padEnd(6)} ` +
        `restarts=${s.restarts} crashes=${s.crashes} rss=${s.rssBytes ?? 0}`,
    );
  }

  console.log('\n========== PANEL INFO (what the dev server exposes) ==========');
  console.log(JSON.stringify(manager.panelInfo(), null, 2));

  await manager.dispose();
  await kernel.stop();
  console.log('\nExtension-host demo complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
