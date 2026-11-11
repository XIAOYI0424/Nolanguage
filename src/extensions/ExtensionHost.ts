/**
 * ExtensionHost — the *parent* side of the extension host (spec 阶段 5).
 *
 * Owns one child process per extension and is the only thing the kernel talks
 * to. Responsibilities, in the order the spec lists them:
 *
 *  1. **子进程隔离** — extension code never runs in the kernel process.
 *  2. **RPC 埋点** — every roundtrip lands as `rpc.roundtrip.extension.<method>`
 *     with the caller's traceId (via the shared correlation skeleton).
 *  3. **HostLogCollector 汇聚** — the child pushes log batches; they are
 *     re-hydrated into the kernel's LogPipeline with
 *     `scope: 'extension'` + `extensionId` + `hostId` + child pid, so
 *     extension logs appear in the panel and the warm tier like any other
 *     record (spec 16.2 / 18.2).
 *  4. **宿主指标** — `memory.rss` from each heartbeat, `crash.count` on an
 *     unexpected exit, and automatic restart (bounded, see `maxCrashes`).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import { ulid } from '../util/ulid.js';
import type { Kernel } from '../kernel/Kernel.js';
import { connectChildProcess } from '../lsp/jsonrpc.js';
import { isPackaged } from '../assets/embeddedAssets.js';
import { LogLevel } from '../log/LogLevel.js';
import type { LogRecord } from '../log/types.js';
import type { RegisteredExtension } from './ExtensionRegistry.js';
import { PROTOCOL, type HostState, type LogBatchParams } from './protocol.js';

export interface ExtensionHostOptions {
  manifestPath: string;
  entryPath: string;
  extensionId: string;
  /** Restarts tolerated inside `crashWindowMs` before giving up. */
  maxCrashes?: number;
  crashWindowMs?: number;
  /** Ready / activate timeouts. */
  readyTimeoutMs?: number;
  activateTimeoutMs?: number;
  heartbeatMs?: number;
}

export interface ExtensionHostStatus {
  extensionId: string;
  state: HostState;
  hostId: string;
  pid?: number;
  restarts: number;
  crashes: number;
  rssBytes?: number;
  uptimeMs?: number;
  logRecords: number;
  lastError?: string;
}

const READY_DEFAULT = 15_000;

/**
 * Resolve a source-tree path (relative to this module) into the forward-slash,
 * cwd-relative form the host child process needs. Falls back to the cwd when
 * the module has no `file://` URL (bundled build) — the packaged path never
 * calls this, so the fallback only matters for unusual dev setups.
 */
function sourceRelative(specifier: string): string {
  let absolute: string;
  try {
    absolute = fileURLToPath(new URL(specifier, import.meta.url));
  } catch {
    absolute = resolve(process.cwd(), specifier);
  }
  const rel = relative(process.cwd(), absolute).replace(/\\/g, '/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export class ExtensionHost {
  readonly hostId = `host-${Math.random().toString(36).slice(2, 8)}`;
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: ReturnType<typeof connectChildProcess>;
  private state: HostState = 'idle';
  private readyResolve?: () => void;
  private readyPromise?: Promise<void>;
  private crashes = 0;
  private restarts = 0;
  private crashTimes: number[] = [];
  private logRecords = 0;
  private rssBytes?: number;
  private uptimeMs?: number;
  private lastError?: string;
  private intentionalExit = false;
  private stderrTail = '';
  private startedAt = performance.now();
  private readonly opts: Required<Omit<ExtensionHostOptions, 'manifestPath' | 'entryPath' | 'extensionId'>> &
    Pick<ExtensionHostOptions, 'manifestPath' | 'entryPath' | 'extensionId'>;

  constructor(
    private kernel: Kernel,
    private entry: RegisteredExtension,
    opts: Partial<ExtensionHostOptions> = {},
  ) {
    this.opts = {
      // The manifest lives at `<extension dir>/extension.json`; the registry
      // carries the directory, not the file path, so derive it here.
      manifestPath: opts.manifestPath ?? join(entry.dir, 'extension.json'),
      entryPath: opts.entryPath ?? entry.entryPath,
      extensionId: entry.manifest.id,
      maxCrashes: opts.maxCrashes ?? 3,
      crashWindowMs: opts.crashWindowMs ?? 30_000,
      readyTimeoutMs: opts.readyTimeoutMs ?? READY_DEFAULT,
      activateTimeoutMs: opts.activateTimeoutMs ?? 20_000,
      heartbeatMs: opts.heartbeatMs ?? 2000,
    };
  }

  // ------------------------------------------------------------- lifecycle

  /** Spawn (or reuse) the host and run the extension's `activate`. */
  async activate(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'starting') return this.readyPromise;
    if (this.state === 'crashed') {
      throw new Error(`extension host gave up after repeated crashes: ${this.opts.extensionId}`);
    }
    if (this.state === 'stopping') throw new Error('extension host is shutting down');
    this.state = 'starting';
    this.startedAt = performance.now();
    this.readyPromise = this.spawnAndActivate().catch((err: unknown) => {
      this.state = 'idle';
      this.lastError = (err as Error).message;
      this.readyPromise = undefined;
      throw err;
    });
    return this.readyPromise;
  }

  private async spawnAndActivate(): Promise<void> {
    const args = isPackaged()
      ? // The exe branches into host mode before starting the server.
        ['--extension-host', '--manifest', this.opts.manifestPath, '--extension', this.opts.entryPath]
      : [
          // Resolve `.js` import specifiers back to their `.ts` sources so the
          // host child can run directly from `src/` without a build step.
          '--experimental-loader',
          // Loader path must be a forward-slash path too: a raw `d:\…` absolute
          // makes Node load the loader module as a raw scheme (ERR_UNSUPPORTED_ESM_URL_SCHEME).
          sourceRelative('../../resolve-loader.mjs'),
          '--experimental-transform-types',
          // Use a path relative to cwd as the entry. It MUST use forward slashes:
          // a raw `d:\…` absolute (or `file://` URL) entry makes the child's
          // `import.meta.url` a raw scheme and breaks relative imports
          // (ERR_UNSUPPORTED_ESM_URL_SCHEME).
          sourceRelative('./host-main.ts'),
          '--manifest',
          this.opts.manifestPath,
          '--extension',
          this.opts.entryPath,
        ];
    this.intentionalExit = false;
    this.child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const child = this.child;
    child.stderr!.on('data', (c: Buffer) => {
      this.stderrTail = (this.stderrTail + c.toString()).slice(-4096);
    });

    this.rpc = connectChildProcess(child, {
      timeoutMs: this.opts.activateTimeoutMs,
      hooks: {
        resolveTraceId: () => this.kernel.tracer.currentSpan()?.traceId,
        onRoundtrip: ({ method, durationMs, ok, traceId }) => this.recordRoundtrip(method, durationMs, ok, traceId),
        onNotify: (method) =>
          this.kernel.perfMetric(`rpc.notify.extension.${method}`, 0, {
            unit: 'count',
            scope: 'extension',
            extensionId: this.opts.extensionId,
          }),
        onInbound: (msg) => this.handleInbound(msg),
      },
    });

    // ---- wait for the child to announce itself ----
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      const timer = setTimeout(() => {
        this.readyResolve = undefined;
        reject(new Error(`extension host not ready after ${this.opts.readyTimeoutMs}ms: ${this.opts.extensionId}`));
      }, this.opts.readyTimeoutMs);
      (this as unknown as { _readyTimer?: ReturnType<typeof setTimeout> })._readyTimer = timer;
    });

    child.on('exit', (code) => this.handleExit(code));

    let activateParams: unknown;
    try {
      await ready;
      activateParams = {
        extensionId: this.opts.extensionId,
        entryPath: this.opts.entryPath,
        kernelVersion: this.kernel.appVersion,
        sessionId: this.kernel.sessionId,
      };
      await this.rpc.request(PROTOCOL.activate, activateParams);
      this.state = 'ready';
      this.lastError = undefined;
      const log = this.kernel.logger.forComponent('extensions.host');
      log.info('Extension host ready', {
        extension: this.opts.extensionId,
        hostId: this.hostId,
        pid: child.pid,
        restarts: this.restarts,
      });
      this.kernel.events.emit('extension:activated', { extensionId: this.opts.extensionId, hostId: this.hostId });
    } catch (err) {
      // A host that never became ready is not "crashed" in the interesting
      // sense, but it must not be retried forever either.
      this.crashTimes.push(Date.now());
      this.trimCrashes();
      if (this.crashTimes.length > this.opts.maxCrashes) this.state = 'crashed';
      this.killChild();
      throw err;
    } finally {
      const timer = (this as unknown as { _readyTimer?: ReturnType<typeof setTimeout> })._readyTimer;
      if (timer) clearTimeout(timer);
      this.readyPromise = undefined;
    }
  }

  private handleExit(code: number | null): void {
    if (this.intentionalExit || this.state === 'stopping' || this.state === 'stopped') {
      this.state = this.state === 'stopping' ? 'stopped' : this.state;
      return;
    }
    // Unexpected death: count it, publish it, and allow one more try.
    this.crashes++;
    this.crashTimes.push(Date.now());
    this.trimCrashes();
    const over = this.crashTimes.length > this.opts.maxCrashes;
    this.state = over ? 'crashed' : 'idle';
    this.rpc?.dispose();
    this.rpc = undefined;
    this.child = undefined;
    this.kernel.perfMetric('crash.count', 1, {
      unit: 'count',
      scope: 'extension',
      extensionId: this.opts.extensionId,
    });
    const log = this.kernel.logger.forComponent('extensions.host');
    const fields = {
      extension: this.opts.extensionId,
      hostId: this.hostId,
      code,
      crashes: this.crashes,
      willRestart: !over,
      stderr: this.stderrTail.trim() || undefined,
    };
    if (over) log.error('Extension host crashed too often — giving up', fields);
    else log.warn('Extension host crashed — it will be restarted on next use', fields);
    this.kernel.events.emit('extension:crashed', { extensionId: this.opts.extensionId, hostId: this.hostId, code });
  }

  private trimCrashes(): void {
    const cutoff = Date.now() - this.opts.crashWindowMs;
    this.crashTimes = this.crashTimes.filter((t) => t > cutoff);
  }

  /** Run a contributed command inside the host (auto-activates). */
  async runCommand(id: string, args: unknown[]): Promise<unknown> {
    if (this.state === 'crashed') {
      throw new Error(`extension host gave up after repeated crashes: ${this.opts.extensionId}`);
    }
    await this.activate();
    const res = (await this.rpc!.request(PROTOCOL.commandRun, {
      id,
      args,
      traceId: this.kernel.tracer.currentSpan()?.traceId,
    })) as { ok: boolean; result?: unknown };
    return res?.result ?? null;
  }

  async deactivate(): Promise<void> {
    if (this.state !== 'ready' || !this.rpc) return;
    this.state = 'stopping';
    try {
      await this.rpc.request(PROTOCOL.deactivate, undefined);
    } catch {
      /* the child may already be gone — fine */
    }
    this.state = 'stopped';
    this.killChild();
  }

  async stop(): Promise<void> {
    await this.deactivate();
  }

  private killChild(): void {
    const child = this.child;
    this.intentionalExit = true;
    this.rpc?.dispose();
    this.rpc = undefined;
    if (!child || child.exitCode !== null) {
      this.child = undefined;
      return;
    }
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill();
    void done.then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      this.child = undefined;
    });
  }

  status(): ExtensionHostStatus {
    return {
      extensionId: this.opts.extensionId,
      state: this.state,
      hostId: this.hostId,
      pid: this.child?.pid,
      restarts: this.restarts,
      crashes: this.crashes,
      rssBytes: this.rssBytes,
      uptimeMs: this.uptimeMs,
      logRecords: this.logRecords,
      lastError: this.lastError,
    };
  }

  // ------------------------------------------------------------- internals

  private recordRoundtrip(method: string, durationMs: number, ok: boolean, traceId?: string): void {
    const base = {
      unit: 'ms',
      traceId,
      scope: 'extension' as const,
      extensionId: this.opts.extensionId,
    };
    this.kernel.perfMetric(`rpc.roundtrip.extension.${method}`, durationMs, base);
    this.kernel.perfMetric('rpc.roundtrip', durationMs, base);
    if (!ok) {
      this.kernel.perfMetric(`rpc.error.extension.${method}`, 1, { ...base, unit: 'count' });
      return;
    }
    const slow = this.kernel.checkSlow(`extension:${method}`, durationMs, {
      extensionId: this.opts.extensionId,
      hostId: this.hostId,
      rpcMethod: method,
    });
    if (slow) {
      this.kernel.logger
        .forComponent('extensions.host')
        .warn('Slow extension RPC roundtrip', {
          method,
          durationMs: Math.round(durationMs),
          thresholdMs: this.kernel.slowThresholdMs,
          extension: this.opts.extensionId,
        });
    }
  }

  private handleInbound(msg: { method?: string; params?: unknown }): void {
    switch (msg.method) {
      case PROTOCOL.ready:
        this.readyResolve?.();
        this.readyResolve = undefined;
        return;

      case PROTOCOL.heartbeat: {
        const p = msg.params as { rssBytes?: number; uptimeMs?: number };
        if (typeof p.rssBytes === 'number') {
          this.rssBytes = p.rssBytes;
          this.kernel.perfMetric('memory.rss', p.rssBytes, {
            unit: 'bytes',
            scope: 'extension',
            extensionId: this.opts.extensionId,
          });
        }
        if (typeof p.uptimeMs === 'number') {
          this.uptimeMs = p.uptimeMs;
          this.kernel.perfMetric('extension.uptime', p.uptimeMs, {
            unit: 'ms',
            scope: 'extension',
            extensionId: this.opts.extensionId,
          });
        }
        return;
      }

      case PROTOCOL.logBatch:
        this.ingestBatch(msg.params as LogBatchParams);
        return;

      default:
        return;
    }
  }

  /**
   * Re-hydrate records that arrived from the child into the kernel's log
   * pipeline. They keep their own timestamp / level / traceId and gain the
   * kernel's correlation skeleton plus the host identity, so the panel shows
   * them inline with kernel records and the warm tier can query them.
   */
  private ingestBatch(params: LogBatchParams): void {
    const records = params?.records ?? [];
    if (!records.length) return;
    const correlation = this.kernel.correlation;
    const env = this.kernel.env;
    const pid = this.child?.pid;
    for (const r of records) {
      const record: LogRecord = {
        id: ulid(),
        timestamp: r.timestamp,
        level: r.level,
        message: r.message,
        traceId: r.traceId,
        spanId: r.spanId,
        resource: {
          scope: 'extension',
          component: `extension.${params.extensionId}`,
          extensionId: params.extensionId,
          processId: pid,
          hostId: this.hostId,
        },
        scope: {},
        correlation: {
          gitCommit: correlation.gitCommit(),
          gitBranch: correlation.gitBranch(),
          configHash: correlation.configHash(),
          sessionId: this.kernel.sessionId,
        },
        environment: env,
        fields: r.fields ?? {},
        error: r.error,
        tags: ['extension-host'],
      };
      this.kernel.logPipeline().ingest(record);
      this.logRecords++;
    }
    this.kernel.perfMetric('extension.log.records', records.length, {
      unit: 'count',
      scope: 'extension',
      extensionId: params.extensionId,
    });
  }
}

export { LogLevel };
