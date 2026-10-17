/**
 * Public, extension-facing types (spec 4.3 · 激活模型).
 *
 * An extension entry module exports `activate?` / `deactivate?` / `execute?`.
 * These are the *only* types an extension should import from the kernel — the
 * rest of the surface (the kernel object, the log pipeline, the perf spine)
 * deliberately stays on the other side of the host process boundary.
 */
import type { HostLogCollector } from './HostLogCollector.js';

/** Everything an extension is handed when it is activated. */
export interface ExtensionContext {
  extensionId: string;
  kernelVersion: string;
  sessionId: string;
  /**
   * Batched logger — records travel back to the kernel over the RPC connection
   * and re-surface in the panel / warm tier as `scope: 'extension'` records.
   */
  log: HostLogCollector;
  /** Host process facts (pid, uptime). */
  host: { pid: number; uptimeMs: () => number };
}

/** The shape the kernel loads from an extension entry module. */
export interface ExtensionModule {
  activate?: (ctx: ExtensionContext) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
  /** Called when a contributed command is invoked through the host. */
  execute?: (commandId: string, args: unknown[]) => unknown | Promise<unknown>;
}
