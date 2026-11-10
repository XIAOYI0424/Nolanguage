/**
 * A minimal DAP adapter for the verification suite.
 *
 * debugpy / delve are not installed on this machine, and a debugger test that
 * only runs when an external tool happens to exist proves nothing. This speaks
 * just enough DAP (framed JSON-RPC) for `DapClient` to be exercised for real:
 * capabilities, launch, configurationDone, setBreakpoints, a `stopped` event,
 * one stack frame, one scope, two variables, continue and disconnect.
 *
 * Plain `.mjs` on purpose: it is spawned as a child process and must not need
 * the TypeScript transform.
 *
 * Usage: node scripts/lib/mockDapServer.mjs [--fail]
 */
const FAIL = process.argv.includes('--fail');

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const header = buf.subarray(0, end).toString('ascii');
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = buf.subarray(end + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = end + 4;
    if (buf.length < start + len) return;
    const body = buf.subarray(start, start + len).toString('utf8');
    buf = buf.subarray(start + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    handle(msg);
  }
});

let launched = false;
let lastFile = '/mock/main.mock';

function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function handle(msg) {
  if (msg.method === 'initialize') {
    respond(msg.id, {
      // DAP nests the capabilities under `capabilities` — this is the shape a
      // real adapter (debugpy, delve) uses.
      capabilities: {
        supportsConfigurationDoneRequest: true,
        supportsSetVariable: true,
        supportsTerminateRequest: true,
      },
    });
    return;
  }
  if (msg.method === 'launch') {
    if (FAIL) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'mock launch refused' } });
      return;
    }
    launched = true;
    respond(msg.id, {});
    // Break immediately, the way `stopOnEntry` does.
    notify('stopped', { threadId: 1, reason: 'entry' });
    return;
  }
  if (msg.method === 'attach') {
    // DAP keeps attach and launch apart, and so must the client: an attach has
    // no program to start. The mock echoes which request it received (via the
    // output event and the stopped reason) so the suite can prove the client
    // sent `attach` rather than quietly falling back to `launch`.
    launched = true;
    respond(msg.id, {});
    notify('output', { category: 'console', output: 'attached ' + JSON.stringify(msg.params || {}) });
    notify('stopped', { threadId: 1, reason: 'attach' });
    return;
  }
  if (msg.method === 'configurationDone') {
    respond(msg.id, {});
    return;
  }
  if (msg.method === 'setBreakpoints') {
    // Remember the file so `stackTrace` reports a realistic frame for it.
    if (msg.params?.source?.path) lastFile = msg.params.source.path;
    respond(msg.id, { breakpoints: (msg.params?.breakpoints ?? []).map(() => ({ verified: true })) });
    return;
  }
  if (msg.method === 'stackTrace') {
    respond(msg.id, {
      stackFrames: [
        { id: 100, name: 'main', source: { path: lastFile }, line: 7, column: 1 },
        { id: 101, name: 'work', source: { path: lastFile }, line: 12, column: 3 },
      ],
    });
    return;
  }
  if (msg.method === 'scopes') {
    respond(msg.id, { scopes: [{ name: 'Locals', variablesReference: 900, expensive: false }] });
    return;
  }
  if (msg.method === 'variables') {
    if (!launched) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'not launched' } });
      return;
    }
    respond(msg.id, {
      variables: [
        { name: 'counter', value: '42', type: 'int', variablesReference: 0 },
        { name: 'name', value: '"mock"', type: 'str', variablesReference: 0 },
      ],
    });
    return;
  }
  if (msg.method === 'continue') {
    respond(msg.id, { allThreadsContinued: true });
    notify('terminated', {});
    return;
  }
  if (msg.method === 'next' || msg.method === 'stepIn' || msg.method === 'stepOut') {
    respond(msg.id, {});
    notify('stopped', { threadId: 1, reason: 'step' });
    return;
  }
  if (msg.method === 'disconnect') {
    respond(msg.id, {});
    process.exit(0);
  }
  // Anything else: a JSON-RPC "method not found" is the honest answer.
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

process.on('SIGTERM', () => process.exit(0));
