/**
 * Minimal RFC 6455 WebSocket server (server -> client frames + text/close/ping
 * parsing). Implemented from scratch so Stage 2 has **zero third-party
 * dependencies** and runs on a machine without network access to npm.
 *
 * Scope (deliberately small, matching the kernel's "mechanism only" philosophy):
 *  - HTTP upgrade handshake with Sec-WebSocket-Accept (SHA-1 + RFC 6455 GUID).
 *  - Text/Binary/Close/Ping/Pong frame parsing, including client masking.
 *  - Payload lengths 7-bit / 16-bit / 64-bit.
 *  - Fragmented (continuation) frames on the read path.
 *  - Origin checking on the upgrade, because a WebSocket handshake bypasses the
 *    same-origin policy and this server can read and write local files.
 *  - `createWebSocketServer({ port, host, onConnection })`.
 */
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Hostnames that mean "this machine". A page served from any of these on the
 * bound port is the app itself; anything else is a third-party origin.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const OPCODE = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export interface WsServerOptions {
  port: number;
  host?: string;
  /** Extra HTTP routes; return true if handled. Used for /health. */
  onRequest?: (req: IncomingMessage, res: import('node:http').ServerResponse) => boolean;
  /** Auto ping interval to keep intermediaries from closing idle sockets. */
  pingIntervalMs?: number;
  /**
   * Extra origins allowed to upgrade, on top of the loopback origins derived
   * from the bound port. `['*']` disables the check entirely.
   */
  allowedOrigins?: string[];
}

export interface WsServerEvents {
  connection: (socket: WebSocketConnection, req: IncomingMessage) => void;
}

/**
 * A single server-side WebSocket connection. Frames are delivered as
 * 'message' (decoded text) / 'close' / 'error' events.
 */
export class WebSocketConnection extends EventEmitter {
  readonly remoteAddress: string;
  private socket: Duplex;
  private closed = false;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode: number | null = null;
  private lastPong = Date.now();

  constructor(socket: Duplex, req: IncomingMessage) {
    super();
    this.socket = socket;
    this.remoteAddress = req.socket.remoteAddress ?? 'unknown';
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.handleClose());
    socket.on('error', (err: Error) => this.onSocketError(err));
  }

  /**
   * A socket error is almost always just the peer going away (ECONNRESET /
   * ECONNABORTED mid-write) — routine, not exceptional.
   *
   * The important part is the `listenerCount` guard: `EventEmitter` *throws* on
   * an unhandled 'error' event, so blindly re-emitting a socket error here would
   * let one disconnecting client take down the whole server. We only surface it
   * when somebody is actually listening; otherwise we close quietly.
   */
  private onSocketError(err: Error): void {
    this.handleClose();
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get idleMs(): number {
    return Date.now() - this.lastPong;
  }

  // ---------------- write path ----------------

  /** Send a text frame (JSON payloads are stringified by the caller). */
  send(data: string): void {
    this.writeFrame(OPCODE.TEXT, Buffer.from(data, 'utf8'));
  }

  sendBinary(data: Buffer): void {
    this.writeFrame(OPCODE.BINARY, data);
  }

  ping(): void {
    this.writeFrame(OPCODE.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    try {
      this.writeFrame(OPCODE.CLOSE, payload);
    } catch {
      /* ignore */
    }
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    this.emit('close');
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    // A half-dead socket (peer gone, FIN received) accepts writes without
    // throwing and then fails asynchronously. Checking first turns that into a
    // clean close instead of an error event nobody asked for.
    const sock = this.socket as Duplex & { destroyed?: boolean };
    if (sock.destroyed || sock.writable === false) {
      this.handleClose();
      return;
    }
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.handleClose();
    }
  }

  // ---------------- read path ----------------

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // Parse as many complete frames as the buffer holds.
    for (;;) {
      const frame = this.tryParseFrame();
      if (!frame) break;
      this.handleFrame(frame);
      if (this.closed) break;
    }
  }

  private tryParseFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close(1009, 'frame too large');
        return null;
      }
      len = Number(big);
      offset += 8;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  private handleFrame(frame: { fin: boolean; opcode: number; payload: Buffer }): void {
    const { fin, opcode, payload } = frame;
    switch (opcode) {
      case OPCODE.PING:
        this.writeFrame(OPCODE.PONG, payload);
        return;
      case OPCODE.PONG:
        this.lastPong = Date.now();
        return;
      case OPCODE.CLOSE:
        this.closed = true;
        try {
          this.writeFrame(OPCODE.CLOSE, payload);
        } catch {
          /* ignore */
        }
        this.socket.end();
        this.emit('close');
        return;
      case OPCODE.CONT: {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          const op = this.fragmentOpcode ?? OPCODE.TEXT;
          this.fragments = [];
          this.fragmentOpcode = null;
          this.dispatch(op, full);
        }
        return;
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (!fin) {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
          return;
        }
        this.dispatch(opcode, payload);
        return;
      default:
        this.close(1002, 'unsupported opcode');
    }
  }

  private dispatch(opcode: number, payload: Buffer): void {
    if (opcode === OPCODE.TEXT) {
      this.emit('message', payload.toString('utf8'));
    } else {
      this.emit('messageBinary', payload);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

export class WebSocketServer extends EventEmitter {
  private http: Server;
  private connections = new Set<WebSocketConnection>();
  private pingTimer?: ReturnType<typeof setInterval>;
  private opts: WsServerOptions;
  /** The port actually bound, which differs from `opts.port` when it is 0. */
  private boundPort: number;

  constructor(opts: WsServerOptions) {
    super();
    this.opts = opts;
    this.boundPort = opts.port;
    this.http = createServer((req, res) => {
      if (this.opts.onRequest?.(req, res)) return;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    });
    this.http.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Duplex, head));
  }

  /**
   * Decide whether an upgrade may proceed.
   *
   * WebSocket handshakes are **exempt from the same-origin policy** — the
   * browser will happily open a socket to `ws://127.0.0.1:<port>` from any page
   * the user happens to be visiting, so the server has to refuse. That matters
   * here because the panel can list, read, write and delete files: an
   * unchecked upgrade is a local file-disclosure hole reachable from a single
   * `<script>` on a random website.
   *
   * Browsers always send `Origin` on a WebSocket upgrade. Native clients — the
   * verification suites, a future CLI — send none, and are allowed, because
   * they are already outside the browser's protection model.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') return true;
    const extra = this.opts.allowedOrigins;
    if (extra?.includes('*')) return true;
    if (extra?.includes(origin)) return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false; // `Origin: null` (sandboxed / file://) and other junk
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return port === this.boundPort;
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (head.length) socket.unshift(head);
    const conn = new WebSocketConnection(socket, req);
    this.connections.add(conn);
    conn.on('close', () => this.connections.delete(conn));
    this.emit('connection', conn, req);
  }

  listen(): Promise<{ port: number; host: string }> {
    const host = this.opts.host ?? '127.0.0.1';
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.opts.port, host, () => {
        const addr = this.http.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        this.boundPort = port;
        const pingMs = this.opts.pingIntervalMs ?? 30_000;
        this.pingTimer = setInterval(() => {
          for (const c of this.connections) {
            if (c.idleMs > pingMs * 2) c.close(1001, 'idle timeout');
            else c.ping();
          }
        }, pingMs);
        this.pingTimer.unref?.();
        resolve({ port, host });
      });
    });
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.connections) c.close(1001, 'server shutting down');
    this.connections.clear();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
