/**
 * A test log is a stream, not a document.
 *
 * `go test -v` prints a case start, the case's output, then the verdict — and
 * the verdict line alone does not carry the failure message, nor does the
 * message line alone say which case it belongs to. So this parser is
 * incremental: it remembers which cases are running (Go nests subtests by
 * printing `=== RUN` for each level) and attributes message lines to the
 * innermost one. `parseGoTest(lines)` is the same parser over an array, which
 * is what the unit tests and the offline re-parse use.
 *
 * Only Go is implemented. The shape is deliberately generic — every runner
 * prints some variant of these markers — so a second language adds a parser
 * here rather than a branch in the panel.
 */

/** One observable state change for a test case. */
export interface TestCaseEvent {
  /** Full Go test name, including `/sub` segments (e.g. `TestFoo/sub_1`). */
  name: string;
  status: 'run' | 'pass' | 'fail' | 'skip' | 'output';
  /** Case duration in milliseconds, when the runner printed one. */
  ms?: number;
  /** Source file, project-relative when the runner printed one. */
  file?: string;
  /** 1-based line number. */
  line?: number;
  /** Failure message, only on `fail` (or `output` for unattributed noise). */
  message?: string;
}

export interface IncrementalTestParser {
  /** Feed one line (without the trailing newline). Returns the events it produced. */
  push(line: string): TestCaseEvent[];
  /** Cases still open (started but no verdict), for a cancelled run. */
  readonly running: readonly string[];
}

/** `=== RUN   TestFoo` / `=== PAUSE TestFoo/sub` / `=== CONT  TestFoo`. */
const RUN_RE = /^\s*=== RUN\s+(\S+)\s*$/;
const SKIP_MARK_RE = /^\s*=== (PAUSE|CONT)\s+\S+\s*$/;
/** `--- PASS: TestFoo (0.01s)`, `    --- FAIL: TestFoo/sub (0.00s)`. */
const VERDICT_RE = /^\s*--- (PASS|FAIL|SKIP): (\S+)(?:\s+\(([\d.]+)s\))?\s*$/;
/** `    foo_test.go:12: message` or `    foo_test.go:12: message` with a path. */
const MSG_RE = /^\s+(\S+?_test\.go):(\d+):\s?(.*)$/;
/** `FAIL\texample.com/demo\t0.01s` / `ok  \texample.com/demo\t0.01s`. */
const PACKAGE_RE = /^(?:FAIL|ok)\s+\S+(?:\s+[\d.]+s)?\s*$/;

function toMs(seconds: string | undefined): number | undefined {
  if (!seconds) return undefined;
  const n = Number(seconds);
  return Number.isFinite(n) ? Math.round(n * 1000) : undefined;
}

/**
 * A package-level failure with no `--- FAIL` line: `go test` could not even
 * build the test binary, so the output is compiler errors rather than case
 * verdicts. The handler reports that as the run's `error`, and these lines are
 * still forwarded as `output` so the console shows the compiler's message.
 */
export function isPackageFailure(line: string): boolean {
  return /^FAIL\s+\S+/.test(line) && !/^FAIL\s*$/.test(line);
}

export function createGoTestParser(): IncrementalTestParser {
  /** Innermost-last stack of open case names. */
  const open: string[] = [];
  /** Messages collected per case, keyed by full name, plus the first location. */
  const messages = new Map<string, { text: string[]; file?: string; line?: number }>();
  const out: TestCaseEvent[] = [];

  const noteMessage = (file: string, line: number, text: string): void => {
    const owner = open[open.length - 1];
    if (!owner) {
      out.push({ name: '', status: 'output', file, line, ...(text ? { message: text } : {}) });
      return;
    }
    const entry = messages.get(owner) ?? { text: [] };
    if (entry.text.length < 20) entry.text.push(`  ${file}:${line}: ${text}`.trimEnd());
    // The first message is the one worth jumping to: later ones are usually
    // consequences (or t.Log noise) of the same failure.
    if (entry.file === undefined) {
      entry.file = file;
      entry.line = line;
    }
    messages.set(owner, entry);
  };

  return {
    get running() {
      return open.slice();
    },
    push(line: string): TestCaseEvent[] {
      out.length = 0;
      const plain = line.replace(/\r$/, '');

      const run = RUN_RE.exec(plain);
      if (run) {
        const name = run[1];
        open.push(name);
        out.push({ name, status: 'run' });
        return out.slice();
      }
      if (SKIP_MARK_RE.test(plain)) return out.slice();

      const verdict = VERDICT_RE.exec(plain);
      if (verdict) {
        const [, kind, name, seconds] = verdict;
        // Close the matching case and anything nested inside it: a parent's
        // verdict arrives after its subtests, but a malformed log may not.
        const at = open.lastIndexOf(name);
        if (at >= 0) open.splice(at, open.length - at);
        const status = kind === 'PASS' ? 'pass' : kind === 'FAIL' ? 'fail' : 'skip';
        const collected = messages.get(name);
        messages.delete(name);
        out.push({
          name,
          status,
          ...(toMs(seconds) !== undefined ? { ms: toMs(seconds) } : {}),
          ...(status === 'fail' && collected?.file !== undefined ? { file: collected.file, line: collected.line } : {}),
          ...(status === 'fail' && collected?.text.length ? { message: collected.text.join('\n') } : {}),
        });
        return out.slice();
      }

      const msg = MSG_RE.exec(plain);
      if (msg) {
        noteMessage(msg[1], Number(msg[2]), msg[3]);
        return out.slice();
      }
      if (PACKAGE_RE.test(plain)) return out.slice();

      // Anything else while a case is running belongs to that case ("output"),
      // which is what makes a panic or a `t.Log` visible in the tree. Outside a
      // case it is build noise; the handler shows it in the console only.
      if (open.length && plain.trim()) {
        out.push({ name: open[open.length - 1], status: 'output', message: plain.trimEnd() });
      }
      // A fresh array: callers keep what push() returns, and this buffer is
      // reused on every line.
      return out.slice();
    },
  };
}

/** Offline form, for tests and for re-parsing a captured run. */
export function parseGoTest(lines: readonly string[]): TestCaseEvent[] {
  const parser = createGoTestParser();
  const events: TestCaseEvent[] = [];
  for (const line of lines) events.push(...parser.push(line));
  return events;
}
