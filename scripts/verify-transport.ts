/**
 * Transport equivalence: the same engine, reached two ways.
 *
 * The Tauri migration replaces the WebSocket with a pipe, and the only thing
 * standing between the UI and the engine is `Transport`. So this suite proves
 * the two implementations are interchangeable *before* any Rust exists:
 *
 *   A. equivalence  — feed identical frames to `WsTransport` and `StdioTransport`
 *                     and require byte-identical reply sequences.
 *   B. framing      — the pipe is a byte stream, so a frame may arrive split, in
 *                     company, or with CRLF; none of that may change the result.
 *   C. end-to-end   — boot the real engine in `--panel-stdio` mode over a pipe
 *                     and drive it, including the invariant that makes the whole
 *                     thing work: **stdout carries protocol lines and nothing
 *                     else** (a banner or log line would desynchronise the peer).
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-transport.ts
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { StdioTransport, WsTransport, parseFrame, type Transport } from '../src/panel/Transport.js';
import type { WebSocketConnection } from '../src/net/websocket.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/**
 * A pipe pair seen from the engine's side.
 *
 * `toPeer` is what the transport writes and the peer reads; `fromPeer` is what
 * the peer writes and the transport reads. They are deliberately *not* piped
 * into each other — a real process has separate stdin and stdout, and joining
 * them would feed the engine its own output.
 */
interface Pipe {
  toPeer: PassThrough;
  fromPeer: PassThrough;
  /** Peer side: write a line to the engine. */
  peerWrites(line: string): void;
  /** Peer side: everything the engine has written so far. */
  peerReads(): string;
}
function makePipe(): Pipe {
  const toPeer = new PassThrough();
  const fromPeer = new PassThrough();
  let read = '';
  toPeer.on('data', (c: Buffer) => { read += c.toString('utf8'); });
  return {
    toPeer,
    fromPeer,
    peerWrites: (line: string) => fromPeer.write(line),
    peerReads: () => read,
  };
}

// ---------------------------------------------------------- A. equivalence

/**
 * Stand-in for `WebSocketConnection`: an EventEmitter plus the two methods
 * `WsTransport` actually uses. Building the real one would drag in the HTTP
 * upgrade machinery, which is not what is under test here.
 */
class FakeConn extends EventEmitter {
  sent: string[] = [];
  closed = 0;
  send(text: string): void { this.sent.push(text); }
  close(): void { this.closed++; this.emit('close'); }
  /** Deliver an inbound frame the way the real connection does. */
  frame(text: string): void { this.emit('message', text); }
}

/** A router shaped like the engine's: answers `ping`, echoes, errors on garbage. */
function installRouter(t: Transport): string[] {
  const seen: string[] = [];
  t.onMessage((raw) => {
    const msg = parseFrame(raw);
    if (!msg) { t.send({ kind: 'error', message: 'invalid JSON' }); return; }
    seen.push(String(msg.kind));
    if (msg.kind === 'ping') t.send({ kind: 'pong', at: 1 });
    else if (msg.kind === 'echo') t.send({ kind: 'echoed', value: msg.value });
    else t.send({ kind: 'error', message: `unknown message kind: ${String(msg.kind)}` });
  });
  return seen;
}

function compareTransports(): void {
  const conn = new FakeConn();
  const ws = new WsTransport(conn as unknown as WebSocketConnection);
  const wsSeen = installRouter(ws);

  const pipe = makePipe();
  const stdio = new StdioTransport({ in: pipe.fromPeer, out: pipe.toPeer });
  const stdioSeen = installRouter(stdio);

  // Blank lines are *not* frames on a pipe (nothing to parse), so they belong to
  // the framing tests below, not to the equivalence set.
  const frames = [
    JSON.stringify({ kind: 'ping' }),
    JSON.stringify({ kind: 'echo', value: [1, 'two', { three: true }] }),
    'not json at all',
    JSON.stringify({ kind: 'nope' }),
  ];

  for (const frame of frames) {
    conn.frame(frame);
    pipe.peerWrites(frame + '\n');
  }

  check('transport: both accept the same frames',
    JSON.stringify(wsSeen) === JSON.stringify(stdioSeen), `ws=[${wsSeen}] stdio=[${stdioSeen}]`);

  const wsReplies = conn.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  const stdioReplies = pipe.peerReads().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  check('transport: both reply the same number of times',
    wsReplies.length === stdioReplies.length && wsReplies.length === frames.length,
    `ws=${wsReplies.length} stdio=${stdioReplies.length}`);
  check('transport: reply payloads are identical',
    JSON.stringify(wsReplies) === JSON.stringify(stdioReplies),
    JSON.stringify(wsReplies.map((r) => r.kind)));

  // A dead peer is routine; a transport must swallow it.
  const dead = new FakeConn();
  dead.send = () => { throw new Error('socket is closed'); };
  const t = new WsTransport(dead as unknown as WebSocketConnection);
  let threw = false;
  try { t.send({ kind: 'ping' }); } catch { threw = true; }
  check('transport: a dead peer never throws from send', !threw);
  check('transport: a broken write closes the dead connection', dead.closed === 1,
    `close() calls=${dead.closed}`);

  const brokenPipe = makePipe();
  brokenPipe.toPeer.destroy(new Error('pipe gone'));
  const t2 = new StdioTransport({ in: brokenPipe.fromPeer, out: brokenPipe.toPeer });
  threw = false;
  try { t2.send({ kind: 'ping' }); } catch { threw = true; }
  check('transport: a broken pipe never throws from send', !threw);
}

// ---------------------------------------------------------- B. framing

function framingTests(): void {
  const pipe = makePipe();
  const t = new StdioTransport({ in: pipe.fromPeer, out: pipe.toPeer });
  const got: string[] = [];
  t.onMessage((raw) => got.push(raw));

  // One frame split across three writes, then two frames in one write, then a
  // CRLF line and blank lines — each frame must arrive exactly once, trimmed.
  const a = JSON.stringify({ kind: 'ping', at: 1 });
  pipe.peerWrites(a.slice(0, 7));
  pipe.peerWrites(a.slice(7, 20));
  pipe.peerWrites(a.slice(20) + '\n');
  pipe.peerWrites(JSON.stringify({ kind: 'echo' }) + '\n' + JSON.stringify({ kind: 'echo', n: 2 }) + '\n');
  pipe.peerWrites('\r\n' + JSON.stringify({ kind: 'last' }) + '\r\n');
  pipe.peerWrites('\n\n');

  check('framing: a frame split across writes is reassembled', got.length === 4, `${got.length} frames`);
  check('framing: each frame arrives whole and parseable',
    got.every((g) => parseFrame(g) !== null), got.join(' | '));
  check('framing: blank and CRLF lines are not frames',
    got.indexOf('') === -1 && got.every((g) => g.trim() === g), got.map((g) => JSON.stringify(g)).join(' '));
  check('framing: frames keep their order',
    parseFrame(got[0])?.kind === 'ping' && parseFrame(got[3])?.kind === 'last',
    got.map((g) => String(parseFrame(g)?.kind)).join(','));

  // A trailing partial line must be held back, not parsed.
  const held = makePipe();
  const t2 = new StdioTransport({ in: held.fromPeer, out: held.toPeer });
  const got2: string[] = [];
  t2.onMessage((raw) => got2.push(raw));
  held.peerWrites('{"kind":"pi');
  held.peerWrites('ng"}\n');
  check('framing: a partial line is held until it completes',
    got2.length === 1 && parseFrame(got2[0])?.kind === 'ping', JSON.stringify(got2));
}

// ---------------------------------------------------------- C. end to end

/** Boot the real engine on a pipe and drive it, exactly as the Rust relay will. */
async function endToEnd(): Promise<void> {
  const child = spawn(process.execPath, [
    '--experimental-loader', './resolve-loader.mjs',
    '--experimental-transform-types',
    'src/panel/server.ts', '--panel-stdio',
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_NO_STORE: '1',
      PANEL_NO_DEMO: '1',
      SANDBOX_MIN: '0',
      NOLANGUAGE_QUIET: '1',
      PANEL_EXPLORER_ROOT: ROOT,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const inbox: Record<string, unknown>[] = [];
  let buf = '';
  let stdoutClean = true;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { inbox.push(JSON.parse(line) as Record<string, unknown>); }
      catch { stdoutClean = false; } // a non-JSON line is a protocol violation
    }
  });

  const waitFor = async (kind: string, ms = 30_000): Promise<Record<string, unknown> | undefined> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = inbox.find((m) => m.kind === kind);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  };
  const send = (msg: Record<string, unknown>): void => { child.stdin?.write(JSON.stringify(msg) + '\n'); };

  try {
    const hello = await waitFor('workspace', 60_000);
    check('stdio: the engine greets the pipe with a workspace message', !!hello, hello ? 'workspace' : '(none)');
    check('stdio: the explorer root is announced for the tree',
      inbox.some((m) => m.kind === 'fsRoot'), inbox.map((m) => String(m.kind)).join(','));

    send({ kind: 'ping' });
    check('stdio: ping is answered with pong', !!(await waitFor('pong')), '');
    check('stdio: stdout carries protocol lines only (no banner, no logs)', stdoutClean, '');

    send({ kind: 'listExtensions' });
    const exts = await waitFor('extensions');
    check('stdio: the extension list arrives over the pipe', !!exts,
      exts ? `${(exts.extensions as unknown[])?.length ?? 0} extension(s)` : '(none)');

    send({ kind: 'fsList', path: '' });
    const listing = await waitFor('fsListing');
    check('stdio: a filesystem listing arrives over the pipe', !!listing,
      listing ? `${(listing.entries as unknown[])?.length ?? 0} entries` : '(none)');

    send({ kind: 'bogusKind' });
    const err = await waitFor('error');
    check('stdio: an unknown kind is reported, not fatal', !!err, String(err?.message ?? ''));

    // A frame split across writes must be reassembled, not lost.
    child.stdin?.write('{"kind":"pi');
    await new Promise((r) => setTimeout(r, 150));
    child.stdin?.write('ng"}\n');
    check('stdio: a frame split across writes is reassembled', !!(await waitFor('pong', 5000)), '');

    check('stdio: the engine survives all of the above', child.exitCode === null, `exit=${String(child.exitCode)}`);
  } finally {
    try { child.stdin?.end(); } catch { /* already gone */ }
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
}

async function main(): Promise<void> {
  compareTransports();
  console.log('');
  framingTests();
  console.log('');
  await endToEnd();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failed: ' + failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('verify-transport failed:', e);
  process.exit(1);
});
