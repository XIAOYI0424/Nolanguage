/**
 * JSON-RPC 2.0 over a child process's stdio, using the LSP base protocol
 * framing (`Content-Length: N\r\n\r\n<json>`). Zero dependencies.
 *
 * This is the layer that gets **instrumented** (spec 阶段 3: "RPC 埋点"):
 * every outbound request/notification and every inbound response is timed and
 * reported to the perf spine as `rpc.roundtrip.<method>` / `rpc.notify.<method>`,
 * and wrapped in a span so it shares the traceId correlation skeleton with logs.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcHooks {
  /** Called after each request completes (or fails). */
  onRoundtrip?: (info: {
    method: string;
    durationMs: number;
    ok: boolean;
    id: number | string;
    traceId?: string;
  }) => void;
  /** Called for each outbound notification. */
  onNotify?: (method: string) => void;
  /** Called for each inbound server notification/request. */
  onInbound?: (msg: JsonRpcMessage) => void;
  /**
   * Resolve the ambient traceId at request-send time, so the roundtrip can be
   * correlated with the span/log that triggered it even after the span ends.
   */
  resolveTraceId?: () => string | undefined;
}

export interface RpcClientOptions {
  /** Max time to wait for a response before rejecting. */
  timeoutMs?: number;
  hooks?: RpcHooks;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  t0: number;
  traceId?: string;
}

/**
 * Framed JSON-RPC client bound to a duplex stream pair (usually a child
 * process's stdin/stdout). Emits 'notification' for server-initiated messages.
 */
export class JsonRpcConnection extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  // Explicitly `Buffer` (== `Buffer<ArrayBufferLike>`): `chunk` and
  // `subarray()` both widen to `ArrayBufferLike`, and inferring the narrow
  // `Buffer<ArrayBuffer>` from `alloc(0)` rejects them.
  private stdoutBuf: Buffer = Buffer.alloc(0);
  private closed = false;
  private opts: Required<Pick<RpcClientOptions, 'timeoutMs'>> & RpcClientOptions;

  constructor(
    private input: NodeJS.WritableStream,
    private output: NodeJS.ReadableStream,
    opts: RpcClientOptions = {},
  ) {
    super();
    this.opts = { timeoutMs: opts.timeoutMs ?? 20_000, hooks: opts.hooks };
    this.output.on('data', (chunk: Buffer) => this.onData(chunk));
    this.output.on('end', () => this.handleClose());
    this.output.on('error', () => this.handleClose());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Number of in-flight requests (used for the panel / leak detection). */
  get inFlight(): number {
    return this.pending.size;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`RPC connection closed (method=${method})`));
    const id = this.nextId++;
    const t0 = performance.now();
    const traceId = this.opts.hooks?.resolveTraceId?.();
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.opts.hooks?.onRoundtrip?.({
          method, durationMs: performance.now() - t0, ok: false, id, traceId,
        });
        reject(new Error(`RPC timeout after ${this.opts.timeoutMs}ms: ${method}`));
      }, this.opts.timeoutMs);
      this.pending.set(id, {
        method,
        t0,
        timer,
        traceId,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.write(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
    this.opts.hooks?.onNotify?.(method);
  }

  /** Send a response to a server-initiated request. */
  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  /** Send an error response to a server-initiated request. */
  respondError(id: number | string, code: number, message: string, data?: unknown): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message, data } });
  }

  private write(msg: JsonRpcMessage): void {
    const json = JSON.stringify(msg);
    const body = Buffer.from(json, 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    try {
      this.input.write(Buffer.concat([header, body]));
    } catch (err) {
      this.handleClose();
      void err;
    }
  }

  private onData(chunk: Buffer): void {
    this.stdoutBuf = this.stdoutBuf.length ? Buffer.concat([this.stdoutBuf, chunk]) : chunk;
    for (;;) {
      const parsed = this.tryParse();
      if (!parsed) break;
      this.dispatch(parsed);
      if (this.closed) break;
    }
  }

  /** Parse one `Content-Length`-framed message from the head of the buffer. */
  private tryParse(): JsonRpcMessage | null {
    const buf = this.stdoutBuf;
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      // Guard against a server that writes non-framed text to stdout.
      if (buf.length > 1_000_000) this.stdoutBuf = Buffer.alloc(0);
      return null;
    }
    const header = buf.subarray(0, headerEnd).toString('ascii');
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) {
      this.stdoutBuf = buf.subarray(headerEnd + 4);
      return null;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buf.length < start + len) return null;
    const body = buf.subarray(start, start + len).toString('utf8');
    this.stdoutBuf = buf.subarray(start + len);
    try {
      return JSON.parse(body) as JsonRpcMessage;
    } catch {
      this.emit('parseError', body);
      return null;
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const p = this.pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(id);
      const durationMs = performance.now() - p.t0;
      if (msg.error) {
        this.opts.hooks?.onRoundtrip?.({ method: p.method, durationMs, ok: false, id, traceId: p.traceId });
        // Keep the JSON-RPC code: -32601 (method not found) is how a server says
        // "I do not implement that", which callers must distinguish from a real
        // failure. String-matching the message would be fragile across servers.
        const err = new Error(`RPC error ${msg.error.code}: ${msg.error.message}`) as Error & { rpcCode?: number };
        err.rpcCode = msg.error.code;
        p.reject(err);
      } else {
        this.opts.hooks?.onRoundtrip?.({ method: p.method, durationMs, ok: true, id, traceId: p.traceId });
        p.resolve(msg.result);
      }
      return;
    }
    // Server -> client notification or request.
    this.opts.hooks?.onInbound?.(msg);
    if (msg.method) this.emit('notification', msg);
    if (msg.id !== undefined && msg.method) this.emit('request', msg);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`RPC connection closed before response: ${p.method}`));
    }
    this.pending.clear();
    this.emit('close');
  }

  dispose(): void {
    this.handleClose();
  }
}

/** Convenience: build an RPC connection over a spawned child process. */
export function connectChildProcess(
  child: ChildProcessWithoutNullStreams,
  opts?: RpcClientOptions,
): JsonRpcConnection {
  return new JsonRpcConnection(child.stdin, child.stdout, opts);
}
