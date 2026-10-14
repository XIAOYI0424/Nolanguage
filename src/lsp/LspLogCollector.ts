/**
 * LSP log collector (spec 18.2 · LspLogCollector).
 *
 * Language servers write unstructured diagnostics to stderr (and sometimes
 * stdout). This collector:
 *   1. splits the stream into lines,
 *   2. parses a level from common prefixes (`ERROR`, `WARN`, `[Info]`, ...),
 *   3. recognises structured JSON lines (`{"level":..,"msg":..}`) emitted by
 *      some servers,
 *   4. folds multi-line stack traces onto the preceding record,
 *   5. emits `LogRecord`s with `resource.scope = 'language-server'`.
 *
 * Every record therefore shares the traceId/correlation skeleton and lands in
 * the same ring buffer + panel as kernel logs.
 */
import { LogLevel, levelFromName } from '../log/LogLevel.js';
import type { Logger } from '../log/Logger.js';

export interface LspLogCollectorOptions {
  languageId: string;
  /** Component name shown in the Logs panel (default `lsp.<languageId>`). */
  component?: string;
  /** Which stream this collector is attached to (for the `fields.stream` tag). */
  stream: 'stderr' | 'stdout';
}

export interface LspLogStats {
  lines: number;
  records: number;
  byLevel: Record<string, number>;
  parseErrors: number;
}

/** Prefixes commonly emitted by clangd / pyright / gopls / jdt.ls / OmniSharp. */
const LEVEL_PREFIXES: Array<{ re: RegExp; level: LogLevel }> = [
  { re: /^\s*\[?\s*fatal\b[:\]]?/i, level: LogLevel.FATAL },
  { re: /^\s*\[?\s*error\b[:\]]?/i, level: LogLevel.ERROR },
  { re: /^\s*\[?\s*warn(ing)?\b[:\]]?/i, level: LogLevel.WARN },
  { re: /^\s*\[?\s*(info|notice)\b[:\]]?/i, level: LogLevel.INFO },
  { re: /^\s*\[?\s*debug\b[:\]]?/i, level: LogLevel.DEBUG },
  { re: /^\s*\[?\s*(trace|verbose)\b[:\]]?/i, level: LogLevel.TRACE },
];

/** `[Info  - 10:30:00]` / `[Error - 1:02:03 PM]` style (pyright / tsserver). */
const BRACKET_LEVEL =
  /^\s*\[\s*(Trace|Debug|Info|Warn|Warning|Error|Fatal)\s*[-–]\s*(\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s*[APap]\.?[Mm]\.?)?)\s*\]\s*/i;

/** Leading bare timestamp some servers emit: `10:30:00.123 message`. */
const LEADING_TIMESTAMP = /^\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\s+/;

/** Python traceback shapes. */
const TRACEBACK_HEAD = /^\s*Traceback\s*\(most recent call last\)\s*:?\s*$/i;
const TRACEBACK_FRAME = /^\s+File\s+".*?",\s+line\s+\d+/;
const EXCEPTION_LINE = /^[A-Za-z_][\w.]*(Error|Exception|Warning|Interrupt|Exit)\b\s*:?/;

/** Indented detail line (continuation of the previous record). */
const INDENTED = /^\s{2,}\S/;

/**
 * Split a trailing JSON object off a log line:
 *   `Indexing done {"files":1234}` → { text: 'Indexing done', fields: {files:1234} }
 * Returns the line unchanged when there is no valid trailing JSON object.
 */
function splitTrailingJson(line: string): { text: string; fields?: Record<string, unknown> } {
  const idx = line.lastIndexOf('{');
  if (idx <= 0) return { text: line };
  const tail = line.slice(idx).trim();
  if (!tail.endsWith('}')) return { text: line };
  try {
    const parsed = JSON.parse(tail);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { text: line };
    const text = line.slice(0, idx).trimEnd();
    if (!text) return { text: line };
    return { text, fields: parsed as Record<string, unknown> };
  } catch {
    return { text: line };
  }
}

export class LspLogCollector {
  private buffer = '';
  private lastRecordLevel: LogLevel | null = null;
  private readonly opts: LspLogCollectorOptions;
  private readonly logger: Logger;
  readonly stats: LspLogStats = { lines: 0, records: 0, byLevel: {}, parseErrors: 0 };

  constructor(logger: Logger, opts: LspLogCollectorOptions) {
    this.opts = opts;
    this.logger = logger;
  }

  /** Feed a raw chunk from the language server's stream. */
  write(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line);
    }
    // Guard against a server that never emits newlines.
    if (this.buffer.length > 65536) {
      this.handleLine(this.buffer);
      this.buffer = '';
    }
  }

  /** Flush any trailing partial line (call on process exit). */
  flush(): void {
    if (this.buffer.trim().length) {
      this.handleLine(this.buffer);
      this.buffer = '';
    }
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trimEnd();
    if (!line.trim()) return;
    this.stats.lines++;

    // 1) Structured JSON line.
    if (line.trimStart().startsWith('{')) {
      if (this.tryJson(line.trim())) return;
    }

    // Many servers append a JSON object with structured detail:
    //   `[Info - 10:30:00] Indexing done {"files": 1234}`
    // Split it out so the message stays readable and the detail is queryable.
    const { text, fields: tail } = splitTrailingJson(line);

    // 2) `[Info - 10:30:00] message` (pyright / tsserver / clangd style).
    const bracket = BRACKET_LEVEL.exec(text);
    if (bracket) {
      const level = levelFromName(bracket[1]);
      this.emit(level, text.slice(bracket[0].length).trim() || text, tail);
      return;
    }

    // 3) Bare leading timestamp: strip it, then continue parsing the rest.
    let body = text;
    const ts = LEADING_TIMESTAMP.exec(text);
    if (ts) body = text.slice(ts[0].length);

    // 4) Bare level prefix at the start of the line.
    for (const { re, level } of LEVEL_PREFIXES) {
      if (re.test(body)) {
        const message = body.replace(re, '').replace(/^[\s:\-\]]+/, '');
        this.emit(level, message || body, tail);
        return;
      }
    }

    // 5) Python traceback: head, frames and the exception line are all part of
    //    one error, so they inherit the current error level.
    if (TRACEBACK_HEAD.test(body)) {
      this.emit(this.errorLevel(), body, { continuation: true, ...tail });
      return;
    }
    if (TRACEBACK_FRAME.test(rawLine) || INDENTED.test(rawLine)) {
      this.emit(this.lastRecordLevel ?? LogLevel.INFO, body.trim(), { continuation: true, ...tail });
      return;
    }
    if (EXCEPTION_LINE.test(body)) {
      this.emit(LogLevel.ERROR, body, tail);
      return;
    }

    // 6) Anything else is informational.
    this.emit(LogLevel.INFO, body, tail);
  }

  /** Level to attribute to a traceback head: the previous level if it was an error. */
  private errorLevel(): LogLevel {
    const prev = this.lastRecordLevel;
    if (prev !== null && prev >= LogLevel.ERROR) return prev;
    return LogLevel.ERROR;
  }

  private tryJson(line: string): boolean {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const levelName = String(obj.level ?? obj.severity ?? 'info');
      const level = levelFromName(levelName);
      const message = String(obj.message ?? obj.msg ?? obj.text ?? line);
      const fields: Record<string, unknown> = { stream: this.opts.stream };
      for (const k of Object.keys(obj)) {
        if (!['level', 'severity', 'message', 'msg', 'text'].includes(k)) fields[k] = obj[k];
      }
      this.emit(level, message, fields);
      return true;
    } catch {
      this.stats.parseErrors++;
      return false;
    }
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    this.lastRecordLevel = level;
    const merged: Record<string, unknown> = { stream: this.opts.stream, ...(fields ?? {}) };
    switch (level) {
      case LogLevel.FATAL:
        this.logger.fatal(message, merged);
        break;
      case LogLevel.ERROR:
        this.logger.error(message, merged);
        break;
      case LogLevel.WARN:
        this.logger.warn(message, merged);
        break;
      case LogLevel.INFO:
        this.logger.info(message, merged);
        break;
      case LogLevel.DEBUG:
        this.logger.debug(message, merged);
        break;
      default:
        this.logger.trace(message, merged);
    }
    this.stats.records++;
    const name = LogLevel[level];
    this.stats.byLevel[name] = (this.stats.byLevel[name] ?? 0) + 1;
  }
}
