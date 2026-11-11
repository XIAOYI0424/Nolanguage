/**
 * Recording and replay: keep what the agent said, and say it again later.
 *
 * The reason this exists is the crash. By the time a program dies, the
 * observatory has already been told everything interesting — the last stacks,
 * the watch that went to `NaN`, the exception — and all of it lives in ring
 * buffers that die with the page. A recording turns that into a file.
 *
 * Three decisions:
 *
 *   1. **The file is the wire format.** Recorded lines are the agent's own
 *      NDJSON, byte for byte, with one `rec-meta` header in front. Replay feeds
 *      them back through the same parser, so a recording cannot drift from the
 *      protocol: if the format changes, old recordings stop parsing and that is
 *      visible immediately rather than after a silent reinterpretation.
 *
 *   2. **Recording never breaks observation.** Every write is best-effort: a
 *      full disk, a locked file or a permission error disables the recorder and
 *      leaves the session alone. A debug tool that dies because it could not
 *      write a log is worse than one with no log.
 *
 *   3. **It is bounded.** `maxBytes` caps the file; past it the recorder stops
 *      and says so in `stats()`, because "record everything" is how a debug tool
 *      fills someone's disk during a long-running session.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const RECORDING_VERSION = 1;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface RecordingHeader {
  v: number;
  t: 'rec-meta';
  /** Wall clock when recording started. */
  at: number;
  tool: string;
  version: string;
  lang: string;
  target: string;
  hz: number;
  redact: string[];
  /**
   * The handshake token of the recorded session.
   *
   * Kept so a replay can reproduce the handshake it recorded. It guards a
   * loopback socket that stopped listening when the session ended, so it is a
   * dead credential rather than a live secret — but it is still a credential,
   * and it is why a recording should be treated as a log rather than a document
   * to publish.
   */
  token?: string;
  /**
   * Present when this file was produced by `--sanitize`. Records what was
   * changed, so a reader can tell a scrubbed recording from a raw one.
   */
  sanitized?: {
    at: number;
    fieldsRedacted: number;
    valuesScrubbed: number;
    tokenRemoved: boolean;
  };
}

export interface RecorderStats {
  path: string;
  bytes: number;
  lines: number;
  /** True once `maxBytes` was reached; nothing after that point was written. */
  truncated: boolean;
  /** Set when the file could not be written at all. */
  error?: string;
}

export class Recorder {
  readonly path: string;
  private fd: number | undefined;
  private bytes = 0;
  private lines = 0;
  private truncated = false;
  private error?: string;
  private readonly maxBytes: number;

  private constructor(path: string, maxBytes: number) {
    this.path = path;
    this.maxBytes = maxBytes;
  }

  /** Open a recording. Returns `undefined` when the path cannot be written. */
  static open(opts: {
    path: string;
    header: Omit<RecordingHeader, 'v' | 't' | 'at'>;
    maxBytes?: number;
  }): Recorder {
    const path = resolve(opts.path);
    const rec = new Recorder(path, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    try {
      mkdirSync(dirname(path), { recursive: true });
      rec.fd = openSync(path, 'w');
      const header: RecordingHeader = { v: RECORDING_VERSION, t: 'rec-meta', at: Date.now(), ...opts.header };
      rec.append(JSON.stringify(header) + '\n');
    } catch (err) {
      rec.error = (err as Error).message;
      rec.fd = undefined;
    }
    return rec;
  }

  private append(text: string): void {
    if (this.fd === undefined) return;
    try {
      writeSync(this.fd, text);
      this.bytes += Buffer.byteLength(text, 'utf8');
    } catch (err) {
      // A failed write disables recording; it must not propagate into the session.
      this.error = (err as Error).message;
      this.fd = undefined;
    }
  }

  /** Append one agent line. Pass the raw text, exactly as it arrived. */
  write(line: string): void {
    if (this.fd === undefined || this.truncated) return;
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (this.bytes + size > this.maxBytes) {
      this.truncated = true;
      return;
    }
    this.append(line.endsWith('\n') ? line : line + '\n');
    this.lines += 1;
  }

  close(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      /* the file is already as complete as it will get */
    }
    this.fd = undefined;
  }

  stats(): RecorderStats {
    return { path: this.path, bytes: this.bytes, lines: this.lines, truncated: this.truncated, ...(this.error ? { error: this.error } : {}) };
  }
}

export interface Recording {
  path: string;
  header: RecordingHeader;
  lines: string[];
  bytes: number;
  /** Non-empty when the file was cut short or a line was unreadable. */
  note?: string;
}

/**
 * Read a recording.
 *
 * A crash during recording leaves a partial last line; that line is dropped and
 * noted rather than making the whole file unreadable — the file is most valuable
 * exactly when the process died.
 */
export function readRecording(path: string): Recording {
  const abs = resolve(path);
  const text = readFileSync(abs, 'utf8');
  const bytes = statSync(abs).size;
  const raw = text.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();

  let header: RecordingHeader | undefined;
  const lines: string[] = [];
  let note: string | undefined;

  for (const line of raw) {
    if (!line.trim()) continue;
    if (!header) {
      try {
        const parsed = JSON.parse(line) as RecordingHeader;
        if (parsed.t === 'rec-meta') {
          header = parsed;
          continue;
        }
      } catch {
        /* fall through: an unheadered file is treated as a bare event stream */
      }
      note = 'no rec-meta header; treated as a bare event stream';
      header = { v: RECORDING_VERSION, t: 'rec-meta', at: 0, tool: 'unknown', version: '0', lang: '', target: '', hz: 10, redact: [] };
      lines.push(line);
      continue;
    }
    try {
      JSON.parse(line);
      lines.push(line);
    } catch {
      note = 'last line was incomplete and was dropped';
    }
  }

  if (!header) throw new Error(`${path}: not a recording (empty file)`);
  return { path: abs, header, lines, bytes, ...(note ? { note } : {}) };
}

/** Timestamp of one recorded line, for paced playback. */
function timeOf(line: string): number | undefined {
  try {
    const obj = JSON.parse(line) as { at?: unknown };
    return typeof obj.at === 'number' && Number.isFinite(obj.at) ? obj.at : undefined;
  } catch {
    return undefined;
  }
}

export interface PlaybackOptions {
  /** 1 = real time, 4 = four times faster, 0 = as fast as possible. */
  speed?: number;
  /** Longest wall-clock wait between two events, in ms (gaps are compressed). */
  maxGapMs?: number;
  onLine: (line: string) => void;
  onDone?: () => void;
  onProgress?: (position: number) => void;
}

export interface Playback {
  /** Resolves when the last line has been delivered. */
  done: Promise<void>;
  stop(): void;
}

/**
 * Feed a recording back through a session, paced by the recorded timestamps.
 *
 * `speed: 0` delivers everything immediately, which is what tests want and what
 * a user wants when they only care about the final state. Real-time playback
 * clamps long gaps: a recording that idles for a minute should not make someone
 * watch a minute of nothing before the interesting part.
 */
export function playback(rec: Recording, opts: PlaybackOptions): Playback {
  const speed = opts.speed ?? 1;
  const maxGap = opts.maxGapMs ?? 2000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const done = new Promise<void>((resolveDone) => {
    if (speed === 0) {
      for (const line of rec.lines) {
        if (stopped) break;
        opts.onLine(line);
      }
      opts.onProgress?.(rec.lines.length);
      opts.onDone?.();
      resolveDone();
      return;
    }

    let i = 0;
    const step = (): void => {
      if (stopped || i >= rec.lines.length) {
        if (!stopped) {
          opts.onProgress?.(rec.lines.length);
          opts.onDone?.();
        }
        resolveDone();
        return;
      }
      const line = rec.lines[i];
      opts.onLine(line);
      i += 1;
      opts.onProgress?.(i);

      if (i >= rec.lines.length) {
        step();
        return;
      }
      const now = timeOf(line);
      const next = timeOf(rec.lines[i]);
      const gap = now !== undefined && next !== undefined ? Math.max(0, next - now) : 0;
      const wait = Math.min(maxGap, gap / speed);
      timer = setTimeout(step, wait);
      timer.unref?.();
    };
    step();
  });

  return {
    done,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** One-line description for the CLI banner. */
export function describeRecording(rec: Recording): string {
  const h = rec.header;
  const size = rec.bytes >= 1024 * 1024 ? `${(rec.bytes / 1048576).toFixed(1)} MiB` : `${Math.round(rec.bytes / 1024)} KiB`;
  return `${h.target || '(unknown target)'} · ${h.lang || '?'} · ${rec.lines.length} events · ${size}`;
}
