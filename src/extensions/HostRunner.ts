/**
 * HostRunner — the *child* side of the extension host.
 *
 * Runs in a dedicated process (spawned by `ExtensionHost`), speaks the JSON-RPC
 * protocol in `protocol.ts` over stdio, and does the one thing the kernel
 * refuses to do: **import and run extension code**. A throwing, hanging or
 * crashing extension can therefore only take down this process — which the
 * parent detects (`exit` event), counts (`crash.count`) and restarts.
 *
 * It is reached two ways:
 *   - source runs: `node --experimental-transform-types src/extensions/host-main.ts`
 *   - packaged:   `Nolanguage.exe --extension-host` (src/desktop/main.ts branch)
 *
 * stdout is the RPC transport, so this module never writes to it directly.
 */
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { JsonRpcConnection } from '../lsp/jsonrpc.js';
import { HostLogCollector } from './HostLogCollector.js';
import type { ExtensionModule, ExtensionContext } from './api.js';
import {
  PROTOCOL,
  type ActivateParams,
  type CommandRunParams,
  type HeartbeatParams,
  type LogBatchParams,
  type ReadyParams,
} from './protocol.js';

export interface HostRunnerOptions {
  /** Heartbeat cadence; the first one is sent right after `ready`. */
  heartbeatMs?: number;
}

export class HostRunner {
  private rpc: JsonRpcConnection;
  private log!: HostLogCollector;
  private mod?: ExtensionModule;
  private active = false;
  private startedAt = performance.now();
  private heartbeat?: ReturnType<typeof setInterval>;
  private opts: HostRunnerOptions;

  constructor(private params: ActivateParams, opts: HostRunnerOptions = {}) {
    this.opts = opts;
    // Child side: outbound (write) goes to stdout (parent reads it), inbound
    // (read) comes from stdin (parent writes it).
    this.rpc = new JsonRpcConnection(process.stdout, process.stdin);
    this.rpc.on('close', () => {
      this.log?.stop();
      process.exit(this.active ? 0 : 0);
    });
    // Server-initiated requests from the parent.
    this.rpc.on('request', (msg: { id: number | string; method: string; params?: unknown }) => {
      void this.handle(msg.id, msg.method, msg.params).then(
        (result) => this.rpc.respond(msg.id, result),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          // An extension blowing up must not kill the host: report, stay alive.
          this.rpc.respondError(msg.id, -32000, message);
          this.log?.error('command failed', { method: msg.method }, err);
        },
      );
    });
  }

  /** Start listening. Resolves once `activate` (and `ready`) have been sent. */
  async run(): Promise<void> {
    const ready: ReadyParams = {
      extensionId: this.params.extensionId,
      pid: process.pid,
    };
    this.rpc.notify(PROTOCOL.ready, ready);
    const beat = this.opts.heartbeatMs ?? 2000;
    const beatNow = (): void => {
      const params: HeartbeatParams = {
        extensionId: this.params.extensionId,
        rssBytes: process.memoryUsage.rss(),
        uptimeMs: Math.round(performance.now() - this.startedAt),
        active: this.active,
      };
      this.rpc.notify(PROTOCOL.heartbeat, params);
    };
    beatNow();
    this.heartbeat = setInterval(beatNow, beat);
  }

  // ------------------------------------------------------------ handlers

  private async handle(id: number | string, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case PROTOCOL.ping:
        return { pong: true, pid: process.pid };

      case PROTOCOL.activate: {
        if (this.active) return { ok: true, alreadyActive: true };
        const p = params as Partial<ActivateParams>;
        const entryPath = p.entryPath ?? this.params.entryPath;
        // The parent knows the real kernel version / session; adopt them so the
        // context an extension sees is accurate (the argc placeholders are only
        // a fallback for hand-launched hosts).
        if (p.kernelVersion) this.params.kernelVersion = p.kernelVersion;
        if (p.sessionId) this.params.sessionId = p.sessionId;
        this.log = new HostLogCollector({
          extensionId: p.extensionId ?? this.params.extensionId,
          push: (records) => {
            const batch: LogBatchParams = {
              extensionId: p.extensionId ?? this.params.extensionId,
              records,
            };
            this.rpc.notify(PROTOCOL.logBatch, batch);
          },
        });
        this.log.start();
        this.mod = (await import(pathToFileURL(entryPath).href)) as ExtensionModule;
        const ctx: ExtensionContext = {
          extensionId: this.params.extensionId,
          kernelVersion: this.params.kernelVersion,
          sessionId: this.params.sessionId,
          log: this.log,
          host: { pid: process.pid, uptimeMs: () => Math.round(performance.now() - this.startedAt) },
        };
        this.log.info('extension host starting', {
          extension: this.params.extensionId,
          entry: entryPath,
          pid: process.pid,
        });
        await this.mod.activate?.(ctx);
        this.active = true;
        this.log.info('extension activated', { extension: this.params.extensionId });
        return { ok: true };
      }

      case PROTOCOL.deactivate: {
        if (!this.active) return { ok: true, alreadyInactive: true };
        await this.mod?.deactivate?.();
        this.active = false;
        this.log.info('extension deactivated', { extension: this.params.extensionId });
        this.log.stop();
        this.rpc.notify(PROTOCOL.deactivated, { extensionId: this.params.extensionId });
        return { ok: true };
      }

      case PROTOCOL.commandRun: {
        const p = (params ?? {}) as CommandRunParams;
        if (!this.active) {
          // Auto-activate on first command so the parent can stay lazy.
          await this.handle(id, PROTOCOL.activate, { entryPath: this.params.entryPath });
        }
        // Extension logs emitted while a command runs carry the caller's trace
        // id, so the panel can fuse them with the span that triggered them.
        this.log.withTrace(p.traceId);
        try {
          const result = await this.mod?.execute?.(p.id, p.args ?? []);
          return { ok: true, result: result ?? null };
        } finally {
          this.log.withTrace(undefined);
        }
      }

      default:
        throw new Error(`unknown method: ${method}`);
    }
  }
}
