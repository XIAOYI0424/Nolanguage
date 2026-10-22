/**
 * Line coverage for the IDE's "Run with Coverage" action.
 *
 * The engine's runners execute a program but do not report which lines ran, so
 * this module adds a *measurement* pass instead of a second execution semantics:
 * the source is run once under Python's standard `trace` module (no third-party
 * dependency), whose per-line counters are written as JSON by a tiny driver
 * script. The IDE highlights the result and never has to trust a text format
 * that varies between CPython releases.
 *
 * Python only, deliberately: `trace` is the one interpreter-level tracer that
 * ships with the runtime the Python plugin already discovered. For any other
 * language the caller gets an explicit "not supported" answer rather than a
 * fabricated percentage.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CoverageLine {
  line: number;
  count: number;
}

export interface CoverageResult {
  ok: boolean;
  error?: string;
  language: string;
  /** Absolute path of the file that was measured. */
  sourceFile: string;
  executableLines: number;
  coveredLines: number;
  /** Executable lines that were never reached, ascending. */
  missing: number[];
  lines: CoverageLine[];
  stdout: string;
  stderr: string;
  durationMs: number;
  /** What was run, for the dialog's footer (`python -m trace …`). */
  command: string;
}

const DRIVER = `
import ast, json, runpy, sys, trace

target, out = sys.argv[1], sys.argv[2]
tracer = trace.Trace(count=1, trace=0)

def _main():
    runpy.run_path(target, run_name='__main__')

try:
    tracer.runfunc(_main)
except SystemExit:
    pass
except BaseException as exc:
    sys.stderr.write('%s: %s\\n' % (type(exc).__name__, exc))

# Every statement is a line the interpreter *could* execute; the tracer only
# reports the ones it did. Subtracting the two is what makes "missing" honest.
source = open(target, encoding='utf-8').read()
executable = sorted({node.lineno for node in ast.walk(ast.parse(source)) if hasattr(node, 'lineno')})

counts = tracer.results().counts
grouped = {}
for (fname, lineno), count in counts.items():
    grouped.setdefault(fname, {})[str(lineno)] = count
with open(out, 'w', encoding='utf-8') as fh:
    json.dump({'executable': executable, 'counts': grouped}, fh)
`;

/** Run `code` under the stdlib tracer and turn its counters into per-line data. */
export async function runPythonCoverage(
  pythonBin: string,
  code: string,
  opts: { timeoutMs?: number } = {},
): Promise<CoverageResult> {
  const started = Date.now();
  const language = 'python';
  const empty = (error: string, extra: Partial<CoverageResult> = {}): CoverageResult => ({
    ok: false,
    error,
    language,
    sourceFile: '',
    executableLines: 0,
    coveredLines: 0,
    missing: [],
    lines: [],
    stdout: '',
    stderr: '',
    durationMs: Date.now() - started,
    command: pythonBin,
    ...extra,
  });

  if (!pythonBin) return empty('Python is not available in this workspace (no interpreter discovered)');

  const dir = await mkdtemp(join(tmpdir(), 'nolanguage-cov-'));
  const sourceFile = join(dir, 'snippet.py');
  const driverFile = join(dir, 'driver.py');
  const dataFile = join(dir, 'counts.json');
  try {
    await writeFile(sourceFile, code, 'utf8');
    await writeFile(driverFile, DRIVER, 'utf8');

    const run = await spawnCapture(pythonBin, ['-u', driverFile, sourceFile, dataFile], dir, opts.timeoutMs ?? 30_000);
    const command = `${pythonBin} -m trace --count snippet.py`;

    if (run.timedOut) {
      return empty(`coverage run timed out after ${Math.round((opts.timeoutMs ?? 30_000) / 1000)}s`, {
        stdout: run.stdout,
        stderr: run.stderr,
        command,
        sourceFile,
      });
    }

    let raw: string;
    try {
      raw = await readFile(dataFile, 'utf8');
    } catch {
      return empty(
        run.stderr.trim() || `the tracer produced no counters (exit code ${run.code ?? '?'})`,
        { stdout: run.stdout, stderr: run.stderr, command, sourceFile },
      );
    }

    const parsed = JSON.parse(raw) as {
      executable?: number[];
      counts?: Record<string, Record<string, number>>;
    };
    const grouped = parsed.counts ?? {};
    // The tracer keys by absolute file name; a symlinked tmpdir can differ in
    // case on Windows, so match on the basename as a fallback.
    const key =
      Object.keys(grouped).find((f) => f === sourceFile) ??
      Object.keys(grouped).find((f) => f.replace(/\\/g, '/').endsWith('/snippet.py'));
    const counts = key ? grouped[key] : {};
    const executable = (parsed.executable ?? [])
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    const lines: CoverageLine[] = executable.map((line) => ({
      line,
      count: Number(counts[String(line)] ?? 0) || 0,
    }));
    const executed = new Set(lines.filter((l) => l.count > 0).map((l) => l.line));
    const missing = lines.filter((l) => l.count === 0).map((l) => l.line);

    if (!executable.length) {
      return empty(
        run.stderr.trim() || 'the tracer produced no executable lines for this file',
        { stdout: run.stdout, stderr: run.stderr, command, sourceFile },
      );
    }

    return {
      ok: true,
      language,
      sourceFile,
      executableLines: executable.length,
      coveredLines: executed.size,
      missing,
      lines,
      stdout: run.stdout,
      stderr: run.stderr,
      durationMs: Date.now() - started,
      command,
    };
  } catch (err) {
    return empty((err as Error).message);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Spawn, stream-capture, kill on timeout. Never throws on a non-zero exit. */
function spawnCapture(
  command: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.join(''), stderr: err.join(''), timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, argv, {
        cwd,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      err.push((e as Error).message);
      finish(-1);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, Math.max(1000, timeoutMs));
    child.stdout?.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => err.push(d.toString('utf8')));
    child.on('error', (e) => {
      err.push(e.message);
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}
