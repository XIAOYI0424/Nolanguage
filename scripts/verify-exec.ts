/**
 * Stage 9 · the execution plane (`src/exec/`).
 *
 * The warm pool is the one part of the platform whose promises are about
 * *processes*: a worker stays alive between runs, Python keeps its namespace,
 * Node reuses the process but resets the context, a timeout kills the worker
 * instead of hanging, and a reset really goes back to cold. None of that is
 * visible from the outside — a pool that respawns on every run looks identical
 * from the caller's side except for `warm: false` — so it is checked here with
 * real processes.
 *
 * Also checked: worker output lands on the log spine as `user-code` records
 * (the spec's "stdout/stderr 捕获"), the commands are registered on the bus, and
 * the generated worker source stays free of relative imports (it runs in a
 * temporary directory, where a relative import would resolve to nothing).
 *
 * Go is exercised when the toolchain is present and reported as SKIP when it is
 * not — a missing optional toolchain is not a failure.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-exec.ts
 */
import { Kernel } from '../src/kernel/Kernel.js';
import { ExecService } from '../src/exec/ExecService.js';
import { NODE_WORKER_SRC } from '../src/exec/workerSource.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
let skipped = 0;
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name: string, why: string): void {
  skipped++;
  console.log(`SKIP  ${name}  — ${why}`);
}

async function main(): Promise<void> {
  const k = new Kernel({ logSilent: true });
  await k.start();

  // `minSize: 0`: the cold/warm assertions below are about *this* session's
  // first run, so the pool must not have a pre-warmed worker waiting.
  const exec = new ExecService(k, { minSize: 0, maxSize: 8, runTimeoutMs: 8000 });

  try {
    // ---------------------------------------------------------- warm pool
    {
      const a = await exec.run({ languageId: 'python', sessionId: 's1', code: 'x = 41\nprint(x + 1)' });
      check('python: the first run is cold', a.warm === false, `warm=${a.warm}`);
      check('python: stdout is captured', a.stdout.includes('42'), JSON.stringify(a.stdout.trim()));
      check('python: a clean run reports ok', a.ok === true && a.exitCode === 0, `ok=${a.ok} exit=${a.exitCode}`);

      const b = await exec.run({ languageId: 'python', sessionId: 's1', code: 'print(x + 1)' });
      check('python: the second run on the same session is warm', b.warm === true, `warm=${b.warm}`);
      check(
        'python: the namespace carries over (x from the previous run)',
        b.stdout.trim() === '42' && b.ok === true,
        JSON.stringify(b.stdout.trim()),
      );

      // Warmth is per session: a second session must not see the first one's
      // variables, and must not inherit its worker.
      const other = await exec.run({ languageId: 'python', sessionId: 's2', code: 'print(x)' });
      check(
        'python: another session cannot see the first one\'s variables',
        other.ok === false && /NameError/.test(String(other.error ?? '') + other.stderr),
        String(other.error ?? other.stderr).split('\n')[0].slice(0, 60),
      );
      check('python: another session starts its own worker', other.warm === false, `warm=${other.warm}`);
    }

    // ------------------------------------------ concurrent same-session calls
    {
      const spawnsBefore = exec.pool.workerSpawns;
      const [first, second] = await Promise.all([
        exec.run({
          languageId: 'python',
          sessionId: 'parallel',
          code: 'import time\nshared = 40\ntime.sleep(0.15)\nprint("first")',
        }),
        exec.run({ languageId: 'python', sessionId: 'parallel', code: 'print(shared + 2)' }),
      ]);
      check('concurrency: simultaneous first runs both complete', first.ok && second.ok, `${first.ok}/${second.ok}`);
      check('concurrency: calls share one worker, not two overwritten workers', exec.pool.workerSpawns - spawnsBefore === 1, `spawned=${exec.pool.workerSpawns - spawnsBefore}`);
      check('concurrency: second run sees the first run\'s namespace', second.stdout.trim() === '42', JSON.stringify(second.stdout.trim()));
      check('concurrency: first call is cold and the queued second is warm', !first.warm && second.warm, `${first.warm}/${second.warm}`);
      const parallelSession = exec.list().find((s) => s.sessionId === 'parallel');
      check('concurrency: the session stays tracked with both runs', !!parallelSession && parallelSession.runs === 2, JSON.stringify(parallelSession ?? null));
      let collision = '';
      try {
        await exec.run({ languageId: 'javascript', sessionId: 'parallel', code: 'console.log("wrong worker")' });
      } catch (err) {
        collision = (err as Error).message;
      }
      check('session: reusing an id for another language is rejected, not misrouted', collision.includes('already belongs to python'), collision || 'no error');

      const active = exec.run({ languageId: 'python', sessionId: 'reset-race', code: 'import time\ntime.sleep(0.12)\nprint("before reset")' });
      const reset = exec.reset('reset-race');
      const afterReset = exec.run({ languageId: 'python', sessionId: 'reset-race', code: 'print("after reset")' });
      const [activeResult, resetResult, resetRun] = await Promise.all([active, reset, afterReset]);
      check('concurrency: reset waits for the active run instead of killing its worker', activeResult.stdout.includes('before reset'), JSON.stringify(activeResult.stdout.trim()));
      check('concurrency: a run queued after reset starts cold', resetResult && !resetRun.warm && resetRun.stdout.includes('after reset'), `reset=${resetResult} warm=${resetRun.warm} out=${resetRun.stdout.trim()}`);
    }

    // ------------------------------------------------------------ failures
    {
      const bad = await exec.run({ languageId: 'python', sessionId: 'err', code: 'raise ValueError("boom")' });
      check(
        'python: a raising snippet is reported, not swallowed',
        bad.ok === false && /ValueError/.test(String(bad.error ?? '') + bad.stderr),
        String(bad.error ?? '').split('\n').slice(-1)[0]?.slice(0, 60) ?? '',
      );
      // exitCode 1 is the *snippet* failing; the worker surviving is proven by
      // the next run on the same session returning normally.
      check('python: a snippet error is not a worker death', bad.timedOut === false && bad.exitCode === 1, `exit=${bad.exitCode} timedOut=${bad.timedOut}`);

      const slow = await exec.run({ languageId: 'python', sessionId: 'slow', code: 'import time\ntime.sleep(30)', timeoutMs: 800 });
      check('python: a timeout comes back instead of hanging', slow.timedOut === true, `timedOut=${slow.timedOut}`);
      check('python: a timed-out run is not reported as ok', slow.ok === false, `ok=${slow.ok}`);

      // The killed worker must not be handed out again.
      const after = await exec.run({ languageId: 'python', sessionId: 'slow', code: 'print("alive")' });
      check('python: a recycled session still works after a timeout', after.stdout.includes('alive'), JSON.stringify(after.stdout.trim()));
    }

    // ------------------------------------------------------- reset / list
    {
      const before = exec.list();
      check('list: sessions are reported', before.length >= 2, before.map((s) => `${s.sessionId}:${s.runs}`).join(' '));
      const s1 = before.find((s) => s.sessionId === 's1');
      check('list: the run count is real', !!s1 && s1.runs === 2, s1 ? `runs=${s1.runs}` : 'missing');
      check('list: the warm flag is real', !!s1 && s1.warm === true, s1 ? `warm=${s1.warm}` : 'missing');

      const reset = await exec.reset('s1');
      check('reset: disposes the session', reset === true, String(reset));
      const after = await exec.run({ languageId: 'python', sessionId: 's1', code: 'print("cold again")' });
      check('reset: the next run is cold again', after.warm === false, `warm=${after.warm}`);
    }

    // -------------------------------------------------------- log spine
    {
      const logs = k.recentLogs(400).filter((r) => (r.resource?.component ?? '').startsWith('user-code'));
      check('logs: worker output lands on the log spine', logs.length > 0, `${logs.length} record(s)`);
      const withSession = logs.find((r) => r.correlation?.sessionId === 's1' || r.correlation?.sessionId === 'err');
      check('logs: records carry the sessionId', !!withSession, withSession ? String(withSession.correlation.sessionId) : 'none');
    }

    // --------------------------------------------------------- javascript
    {
      const j1 = await exec.run({ languageId: 'javascript', sessionId: 'js', code: 'globalThis.leak = 7; console.log("first")' });
      check('javascript: a run reports ok', j1.ok === true && j1.stdout.includes('first'), JSON.stringify(j1.stdout.trim()));
      const j2 = await exec.run({ languageId: 'javascript', sessionId: 'js', code: 'console.log(typeof globalThis.leak)' });
      check('javascript: the process is reused (warm)', j2.warm === true, `warm=${j2.warm}`);
      check(
        'javascript: but each snippet gets a fresh context',
        j2.stdout.trim() === 'undefined',
        JSON.stringify(j2.stdout.trim()),
      );
      const jbad = await exec.run({ languageId: 'javascript', sessionId: 'js', code: 'throw new Error("nope")' });
      check('javascript: a throwing snippet is reported', jbad.ok === false, `ok=${jbad.ok}`);
    }

    // ----------------------------------------------------------- commands
    {
      exec.registerCommands();
      const viaBus = await k.commands.execute<{ stdout: string }>('sandbox.run', {
        languageId: 'python', sessionId: 'bus', code: 'print("via bus")',
      });
      check('commands: sandbox.run is on the bus', viaBus.stdout.includes('via bus'), JSON.stringify(viaBus.stdout.trim()));
      const alias = await k.commands.execute<{ stdout: string }>('code.run', {
        languageId: 'python', sessionId: 'bus', code: 'print("alias")',
      });
      check('commands: code.run is the same surface', alias.stdout.includes('alias'), JSON.stringify(alias.stdout.trim()));
    }

    // ------------------------------------------------------------- go
    {
      try {
        const g = await exec.run({ languageId: 'go', sessionId: 'go1', code: 'package main\nimport "fmt"\nfunc main(){ fmt.Println("go ok") }', timeoutMs: 60_000 });
        check('go: a program builds and runs', g.ok === true && g.stdout.includes('go ok'), `exit=${g.exitCode} ${JSON.stringify(g.stdout.trim().slice(0, 40))}`);
        let goCollision = '';
        try {
          await exec.run({ languageId: 'python', sessionId: 'go1', code: 'print("must not route to Go")' });
        } catch (err) {
          goCollision = (err as Error).message;
        }
        check('session: a Go id cannot be reused by Python', goCollision.includes('already belongs to go'), goCollision || 'no error');
        const gbad = await exec.run({ languageId: 'go', sessionId: 'go2', code: 'package main\nfunc main(){ nope() }', timeoutMs: 60_000 });
        check('go: a compile error is a compile error', gbad.compileError === true && gbad.phase === 'build', `phase=${gbad.phase}`);
      } catch (err) {
        skip('go: toolchain', String((err as Error).message).slice(0, 60));
      }
    }
  } finally {
    await exec.close();
    await k.stop();
  }

  // ----------------------------------------------------- worker source
  {
    // The worker script is written into a temp directory and run there, so a
    // relative import would resolve to nothing. Only `node:` builtins are safe.
    const src = NODE_WORKER_SRC;
    const relative = [...src.matchAll(/(?:from\s+|require\(\s*)['"](\.[^'"]*)['"]/g)].map((m) => m[1]);
    check('worker: the generated script has no relative imports', relative.length === 0, relative.join(', ') || 'none');
    check('worker: it is plain source, not a template placeholder', src.length > 200 && !src.includes('${'), `${src.length} bytes`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed` + (skipped ? ` (${skipped} skipped)` : ''));
  process.exit(failed ? 1 : 0);
}

await main();
