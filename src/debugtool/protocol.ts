/**
 * Wire format for the live debug observatory (v1).
 *
 * One JSON object per line (NDJSON) over a loopback TCP socket. The agent lives
 * *inside* the observed process; this module is the contract between it and the
 * engine, plus the validation that keeps a buggy (or hostile) agent from
 * corrupting the engine's state.
 *
 * Three rules the whole design leans on:
 *
 *   1. **Version first.** A `v` mismatch is fatal and explicit; the engine never
 *      guesses at unknown fields.
 *   2. **Unknown is not fatal.** A future agent may send an event type this
 *      build has never heard of; that is dropped, not disconnected — otherwise
 *      every protocol addition would break older tools.
 *   3. **Everything is bounded.** A line has a byte ceiling and every event
 *      carries its own limits, so one enormous object cannot stall the reader.
 *
 * The shapes here are deliberately flat and string-heavy: numbers that arrive as
 * strings (`v: "12.5"`) keep JavaScript's float formatting out of the picture,
 * and the agent is free to send `repr`-free text.
 */

/** Bump when a field's meaning changes; additive fields do not need a bump. */
export const PROTOCOL_VERSION = 1;

/** Hard ceiling for one NDJSON line (agent side must truncate before sending). */
export const MAX_LINE_BYTES = 256 * 1024;

/** Reader-side ceiling; beyond this the engine drops lines and counts them. */
export const MAX_EVENTS_PER_SEC = 500;

/** One entry of a sampled stack, innermost last. */
export interface Frame {
  /** Function name as the runtime reports it (`<module>`, `lambda`, `anonymous`). */
  fn: string;
  /** File name only — absolute paths leak the user's directory layout. */
  file: string;
  line: number;
}

export type ThreadState = 'running' | 'blocked' | 'idle';

export interface HelloEvent {
  v: number;
  t: 'hello';
  /** Shared secret from `NLG_DEBUG_TOKEN`; a mismatch closes the socket. */
  token?: string;
  lang: string;
  pid: number;
  /** Script the process is running, for the page header. */
  target: string;
  agentVersion: string;
  /** `stack`, `snapshot`, `watch`, `exception`, `metric` — what it can send. */
  caps: string[];
}

export interface StackEvent {
  v: number;
  t: 'stack';
  at: number;
  /** Thread id, as the runtime reports it. */
  tid: number;
  state: ThreadState;
  frames: Frame[];
}

/** Serialized value tree; see `serializer.ts` for the invariants. */
export type SNode =
  | { k: 'prim'; t: 'int' | 'float' | 'str' | 'bool' | 'none'; v: string }
  | { k: 'seq'; t: string; n: number; items: SNode[]; more?: number }
  | { k: 'map'; t: string; n: number; entries: Array<[SNode, SNode]>; more?: number }
  | { k: 'obj'; t: string; fields: Array<[string, SNode]>; more?: number; cycle?: string }
  | { k: 'trunc'; why: 'depth' | 'size' | 'unsupported' | 'redacted'; t?: string };

export interface SnapshotEvent {
  v: number;
  t: 'snapshot';
  id: string;
  at: number;
  /** Expression or path the snapshot was taken from (`locals`, `self.order`). */
  path: string;
  value: SNode;
}

export interface WatchEvent {
  v: number;
  t: 'watch';
  at: number;
  id: string;
  ok: boolean;
  value?: SNode;
  error?: string;
}

export interface ExceptionEvent {
  v: number;
  t: 'exception';
  at: number;
  tid: number;
  type: string;
  message: string;
  frames: Frame[];
}

export interface MetricEvent {
  v: number;
  t: 'metric';
  at: number;
  name: string;
  value: number;
  unit: string;
}

export interface ByeEvent {
  v: number;
  t: 'bye';
  reason: string;
}

export type AgentEvent =
  | HelloEvent
  | StackEvent
  | SnapshotEvent
  | WatchEvent
  | ExceptionEvent
  | MetricEvent
  | ByeEvent;

/** Commands the engine sends to the agent. */
export type ToolCommand =
  | { v: number; t: 'hello-ack'; sampleHz: number; maxDepth: number; watches: string[]; redact: string[] }
  | { v: number; t: 'set-watches'; watches: string[] }
  | { v: number; t: 'snapshot'; id: string; path: string }
  | { v: number; t: 'bye' };

export type ParseResult =
  | { ok: true; event: AgentEvent }
  | { ok: false; reason: string; fatal: boolean };

/**
 * Parse one line.
 *
 * `fatal` means "stop talking to this agent": bad JSON or a version mismatch is
 * unrecoverable (the stream is misaligned or the contract is different). An
 * unknown type or a malformed payload is not — the agent may be newer, or one
 * event may be broken while the rest of the stream is fine.
 */
export function parseAgentEvent(line: string, expectedVersion = PROTOCOL_VERSION): ParseResult {
  const text = line.trim();
  if (!text) return { ok: false, reason: 'empty', fatal: false };
  if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) return { ok: false, reason: 'line too large', fatal: true };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not json', fatal: true };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object', fatal: true };
  const obj = raw as Record<string, unknown>;

  const v = obj.v;
  if (typeof v !== 'number' || v !== expectedVersion) {
    return { ok: false, reason: `protocol version ${String(v)} != ${expectedVersion}`, fatal: true };
  }
  const t = obj.t;
  if (typeof t !== 'string') return { ok: false, reason: 'missing type', fatal: true };

  switch (t) {
    case 'hello': {
      const lang = str(obj.lang);
      if (!lang) return { ok: false, reason: 'hello without lang', fatal: true };
      return {
        ok: true,
        event: {
          v,
          t: 'hello',
          lang,
          pid: num(obj.pid, 0),
          target: str(obj.target) ?? '',
          agentVersion: str(obj.agentVersion) ?? 'unknown',
          caps: Array.isArray(obj.caps) ? obj.caps.filter((c): c is string => typeof c === 'string') : [],
          ...(typeof obj.token === 'string' ? { token: obj.token } : {}),
        },
      };
    }
    case 'stack': {
      const frames = parseFrames(obj.frames);
      if (!frames) return { ok: false, reason: 'stack without frames', fatal: false };
      return {
        ok: true,
        event: {
          v,
          t: 'stack',
          at: num(obj.at, Date.now()),
          tid: num(obj.tid, 0),
          state: obj.state === 'blocked' || obj.state === 'idle' ? obj.state : 'running',
          frames,
        },
      };
    }
    case 'snapshot': {
      const value = parseNode(obj.value);
      if (!value) return { ok: false, reason: 'snapshot without a valid tree', fatal: false };
      return {
        ok: true,
        event: {
          v,
          t: 'snapshot',
          id: str(obj.id) ?? '',
          at: num(obj.at, Date.now()),
          path: str(obj.path) ?? '',
          value,
        },
      };
    }
    case 'watch': {
      const ok = obj.ok === true;
      return {
        ok: true,
        event: {
          v,
          t: 'watch',
          at: num(obj.at, Date.now()),
          id: str(obj.id) ?? '',
          ok,
          ...(ok ? { value: parseNode(obj.value) ?? { k: 'trunc' as const, why: 'unsupported' as const } } : {}),
          ...(typeof obj.error === 'string' ? { error: obj.error } : {}),
        },
      };
    }
    case 'exception': {
      return {
        ok: true,
        event: {
          v,
          t: 'exception',
          at: num(obj.at, Date.now()),
          tid: num(obj.tid, 0),
          type: str(obj.type) ?? 'Error',
          message: str(obj.message) ?? '',
          frames: parseFrames(obj.frames) ?? [],
        },
      };
    }
    case 'metric': {
      const name = str(obj.name);
      if (!name) return { ok: false, reason: 'metric without name', fatal: false };
      return {
        ok: true,
        event: { v, t: 'metric', at: num(obj.at, Date.now()), name, value: num(obj.value, 0), unit: str(obj.unit) ?? '' },
      };
    }
    case 'bye':
      return { ok: true, event: { v, t: 'bye', reason: str(obj.reason) ?? '' } };
    default:
      // Newer agent, older tool: drop the line, keep the connection.
      return { ok: false, reason: `unknown event "${t}"`, fatal: false };
  }
}

/** Encode a command as one NDJSON line. */
export function encodeCommand(cmd: ToolCommand): string {
  return JSON.stringify(cmd) + '\n';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function parseFrames(v: unknown): Frame[] | null {
  if (!Array.isArray(v)) return null;
  const out: Frame[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const fn = str(f.fn);
    if (!fn) continue;
    out.push({ fn, file: str(f.file) ?? '', line: num(f.line, 0) });
  }
  return out;
}

/** Structural validation of a serialized tree — see `validateNode`. */
export function parseNode(v: unknown, depth = 0): SNode | null {
  if (depth > 64) return null; // a self-referential payload must not recurse forever
  if (!v || typeof v !== 'object') return null;
  const n = v as Record<string, unknown>;
  switch (n.k) {
    case 'prim': {
      const t = n.t;
      if (t !== 'int' && t !== 'float' && t !== 'str' && t !== 'bool' && t !== 'none') return null;
      return { k: 'prim', t, v: typeof n.v === 'string' ? n.v : String(n.v ?? '') };
    }
    case 'seq': {
      const items = Array.isArray(n.items) ? n.items.map((i) => parseNode(i, depth + 1)) : [];
      if (items.some((i) => i === null)) return null;
      return {
        k: 'seq',
        t: str(n.t) ?? 'seq',
        n: num(n.n, items.length),
        items: items as SNode[],
        ...(typeof n.more === 'number' && n.more > 0 ? { more: n.more } : {}),
      };
    }
    case 'map': {
      if (!Array.isArray(n.entries)) return null;
      const entries: Array<[SNode, SNode]> = [];
      for (const e of n.entries) {
        if (!Array.isArray(e) || e.length !== 2) return null;
        const k = parseNode(e[0], depth + 1);
        const val = parseNode(e[1], depth + 1);
        if (!k || !val) return null;
        entries.push([k, val]);
      }
      return {
        k: 'map',
        t: str(n.t) ?? 'map',
        n: num(n.n, entries.length),
        entries,
        ...(typeof n.more === 'number' && n.more > 0 ? { more: n.more } : {}),
      };
    }
    case 'obj': {
      if (!Array.isArray(n.fields)) return null;
      const fields: Array<[string, SNode]> = [];
      for (const f of n.fields) {
        if (!Array.isArray(f) || f.length !== 2) return null;
        const key = str(f[0]);
        const val = parseNode(f[1], depth + 1);
        if (!key || !val) return null;
        fields.push([key, val]);
      }
      return {
        k: 'obj',
        t: str(n.t) ?? 'object',
        fields,
        ...(typeof n.more === 'number' && n.more > 0 ? { more: n.more } : {}),
        ...(typeof n.cycle === 'string' ? { cycle: n.cycle } : {}),
      };
    }
    case 'trunc': {
      const why = n.why;
      if (why !== 'depth' && why !== 'size' && why !== 'unsupported' && why !== 'redacted') return null;
      return { k: 'trunc', why, ...(typeof n.t === 'string' ? { t: n.t } : {}) };
    }
    default:
      return null;
  }
}
