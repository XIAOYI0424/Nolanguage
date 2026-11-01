/**
 * One attached program: the socket, the ring buffers, and the aggregates the
 * page reads.
 *
 * The engine is deliberately *dumb about meaning and strict about memory*. It
 * stores bounded rings of raw events, and computes the derived views (hot
 * stacks, stalls, watch history) on demand — recomputing 2,000 samples costs
 * microseconds and avoids a class of bugs where an incremental aggregate drifts
 * from the raw data it claims to summarise.
 *
 * The agent is untrusted: it is a program we injected into, not a program we
 * wrote. So every line is validated, oversized lines are refused, and a
 * protocol violation closes the socket instead of poisoning the buffers.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import {
  MAX_EVENTS_PER_SEC,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  encodeCommand,
  parseAgentEvent,
  type AgentEvent,
  type Frame,
  type SNode,
  type StackEvent,
} from './protocol.js';
import { detectStalls, effectiveHz, foldStacks, type HotStack, type Stall, type StackSample } from './sampler.js';

export type SessionState = 'listening' | 'attached' | 'detached' | 'closed' | 'rejected';

export interface WatchView {
  expr: string;
  at: number;
  ok: boolean;
  value?: SNode;
  error?: string;
  /** Last N numeric values, for a sparkline. Empty for non-numbers. */
  history: number[];
}

export interface SnapshotView {
  id: string;
  at: number;
  path: string;
  value: SNode;
}

export interface SessionView {
  state: SessionState;
  /** Set once the agent says hello. */
  target?: string;
  lang?: string;
  pid?: number;
  agentVersion?: string;
  caps?: string[];
  hz: number;
  /** Measured, not requested. */
  actualHz: number;
  samples: number;
  snapshots: SnapshotView[];
  watches: WatchView[];
  hot: HotStack[];
  stalls: Stall[];
  exceptions: Array<{ at: number; type: string; message: string; frames: Frame[] }>;
  dropped: number;
  badLines: number;
  /** Reason for `rejected`, for the page header. */
  note?: string;
}

export interface SessionOptions {
  /** Sample rate handed to the agent. */
  hz?: number;
  /** Samples kept for the hot-stack view (default 2000 ≈ 3 min at 10 Hz). */
  maxSamples?: number;
  /** Stack depth the agent should keep. */
  maxDepth?: number;
  /** Extra field names to redact, merged with the agent's defaults. */
  redact?: string[];
}

const DEFAULT_MAX_SAMPLES = 2000;

export class DebugSession extends EventEmitter {
  readonly token: string;
  private readonly opts: Required<Omit<SessionOptions, 'redact'>> & { redact: string[] };
  private server?: Server;
  private socket?: Socket;
  private port = 0;
  private state: SessionState = 'listening';
  private note?: string;

  private samples: StackSample[] = [];
  private snapshotList: SnapshotView[] = [];
  private snapshotById = new Map<string, SnapshotView>();
  private watchMap = new Map<string, WatchView>();
  private exceptions: SessionView['exceptions'] = [];

  private hello?: { target: string; lang: string; pid: number; agentVersion: string; caps: string[] };
  private dropped = 0;
  private badLines = 0;
  private windowCount = 0;
  private windowStart = Date.now();

  constructor(opts: SessionOptions = {}) {
    super();
    this.opts = {
      hz: opts.hz ?? 10,
      maxSamples: opts.maxSamples ?? DEFAULT_MAX_SAMPLES,
      maxDepth: opts.maxDepth ?? 12,
      redact: opts.redact ?? [],
    };
    this.token = randomBytes(16).toString('hex');
  }

  /** Bind to a loopback port. Port 0 lets the OS pick (tests rely on it). */
  async listen(): Promise<{ port: number }> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    return { port: this.port };
  }

  get boundPort(): number {
    return this.port;
  }

  /** Environment the target needs in order to reach this session. */
  agentEnv(): Record<string, string> {
    return {
      NLG_DEBUG_PORT: String(this.port),
      NLG_DEBUG_TOKEN: this.token,
      NLG_DEBUG_HZ: String(this.opts.hz),
    };
  }

  private accept(socket: Socket): void {
    if (this.state !== 'listening') {
      // One program per session: a second connection is either a stray agent or
      // something probing the port. Refuse it rather than multiplexing.
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding('utf8');
    let buffer = '';

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line.trim()) continue;
        this.ingest(line);
      }
      // A single line larger than the ceiling means the agent is not following
      // the protocol; do not grow the buffer to hold it.
      if (buffer.length > MAX_LINE_BYTES * 2) {
        this.reject('line too large');
      }
    });
    socket.on('error', () => this.detach('socket error'));
    socket.on('close', () => this.detach('agent exited'));
  }

  /** Feed one NDJSON line. Public so tests can drive the session directly. */
  ingest(line: string): void {
    if (Date.now() - this.windowStart >= 1000) {
      this.windowStart = Date.now();
      this.windowCount = 0;
    }
    this.windowCount += 1;
    if (this.windowCount > MAX_EVENTS_PER_SEC) {
      this.dropped += 1;
      return;
    }

    const parsed = parseAgentEvent(line, PROTOCOL_VERSION);
    if (!parsed.ok) {
      this.badLines += 1;
      if (parsed.fatal) this.reject(parsed.reason);
      return;
    }
    this.apply(parsed.event);
  }

  private apply(ev: AgentEvent): void {
    switch (ev.t) {
      case 'hello': {
        if (ev.token !== undefined && ev.token !== this.token) {
          this.reject('token mismatch');
          return;
        }
        this.hello = { target: ev.target, lang: ev.lang, pid: ev.pid, agentVersion: ev.agentVersion, caps: ev.caps };
        this.state = 'attached';
        this.send({
          v: PROTOCOL_VERSION,
          t: 'hello-ack',
          sampleHz: this.opts.hz,
          maxDepth: this.opts.maxDepth,
          watches: [...this.watchMap.keys()],
          redact: this.opts.redact,
        });
        this.emit('attached', this.view());
        return;
      }
      case 'stack': {
        this.pushSample(ev);
        return;
      }
      case 'snapshot': {
        const view: SnapshotView = { id: ev.id, at: ev.at, path: ev.path, value: ev.value };
        const prev = this.snapshotById.get(ev.id);
        if (prev) {
          // Live locals reuse one id; keep a single entry so the panel does not
          // fill with 2 Hz history nobody asked for.
          this.snapshotById.set(ev.id, view);
          const at = this.snapshotList.findIndex((s) => s.id === ev.id);
          if (at >= 0) this.snapshotList[at] = view;
        } else {
          this.snapshotById.set(ev.id, view);
          this.snapshotList.push(view);
          if (this.snapshotList.length > 100) {
            const gone = this.snapshotList.shift();
            if (gone) this.snapshotById.delete(gone.id);
          }
        }
        this.emit('snapshot', view);
        return;
      }
      case 'watch': {
        const prev = this.watchMap.get(ev.id);
        const history = prev ? prev.history.slice() : [];
        const numeric = ev.ok && ev.value?.k === 'prim' && (ev.value.t === 'int' || ev.value.t === 'float')
          ? Number(ev.value.v)
          : undefined;
        if (numeric !== undefined && Number.isFinite(numeric)) {
          history.push(numeric);
          if (history.length > 60) history.shift();
        }
        this.watchMap.set(ev.id, {
          expr: ev.id,
          at: ev.at,
          ok: ev.ok,
          ...(ev.value ? { value: ev.value } : {}),
          ...(ev.error ? { error: ev.error } : {}),
          history,
        });
        return;
      }
      case 'exception': {
        this.exceptions.push({ at: ev.at, type: ev.type, message: ev.message, frames: ev.frames });
        if (this.exceptions.length > 50) this.exceptions.shift();
        return;
      }
      case 'metric':
        // Not surfaced yet (M2): kept out of the rings on purpose rather than
        // half-wired into the view.
        return;
      case 'bye':
        this.detach(`agent exited (${ev.reason})`);
        return;
      default:
        return;
    }
  }

  private pushSample(ev: StackEvent): void {
    this.samples.push({ at: ev.at, tid: ev.tid, state: ev.state, frames: ev.frames });
    if (this.samples.length > this.opts.maxSamples) this.samples.splice(0, this.samples.length - this.opts.maxSamples);
  }

  /** Ask the agent for one expression's value (path is evaluated in its frame). */
  requestSnapshot(path: string, id = `snap-${Date.now().toString(36)}`): string {
    this.send({ v: PROTOCOL_VERSION, t: 'snapshot', id, path });
    return id;
  }

  /** Replace the watch list; the agent evaluates them at its own low rate. */
  setWatches(list: string[]): void {
    const clean = [...new Set(list.map((w) => w.trim()).filter(Boolean))].slice(0, 32);
    for (const expr of [...this.watchMap.keys()]) if (!clean.includes(expr)) this.watchMap.delete(expr);
    for (const expr of clean) if (!this.watchMap.has(expr)) this.watchMap.set(expr, { expr, at: 0, ok: false, history: [] });
    this.send({ v: PROTOCOL_VERSION, t: 'set-watches', watches: clean });
  }

  private send(cmd: Parameters<typeof encodeCommand>[0]): void {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(encodeCommand(cmd));
    } catch {
      /* the agent may be gone; the close handler will notice */
    }
  }

  private reject(reason: string): void {
    this.state = 'rejected';
    this.note = reason;
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.emit('rejected', reason);
  }

  private detach(reason: string): void {
    if (this.state === 'closed') return;
    if (this.state !== 'rejected') this.state = 'detached';
    if (!this.note) this.note = reason;
    this.emit('detached', reason);
  }

  /** The aggregate the page renders. Cheap: derived from the rings each call. */
  view(): SessionView {
    const hot = foldStacks(this.samples, { stallSamples: Math.max(3, Math.round(this.opts.hz / 2)) });
    return {
      state: this.state,
      ...(this.hello ? { target: this.hello.target, lang: this.hello.lang, pid: this.hello.pid, agentVersion: this.hello.agentVersion, caps: this.hello.caps } : {}),
      hz: this.opts.hz,
      actualHz: effectiveHz(this.samples),
      samples: this.samples.length,
      snapshots: this.snapshotList.slice(-40),
      watches: [...this.watchMap.values()],
      hot,
      stalls: detectStalls(this.samples, Math.max(3, Math.round(this.opts.hz / 2))).slice(-20),
      exceptions: this.exceptions.slice(-20),
      dropped: this.dropped,
      badLines: this.badLines,
      ...(this.note ? { note: this.note } : {}),
    };
  }

  /** Raw samples, for tests and for the page's timeline when it asks. */
  recentSamples(limit = 200): StackSample[] {
    return this.samples.slice(-limit);
  }

  async close(): Promise<void> {
    this.state = 'closed';
    this.send({ v: PROTOCOL_VERSION, t: 'bye' });
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
