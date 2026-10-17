/**
 * Faulty demo extension — the counterpart to `demo.hello`.
 *
 * Its whole purpose is to prove the isolation guarantees of spec 阶段 5: a
 * command that throws must surface as an RPC error *without* killing the host,
 * and a command that hard-crashes the process must be detected, counted
 * (`crash.count`) and recovered on the next use.
 */
import type { ExtensionContext } from '../api.js';

export function activate(ctx: ExtensionContext): void {
  ctx.log.info('faulty extension activated', { pid: ctx.host.pid });
}

export async function execute(commandId: string, args: unknown[]): Promise<unknown> {
  switch (commandId) {
    case 'demo.faulty.throw':
      // A rejected promise: the host catches it and answers with a JSON-RPC
      // error, so the kernel sees a failed command but keeps its host alive.
      throw new Error(String(args[0] ?? 'deliberate failure'));

    case 'demo.faulty.crash':
      // Hard exit — no handler can intercept this in the parent, which is the
      // point: the crash must be observed via the child's `exit` event.
      process.exit(23);

    default:
      throw new Error(`unknown command: ${commandId}`);
  }
}

export function deactivate(): void {
  // Never reached for `demo.faulty.crash`; a crash skips the lifecycle hook.
}
