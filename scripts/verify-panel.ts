/**
 * Stage-2 verification: boots the panel server as a child process, connects a
 * raw WebSocket client, and asserts the wire protocol works end to end
 * (handshake -> hello -> metrics digest -> logs -> slow paths -> filter echo).
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-panel.ts
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPickerScript, encodeCommand, parsePickerOutput } from '../src/util/nativePicker.js';

const PORT = Number(process.env.VERIFY_PORT ?? 7411);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Run a generated script through the real parser, headless (no window). */
const runPowerShell = (script: string): Promise<{ code: number | null; out: string; err: string }> =>
  new Promise((resolve) => {
    let out = '';
    let err = '';
    const p = spawn('powershell', ['-NoProfile', '-STA', '-EncodedCommand', encodeCommand(script)], {
      windowsHide: true,
      shell: false,
    });
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => resolve({ code, out, err }));
  });

interface Msg {
  kind: string;
  [k: string]: unknown;
}

/** Tiny raw WS client (mirrors the server frame format). */
class RawWsClient {
  received: Msg[] = [];
  ready: Promise<void>;
  private socket: ReturnType<typeof connect>;
  private buffer = Buffer.alloc(0);
  private handshakeBuf = Buffer.alloc(0);
  private hsDone = false;
  private expected = '';
  private resolveHs!: () => void;

  constructor() {
    this.socket = connect(PORT, '127.0.0.1');
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveHs = resolve;
      const timer = setTimeout(() => reject(new Error('handshake timeout')), 8000);
      this.socket.on('error', reject);
      this.socket.on('connect', () => {
        const key = randomBytes(16).toString('base64');
        this.expected = createHash('sha1').update(key + GUID).digest('base64');
        this.socket.write(
          `GET / HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this.socket.on('data', (c: Buffer) => {
        if (!this.hsDone) {
          this.handshakeBuf = Buffer.concat([this.handshakeBuf, c]);
          const idx = this.handshakeBuf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this.handshakeBuf.subarray(0, idx).toString();
          const rest = this.handshakeBuf.subarray(idx + 4);
          this.handshakeBuf = Buffer.alloc(0);
          if (!head.includes('101') || !head.includes(this.expected)) {
            reject(new Error('bad handshake: ' + head));
            return;
          }
          this.hsDone = true;
          clearTimeout(timer);
          resolve();
          if (rest.length) this.push(rest);
        } else {
          this.push(c);
        }
      });
    });
  }

  private push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const f = this.parse();
      if (!f) break;
      if (f.opcode === 0x1) {
        try {
          this.received.push(JSON.parse(f.payload.toString('utf8')));
        } catch {
          /* ignore */
        }
      } else if (f.opcode === 0x9) {
        this.sendFrame(0xa, f.payload);
      } else if (f.opcode === 0x8) {
        this.socket.end();
      }
    }
  }

  private parse(): { opcode: number; payload: Buffer } | null {
    const b = this.buffer;
    if (b.length < 2) return null;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    if (masked) off += 4;
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    this.buffer = b.subarray(off + len);
    return { opcode, payload };
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(obj: unknown): void {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }
  find(kind: string): Msg | undefined {
    return this.received.find((m) => m.kind === kind);
  }
  findAll(kind: string): Msg[] {
    return this.received.filter((m) => m.kind === kind);
  }
  close(): void {
    this.socket.destroy();
  }
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', '--experimental-loader', './resolve-loader.mjs', 'src/panel/server.ts'],
    { env: { ...process.env, PANEL_PORT: String(PORT), PANEL_SLOW_MS: '30', PANEL_NO_STORE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverOut = '';
  child.stdout.on('data', (d) => (serverOut += d.toString()));
  child.stderr.on('data', (d) => (serverOut += d.toString()));

  try {
    await waitForHttp(PORT, 10_000);
    const c = new RawWsClient();
    await c.ready;
    check('websocket handshake (RFC 6455)', true, '101 Switching Protocols');

    await waitFor(() => !!c.find('hello'), 5000);
    const hello = c.find('hello')!;
    check('hello frame on connect', !!hello, `appVersion=${hello.appVersion} push=${hello.pushIntervalMs}ms`);
    check(
      'hello carries command list',
      Array.isArray(hello.commands) && (hello.commands as unknown[]).length > 0,
      `${(hello.commands as unknown[]).length} commands`,
    );
    check('hello carries environment', typeof hello.os === 'string' && typeof hello.arch === 'string', String(hello.arch));

    // Wait for a digest that actually carries instrumented metrics (the first
    // few arrive before the demo traffic has produced any samples).
    await waitFor(
      () =>
        c.findAll('metrics').some((m) => {
          const mm = m.metrics as Record<string, unknown>;
          return !!mm['command.latency'] && Object.keys(m.series as object).length > 0;
        }),
      15_000,
    );
    const digests = c.findAll('metrics');
    const populated = digests.filter((m) => !!(m.metrics as Record<string, unknown>)['command.latency']);
    const d1 = populated[populated.length - 1] ?? digests[digests.length - 1];
    const metrics = d1.metrics as Record<string, { p95: number; count: number }>;
    check('metrics digest at ~1Hz', digests.length >= 2, `${digests.length} digests, tick=${d1.tick}`);
    check(
      'auto-instrumented command metrics present',
      !!metrics['command.latency'],
      Object.keys(metrics).slice(0, 5).join(','),
    );
    check('digest carries sparkline series', Object.keys(d1.series as object).length > 0, `${Object.keys(d1.series as object).length} series`);

    await waitFor(() => c.findAll('log').length >= 1, 8000);
    const logs = c.findAll('log').flatMap((m) => m.records as { levelName: string; component: string; level: number }[]);
    check('log frames delivered', logs.length > 0, `${logs.length} records`);
    check('log records are structured', logs.every((l) => typeof l.component === 'string' && typeof l.levelName === 'string'));

    // Slow paths: wait for real spans (the initial snapshot frame has none).
    await waitFor(() => c.findAll('slow').some((m) => (m.spans as unknown[]).length > 0), 12_000);
    const slow = c.findAll('slow').flatMap((m) => m.spans as { durationMs: number }[]);
    check(
      'slow-path capture broadcast',
      slow.length > 0,
      `${slow.length} spans, max=${slow.length ? Math.max(...slow.map((s) => s.durationMs)).toFixed(1) : 0}ms`,
    );

    // Live WARN+ push: a WARN must arrive outside the digest cadence. Wait for
    // a log frame whose records include a WARN/ERROR and whose arrival is
    // independent of a metrics digest.
    await waitFor(
      () => c.findAll('log').some((m) => (m.records as { level: number }[]).some((r) => r.level >= 3)),
      12_000,
    );
    const highSeverity = c
      .findAll('log')
      .flatMap((m) => m.records as { level: number }[])
      .filter((r) => r.level >= 3);
    check('live WARN+ push works', highSeverity.length > 0, `${highSeverity.length} high-severity pushed live`);

    c.send({ kind: 'filter', minLevel: 3, components: ['lsp.pyright'], pattern: 'slow' });
    await waitFor(() => !!c.find('filter'), 4000);
    const f = c.find('filter')!;
    check('filter command echoed back', !!f, JSON.stringify(f.filter));

    c.send({ kind: 'clear' });
    await waitFor(() => !!c.find('logReset'), 4000);
    check('clear command -> logReset', !!c.find('logReset'));

    c.send({ kind: 'bogus' });
    await waitFor(() => !!c.find('error'), 4000);
    check('unknown command rejected', !!c.find('error'));

    c.close();
  } finally {
    child.kill('SIGKILL');
  }

  // ---- the OS dialog the page asks for -------------------------------------
  // `File > Open Folder` used to call `__TAURI_INTERNALS__`, which the shipped
  // Edge --app build does not have, so the menu item answered "available in the
  // desktop app" from inside the desktop app. The engine opens the dialog now,
  // and these checks keep the generated PowerShell honest: a quoting bug there is
  // a dialog that never appears, which is exactly the bug being fixed.
  //
  // The dialog is never shown here: `ShowDialog()` is swapped for a property
  // dump, so the real parser runs over the real generated text without a window.
  {
    const dirScript = buildPickerScript({ mode: 'directory', title: "Bob's \"folder\"", defaultPath: 'C:\\Temp' });
    check('picker: a directory script constructs a FolderBrowserDialog', dirScript.includes('FolderBrowserDialog'));
    check('picker: an apostrophe in the title is doubled, not left to break the string', dirScript.includes("Bob''s"));
    const fileScript = buildPickerScript({
      mode: 'file',
      title: 'Open',
      filters: [{ name: 'Source', extensions: ['py', 'js'] }],
    });
    check(
      'picker: the file filter becomes a WinForms filter string',
      fileScript.includes("'Source|*.py;*.js|All files|*.*'"),
      fileScript.split('\n').find((l) => l.includes('Filter')) ?? '',
    );
    check('picker: a cancelled dialog parses as null', parsePickerOutput('') === null);
    check('picker: a path with trailing noise still parses', parsePickerOutput('x\r\nC:\\a b\\c.py\r\n') === 'C:\\a b\\c.py');

    const headless = (script: string): string =>
      script.replace(
        /if \(\$d\.ShowDialog\(\) -eq \[System\.Windows\.Forms\.DialogResult\]::OK\) \{ \[Console\]::Out\.Write\(([^)]+)\) \}/,
        '[Console]::Out.Write("OK:" + $d.GetType().Name)',
      );
    for (const [label, script] of [
      ['directory', dirScript],
      ['file', fileScript],
      ['save', buildPickerScript({ mode: 'save', title: 'Save As' })],
    ] as const) {
      const r = await runPowerShell(headless(script));
      check(
        `picker: PowerShell parses the ${label} script and builds its dialog`,
        r.code === 0 && r.out.trim().startsWith('OK:'),
        r.code === 0 ? r.out.trim() : (r.err.trim().split(/\r?\n/).slice(-1)[0] ?? `exit ${r.code}`),
      );
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('--- server output (tail) ---\n' + serverOut.slice(-1500));
    process.exit(1);
  }
}

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await delay(70);
  }
}

async function waitForHttp(port: number, ms: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > ms) throw new Error('server did not start');
    await delay(150);
  }
}

main().catch((e) => {
  console.error('verify failed:', e);
  process.exit(1);
});
