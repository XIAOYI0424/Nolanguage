/**
 * ndebug · Go support: the pprof parser and the guide.
 *
 * The fixture is a real dump from a real Go 1.27 program (a `net/http` server
 * with two background goroutines), not a hand-written approximation — the point
 * of parsing `runtime.Stack` output is that its shape is decided by the runtime,
 * so the only honest test input is the runtime's own output.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-ndebug-go.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentEvent } from '../src/debugtool/protocol.js';
import { startAttachApp } from '../src/debugtool/main.js';
import { resolveGoBin } from '../src/go/discover.js';
import { dumpToStackLines, parseGoroutineDump, pprofUrl } from '../src/debugtool/agents/go/pprof.js';
import { goAttachGuide } from '../src/debugtool/agents/go/guide.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Remove a temp directory that a just-killed child may still hold open.
 *
 * On Windows the compiled sample lives inside `dir`, so the kernel keeps a lock on
 * the directory until the terminated process is fully reaped. A single `rmSync`
 * therefore throws `EPERM` — and because it threw from a `finally`, it replaced a
 * green suite with a `0/0 checks` red one (the crash happened before the summary
 * line). Waiting for the exit and retrying is the fix; leaking a temp directory is
 * an acceptable last resort, failing the suite is not.
 */
async function removeTempDir(dir: string, child: { once: (event: 'exit', cb: () => void) => void; exitCode: number | null } | null): Promise<void> {
  if (child && child.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 40 });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
        console.log(`  note: could not remove ${dir} (${code ?? 'unknown'})`);
        return;
      }
      await sleep(150);
    }
  }
  console.log(`  note: left ${dir} behind (still locked by a terminated process)`);
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// A real `GET /debug/pprof/goroutine?debug=2` body, trimmed to three goroutines.
const DUMP = [
  'goroutine 25 [running]:',
  'runtime/pprof.writeGoroutineStacks({0x7ff795ff95b8, 0x3ebd86862000})',
  '\tD:/Go lang/src/runtime/pprof/pprof.go:816 +0x69',
  'runtime/pprof.writeGoroutine({0x7ff795ff95b8?, 0x3ebd86862000?}, 0x3ebd868602c0?)',
  '\tD:/Go lang/src/runtime/pprof/pprof.go:779 +0x25',
  'net/http/pprof.Index({0x7ff795ffb418, 0x3ebd86862000}, 0x3ebd86840140?)',
  '\tD:/Go lang/src/net/http/pprof/pprof.go:391 +0xdc',
  'net/http.serverHandler.ServeHTTP({0x3ebd8684c0c0?}, {0x7ff795ffb418?, 0x3ebd86862000?}, 0x1?)',
  '\tD:/Go lang/src/net/http/server.go:3436 +0x8e',
  'created by net/http.(*Server).Serve in goroutine 23',
  '\tD:/Go lang/src/net/http/server.go:3604 +0x4fd',
  '',
  'goroutine 1 [sleep]:',
  'time.Sleep(0x1312d00)',
  '\tD:/Go lang/src/runtime/time.go:368 +0x167',
  'main.work(0x7ff795ff9238?)',
  '\tD:/15936/Documents/Nolanguage/.tmp/goprobe/main.go:22 +0x2b',
  'main.main()',
  '\tD:/15936/Documents/Nolanguage/.tmp/goprobe/main.go:35 +0x6f',
  '',
  'goroutine 23 [IO wait]:',
  'internal/poll.runtime_pollWait(0x20d21ed6800, 0x72)',
  '\tD:/Go lang/src/runtime/netpoll.go:351 +0x85',
  'internal/poll.(*FD).waitIO(0x3e25162b4000, 0x3e2516228ed0)',
  '\tD:/Go lang/src/internal/poll/fd_windows.go:233 +0x45',
  'net/http.(*Server).Serve(0x3e25162b2000, {0x7ff795ffb538, 0x3e25162be000})',
  '\tD:/Go lang/src/net/http/server.go:3574 +0x379',
  'net/http.ListenAndServe(...)',
  '\tD:/Go lang/src/net/http/server.go:3836',
  'created by main.main in goroutine 1',
  '\tD:/15936/Documents/Nolanguage/.tmp/goprobe/main.go:28 +0x1e',
  '',
  'goroutine 24 [chan receive, 9 minutes]:',
  'main.func2()',
  '\tD:/15936/Documents/Nolanguage/.tmp/goprobe/main.go:31 +0x1d',
  'created by main.main in goroutine 1',
  '\tD:/15936/Documents/Nolanguage/.tmp/goprobe/main.go:30 +0x12',
].join('\n');

// ------------------------------------------------------------ 1. the address

{
  const one = 'http://127.0.0.1:6060/debug/pprof/goroutine?debug=2';
  check('url: a bare host:port becomes the dump URL', pprofUrl('http://127.0.0.1:6060') === one, pprofUrl('http://127.0.0.1:6060'));
  check('url: a missing scheme defaults to http', pprofUrl('127.0.0.1:6060') === one, pprofUrl('127.0.0.1:6060'));
  check('url: the pprof index is normalised', pprofUrl('http://127.0.0.1:6060/debug/pprof') === one, pprofUrl('http://127.0.0.1:6060/debug/pprof'));
  check('url: a full URL stays equivalent', pprofUrl(one) === one, pprofUrl(one));
  check('url: https is preserved', pprofUrl('https://box:6060').startsWith('https://box:6060/'), pprofUrl('https://box:6060'));
  check('url: a non-http scheme is refused', (() => {
    try {
      pprofUrl('ftp://box:21');
      return false;
    } catch {
      return true;
    }
  })());
  check('url: an empty address is refused', (() => {
    try {
      pprofUrl('   ');
      return false;
    } catch {
      return true;
    }
  })());
}

// ------------------------------------------------------------ 2. the dump

const parsed = parseGoroutineDump(DUMP);
check('dump: three goroutines are parsed', parsed.length === 3, `${parsed.length}`);
check('dump: the pprof handler is not reported as the program', !parsed.some((g) => g.id === 25), parsed.map((g) => g.id).join(','));

const g1 = parsed.find((g) => g.id === 1);
check('dump: a sleeping goroutine is blocked', g1?.state === 'blocked' && g1?.wait === 'sleep', `${g1?.state}/${g1?.wait}`);
check('dump: frames are innermost-last', g1?.frames[g1.frames.length - 1]?.fn === 'time.Sleep', g1?.frames.map((f) => f.fn).join(' > '));
check('dump: the outermost frame is the entry point', g1?.frames[0]?.fn === 'main.main', g1?.frames[0]?.fn ?? '');
check('dump: file names are basenames only', g1?.frames.every((f) => !f.file.includes('/') && !f.file.includes('\\')) === true, g1?.frames.map((f) => f.file).join(','));
check('dump: line numbers are kept', g1?.frames.some((f) => f.file === 'main.go' && f.line === 22) === true, JSON.stringify(g1?.frames));
check('dump: `created by` is not a frame', !JSON.stringify(parsed).includes('created by'), '');

const g23 = parsed.find((g) => g.id === 23);
check('dump: an IO wait is blocked', g23?.state === 'blocked' && g23?.wait === 'IO wait', `${g23?.state}/${g23?.wait}`);
check('dump: a frame without an offset still parses', g23?.frames.some((f) => f.fn === 'http.ListenAndServe') === true, g23?.frames.map((f) => f.fn).join(' > '));

const g24 = parsed.find((g) => g.id === 24);
check('dump: the duration is not part of the state', g24?.wait === 'chan receive' && g24?.state === 'blocked', `${g24?.wait}`);

// ------------------------------------------------------------ 3. the states

{
  const states = parseGoroutineDump(
    ['goroutine 7 [running]:', 'main.a()', '\t/a.go:1 +0x1', '', 'goroutine 8 [runnable]:', 'main.b()', '\t/b.go:2 +0x2', '', 'goroutine 9 [select]:', 'main.c()', '\t/c.go:3 +0x3'].join('\n'),
  );
  const by = (id: number): string | undefined => states.find((s) => s.id === id)?.state;
  check('state: running is running', by(7) === 'running', String(by(7)));
  // `runnable` means "ready but not on a CPU": calling it running would make the
  // stall detector fire on a healthy program.
  check('state: runnable is idle, not running', by(8) === 'idle', String(by(8)));
  check('state: select is blocked', by(9) === 'blocked', String(by(9)));
}

// ------------------------------------------------------------ 4. bounds

{
  const wide = Array.from({ length: 300 }, (_, i) => `goroutine ${i + 1} [running]:\nmain.f${i}()\n\t/a.go:${i + 1} +0x1`).join('\n\n');
  check('bounds: goroutines are capped', parseGoroutineDump(wide).length === 200, String(parseGoroutineDump(wide).length));

  const deep = Array.from({ length: 40 }, (_, i) => `main.f${i}()`).flatMap((fn, i) => [fn, `\t/a.go:${i + 1} +0x1`]).join('\n');
  const capped = parseGoroutineDump(`goroutine 1 [running]:\n${deep}`, { maxFrames: 3 });
  check('bounds: frames are capped', capped[0]?.frames.length === 3, String(capped[0]?.frames.length));
  check('bounds: capping keeps the innermost frames', capped[0]?.frames[2]?.fn === 'main.f0', capped[0]?.frames.map((f) => f.fn).join(' > '));
}

// ------------------------------------------------------------ 5. robustness

{
  check('robust: an empty body yields nothing', parseGoroutineDump('').length === 0);
  check('robust: garbage yields nothing', parseGoroutineDump('not a dump at all\nneither is this').length === 0);
  check('robust: a goroutine with no frames is dropped', parseGoroutineDump('goroutine 5 [running]:\n').length === 0);
  check('robust: a half-written tail does not throw', parseGoroutineDump('goroutine 5 [running]:\nmain.x()\n\t/a.go:').length === 0);
}

// ------------------------------------------------------------ 6. the wire

{
  const lines = dumpToStackLines(parsed, 1_700_000_000_000);
  check('wire: one line per goroutine', lines.length === parsed.length, String(lines.length));
  const events = lines.map((l) => parseAgentEvent(l));
  check('wire: every line passes the real parser', events.every((e) => e.ok), events.map((e) => (e.ok ? 'ok' : e.reason)).join(','));
  const first = events[0];
  check('wire: the event is a stack sample', first.ok && first.event.t === 'stack', first.ok ? first.event.t : first.reason);
  check('wire: the goroutine id becomes the thread id', first.ok && first.event.t === 'stack' && first.event.tid === 1, first.ok && first.event.t === 'stack' ? String(first.event.tid) : '');
}

// ------------------------------------------------------------ 7. the guide

{
  const guide = goAttachGuide('/x/app.go');
  check('guide: names the command that works', guide.includes('ndebug --attach http://127.0.0.1:6060'), '');
  check('guide: shows the two lines to add', guide.includes('import _ "net/http/pprof"') && guide.includes('http.ListenAndServe'), '');
  check('guide: says what is not available', /locals and watches/.test(guide), '');
  check('guide: names the file that cannot be attached', guide.includes('app.go'), '');
}

// ------------------------------------------- 8. attach to a real Go program

{
  const go = resolveGoBin();
  if (!go.bin || go.source === 'missing') {
    console.log(`SKIP  go attach end-to-end (no toolchain: ${go.source})`);
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'nlg-go-'));
    const bin = join(dir, process.platform === 'win32' ? 'app.exe' : 'app');
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const build = spawnSync(go.bin, ['build', '-o', bin, join(root, 'debugtool', 'samples', 'go', 'app.go')], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 240_000,
      });
      check('go: the sample builds', build.status === 0, (build.stderr || build.stdout || '').split('\n')[0].slice(0, 120));

      if (build.status === 0) {
        child = spawn(bin, ['400'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const url = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no ready line; output: ${out.slice(0, 200)}`)), 15_000);
          child?.stdout?.on('data', (d: Buffer) => {
            out += d.toString();
            // No backslashes needed: `[^ ]` keeps this readable and impossible to
            // mangle when the line is generated by a script.
            const m = /ready (http:[^ ]+)/.exec(out);
            if (m) {
              clearTimeout(timer);
              resolve(m[1]);
            }
          });
        });

        const app = await startAttachApp({ url, port: 0, hz: 10, quiet: true });
        try {
          let view = app.session.view();
          const deadline = Date.now() + 12_000;
          while (Date.now() < deadline && view.samples < 5) {
            await sleep(200);
            view = app.session.view();
          }
          const hot = view.hot.map((h) => h.stack);
          check('go: the endpoint is polled', view.samples > 0, `${view.samples} samples`);
          check('go: the session attaches as go', view.state === 'attached' && view.lang === 'go', `${view.state}/${view.lang}`);
          check('go: hot stacks come from the program', hot.some((h) => /work|step|main/.test(h)), hot.slice(0, 2).join(' | '));
          // The dump includes the goroutine that produced it; if that is not
          // filtered, the observatory's own HTTP handler is the hottest stack.
          check('go: the pprof handler is not reported as the program', !hot.some((h) => /pprof/.test(h)), hot.join(' | '));
          check('go: blocked goroutines are visible', view.stalls.length > 0 || hot.length > 1, `${view.stalls.length} stalls, ${hot.length} stacks`);
          check('go: no locals are promised', !(view.caps ?? []).includes('locals'), JSON.stringify(view.caps ?? []));
          check('go: the page is served', (await fetch(app.url, { signal: AbortSignal.timeout(3000) })).status === 200);
        } finally {
          await app.close();
        }
      }
    } finally {
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      await removeTempDir(dir, child ?? null);
    }
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = 1;
}
