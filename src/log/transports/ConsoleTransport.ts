import type { LogRecord } from '../types.js';
import { LogLevel, LOG_LEVEL_NAMES } from '../LogLevel.js';

const RESET = '\x1b[0m';
const LEVEL_COLORS: Record<number, string> = {
  [LogLevel.TRACE]: '\x1b[90m',
  [LogLevel.DEBUG]: '\x1b[36m',
  [LogLevel.INFO]: '\x1b[32m',
  [LogLevel.WARN]: '\x1b[33m',
  [LogLevel.ERROR]: '\x1b[31m',
  [LogLevel.FATAL]: '\x1b[41m\x1b[37m',
  [LogLevel.AUDIT]: '\x1b[35m',
  [LogLevel.METRIC]: '\x1b[34m',
};

/**
 * Console transport: colored human-readable text (dev mode) or raw JSON
 * (file/remote mode). ERROR+ goes to stderr.
 */
export class ConsoleTransport {
  constructor(private opts: { pretty?: boolean } = {}) {}

  write(record: LogRecord): void {
    if (this.opts.pretty === false) {
      process.stdout.write(JSON.stringify(record) + '\n');
      return;
    }
    const line = this.format(record);
    const stream = record.level >= LogLevel.ERROR ? process.stderr : process.stdout;
    stream.write(line + '\n');
  }

  private format(r: LogRecord): string {
    const ts = new Date(r.timestamp / 1_000_000).toISOString().slice(11, 23);
    const lvl = (LOG_LEVEL_NAMES[r.level] ?? '?').padEnd(5);
    const comp = (r.resource.component ?? '?').padEnd(28);
    const color = LEVEL_COLORS[r.level] ?? '';
    const fields = r.fields && Object.keys(r.fields).length ? ' ' + JSON.stringify(r.fields) : '';
    const err = r.error ? ` ${r.error.type}: ${r.error.message}` : '';
    const tid = r.traceId ? ` [${r.traceId.slice(0, 8)}]` : '';
    return `${color}${ts} ${lvl} ${comp}${tid} ${r.message}${fields}${err}${RESET}`;
  }
}
