/**
 * Python user-code profiler — stdlib `cProfile` via an inlined bootstrap.
 *
 * Runs the snippet under cProfile, reads back the raw pstats rows, and
 * normalises them into hotspots sorted by cumulative time. No py-spy required
 * (that stays an optional accelerator); this works fully offline.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Kernel } from '../kernel/Kernel.js';
import { PYTHON_PROFILE_SRC } from './pythonProfileSource.js';
import type { ProfileHotspot, ProfileOptions, ProfileResult } from './types.js';

interface RawRow {
  file: string;
  line: number;
  name: string;
  calls: number;
  primitiveCalls: number;
  tottimeMs: number;
  cumtimeMs: number;
}

/** One node of the call tree the bootstrap writes under `flame`. */
interface RawFrame {
  name: string;
  file: string;
  line: number;
  selfMs: number;
  totalMs: number;
  calls: number;
  children: RawFrame[];
}

const WRAPPER = new Map<string, string>();

async function wrapperPath(): Promise<string> {
  const cached = WRAPPER.get('py');
  if (cached) return cached;
  const dir = join(tmpdir(), `nolanguage-profiler-${process.pid}`);
  await mkdir(dir, { recursive: true });
  // NB: must NOT be named `profile.py` — that shadows the stdlib `profile`
  // module that `cProfile` imports internally (circular import → AttributeError).
  const file = join(dir, 'nl_profile_runner.py');
  await writeFile(file, PYTHON_PROFILE_SRC, 'utf8');
  WRAPPER.set('py', file);
  return file;
}

export class PythonProfiler {
  private readonly pythonBin: string;

  constructor(private kernel: Kernel, pythonBin?: string) {
    this.pythonBin = pythonBin ?? process.env.PYTHON_BIN ?? 'python';
  }

  get binary(): string {
    return this.pythonBin;
  }

  /**
   * A path we were handed is checked; a bare command name (the default `python`)
   * is assumed to be on PATH, because that is what PATH means.
   */
  get available(): boolean {
    return /[\\/]/.test(this.pythonBin) ? existsSync(this.pythonBin) : true;
  }

  async profile(opts: ProfileOptions): Promise<ProfileResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const topN = opts.topN ?? 25;
    const dir = await mkdtemp(join(tmpdir(), 'nolanguage-prof-'));
    const snippetPath = join(dir, 'snippet.py');
    const outPath = join(dir, 'out.json');
    const wrapper = await wrapperPath();
    await writeFile(snippetPath, opts.code, 'utf8');

    const log = this.kernel.logger.forComponent('profiler.python');
    const span = this.kernel.tracer.startSpan('profiler.run', {
      attributes: { languageId: 'python' },
    });
    const t0 = performance.now();

    const child = spawn(this.pythonBin, [wrapper, snippetPath, outPath], {
      cwd: dir,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    let timedOut = false;
    let spawnError: string | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('error', (err) => {
        spawnError = err.message;
        resolve({ code: -1, signal: null });
      });
      child.on('close', (code, signal) => resolve({ code, signal: signal ?? null }));
    });
    clearTimeout(timer);

    let parsed: {
      wallMs: number;
      ok: boolean;
      error: string | null;
      stdout: string;
      stderr: string;
      rows: RawRow[];
      /** Call tree for the flamegraph; absent when pstats had no callers. */
      flame?: RawFrame[];
    } | null = null;
    try {
      parsed = JSON.parse(await readFile(outPath, 'utf8'));
    } catch {
      parsed = null;
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);

    const wallMs = performance.now() - t0;
    const rows = parsed?.rows ?? [];
    const hotspots: ProfileHotspot[] = rows
      .map((r) => ({
        name: r.name,
        file: r.file,
        line: r.line,
        calls: r.calls,
        tottimeMs: round(r.tottimeMs),
        cumtimeMs: round(r.cumtimeMs),
      }))
      .sort((a, b) => b.cumtimeMs - a.cumtimeMs)
      .slice(0, topN);

    this.kernel.perfMetrics().record('profiler.run', wallMs);
    this.kernel.perfMetrics().record('profiler.samples', rows.length);
    log.info('Python profile', {
      wallMs: Math.round(wallMs),
      functions: rows.length,
      hotspots: hotspots.length,
      ok: parsed?.ok ?? false,
      exitCode: exit.code,
      timedOut,
    });
    span.setAttribute('samples', rows.length).end();

    const ok = (parsed?.ok ?? false) && !timedOut && !spawnError;
    return {
      languageId: 'python',
      source: 'cProfile',
      wallMs: Math.round(wallMs),
      sampleCount: rows.length,
      hotspots,
      flame: parsed?.flame?.length ? parsed.flame.map(roundFrame) : undefined,
      stdout: parsed?.stdout ?? '',
      stderr: parsed?.stderr ?? '',
      ok,
      error: spawnError ?? (timedOut ? `profiling timed out after ${timeoutMs}ms` : parsed?.error ?? null),
      binary: this.pythonBin,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Recursively round the timings in a call-tree frame. */
function roundFrame(f: RawFrame): import('./types.js').ProfileFrame {
  const kids = f.children.map((c) => roundFrame(c));
  return {
    name: f.name,
    file: f.file,
    line: f.line,
    selfMs: round(f.selfMs),
    totalMs: round(f.totalMs),
    calls: f.calls,
    children: kids,
  };
}
