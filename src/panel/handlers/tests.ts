/**
 * The test runner: one test run, its live case events, and Stop.
 *
 * A test run is the ordinary execution pipeline in `mode: 'test'` — same session
 * directory, same scaffold, same timeout, same toolchain — with two additions:
 * a `{filter}` selector (so one case can be re-run) and a parser that turns the
 * runner's log into per-case events. Neither addition teaches the engine a
 * language: the command comes from `run.modes.test` in the manifest, and the
 * parser is chosen by `run.testFormat` in `langs/testFormats.ts`.
 *
 * The parser is fed from `onData`, not from the final result: a suite that takes
 * ten minutes should fill the tree as cases finish, and a cancelled run should
 * still show what already passed.
 */
import type { WorkspaceService } from '../WorkspaceService.js';
import { stateFor } from '../conn-state.js';
import { asLanguage } from './languages.js';
import { type IncrementalTestParser, type TestCaseEvent } from '../../langs/testParser.js';
import { testParserFor } from '../../langs/testFormats.js';

/**
 * The Test runner: one test run, its live case events, and Stop.
 *
 * A test run is the ordinary execution pipeline in `mode: 'test'` — same
 * session directory, same scaffold, same timeout, same toolchain — with two
 * additions: a `{filter}` selector (so one case can be re-run) and a parser
 * that turns the runner's log into per-case events. Neither addition teaches
 * the engine a language: the command comes from `run.modes.test` in the
 * manifest, and the parser is chosen here, where the UI contract lives.
 *
 * The parser is fed from `onData`, not from the final result: a suite that
 * takes ten minutes should fill the tree as cases finish, and a cancelled run
 * should still show what already passed.
 */

/**
 * Test selectors are composed into an argv fragment, so they are validated as
 * *fragments*: an optional `-run` prefix plus a regex over test names. No
 * spaces beyond that prefix, no quotes, no shell metacharacters — a plugin
 * command is a template, and this value must never be able to add a second
 * command to it.
 */
export function sanitizeTestFilter(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text) return '';
  const m = /^(?:-run\s+)?([\w.*+?^$[\]\\|()/-]{1,160})$/.exec(text);
  if (!m) return undefined;
  return `-run ${m[1]}`;
}

/** Languages whose test output this module can parse. */
function parserFor(format: unknown): IncrementalTestParser | null {
  return testParserFor(format) ?? null;
}

interface CaseState {
  name: string;
  status: TestCaseEvent['status'];
  ms?: number;
  file?: string;
  line?: number;
  message?: string;
}

export async function handleTestRun(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
  conn: unknown,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  // The id is opaque to the client (it only needs to match replies to its own
  // request), but it travels through JSON, so a NaN would arrive as null. Coerce
  // once, here, and every reply carries the same usable number.
  const rawId = Number(msg.requestId);
  const requestId = Number.isFinite(rawId) ? rawId : 0;
  const code = typeof msg.code === 'string' ? msg.code : '';
  const fail = (error: string, extra: Record<string, unknown> = {}): void => {
    reply({ kind: 'testResult', language, requestId, ok: false, passed: 0, failed: 0, skipped: 0, ms: 0, error, ...extra });
  };

  const manifest = workspace.manifestOf(language);
  if (!manifest?.run?.modes?.test) {
    fail(`"${language}" does not declare a test mode (manifest.run.modes.test)`);
    return;
  }
  const parser = parserFor(manifest.run.testFormat);
  if (!parser) {
    fail(`no test-output parser is registered for this language's test format; "${language}" runs tests as plain output`);
    return;
  }
  const filter = sanitizeTestFilter(msg.filter);
  if (filter === undefined) {
    fail(`invalid test filter: ${JSON.stringify(String(msg.filter ?? ''))} (expected a test name or -run regex)`);
    return;
  }

  const st = stateFor(conn);
  if (st.testAbort) {
    fail('a test run is already in progress');
    return;
  }
  const abort = new AbortController();
  st.testAbort = abort;

  const started = Date.now();
  const cases = new Map<string, CaseState>();
  /** Pending partial line per stream: `onData` chunks are not line-aligned. */
  const partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  let parsedLines = 0;
  let outputBytes = 0;
  const OUTPUT_CAP = 2 * 1024 * 1024;

  const emitCase = (ev: TestCaseEvent): void => {
    if (!ev.name) {
      if (ev.message) reply({ kind: 'testOut', requestId, stream: 'stdout', text: `${ev.message}\n` });
      return;
    }
    const cur = cases.get(ev.name) ?? { name: ev.name, status: 'run' as const };
    cur.status = ev.status === 'output' ? cur.status === 'run' ? 'run' : cur.status : ev.status;
    if (ev.ms !== undefined) cur.ms = ev.ms;
    if (ev.file) cur.file = ev.file;
    if (ev.line !== undefined) cur.line = ev.line;
    if (ev.message) cur.message = cur.message ? `${cur.message}\n${ev.message}` : ev.message;
    cases.set(ev.name, cur);
    reply({
      kind: 'testCase',
      requestId,
      name: ev.name,
      status: ev.status,
      ...(cur.ms !== undefined ? { ms: cur.ms } : {}),
      ...(cur.file ? { file: cur.file } : {}),
      ...(cur.line !== undefined ? { line: cur.line } : {}),
      ...(ev.message ? { message: ev.message } : {}),
    });
  };

  const feed = (stream: 'stdout' | 'stderr', text: string): void => {
    outputBytes += text.length;
    if (outputBytes > OUTPUT_CAP) return;
    const joined = partial[stream] + text;
    const lines = joined.split('\n');
    partial[stream] = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      reply({ kind: 'testOut', requestId, stream, text: `${line}\n` });
      if (parsedLines > 20_000) continue;
      parsedLines++;
      for (const ev of parser.push(line)) emitCase(ev);
    }
  };

  reply({
    kind: 'testStart',
    language,
    requestId,
    filter,
    command: manifest.run.modes.test.steps?.[0]?.cmd ?? '',
  });

  try {
    const result = await workspace.run(language, code, {
      sessionId: 'tests',
      mode: 'test',
      filter,
      signal: abort.signal,
      onData: feed,
    });

    // Flush a last line that had no trailing newline (a crashing runner).
    for (const stream of ['stdout', 'stderr'] as const) {
      if (partial[stream]) {
        for (const ev of parser.push(partial[stream])) emitCase(ev);
        partial[stream] = '';
      }
    }
    // Cases that started but never got a verdict: a build failure or a kill.
    // Reporting them as failed is what the user sees in PyCharm too; leaving
    // them "running" would keep a spinner alive after the result arrived.
    if (result.exitCode !== 0 && !result.cancelled) {
      for (const name of parser.running) {
        const cur = cases.get(name);
        if (cur && cur.status === 'run') {
          cur.status = 'fail';
          reply({ kind: 'testCase', requestId, name, status: 'fail', ...(cur.ms !== undefined ? { ms: cur.ms } : {}) });
        }
      }
    }

    const all = [...cases.values()];
    const passed = all.filter((c) => c.status === 'pass').length;
    const failed = all.filter((c) => c.status === 'fail').length;
    const skipped = all.filter((c) => c.status === 'skip').length;
    reply({
      kind: 'testResult',
      language,
      requestId,
      ok: !result.cancelled && failed === 0 && result.exitCode === 0,
      passed,
      failed,
      skipped,
      ms: result.durationMs || Date.now() - started,
      exitCode: result.exitCode,
      ...(result.cancelled ? { cancelled: true } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(result.compileError ? { compileError: true } : {}),
      ...(result.stdoutTruncated || result.stderrTruncated ? { truncated: true } : {}),
      ...(failed === 0 && result.exitCode !== 0 && !result.cancelled
        ? { error: `the test command exited with code ${result.exitCode} without a failing case (see output)` }
        : {}),
    });
  } catch (err) {
    reply({
      kind: 'testResult',
      language,
      requestId,
      ok: false,
      passed: 0,
      failed: 0,
      skipped: 0,
      ms: Date.now() - started,
      error: `test run failed: ${(err as Error).message}`,
    });
  } finally {
    if (st.testAbort === abort) st.testAbort = undefined;
  }
}

/** Stop the test run this connection started. */
export function handleTestCancel(conn: unknown, reply: (p: unknown) => void): void {
  const st = stateFor(conn);
  const abort = st.testAbort;
  if (!abort) {
    reply({ kind: 'testCancelled', ok: false, error: 'no test run is in progress' });
    return;
  }
  abort.abort();
  reply({ kind: 'testCancelled', ok: true });
}
