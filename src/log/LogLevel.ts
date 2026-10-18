export enum LogLevel {
  TRACE = 0, // 极细粒度，仅开发模式
  DEBUG = 1, // 调试信息，开发模式
  INFO = 2, // 正常事件，默认
  WARN = 3, // 潜在问题
  ERROR = 4, // 错误但可恢复
  FATAL = 5, // 致命错误
  AUDIT = 10, // 审计日志，始终保留
  METRIC = 11, // 指标日志，进性能管道
}

export const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.TRACE]: 'TRACE',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.FATAL]: 'FATAL',
  [LogLevel.AUDIT]: 'AUDIT',
  [LogLevel.METRIC]: 'METRIC',
};

/**
 * Reverse of `LOG_LEVEL_NAMES`: level **name → numeric severity**.
 *
 * This is the shape the panel wire protocol uses (`hello.levels`), because the
 * browser side needs to map a filter name back to a comparable number.
 * `LOG_LEVEL_NAMES` is the other direction (number → name) and must not be sent
 * as-is.
 */
export const LOG_LEVEL_VALUES: Record<string, number> = Object.fromEntries(
  Object.entries(LOG_LEVEL_NAMES).map(([value, name]) => [name, Number(value)]),
);

/** Case-insensitive name → numeric level. Returns INFO for unknown names. */
export function levelFromName(name: string): LogLevel {
  const upper = name.trim().toUpperCase();
  switch (upper) {
    case 'TRACE':
    case 'VERBOSE':
      return LogLevel.TRACE;
    case 'DEBUG':
      return LogLevel.DEBUG;
    case 'INFO':
    case 'NOTICE':
    case 'LOG':
      return LogLevel.INFO;
    case 'WARN':
    case 'WARNING':
      return LogLevel.WARN;
    case 'ERROR':
    case 'ERR':
      return LogLevel.ERROR;
    case 'FATAL':
    case 'CRITICAL':
      return LogLevel.FATAL;
    case 'AUDIT':
      return LogLevel.AUDIT;
    case 'METRIC':
      return LogLevel.METRIC;
    default:
      return LogLevel.INFO;
  }
}
