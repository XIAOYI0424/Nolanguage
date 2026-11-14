/**
 * The kernel log, on disk.
 *
 * # Why this exists
 *
 * Everything the kernel logs used to end up in exactly two places: the in-memory
 * ring buffer (gone when the process exits) and the console transport. The
 * packaged desktop is a **GUI-subsystem** executable — it has no console — so
 * the console transport wrote to nothing at all. The only durable traces were
 * `desktop.log` (launch events, a few hundred bytes) and the SQLite warm tier,
 * which is exactly the thing that reports `attempt to write a readonly database`
 * on a machine with a locked or read-only profile directory.
 *
 * The practical cost: when the app misbehaved there was nothing to read
 * afterwards. Diagnosing one launch took an afternoon of guesswork that a log
 * file would have answered in ten seconds.
 *
 * # Shape
 *
 * Newline-delimited JSON, one record per line, compact keys. NDJSON because it
 * survives a truncated tail (a crash mid-write loses one line, not the file),
 * greps cleanly, and can be replayed by any reader that understands one object
 * per line.
 *
 * The first line of a file is a **header** describing the process that wrote it
 * (version, platform, start time). Without it, a log from a month ago is a pile
 * of timestamps with no idea which build produced them.
 *
 * # Bounded, in three ways
 *
 *   - `maxBytes` per file, rotated to `.1`, `.2`, … keeping `keep` generations.
 *     The old `logDesktop` deleted the file at the limit, so the interesting
 *     part (what happened just before the failure) was the first thing lost.
 *   - `maxLineBytes` per record: one enormous field must not push a rotation.
 *   - `maxQueue` pending lines: if the disk stalls, the queue is capped instead
 *     of growing until the process dies. Overflow is counted and reported.
 *
 * # Failure policy
 *
 * `write()` never throws — a logger that can take the application down is worse
 * than no logger. Failures are counted in `stats()` so a caller can surface
 * "logging is broken" once instead of silently losing everything, which is what
 * `logDesktop` did.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOG_LEVEL_NAMES, LogLevel } from '../LogLevel.js';
import type { LogRecord } from '../types.js';
import type { LogTransport } from '../LogPipeline.js';

export interface FileTransportOptions {
  /** Absolute path of the active file. Rotated siblings sit next to it. */
  path: string;
  /** Rotate once the active file passes this size. */
  maxBytes?: number;
  /** How many rotated generations to keep (`app.log.1` … `app.log.N`). */
  keep?: number;
  /** Records below this level are not written. */
  minLevel?: LogLevel;
  /** A single serialized line is truncated past this. */
  maxLineBytes?: number;
  /** Pending lines held while the disk is slow; beyond this they are dropped. */
  maxQueue?: number;
  /** Header written as the first line of a new file. */
  header?: Record<string, unknown>;
}

export interface FileTransportStats {
  written: number;
  dropped: number;
  errors: number;
  lastError?: string;
  rotations: number;
  path: string;
}

/** Defaults chosen so a week of normal use fits in a handful of files. */
const DEFAULTS = {
  maxBytes: 8 * 1024 * 1024,
  keep: 3,
  minLevel: LogLevel.TRACE,
  maxLineBytes: 8 * 1024,
  maxQueue: 5_000,
};

export class FileTransport implements LogTransport {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly minLevel: LogLevel;
  private readonly maxLineBytes: number;
  private readonly maxQueue: number;
  private readonly header?: Record<string, unknown>;

  private queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private headerWritten = false;
  private closed = false;

  private written = 0;
  private dropped = 0;
  private errors = 0;
  private rotations = 0;
  private lastError: string | undefined;

  constructor(opts: FileTransportOptions) {
    this.path = opts.path;
    this.maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
    this.keep = Math.max(1, opts.keep ?? DEFAULTS.keep);
    this.minLevel = opts.minLevel ?? DEFAULTS.minLevel;
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULTS.maxLineBytes;
    this.maxQueue = opts.maxQueue ?? DEFAULTS.maxQueue;
    this.header = opts.header;
  }

  write(record: LogRecord): void {
    if (this.closed) return;
    if (record.level < this.minLevel) return;
    if (this.queue.length >= this.maxQueue) {
      // Counted, not silently swallowed: `stats()` is how a caller notices.
      this.dropped++;
      return;
    }
    this.queue.push(this.format(record));
    this.schedule();
  }

  /** Force everything out now. Safe to call from a shutdown path. */
  flush(): void {
    this.drain();
  }

  close(): void {
    this.flush();
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  stats(): FileTransportStats {
    return {
      written: this.written,
      dropped: this.dropped,
      errors: this.errors,
      lastError: this.lastError,
      rotations: this.rotations,
      path: this.path,
    };
  }

  // ---------------- internals ----------------

  /**
   * One NDJSON line. Short keys keep the file readable and small; the long-form
   * record is still available in the ring buffer for the panel.
   */
  private format(record: LogRecord): string {
    // `timestamp` is nanoseconds (the panel divides by 1e6 too); feeding it to
    // `Date` directly is an Invalid time value.
    const ms = Math.round(record.timestamp / 1_000_000);
    const iso = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
    const line: Record<string, unknown> = {
      t: iso,
      lvl: LOG_LEVEL_NAMES[record.level] ?? String(record.level),
      scope: record.resource?.scope ?? 'kernel',
      comp: record.resource?.component ?? '',
      msg: record.message,
    };
    if (record.traceId) line.trace = record.traceId;
    if (record.spanId) line.span = record.spanId;
    if (record.resource?.languageId) line.lang = record.resource.languageId;
    if (record.resource?.extensionId) line.ext = record.resource.extensionId;
    if (record.resource?.processId) line.pid = record.resource.processId;
    if (record.scope?.fileUri) line.file = record.scope.fileUri;
    if (typeof record.scope?.line === 'number') line.line = record.scope.line;
    if (record.fields && Object.keys(record.fields).length) line.f = record.fields;
    if (record.error) line.err = { type: record.error.type, message: record.error.message, stack: record.error.stack };
    if (record.tags?.length) line.tags = record.tags;
    if (record.sampled) line.sampled = true;

    let text: string;
    try {
      text = JSON.stringify(line);
    } catch (err) {
      // A record with a circular `fields` value must not lose the line entirely.
      text = JSON.stringify({ t: line.t, lvl: line.lvl, scope: line.scope, comp: line.comp, msg: String(record.message), unserializable: (err as Error).message });
    }
    if (text.length > this.maxLineBytes) {
      // Truncate the *message*, then re-serialize: slicing the JSON string would
      // produce a line that no reader can parse, and a log full of broken lines
      // is worse than a short one.
      const overflow = text.length - this.maxLineBytes;
      const msg = String(line.msg ?? '');
      line.msg = msg.length > overflow + 32 ? msg.slice(0, msg.length - overflow - 32) + '…[truncated]' : '…[truncated]';
      delete line.f;
      try {
        text = JSON.stringify(line);
      } catch {
        text = JSON.stringify({ t: line.t, lvl: line.lvl, msg: '…[truncated]' });
      }
    }
    return text;
  }

  private schedule(): void {
    if (this.timer) return;
    // A short coalescing window: one write syscall per burst instead of one per
    // record, and a crash still loses at most this window.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, 200);
    this.timer.unref?.();
  }

  private drain(): void {
    if (!this.queue.length) return;
    const lines = this.queue;
    this.queue = [];
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Rotate *before* appending, not after. Rotating after means the last
      // rotation of a session leaves no `app.log` at all — the records that
      // caused it sit in `.1` and the active file is missing until the next
      // write, which for a crashed process is never.
      if (this.atCapacity()) this.rotate();
      if (!this.headerWritten) {
        this.headerWritten = true;
        if (this.header) appendFileSync(this.path, JSON.stringify({ '#': 'header', ...this.header }) + '\n', 'utf8');
      }
      appendFileSync(this.path, lines.join('\n') + '\n', 'utf8');
      this.written += lines.length;
    } catch (err) {
      this.errors++;
      this.lastError = (err as Error).message;
      // Keep the lines that did not make it, up to the cap, so a transient lock
      // does not lose them — but never let the queue grow without bound.
      const room = Math.max(0, this.maxQueue - this.queue.length);
      this.queue = lines.slice(-room).concat(this.queue);
      if (lines.length > room) this.dropped += lines.length - room;
    }
  }

  /** True when the active file has reached the size limit. */
  private atCapacity(): boolean {
    try {
      return existsSync(this.path) && statSync(this.path).size >= this.maxBytes;
    } catch {
      return false;
    }
  }

  private rotate(): void {
    try {
      // Drop the oldest generation, shift the rest up by one, then move the
      // active file to `.1`. Anything beyond `keep` is removed, so the
      // directory never grows without bound.
      rmSync(`${this.path}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${this.path}.${i}`;
        if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`);
      }
      renameSync(this.path, `${this.path}.1`);
      this.headerWritten = false;
      this.rotations++;
    } catch (err) {
      this.errors++;
      this.lastError = `rotate: ${(err as Error).message}`;
    }
  }
}
