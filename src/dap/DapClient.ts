/**
 * DapClient — a zero-dependency DAP client over the same framed JSON-RPC
 * transport the language servers use (`lsp/jsonrpc.ts`). No DAP library, no
 * dependency: DAP is JSON-RPC with `Content-Length` framing exactly like LSP.
 *
 * This is the substrate half of Phase 6's "DAP runtime". The other half is a
 * manifest block (`debug`) that says which adapter to use and how to find it,
 * so the debugger — like the runner, the profiler and the language server —
 * is declared rather than coded.
 *
 * Session lifecycle (mirrors what every DAP adapter expects):
 *
 *   initialize → launch → configurationDone → setBreakpoints →
 *   (stopped → stackTrace → scopes → variables)* → continue → disconnect
 *
 * The client only kicks off the requests that keep the adapter moving; the
 * callbacks (`onStopped`, `onOutput`, `onTerminated`) are where an IDE tool
 * window would render. Splitting the transport from the rendering is what lets
 * this run headless in tests.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonRpcConnection } from '../lsp/jsonrpc.js';
import type { Kernel } from '../kernel/Kernel.js';

export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsSetVariable?: boolean;
  supportsTerminateRequest?: boolean;
  [k: string]: unknown;
}

export interface DapStackFrame {
  id: number;
  name: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface DapLaunch {
  /** Command to start the adapter with, already resolved. */
  command: string;
  args?: string[];
  /** DAP `initialize.adapterID` and `launch.type`. */
  adapterId: string;
  /** Extra `launch` arguments the adapter needs (program, stopOnEntry …). */
  launchArgs?: Record<string, unknown>;
  /** Working directory for the adapter process. */
  cwd?: string;
  /** How long to wait for `initialize` before giving up. */
  initTimeoutMs?: number;
}

export interface DapSession {
  capabilities: DapCapabilities;
  stackFrames: DapStackFrame[];
  scopes: DapScope[];
  variables: DapVariable[];
  output: string[];
  terminated: boolean;
}

export type DapEventName = 'stopped' | 'output' | 'terminated' | 'thread';

export interface DapHandlers {
  onStopped?: (info: { threadId: number; reason: string }) => void;
  onOutput?: (text: string, category: string) => void;
  onTerminated?: () => void;
}

const CLIENT_ID = 'nolanguage';
const CLIENT_NAME = 'Nolanguage';

export class DapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DapError';
  }
}

export class DapClient {
  private conn: JsonRpcConnection | undefined;
  private proc: ChildProcessWithoutNullStreams | undefined;
  private session: DapSession = {
    capabilities: {},
    stackFrames: [],
    scopes: [],
    variables: [],
    output: [],
    terminated: false,
  };
  private running = false;
  private handshakeDone = false;

  constructor(
    private kernel: Kernel,
    private opts: DapLaunch,
    private handlers: DapHandlers = {},
  ) {}

  /** True once the handshake has completed and the adapter is running. */
  get ready(): boolean {
    return this.handshakeDone && this.running;
  }

  get current(): DapSession {
    return this.session;
  }

  /**
   * Spawn the adapter, handshake, launch, and mark configuration done.
   *
   * `stopOnEntry` defaults to true: a debugger that runs to completion before
   * the UI attaches is a debugger that never breaks, which is the most
   * confusing failure mode this client could have.
   */
  async start(): Promise<DapCapabilities> {
    const log = this.kernel.logger.forComponent('dap.client');
    this.running = true;
    const child = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = child;
    child.stderr?.on('data', (c: Buffer) => {
      // Adapters log to stderr; forward it as debug output rather than swallowing.
      this.handlers.onOutput?.(c.toString('utf8'), 'stderr');
    });
    child.on('error', (err) => {
      log.error('DAP adapter failed to start', { adapter: this.opts.adapterId }, err);
      this.running = false;
    });

    this.conn = new JsonRpcConnection(child.stdin, child.stdout, {
      timeoutMs: this.opts.initTimeoutMs ?? 20_000,
      hooks: {
        onInbound: (msg) => this.onInbound(msg),
        onRoundtrip: (info) => {
          this.kernel.perfMetrics().record(`rpc.roundtrip.dap.${info.method}`, info.durationMs);
        },
      },
    });

    try {
      const init = await this.request<{ capabilities?: DapCapabilities }>('initialize', {
        clientID: CLIENT_ID,
        clientName: CLIENT_NAME,
        adapterID: this.opts.adapterId,
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
      });
      this.session.capabilities = init?.capabilities ?? {};
      await this.request('launch', {
        type: this.opts.adapterId,
        ...(this.opts.launchArgs ?? {}),
        stopOnEntry: this.opts.launchArgs?.stopOnEntry ?? true,
      });
      await this.notify('initialized');
      await this.request('configurationDone');
      this.handshakeDone = true;
      log.info('DAP session ready', { adapter: this.opts.adapterId });
      return this.session.capabilities;
    } catch (err) {
      await this.stop().catch(() => undefined);
      throw err;
    }
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const conn = this.conn;
    if (!conn) return Promise.reject(new DapError(`DAP client is not connected (${method})`));
    return conn.request<T>(method, params);
  }

  private notify(method: string, params?: unknown): void {
    this.conn?.notify(method, params);
  }

  /** Server-initiated traffic: events, plus the odd reverse request. */
  private onInbound(msg: { method?: string; id?: number; params?: unknown }): void {
    if (msg.id !== undefined && msg.method) {
      // A reverse request (runInTerminal, startDebugging). Answer so the adapter
      // is not left hanging on a promise it will never get.
      this.conn?.respondError(msg.id, -32601, `reverse request not supported: ${msg.method}`);
      return;
    }
    if (!msg.method) return;
    const p = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'stopped':
        this.handlers.onStopped?.({
          threadId: Number(p.threadId ?? 1),
          reason: String(p.reason ?? ''),
        });
        break;
      case 'output':
        this.session.output.push(String(p.output ?? ''));
        this.handlers.onOutput?.(String(p.output ?? ''), String(p.category ?? 'console'));
        break;
      case 'terminated':
        this.session.terminated = true;
        this.handlers.onTerminated?.();
        break;
      default:
        break;
    }
  }

  /** Set breakpoints for one file, replacing whatever was there before. */
  async setBreakpoints(file: string, lines: number[]): Promise<unknown> {
    return this.request('setBreakpoints', {
      source: { path: file },
      breakpoints: lines.map((line) => ({ line })),
    });
  }

  /** Pull the stack for the stopped thread. */
  async stackTrace(threadId = 1): Promise<DapStackFrame[]> {
    const r = await this.request<{ stackFrames?: Array<Record<string, unknown>> }>('stackTrace', { threadId });
    this.session.stackFrames = (r.stackFrames ?? []).map((f) => ({
      id: Number(f.id ?? 0),
      name: String(f.name ?? ''),
      file: (f.source as { path?: string } | undefined)?.path,
      line: typeof f.line === 'number' ? f.line : undefined,
      column: typeof f.column === 'number' ? f.column : undefined,
    }));
    return this.session.stackFrames;
  }

  /** Scopes for the top frame. */
  async scopes(frameId: number): Promise<DapScope[]> {
    const r = await this.request<{ scopes?: DapScope[] }>('scopes', { frameId });
    this.session.scopes = r.scopes ?? [];
    return this.session.scopes;
  }

  /** Variables inside one scope. */
  async variables(variablesReference: number): Promise<DapVariable[]> {
    const r = await this.request<{ variables?: DapVariable[] }>('variables', { variablesReference });
    this.session.variables = r.variables ?? [];
    return this.session.variables;
  }

  async continue_(threadId = 1): Promise<void> {
    await this.request('continue', { threadId });
  }

  async stepOver(threadId = 1): Promise<void> {
    await this.request('next', { threadId });
  }

  async stepIn(threadId = 1): Promise<void> {
    await this.request('stepIn', { threadId });
  }

  async stepOut(threadId = 1): Promise<void> {
    await this.request('stepOut', { threadId });
  }

  async stop(): Promise<void> {
    if (this.conn && !this.session.terminated) {
      try {
        await this.request('disconnect', { terminateDebuggee: true });
      } catch {
        // An adapter that already died does not need a graceful goodbye.
      }
    }
    this.conn = undefined;
    this.proc?.kill();
    this.proc = undefined;
    this.running = false;
  }
}
