/**
 * A usage log built to be read months later.
 *
 * The app log rotates on its own schedule, mixes levels, and is dominated by
 * whatever was being debugged that day. Optimising from it is guesswork: the one
 * number you need is usually the one nobody thought to log. This is the other
 * file — append-only JSONL, one event per line, with a schema version, rotated by
 * size, and never in the request path's way.
 *
 * # What it deliberately does not record
 *
 * No source text, no file paths, no user names, no hostnames. Language ids,
 * durations, counts and sizes only: enough to decide a TTL or a migration, not
 * enough to reconstruct what anyone was working on.
 *
 * # Why buffered
 *
 * A completion fires on every keystroke. `appendFileSync` per event would put a
 * syscall in the typing path; this buffers and flushes on a timer, and the timer
 * is unref'd so a background flush never keeps the process alive.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** What the rest of the app is allowed to know about this. */
export interface UsageRecorder {
  record(event: string, fields?: Record<string, unknown>): void;
}

export interface UsageLogOptions {
  home: string;
  appVersion: string;
  sessionId: string;
  /** Rotate once the file passes this. Default 8 MiB — months of normal use. */
  maxBytes?: number;
  /** How many rotated files to keep. Default 4. */
  keep?: number;
  /** Flush cadence. Default 2000 ms. */
  flushMs?: number;
}

const SCHEMA = '1';

export class UsageLog implements UsageRecorder {
  private readonly dir: string;
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly flushMs: number;
  private readonly header: { sid: string; v: string };
  private buffer: string[] = [];
  private bytes = 0;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(opts: UsageLogOptions) {
    this.dir = join(opts.home, 'logs');
    this.file = join(this.dir, 'usage.jsonl');
    this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    this.keep = opts.keep ?? 4;
    this.flushMs = opts.flushMs ?? 2000;
    this.header = { sid: opts.sessionId, v: SCHEMA };
    // A test run must not leave synthetic events in the user's real data: the
    // point of this file is that everything in it happened to someone.
    if (process.env.NOLANGUAGE_USAGE === '0') {
      this.closed = true;
      return;
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      // The version goes in the first line of every session, so a file from a
      // year ago can be interpreted without guessing what the fields meant.
      this.push({ event: 'session.start', appVersion: opts.appVersion });
      this.timer = setInterval(() => this.flush(), this.flushMs);
      this.timer.unref?.();
    } catch {
      this.closed = true;
    }
  }

  get path(): string {
    return this.file;
  }

  record(event: string, fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.push({ event, ...fields });
    if (this.bytes >= 64 * 1024) this.flush();
  }

  flush(): void {
    if (this.closed || !this.buffer.length) return;
    const text = this.buffer.join('');
    this.buffer = [];
    this.bytes = 0;
    try {
      this.rotateIfNeeded();
      appendFileSync(this.file, text, 'utf8');
    } catch {
      // A log that throws is worse than a log that misses a line.
    }
  }

  close(): void {
    if (this.closed) return;
    this.record('session.end', { uptimeMs: Math.round(process.uptime() * 1000) });
    this.flush();
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  private push(record: Record<string, unknown>): void {
    const line = JSON.stringify({ t: new Date().toISOString(), ...this.header, ...record });
    this.buffer.push(line + '\n');
    this.bytes += line.length + 1;
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file) || statSync(this.file).size < this.maxBytes) return;
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = join(this.dir, `usage.${i}.jsonl`);
        if (existsSync(from)) renameSync(from, join(this.dir, `usage.${i + 1}.jsonl`));
      }
      renameSync(this.file, join(this.dir, 'usage.1.jsonl'));
    } catch {
      // Keep writing to the current file rather than losing the records.
    }
  }
}
