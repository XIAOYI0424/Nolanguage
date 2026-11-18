#!/usr/bin/env node
/**
 * A deliberately tiny LSP server over stdio, for testing the *manager*.
 *
 * The manager's job — pooling, routing, cancelling, degrading — is
 * language-agnostic, so testing it against jdtls would make every assertion
 * depend on a 50 MB JVM download and a 30 s import. This server speaks just
 * enough LSP to exercise those paths, and every behaviour is a CLI flag so a
 * test can dial the exact condition it wants.
 *
 * It also logs every inbound method to a file, which is how a test proves that
 * `$/cancelRequest` was actually forwarded and that `didChange` was sent for one
 * file and not the others.
 *
 *   node fake-lsp.mjs --log <path> [--init-delay ms] [--completion-delay ms]
 *                     [--items a,b,c] [--diagnostics 1] [--fail-start]
 */
import { appendFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const LOG = arg('log', '');
const INIT_DELAY = Number(arg('init-delay', '0'));
const COMPLETION_DELAY = Number(arg('completion-delay', '0'));
const ITEMS = arg('items', 'alpha,beta,gamma').split(',').filter(Boolean);
const DIAGNOSTICS = flag('diagnostics');
const FAIL_START = flag('fail-start');
/** Never answer these methods: the client must time out and degrade. */
const argsOf = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}` && i + 1 < argv.length) out.push(argv[i + 1]);
  return out;
};
const HANG = new Set(argsOf('hang'));
/** Exit the moment this method arrives: simulates a server dying mid-request. */
const DIE_ON = arg('die-on', '');
/** Record the initialize params, so a test can prove options were forwarded. */
const LOG_INIT = flag('log-init');

if (LOG) writeFileSync(LOG, '');
const log = (method) => {
  if (LOG) appendFileSync(LOG, `${method}\n`);
};

if (FAIL_START) {
  process.stderr.write('fake-lsp: refusing to start\n');
  process.exit(3);
}

let buffer = Buffer.alloc(0);
/** id -> timer, so $/cancelRequest can actually cancel work. */
const pending = new Map();
let initialized = false;

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function handle(msg) {
  log(msg.method ?? `response:${msg.id}`);
  if (DIE_ON && msg.method === DIE_ON) {
    // Exit without answering: the client is left holding a promise whose pipe is
    // gone, which is exactly the crash shape that used to take the editor down.
    process.exit(7);
  }
  switch (msg.method) {
    case 'initialize': {
      if (LOG_INIT) log(`initialize-options:${JSON.stringify(msg.params?.initializationOptions ?? null)}`);
      const capabilities = {
        completionProvider: { triggerCharacters: ['.'] },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        codeActionProvider: true,
        // Advertised so the folding request goes out; the answer below contains
        // one degenerate span, which the client's normaliser must drop.
        foldingRangeProvider: true,
        // Formatting is deliberately absent: the fallback path for it is
        // exercised by the client's own indenter.
        documentFormattingProvider: false,
      };
      const respond = () =>
        reply(msg.id, {
          capabilities,
          serverInfo: { name: 'fake-lsp', version: '1.0.0' },
          // Echoed back so a test can prove initializationOptions were passed.
          __initializationOptions: msg.params?.initializationOptions ?? null,
        });
      if (INIT_DELAY > 0) setTimeout(respond, INIT_DELAY);
      else respond();
      return;
    }
    case 'initialized':
      initialized = true;
      return;
    case 'shutdown':
      reply(msg.id, null);
      return;
    case 'exit':
      process.exit(0);
      return;
    case 'textDocument/didOpen': {
      const uri = msg.params?.textDocument?.uri;
      if (DIAGNOSTICS && uri) {
        send({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: {
            uri,
            diagnostics: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                severity: 1,
                message: 'fake diagnostic',
                source: 'fake-lsp',
              },
              // A duplicate, so the buffer's dedupe has something to remove.
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                severity: 1,
                message: 'fake diagnostic',
                source: 'fake-lsp',
              },
            ],
          },
        });
      }
      return;
    }
    case 'textDocument/didChange':
      return;
    case 'textDocument/completion': {
      if (HANG.has('textDocument/completion')) {
        // Deliberately never answers and never clears: the request stays in
        // flight until the caller's budget expires.
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(msg.id);
        reply(
          msg.id,
          ITEMS.map((label) => ({ label, kind: 3, detail: 'from fake-lsp' })),
        );
      }, COMPLETION_DELAY);
      pending.set(msg.id, timer);
      return;
    }
    case 'textDocument/hover':
      reply(msg.id, { contents: { value: `hover from fake-lsp (initialized=${initialized})` } });
      return;
    case 'textDocument/definition':
      if (HANG.has('textDocument/definition')) return;
      reply(msg.id, [
        { uri: msg.params?.textDocument?.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ]);
      return;
    // The next three exist so the *plumbing* is covered in CI: the request goes
    // out, the result is normalised, the frame carries what the UI needs. They
    // deliberately return URIs in the form pyright uses (percent-encoded drive,
    // lowercase) — that is the shape that broke navigation in the live suite.
    case 'textDocument/references':
      if (HANG.has('textDocument/references')) return;
      reply(msg.id, [
        { uri: 'file:///c%3A/tmp/fake-a.py', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
        { uri: 'file:///c%3A/tmp/fake-a.py', range: { start: { line: 5, character: 4 }, end: { line: 5, character: 7 } } },
        { uri: 'file:///c%3A/tmp/fake-b.py', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } },
      ]);
      return;
    case 'textDocument/codeAction':
      if (HANG.has('textDocument/codeAction')) return;
      reply(msg.id, [
        {
          title: 'Replace with alpha',
          kind: 'quickfix',
          edit: {
            changes: {
              'file:///c%3A/tmp/fake-a.py': [
                { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'alpha' },
              ],
            },
          },
        },
      ]);
      return;
    case 'textDocument/foldingRange':
      if (HANG.has('textDocument/foldingRange')) return;
      reply(msg.id, [
        // Out of order on purpose: the normaliser sorts by start line.
        { startLine: 10, endLine: 14, kind: 'region' },
        { startLine: 2, endLine: 6 },
        // Degenerate: start === end, dropped by the client.
        { startLine: 20, endLine: 20 },
      ]);
      return;
    case '$/cancelRequest': {
      const id = msg.params?.id;
      const timer = pending.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        pending.delete(id);
        // LSP requires an answer to a cancelled request, and this exact code is
        // what the client's scheduler recognises.
        fail(id, -32800, 'Request cancelled');
      }
      return;
    }
    default:
      if (msg.id !== undefined) fail(msg.id, -32601, `fake-lsp does not implement ${msg.method}`);
  }
}

process.stdin.on('data', (chunk) => {
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString('ascii');
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) {
      buffer = buffer.subarray(end + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = end + 4;
    if (buffer.length < start + len) return;
    const body = buffer.subarray(start, start + len).toString('utf8');
    buffer = buffer.subarray(start + len);
    try {
      handle(JSON.parse(body));
    } catch {
      /* a malformed frame is the client's bug, not ours */
    }
  }
});

process.stdin.on('end', () => process.exit(0));
