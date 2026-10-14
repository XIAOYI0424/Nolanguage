/**
 * Minimal RFC 6455 client used by the verification scripts. Mirrors the frame
 * format of `src/panel/WebSocketServer.ts` so the tests exercise the real
 * handshake and framing rather than a third-party library.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type WsMessage = { kind: string } & Record<string, unknown>;

export class RawWsClient {
  received: WsMessage[] = [];
  /**
   * Every message ever seen, never cleared by `clearReceived()`. Use this for
   * assertions that need the accumulated stream (logs, metrics digests) rather
   * than the messages since the last request.
   */
  history: WsMessage[] = [];
  ready: Promise<void>;
  private socket: ReturnType<typeof connect>;
  private buffer = Buffer.alloc(0);
  private handshakeBuf = Buffer.alloc(0);
  private hsDone = false;
  private expected = '';
  private closed = false;

  constructor(
    private port: number,
    private path = '/',
    host = '127.0.0.1',
  ) {
    this.socket = connect(port, host);
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('handshake timeout')), 10_000);
      this.socket.on('error', reject);
      this.socket.on('connect', () => {
        const key = randomBytes(16).toString('base64');
        this.expected = createHash('sha1').update(key + GUID).digest('base64');
        this.socket.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${host}:${this.port}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this.socket.on('data', (c: Buffer) => {
        if (!this.hsDone) {
          this.handshakeBuf = Buffer.concat([this.handshakeBuf, c]);
          const idx = this.handshakeBuf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this.handshakeBuf.subarray(0, idx).toString();
          const rest = this.handshakeBuf.subarray(idx + 4);
          this.handshakeBuf = Buffer.alloc(0);
          if (!head.includes('101') || !head.includes(this.expected)) {
            reject(new Error('bad handshake: ' + head.split('\r\n')[0]));
            return;
          }
          this.hsDone = true;
          clearTimeout(timer);
          resolve();
          if (rest.length) this.push(rest);
        } else {
          this.push(c);
        }
      });
    });
  }

  private push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const f = this.parse();
      if (!f) break;
      if (f.opcode === 0x1) {
        try {
          const parsed = JSON.parse(f.payload.toString('utf8')) as WsMessage;
          this.received.push(parsed);
          this.history.push(parsed);
        } catch {
          /* ignore malformed frames */
        }
      } else if (f.opcode === 0x9) {
        this.sendFrame(0xa, f.payload); // reply to ping
      } else if (f.opcode === 0x8) {
        this.closed = true;
        this.socket.end();
      }
    }
  }

  private parse(): { opcode: number; payload: Buffer } | null {
    const b = this.buffer;
    if (b.length < 2) return null;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    if (masked) off += 4;
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    this.buffer = b.subarray(off + len);
    return { opcode, payload };
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(obj: unknown): void {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  /** Wait until a message of `kind` arrives (or timeout). */
  async waitFor(kind: string, timeoutMs = 15_000): Promise<WsMessage | undefined> {
    const t0 = Date.now();
    for (;;) {
      const found = this.received.find((m) => m.kind === kind);
      if (found) return found;
      if (Date.now() - t0 > timeoutMs) return undefined;
      await delay(50);
    }
  }

  /** Wait for a `kind` message that also satisfies `pred` (for repeated kinds). */
  async waitForWhere(
    kind: string,
    pred: (m: WsMessage) => boolean,
    timeoutMs = 15_000,
  ): Promise<WsMessage | undefined> {
    const t0 = Date.now();
    for (;;) {
      const found = this.received.find((m) => m.kind === kind && pred(m));
      if (found) return found;
      if (Date.now() - t0 > timeoutMs) return undefined;
      await delay(50);
    }
  }

  find(kind: string): WsMessage | undefined {
    return this.received.find((m) => m.kind === kind);
  }
  findAll(kind: string): WsMessage[] {
    return this.received.filter((m) => m.kind === kind);
  }
  /** Search the full accumulated stream (survives `clearReceived`). */
  findInHistory(kind: string): WsMessage[] {
    return this.history.filter((m) => m.kind === kind);
  }
  clearReceived(): void {
    this.received = [];
  }
  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.socket.destroy();
  }
}

export { delay };
