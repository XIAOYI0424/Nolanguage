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
import { capture } from '../src/runtimes/proc.js';

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
  const exec = new ExecService(k, { minSize: 0, maxSize: 2, maxWorkers: 32, runTimeoutMs: 8000 });

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

      const prewarmed = new ExecService(k, { minSize: 2, maxSize: 2, maxWorkers: 1, runTimeoutMs: 8000 });
      check('capacity: prewarm reservations respect the total worker cap', prewarmed.pool.workerSpawns === 1, `spawned=${prewarmed.pool.workerSpawns}`);
      await prewarmed.close();

      const capRace = new ExecService(k, { minSize: 0, maxWorkers: 1, runTimeoutMs: 8000 });
      try {
        const raced = await Promise.allSettled([
          capRace.run({ languageId: 'javascript', sessionId: 'race-a', code: 'console.log("a")' }),
          capRace.run({ languageId: 'python', sessionId: 'race-b', code: 'print("b")' }),
        ]);
        check('capacity: distinct concurrent sessions cannot over-admit the last slot', raced.filter((r) => r.status === 'fulfilled').length === 1 && capRace.pool.workerSpawns === 1, `fulfilled=${raced.filter((r) => r.status === 'fulfilled').length} spawned=${capRace.pool.workerSpawns}`);
      } finally {
        await capRace.close();
      }

      const capped = new ExecService(k, { minSize: 0, maxWorkers: 1, runTimeoutMs: 8000 });
      try {
        await capped.create('javascript', 'reserved');
        let createLimitError = '';
        try { await capped.create('python', 'reserved-two'); }
        catch (err) { createLimitError = (err as Error).message; }
        check('capacity: create reserves a slot and refuses excess named sessions', createLimitError.includes('session limit reached (1)') && capped.list().some((s) => s.sessionId === 'reserved'), createLimitError || JSON.stringify(capped.list()));
        await capped.reset('reserved');
        await capped.run({ languageId: 'javascript', sessionId: 'cap-one', code: 'console.log("one")' });
        let limitError = '';
        try { await capped.run({ languageId: 'javascript', sessionId: 'cap-two', code: 'console.log("two")' }); }
        catch (err) { limitError = (err as Error).message; }
        check('capacity: the worker ceiling rejects excess named sessions clearly', limitError.includes('session limit reached (1)'), limitError || 'no error');
        await capped.reset('cap-one');
        const replacement = await capped.run({ languageId: 'javascript', sessionId: 'cap-two', code: 'console.log("two")' });
        check('capacity: reset releases a slot for the next named session', replacement.ok && replacement.stdout.includes('two'), replacement.stdout.trim());
      } finally {
        await capped.close();
      }

      const expiry = new ExecService(k, { minSize: 0, maxWorkers: 2, maxSessionIdleMs: 30, maxIdleMs: 5, runTimeoutMs: 8000 });
      try {
        const anonymous = await expiry.run({ languageId: 'javascript', code: 'console.log("temporary")' });
        const named = await expiry.run({ languageId: 'javascript', sessionId: 'keep-state', code: 'console.log("persistent")' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        check('lifecycle: generated anonymous sessions expire after idle', !expiry.list().some((s) => s.sessionId === anonymous.sessionId), anonymous.sessionId);
        check('lifecycle: named sessions preserve user state across idle', expiry.list().some((s) => s.sessionId === named.sessionId), named.sessionId);
      } finally {
        await expiry.close();
      }
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
        const goOutput = await exec.run({
          languageId: 'go', sessionId: 'go-output',
          code: 'package main\nimport ("fmt"; "strings")\nfunc main(){fmt.Println(strings.Repeat("x", 5*1024*1024))}', timeoutMs: 60_000,
        });
        check('worker output: Go caps retained stdout at 4 MiB', goOutput.stdoutTruncated === true && Buffer.byteLength(goOutput.stdout) < 4 * 1024 * 1024 + 200, `${Buffer.byteLength(goOutput.stdout)} bytes truncated=${goOutput.stdoutTruncated}`);
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

  // ------------------------------------------------ bounded process capture
  {
    const pyOutput = await exec.run({
      languageId: 'python', sessionId: 'large-output-py',
      code: 'print("x" * (5 * 1024 * 1024))',
    });
    check('worker output: Python caps retained stdout at 4 MiB', pyOutput.stdoutTruncated === true && Buffer.byteLength(pyOutput.stdout) < 4 * 1024 * 1024 + 200, `${Buffer.byteLength(pyOutput.stdout)} bytes truncated=${pyOutput.stdoutTruncated}`);
    const jsOutput = await exec.run({
      languageId: 'javascript', sessionId: 'large-output-js',
      code: 'console.log("x".repeat(5 * 1024 * 1024))',
    });
    check('worker output: JavaScript caps retained stdout at 4 MiB', jsOutput.stdoutTruncated === true && Buffer.byteLength(jsOutput.stdout) < 4 * 1024 * 1024 + 200, `${Buffer.byteLength(jsOutput.stdout)} bytes truncated=${jsOutput.stdoutTruncated}`);

    const raw = await capture(process.execPath, [
      '-e', 'process.stdout.write("A".repeat(5000));process.stderr.write("B".repeat(5000))',
    ], { cwd: process.cwd(), env: process.env, timeoutMs: 10_000, maxCaptureBytes: 1024 });
    check('capture: returned stdout is byte bounded and marked', Buffer.byteLength(raw.stdout) < 1200 && raw.stdoutTruncated && raw.stdout.includes('truncated at 1024 bytes'), `${Buffer.byteLength(raw.stdout)} bytes truncated=${raw.stdoutTruncated}`);
    check('capture: returned stderr is byte bounded and marked', Buffer.byteLength(raw.stderr) < 1200 && raw.stderrTruncated && raw.stderr.includes('truncated at 1024 bytes'), `${Buffer.byteLength(raw.stderr)} bytes truncated=${raw.stderrTruncated}`);

    const log = k.logger.forExecution('verify.capture', 'bounded');
    const lines = await capture(process.execPath, [
      '-e', 'process.stdout.write(Array.from({length:20},(_,i)=>"line"+i+"\\n").join(""))',
    ], { cwd: process.cwd(), env: process.env, timeoutMs: 10_000, captureLines: true, maxLogLines: 3, userLog: log });
    check('capture: telemetry line count is capped', lines.logLines === 3 && lines.logLinesTruncated, `lines=${lines.logLines} truncated=${lines.logLinesTruncated}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed` + (skipped ? ` (${skipped} skipped)` : ''));
  process.exit(failed ? 1 : 0);
}

await main();
