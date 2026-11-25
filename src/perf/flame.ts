/**
 * Kernel flame sampler (the IDE's "Kernel Performance Flame Graph" window).
 *
 * The engine already exposes *what* took time (metrics, slow paths), but not
 * *where inside the kernel* the time went. This module answers that with the
 * V8 CPU profiler driven through `node:inspector`: the same engine as
 * `--cpu-prof`, except the samples are harvested every second while the kernel
 * keeps serving requests. So the user can run a program and watch the call
 * tree heat up at the same time.
 *
 * Scope is the kernel process by design: the panel server, the command/event
 * buses, the language servers' event loop. A user program runs in its own
 * child process, and its own hotspots belong to the user-code profiler.
 *
 * Two rules shape the implementation:
 *  - one profile session for the whole server (V8 allows no more), shared by
 *    every attached IDE window through `subscribe` / `unsubscribe`;
 *  - sampling stops when the last window closes, so an idle IDE never pays for
 *    the profiler's bookkeeping.
 */
import { Session } from 'node:inspector';

export type FlameNodeKind = 'kernel' | 'js' | 'native' | 'idle' | 'gc';

export interface FlameNode {
  name: string;
  /** Source URL as V8 reports it (`file:///…` for user code, `node:` for internals). */
  url: string;
  /** 1-based source line; 0 when V8 has none. */
  line: number;
  /** Time spent in this frame itself (samples attributed to it). */
  selfMs: number;
  /** Self time plus every child's total. */
  totalMs: number;
  kind: FlameNodeKind;
  children: FlameNode[];
}

/** One attributed memory holder (a language server, the kernel itself, …). */
export interface MemoryService {
  name: string;
  bytes: number;
}

/**
 * Memory sample taken at the same instant as a CPU frame.
 *
 * CPU time answers "who is burning cycles"; this answers "who is holding the
 * heap" — the two questions the flame window exists for. `services` is
 * attribution the host can actually prove (a language server is a separate
 * process with a measurable RSS), not an estimate.
 */
export interface MemorySample {
  /** Resident set of the kernel process. */
  rss: number;
  /** V8 heap in use — the part the kernel itself caused. */
  heapUsed: number;
  /** Buffers/typed arrays outside the JS heap. */
  external: number;
  services: MemoryService[];
}

export interface FlameFrame {
  kind: 'flame';
  at: number;
  ok: boolean;
  /** `v8-profile` when the inspector answered; the UI shows `error` otherwise. */
  source: 'v8-profile' | 'error';
  error?: string;
  /** How often a frame is pushed, milliseconds. */
  intervalMs: number;
  /** Call frames the profile contained. */
  samples: number;
  /** Wall time covered by this snapshot. */
  totalMs: number;
  /** Time that was *not* idle or GC — the number the window headlines. */
  busyMs: number;
  root?: FlameNode;
  /** Present when the host supplied a `memory` probe. */
  memory?: MemorySample;
}

export type FlameSink = (frame: FlameFrame) => void;

/** Shape of the bits of a V8 CPU profile this module reads. */
interface CpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount?: number;
  children?: number[];
}

interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

const MAX_NODES = 3000;
const MAX_DEPTH = 64;
const MAX_CHILDREN = 60;

/** `(idle)` is the kernel waiting for work — not load, so it is not "busy". */
function isIdle(name: string): boolean {
  return /^\(idle\)$/.test(name);
}

function isGc(name: string): boolean {
  return /^\(garbage collector\)$/i.test(name) || /^\(gc\)$/i.test(name);
}

function kindOf(name: string, url: string): FlameNodeKind {
  if (isIdle(name)) return 'idle';
  if (isGc(name)) return 'gc';
  if (url.startsWith('node:') || url.startsWith('internal/')) return 'native';
  return 'js';
}

/** Trim a URL to something a human can read in a 240px column. */
function shortUrl(url: string): string {
  if (!url) return '';
  const noScheme = url.replace(/^file:\/\/\/?/, '');
  const i = noScheme.lastIndexOf('/src/');
  return i >= 0 ? noScheme.slice(i + 1) : noScheme;
}

function emptyRoot(): FlameNode {
  return {
    name: '(kernel)',
    url: '',
    line: 0,
    selfMs: 0,
    totalMs: 0,
    kind: 'kernel',
    children: [],
  };
}

/**
 * Collapse a V8 CPU profile into a flame tree with millisecond widths.
 *
 * V8 reports `samples` (node id per sample) and `timeDeltas` (microseconds
 * since the previous sample); summing the deltas per node is the self time.
 * `hitCount` is the fallback for profiles that carry no sample arrays.
 */
export function buildFlameTree(profile: CpuProfile, intervalMs: number): FlameFrame {
  const nodes = new Map<number, CpuProfileNode>();
  for (const n of profile.nodes) nodes.set(n.id, n);

  const selfUs = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  if (samples.length) {
    for (let i = 0; i < samples.length; i++) {
      const id = samples[i];
      const d = deltas[i] ?? (deltas.length ? deltas[deltas.length - 1] : 0);
      selfUs.set(id, (selfUs.get(id) ?? 0) + Math.max(0, d));
    }
  } else {
    for (const n of profile.nodes) {
      if (n.hitCount) selfUs.set(n.id, n.hitCount * intervalMs * 1000);
    }
  }

  let budget = MAX_NODES;
  let idleUs = 0;
  let busyUs = 0;

  const walk = (node: CpuProfileNode, depth: number): FlameNode | null => {
    if (budget <= 0) return null;
    budget--;
    const cf = node.callFrame;
    const name = cf.functionName || '(anonymous)';
    const self = (selfUs.get(node.id) ?? 0) / 1000;
    const kind = kindOf(name, cf.url);
    if (kind === 'idle') idleUs += self;
    else if (kind !== 'gc') busyUs += self;

    const out: FlameNode = {
      name,
      url: cf.url ?? '',
      line: (cf.lineNumber ?? -1) + 1,
      selfMs: self,
      totalMs: self,
      kind,
      children: [],
    };
    if (depth >= MAX_DEPTH) return out;

    const kids = (node.children ?? [])
      .map((id) => nodes.get(id))
      .filter((n): n is CpuProfileNode => !!n)
      .map((n) => walk(n, depth + 1))
      .filter((n): n is FlameNode => !!n)
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, MAX_CHILDREN);
    out.children = kids;
    for (const k of kids) out.totalMs += k.totalMs;
    return out;
  };

  const head = profile.nodes[0];
  const root = head ? (walk(head, 0) ?? emptyRoot()) : emptyRoot();
  // V8's head frame is `(root)`; name it after the thing being measured so the
  // window's bottom bar reads "kernel" instead of an implementation detail.
  root.name = '(kernel)';
  root.kind = 'kernel';
  root.url = '';
  const wallMs = Math.max(0, (profile.endTime - profile.startTime) / 1000);
  root.totalMs = Math.max(root.totalMs, wallMs);

  return {
    kind: 'flame',
    at: Date.now(),
    ok: true,
    source: 'v8-profile',
    intervalMs,
    samples: profile.nodes.length,
    totalMs: Math.max(wallMs, root.totalMs),
    busyMs: busyUs || Math.max(0, root.totalMs - idleUs),
    root,
  };
}

/**
 * One sampler per kernel. Attached IDE windows are sinks; the sampler starts on
 * the first subscription and shuts the profiler down when the last one leaves.
 */
export interface FlameSamplerOptions {
  /** Per-frame memory attribution, supplied by the host (workspace/kernel). */
  memory?: () => MemorySample;
  /** Windows allowed to share the profiler. */
  maxSinks?: number;
}

export class FlameSampler {
  private session: Session | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sinks = new Set<FlameSink>();
  private intervalMs = 1000;
  private busy = false;
  private running = false;
  private last: FlameFrame | null = null;
  private readonly maxSinks: number;

  constructor(private opts: FlameSamplerOptions = {}) {
    this.maxSinks = opts.maxSinks ?? 8;
  }

  get sampling(): boolean {
    return this.running;
  }

  /** Attach one window. Pushes the previous frame immediately when there is one. */
  subscribe(sink: FlameSink, intervalMs?: number): void {
    if (this.sinks.size >= this.maxSinks && !this.sinks.has(sink)) {
      sink(this.failure('too many flame windows open'));
      return;
    }
    this.sinks.add(sink);
    const wanted = intervalMs ? Math.min(10_000, Math.max(250, Math.round(intervalMs))) : this.intervalMs;
    const changed = wanted !== this.intervalMs;
    this.intervalMs = wanted;
    if (this.last) sink(this.last);
    if (!this.running) void this.start();
    else if (changed && this.timer) {
      // The subscriber chose a different cadence; the existing timer keeps the
      // old one unless it is rebuilt.
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.snapshot(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  unsubscribe(sink: FlameSink): void {
    this.sinks.delete(sink);
    if (!this.sinks.size) void this.stop();
  }

  private emit(frame: FlameFrame): void {
    this.last = frame;
    for (const sink of [...this.sinks]) {
      try {
        sink(frame);
      } catch {
        this.sinks.delete(sink);
      }
    }
  }

  private failure(error: string): FlameFrame {
    return {
      kind: 'flame',
      at: Date.now(),
      ok: false,
      source: 'error',
      error,
      intervalMs: this.intervalMs,
      samples: 0,
      totalMs: 0,
      busyMs: 0,
    };
  }

  private post<T>(method: string, params?: object): Promise<T> {
    const s = this.session;
    if (!s) return Promise.reject(new Error('profiler session is not connected'));
    return new Promise<T>((resolve, reject) => {
      s.post(method, params ?? {}, (err, result) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve(result as T);
      });
    });
  }

  private async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const session = new Session();
      session.connect();
      this.session = session;
      await this.post('Profiler.enable');
      // V8 takes microseconds; ~1 ms per sample keeps 1 Hz frames cheap and
      // still fine-grained enough to rank functions.
      await this.post('Profiler.setSamplingInterval', { interval: 1000 });
      await this.post('Profiler.start');
      this.timer = setInterval(() => void this.snapshot(), this.intervalMs);
      this.timer.unref?.();
    } catch (err) {
      this.running = false;
      this.cleanup();
      this.emit(this.failure(`CPU profiler unavailable: ${(err as Error).message}`));
    }
  }

  private async snapshot(): Promise<void> {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const { profile } = await this.post<{ profile: CpuProfile }>('Profiler.stop');
      await this.post('Profiler.start');
      const frame = buildFlameTree(profile, this.intervalMs);
      if (this.opts.memory) {
        // Memory is advisory: a probe failure must not end the CPU sampling.
        try {
          frame.memory = this.opts.memory();
        } catch {
          /* keep the CPU frame */
        }
      }
      this.emit(frame);
    } catch (err) {
      this.running = false;
      this.cleanup();
      this.emit(this.failure(`CPU profiler stopped: ${(err as Error).message}`));
    } finally {
      this.busy = false;
    }
  }

  private cleanup(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const s = this.session;
    this.session = null;
    if (!s) return;
    try {
      s.disconnect();
    } catch {
      /* already gone */
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.session && this.running) {
      try {
        await this.post('Profiler.stop');
        await this.post('Profiler.disable');
      } catch {
        /* the session may already be gone */
      }
    }
    this.running = false;
    this.cleanup();
  }
}
