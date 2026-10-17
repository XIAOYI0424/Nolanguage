/**
 * Demo extension (spec 4.3 · 扩展示例).
 *
 * This module is loaded *inside* an isolated host process — it never sees the
 * kernel object. It receives an {@link ExtensionContext} on `activate` and is
 * invoked via `execute` when one of its contributed commands runs. All logging
 * goes through `ctx.log`, which the host batches and ships back to the kernel
 * (visible in the panel as `scope: 'extension'` records).
 *
 * Run it with:  npm run demo:extensions
 */
import type { ExtensionContext } from '../api.js';

/**
 * Set by `activate`. Kept module-local (not on `ctx`) so the demo shows the
 * two sides of an extension: lifecycle wiring in `activate`, work in
 * `execute`.
 */
let log: ExtensionContext['log'] | undefined;

export function activate(ctx: ExtensionContext): void {
  log = ctx.log;
  ctx.log.info('hello extension activated', {
    extension: ctx.extensionId,
    kernel: ctx.kernelVersion,
  });
}

export async function execute(commandId: string, args: unknown[]): Promise<unknown> {
  // Logging here proves the trace correlation: the host attaches the caller's
  // traceId for the duration of the command, so this record can be fused with
  // the span that triggered it.
  log?.info('executing command', { commandId, args });
  switch (commandId) {
    case 'demo.hello.greet': {
      const name = typeof args[0] === 'string' ? (args[0] as string) : 'world';
      return `Hello, ${name}! (from extension ${'demo.hello'})`;
    }
    case 'demo.hello.fib': {
      const n = Number(args[0] ?? 10);
      let a = 0;
      let b = 1;
      for (let i = 0; i < n; i++) {
        const t = a + b;
        a = b;
        b = t;
      }
      return a;
    }
    default:
      throw new Error(`unknown command: ${commandId}`);
  }
}

export function deactivate(): void {
  log?.info('hello extension stopping');
}

