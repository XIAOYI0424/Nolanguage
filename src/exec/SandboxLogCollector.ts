/**
 * SandboxLogCollector (spec §七 / §方案 line 414).
 *
 * The warm-pool workers return their full stdout/stderr in the run result. To
 * make that visible on the log spine (and thus the panel's live Logs tab) the
 * collector replays each line as a structured `user-code` LogRecord tagged
 * with the `sessionId`, exactly the way `PythonRunner` / `GoRunner` already do
 * for the cold runners. Centralising it here keeps the level heuristic
 * (tracebacks → error, plain prints → info) in one place.
 */
import type { Kernel } from '../kernel/Kernel.js';
import type { SandboxLanguage } from './types.js';

/** Python tracebacks / Node stacks surface as errors; plain prints as info. */
function classify(stream: 'stdout' | 'stderr', line: string): 'info' | 'warn' | 'error' {
  if (stream === 'stdout') return 'info';
  if (/^(Traceback|Stack:|    at |\w*Error:|\w*Exception:)|Error:/.test(line)) return 'error';
  if (/^\s*File "|^\s*\.go:\d+:\d+:/.test(line) || /^(#|\s*panic:|\s*FAIL)/.test(line)) return 'error';
  return 'warn';
}

/**
 * Replay captured worker output into the log spine as `user-code` records.
 * Returns the number of lines logged (so a test can assert capture happened).
 */
export function collectSandboxOutput(
  kernel: Kernel,
  languageId: SandboxLanguage,
  sessionId: string,
  runId: string,
  stdout: string,
  stderr: string,
): number {
  const userLog = kernel.logger.forUserCode(languageId, sessionId);
  let lines = 0;
  const replay = (stream: 'stdout' | 'stderr', text: string): void => {
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      lines++;
      const fields = { stream, runId, sessionId };
      const level = classify(stream, line);
      if (level === 'error') userLog.error(line, fields);
      else if (level === 'warn') userLog.warn(line, fields);
      else userLog.info(line, fields);
    }
  };
  replay('stdout', stdout);
  replay('stderr', stderr);
  return lines;
}
