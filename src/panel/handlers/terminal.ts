/**
 * The attached terminal: one shell child per connection.
 *
 * The child stays attached until it exits so the panel can drive interactive
 * programs (`input()`, a dev server), and a 4 MiB output cap kills a runaway
 * producer. Splitting this out of `run.ts` keeps the module that owns "one
 * process, lots of output" separate from the one that owns the run pipeline.
 */
import { spawn } from 'node:child_process';
import { OutputDecoder } from '../../util/encoding.js';
import { stateFor } from '../conn-state.js';

/**
 * Terminal command execution for the PyCharm-style shell. Spawns an attached
 * shell child (piped stdin/stdout/stderr) so the terminal can drive interactive
 * programs — e.g. `python main.py` that calls `input()`, or a long-running
 * server. Output streams back live as `termOut` frames; the child stays attached
 * until it exits, when a `termResult` frame arrives. While attached, the UI sends
 * `termInput` to feed the child's stdin. A 4 MiB output cap kills a runaway
 * producer so it can't wedge the panel.
 */
export function handleTerm(cmd: string, reply: (p: unknown) => void, conn: unknown, cwd: string): void {
  const st = stateFor(conn);
  if (st.termChild) return; // already attached; ignore stray commands
  const started = Date.now();
  let bytes = 0;
  const CAP = 4 * 1024 * 1024;
  const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
  const args = process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd];
  const child = spawn(shell, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  st.termChild = child;
  const cap = (d: Buffer): void => {
    bytes += d.length;
    if (bytes > CAP) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };
  const decoders = { stdout: new OutputDecoder(), stderr: new OutputDecoder() };
  child.stdout?.on('data', (d) => { cap(d); reply({ kind: 'termOut', text: decoders.stdout.push(d), stream: 'stdout' }); });
  child.stderr?.on('data', (d) => { cap(d); reply({ kind: 'termOut', text: decoders.stderr.push(d), stream: 'stderr' }); });
  child.on('error', (err) => {
    st.termChild = undefined;
    reply({ kind: 'termResult', cmd, stdout: '', stderr: String(err), code: 1, ms: Date.now() - started });
  });
  child.on('close', (code, signal) => {
    st.termChild = undefined;
    reply({ kind: 'termResult', cmd, stdout: '', stderr: '', code: code ?? null, ms: Date.now() - started });
  });
}
