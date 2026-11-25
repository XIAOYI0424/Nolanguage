/**
 * Panel transport — the seam between the engine and a UI.
 *
 * A UI talks to this engine in exactly one way: JSON messages in, JSON messages
 * out. That is all `PanelHub` (`PanelSink.send`) and the router in `server.ts`
 * ever see, so *how* those bytes travel is a detail this module owns:
 *
 *   - `WsTransport`     — a browser page over WebSocket (the dev server and
 *                         `npm run ide`; the page may be many).
 *   - `StdioTransport`  — one peer over stdin/stdout, newline-delimited JSON
 *                         (the Tauri sidecar; the peer is exactly one).
 *
 * Keeping the two behind one interface is what lets the engine be driven by
 * either host without a single `if (isTauri)` inside the router, and what makes
 * the pair testable against each other: feed both the same message sequence and
 * the replies must match line for line.
 *
 * A transport never throws from `send` — a vanished peer is normal, and one dead
 * socket must not disturb the engine or the other clients.
 */
import { appendFileSync } from 'node:fs';
import type { WebSocketConnection } from '../net/websocket.js';

/**
 * Debug trace for the stdio transport: when `NOLANGUAGE_STDIO_TRACE` names a
 * file, every inbound frame is appended to it. The pipe itself is opaque (the
 * peer is a Rust relay, or a test), so this is the only way to see what the UI
 * actually sent — which is how a relay bug gets diagnosed at all. Off unless
 * the variable is set, and a failure to write never affects the protocol.
 */
const TRACE_PATH = process.env.NOLANGUAGE_STDIO_TRACE;
function trace(direction: 'in' | 'out', line: string): void {
  if (!TRACE_PATH) return;
  try {
    appendFileSync(TRACE_PATH, `${Date.now()} ${direction} ${line}\n`);
  } catch {
    /* tracing must never break the transport */
  }
}

/**
 * One reply function per client, with a one-way "dead" latch. Keeping the guard
 * here (rather than in the router) means a broken peer can never re-enter a
 * message handler, and routers stay under the architecture line budget.
 */
export function guardedReply(transport: Transport): (payload: unknown) => void {
  let alive = true;
  return (payload: unknown): void => {
    if (!alive) return;
    try {
      transport.send(payload);
    } catch {
      alive = false;
      void transport.close().catch(() => {});
    }
  };
}

export interface Transport {
  /** Deliver one payload to the peer. Never throws. */
  send(payload: unknown): void;
  /** Subscribe to inbound messages, as raw (still unparsed) frames. */
  onMessage(handler: (raw: string) => void): void;
  /** Subscribe to the peer going away. */
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

/** JSON.parse that yields `null` instead of throwing on malformed input. */
export function parseFrame(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** WebSocket transport: one browser tab (or the packaged WebView window). */
export class WsTransport implements Transport {
  constructor(private readonly conn: WebSocketConnection) {}

  send(payload: unknown): void {
    let frame: string;
    try {
      frame = JSON.stringify(payload);
    } catch {
      return; // a frame we cannot serialise is not a reason to kill a client
    }
    try {
      this.conn.send(frame);
    } catch {
      // A broken pipe during send means the peer is already gone. Close this
      // connection so the normal cleanup path unregisters it; never let the
      // exception escape into the message handler that produced the reply.
      void this.close();
    }
  }

  onMessage(handler: (raw: string) => void): void {
    this.conn.on('message', (raw: string) => handler(raw));
  }

  onClose(handler: () => void): void {
    this.conn.on('close', () => handler());
  }

  async close(): Promise<void> {
    try {
      this.conn.close(1001, 'server shutting down');
    } catch {
      /* already closed */
    }
  }
}

export interface StdioStreams {
  in?: NodeJS.ReadableStream;
  out?: NodeJS.WritableStream;
}

/**
 * stdio transport: newline-delimited JSON over a pipe.
 *
 * Newline framing (rather than length-prefixed) is deliberate: the peer is a
 * Rust relay that only has to split on `\n`, and a partial line is buffered
 * rather than parsed — a pipe can deliver a frame in pieces.
 *
 * Output discipline: `stdout` carries protocol lines and nothing else. A banner
 * or a pretty log line written here would desynchronise the peer, so the host
 * runs with the logger silenced (see `server.ts`).
 */
export class StdioTransport implements Transport {
  private readonly streams: Required<StdioStreams>;
  private buffer = '';
  private closed = false;

  constructor(streams: StdioStreams = {}) {
    this.streams = {
      in: streams.in ?? process.stdin,
      out: streams.out ?? process.stdout,
    };
    // A peer that disappears does not make `write` throw — it emits an
    // asynchronous 'error' (EPIPE) on the stream, and an unhandled 'error' takes
    // the whole Node process down. Absorbing it here is what keeps a vanished
    // relay from killing the engine.
    this.streams.out.on?.('error', () => { this.closed = true; });
  }

  send(payload: unknown): void {
    if (this.closed) return;
    const line = JSON.stringify(payload);
    trace('out', line);
    try {
      this.streams.out.write(line + '\n');
    } catch {
      /* pipe gone — treat as a closed peer */
      this.closed = true;
    }
  }

  onMessage(handler: (raw: string) => void): void {
    const input = this.streams.in;
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        // Trimmed so a CRLF peer (or stray whitespace) cannot smuggle a `\r`
        // into the payload; JSON does not care, but the router's string
        // comparisons would.
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) {
          trace('in', line);
          handler(line);
        }
      }
    });
  }

  onClose(handler: () => void): void {
    // Either end of the pipe disappearing means this UI is gone.
    this.streams.in.on('end', () => { this.closed = true; handler(); });
    this.streams.in.on('close', () => { this.closed = true; handler(); });
  }

  async close(): Promise<void> {
    this.closed = true;
    /* the host owns the process lifetime */
  }
}
