/**
 * Go user-code profiler — `runtime/pprof` CPU profile + `go tool pprof -top`.
 *
 * Go has no cProfile equivalent we can inject at run time, so we transform the
 * user's `func main()` into `func userMain()` and append a tiny wrapper that
 * starts a CPU profile around it. Then `go tool pprof -top` turns the binary
 * profile into text rows we parse into hotspots. Fully offline; degrades to a
 * clear `skipped` result when the toolchain is absent (never throws).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Kernel } from '../kernel/Kernel.js';
import { resolveGoBin } from '../go/discover.js';
import { decodeOutput } from '../util/encoding.js';
import type { ProfileHotspot, ProfileOptions, ProfileResult } from './types.js';

const GO_MOD = `module nolanguage/profile

go 1.21
`;

const WRAPPER = `package main

import (
	"os"
	"runtime/pprof"
)

func main() {
	f, err := os.Create("cpu.prof")
	if err != nil {
		panic(err)
	}
	if err := pprof.StartCPUProfile(f); err != nil {
		panic(err)
	}
	userMain()
	pprof.StopCPUProfile()
	f.Close()
}
`;

export class GoProfiler {
  private readonly goBin: string;
  private readonly source: string;

  constructor(private kernel: Kernel, goBin?: string) {
    const r = resolveGoBin(goBin ?? process.env.GO_BIN);
    this.goBin = r.bin;
    this.source = r.source;
  }

  get binary(): string {
    return this.goBin;
  }

  get available(): boolean {
    return this.source !== 'missing';
  }

  async profile(opts: ProfileOptions): Promise<ProfileResult> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const topN = opts.topN ?? 25;
    if (!this.available) {
      return {
        languageId: 'go',
        source: 'pprof',
        wallMs: 0,
        sampleCount: 0,
        hotspots: [],
        stdout: '',
        stderr: '',
        ok: false,
        error: 'Go toolchain not found',
        binary: this.goBin,
        skipped: true,
        skipReason: 'Go toolchain not installed on this machine',
      };
    }
    // Only `package main` snippets with a `func main()` can be wrapped.
    if (!/func\s+main\s*\(/.test(opts.code)) {
      return {
        languageId: 'go',
        source: 'pprof',
        wallMs: 0,
        sampleCount: 0,
        hotspots: [],
        stdout: '',
        stderr: '',
        ok: false,
        error: 'profiling needs a `func main()` (run mode)',
        binary: this.goBin,
        skipped: true,
        skipReason: 'no func main() to wrap',
      };
    }

    const dir = await mkdtemp(join(tmpdir(), 'nolanguage-goprof-'));
    const binName = process.platform === 'win32' ? 'profile.exe' : 'profile';
    const binPath = join(dir, binName);
    const mainGo = opts.code.replace(/func\s+main\s*\(/, 'func userMain(');
    await writeFile(join(dir, 'main.go'), mainGo, 'utf8');
    await writeFile(join(dir, 'profile_wrap.go'), WRAPPER, 'utf8');
    await writeFile(join(dir, 'go.mod'), GO_MOD, 'utf8');

    const log = this.kernel.logger.forComponent('profiler.go');
    const span = this.kernel.tracer.startSpan('profiler.run', { attributes: { languageId: 'go' } });
    const t0 = performance.now();
    const env = this.childEnv();
    let timedOut = false;

    const run = (cmd: string, argv: string[]): Promise<{ code: number | null; out: string; err: string }> =>
      new Promise((resolve) => {
        const child = spawn(cmd, argv, { cwd: dir, env, windowsHide: true });
        let out = '';
        let err = '';
        child.stdout?.on('data', (c: Buffer) => (out += decodeOutput(c)));
        child.stderr?.on('data', (c: Buffer) => (err += decodeOutput(c)));
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs);
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve({ code: -1, out, err: err + e.message });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, out, err });
        });
      });

    const build = await run(this.goBin, ['build', '-o', binPath, '.']);
    let topText = '';
    let execOut = '';
    let execErr = '';
    if (build.code === 0 && !timedOut) {
      const exec = await run(binPath, []);
      execOut = exec.out;
      execErr = exec.err;
      const top = await run(this.goBin, ['tool', 'pprof', '-top', `-nodecount=${topN}`, 'cpu.prof']);
      topText = top.out;
    }
    const wallMs = performance.now() - t0;
    const hotspots = parsePprofTop(topText, topN);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);

    this.kernel.perfMetrics().record('profiler.run', wallMs);
    this.kernel.perfMetrics().record('profiler.samples', hotspots.length);
    const ok = build.code === 0 && !timedOut && hotspots.length > 0;
    log.info('Go profile', {
      wallMs: Math.round(wallMs),
      hotspots: hotspots.length,
      buildCode: build.code,
      timedOut,
    });
    span.setAttribute('samples', hotspots.length).end();

    return {
      languageId: 'go',
      source: 'pprof',
      wallMs: Math.round(wallMs),
      sampleCount: hotspots.length,
      hotspots,
      flame: hotspots.length
        ? hotspotsToFlame(hotspots)
        : undefined,
      stdout: execOut,
      stderr: execErr || build.err,
      ok,
      error: timedOut
        ? `profiling timed out after ${timeoutMs}ms`
        : build.code === 0
          ? null
          : build.err.trim() || `go build exited ${build.code}`,
      binary: this.goBin,
    };
  }

  private childEnv(): NodeJS.ProcessEnv {
    const binDir = this.goBin.replace(/[\\/][^\\/]+$/, '');
    const sep = process.platform === 'win32' ? ';' : ':';
    return {
      ...process.env,
      PATH: binDir + sep + (process.env.PATH ?? ''),
      GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? 'local',
    };
  }
}

/**
 * Build a flamegraph frame from the flat `-top` hotspots.
 *
 * `go tool pprof -top` gives no call edges we parse here, so we synthesise a
 * single root (`go:cpu.prof`) whose children are the hotspots. It is a valid
 * (if shallow) call tree the UI renders uniformly; a future adapter using
 * `pprof -tree`/`-flame` can replace this with a real hierarchy.
 */
export function hotspotsToFlame(hotspots: ProfileHotspot[]): import('./types.js').ProfileFrame[] {
  const total = hotspots.reduce((s, h) => s + h.cumtimeMs, 0);
  return [
    {
      name: 'go:cpu.prof',
      file: '',
      line: 0,
      selfMs: 0,
      totalMs: Math.round(total * 1000) / 1000,
      calls: 0,
      children: hotspots.map((h) => ({
        name: h.name,
        file: h.file,
        line: h.line,
        selfMs: Math.round(h.tottimeMs * 1000) / 1000,
        totalMs: Math.round(h.cumtimeMs * 1000) / 1000,
        calls: h.calls,
        children: [],
      })),
    },
  ];
}

/** Parse `go tool pprof -top` text rows into hotspots. */
export function parsePprofTop(text: string, topN: number): ProfileHotspot[] {
  const out: ProfileHotspot[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Data rows look like: 10ms 33.33% 33.33% 20ms 66.67% main.userMain
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    if (!/^\d/.test(parts[0]!)) continue;
    const flat = parseDuration(parts[0]!);
    const cum = parseDuration(parts[3]!);
    if (flat === null || cum === null) continue;
    const name = parts.slice(5).join(' ');
    if (!name) continue;
    out.push({ name, file: '', line: 0, calls: 0, tottimeMs: flat, cumtimeMs: cum });
  }
  return out.sort((a, b) => b.cumtimeMs - a.cumtimeMs).slice(0, topN);
}

function parseDuration(tok: string): number | null {
  if (tok === '0') return 0;
  const m = /^([\d.]+)(ns|us|µs|ms|s)$/.exec(tok);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  switch (m[2]) {
    case 's':
      return n * 1000;
    case 'ms':
      return n;
    case 'us':
    case 'µs':
      return n / 1000;
    case 'ns':
      return n / 1e6;
    default:
      return null;
  }
}
