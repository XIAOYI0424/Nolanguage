/**
 * AI Assistant: the engine side of the panel, verified against a loopback
 * provider.
 *
 * The point of this suite is not "can it fetch a URL" but the three promises the
 * panel makes to the user:
 *   - the key is only ever written to `<appData>/ai.json` and never travels back
 *     to the page (no reply frame may contain it),
 *   - one connection has one answer in flight, and Stop actually closes the
 *     socket,
 *   - a provider failure becomes one `aiDone{ok:false}` with a readable reason,
 *     never a hang and never a stack trace.
 *
 * Everything here is offline: `node:http` serves the three endpoints from
 * 127.0.0.1 and records what the engine sent.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleAiAsk,
  handleAiCancel,
  handleAiConfig,
  handleAiSetConfig,
  type AiDeps,
} from '../src/panel/handlers/ai.js';

let passed = 0;
let total = 0;

function check(name: string, ok: boolean, detail?: string): void {
  total++;
  if (ok) {
    passed++;
    console.log(`PASS  ${name}${detail ? '  - ' + detail : ''}`);
  } else {
    console.log(`FAIL  ${name}${detail ? '  - ' + detail : ''}`);
  }
}

const dataDir = await mkdtemp(join(tmpdir(), 'nlg-ai-'));
process.env.NOLANGUAGE_DATA = dataDir;
const keyFile = join(dataDir, 'ai.json');

type Frame = Record<string, unknown>;

/** One fake client: the engine keys connection state by this object. */
function conn(): { client: object; frames: Frame[]; deps: AiDeps; sent: () => string } {
  const client = {};
  const frames: Frame[] = [];
  const deps: AiDeps = {
    reply: (payload) => { frames.push(payload as Frame); },
    log: () => { /* the log line shape is asserted through the server, not here */ },
  };
  return { client, frames, deps, sent: () => JSON.stringify(frames) };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

// ----------------------------------------------------------------- the provider

interface Seen {
  authorization?: string;
  body?: string;
  aborted: boolean;
}

const seen: Seen = { aborted: false };
let promptSeen = '';

const provider = createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  seen.authorization = String(req.headers.authorization || '');
  let body = '';
  req.on('data', (c) => { body += String(c); });
  req.on('end', () => {
    seen.body = body;
    try {
      promptSeen = String((JSON.parse(body) as { messages?: Array<{ content?: string }> }).messages?.[0]?.content || '');
    } catch { promptSeen = ''; }
    if (String(req.url).startsWith('/bad/')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key sk-test-123' } }));
      return;
    }
    if (String(req.url).startsWith('/slow/')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      res.on('close', () => { seen.aborted = true; });
      return; // deliberately never ends until the client hangs up
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of ['one ', 'two ', 'three']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
});

await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const port = (provider.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

// --------------------------------------------------------------- configuration

{
  const c = conn();
  handleAiConfig(c.deps);
  const view = c.frames[0] || {};
  check('config: empty app data answers with an empty view, not an error',
    view.kind === 'aiConfig' && view.baseUrl === '' && view.hasKey === false && !('key' in view));
}

{
  const c = conn();
  handleAiSetConfig(c.deps, { baseUrl: 'file:///etc/passwd', model: 'm' });
  const view = c.frames[0] || {};
  check('config: a non-http base URL is refused with a reason',
    typeof view.error === 'string' && String(view.error).includes('http(s)'));
  handleAiSetConfig(c.deps, { baseUrl: `${base}/v1`, model: 'bad model' });
  check('config: a model with whitespace is refused',
    typeof (c.frames[1] || {}).error === 'string');
  handleAiSetConfig(c.deps, { baseUrl: `http://user:pw@127.0.0.1:${port}/v1`, model: 'm' });
  check('config: credentials embedded in the URL are refused (the key has one home only)',
    String((c.frames[2] || {}).error || '').includes('credentials'));
}

{
  const c = conn();
  handleAiSetConfig(c.deps, { baseUrl: `${base}/v1`, model: 'gpt-4o-mini', key: 'sk-test-123' });
  const view = c.frames[0] || {};
  check('config: saving a key reports hasKey but never echoes the key',
    view.kind === 'aiConfig' && view.hasKey === true && !JSON.stringify(c.frames).includes('sk-test-123'));
  const raw = await readFile(keyFile, 'utf8');
  check('config: the key is persisted in <appData>/ai.json', raw.includes('sk-test-123') && raw.includes('gpt-4o-mini'));
  if (process.platform !== 'win32') {
    const mode = (await stat(keyFile)).mode & 0o777;
    check('config: ai.json is written 0600', mode === 0o600, `mode ${mode.toString(8)}`);
  }
  handleAiConfig(c.deps);
  const readBack = c.frames[1] || {};
  check('config: reading back keeps the key hidden', readBack.hasKey === true && !('key' in readBack));
}

// ------------------------------------------------------------------- streaming

{
  const c = conn();
  void handleAiAsk(c.client, c.deps, { requestId: 11, prompt: 'what is this?', language: 'go' });
  const done = await waitFor(() => c.frames.some((f) => f.kind === 'aiDone'));
  const outs = c.frames.filter((f) => f.kind === 'aiOut');
  const last = c.frames[c.frames.length - 1] || {};
  check('ask: a streamed answer arrives as incremental aiOut frames',
    done && outs.length === 3 && outs.map((f) => f.text).join('') === 'one two three');
  check('ask: exactly one aiDone closes the stream with ok:true and a byte count',
    last.kind === 'aiDone' && last.ok === true && last.requestId === 11 && last.bytes === 13);
  check('ask: the key travels as a Bearer header and never inside the body',
    seen.authorization === 'Bearer sk-test-123' && !String(seen.body).includes('sk-test-123'));
  check('ask: the request is OpenAI-compatible and carries the language hint',
    (() => {
      const body = JSON.parse(promptSeen ? seen.body || '{}' : '{}') as { model?: string; stream?: boolean };
      return body.model === 'gpt-4o-mini' && body.stream === true && promptSeen.startsWith('The user is editing a go file.');
    })());
}

{
  const c = conn();
  void handleAiAsk(c.client, c.deps, { requestId: 12, prompt: '' });
  check('ask: an empty prompt is refused before any network call',
    (c.frames[0] || {}).ok === false && String((c.frames[0] || {}).error).includes('empty'));
  void handleAiAsk(c.client, c.deps, { requestId: 13, prompt: 'x'.repeat(8001) });
  check('ask: an over-long prompt is refused',
    String((c.frames[1] || {}).error).includes('longer than'));
}

// ----------------------------------------------------------------- disconnects

{
  const c = conn();
  handleAiSetConfig(c.deps, { baseUrl: `${base}/bad/v1`, model: 'm' });
  void handleAiAsk(c.client, c.deps, { requestId: 21, prompt: 'hi' });
  await waitFor(() => c.frames.some((f) => f.kind === 'aiDone'));
  const done = c.frames.find((f) => f.kind === 'aiDone') || {};
  check('failure: an HTTP 401 becomes one aiDone with the status, not a thrown stack',
    done.ok === false && String(done.error).includes('401'));
  check('failure: the provider error body is not echoed back to the page',
    !JSON.stringify(c.frames).includes('sk-test-123'));
}

{
  const c = conn();
  handleAiSetConfig(c.deps, { baseUrl: `${base}/slow/v1`, model: 'm' });
  void handleAiAsk(c.client, c.deps, { requestId: 31, prompt: 'stream forever' });
  const streaming = await waitFor(() => c.frames.some((f) => f.kind === 'aiOut'));
  void handleAiAsk(c.client, c.deps, { requestId: 32, prompt: 'second' });
  const refused = await waitFor(() => c.frames.some((f) => f.requestId === 32 && f.kind === 'aiDone'));
  check('one at a time: a second ask while streaming is refused',
    streaming && refused && String((c.frames.find((f) => f.requestId === 32 && f.kind === 'aiDone') || {}).error).includes('already streaming'));

  handleAiCancel(c.client, c.deps, { requestId: 31 });
  const cancelled = c.frames.find((f) => f.kind === 'aiCancelled') || {};
  check('cancel: aiCancel answers ok:true while a stream is running', cancelled.ok === true && cancelled.requestId === 31);
  const settled = await waitFor(() => c.frames.some((f) => f.requestId === 31 && f.kind === 'aiDone'));
  const done = c.frames.find((f) => f.requestId === 31 && f.kind === 'aiDone') || {};
  check('cancel: the stream still ends with exactly one aiDone, marked cancelled',
    settled && done.ok === false && String(done.error).includes('cancelled'));
  check('cancel: the socket is actually closed, so the provider stops generating',
    await waitFor(() => seen.aborted));

  const idle = conn();
  handleAiCancel(idle.client, idle.deps, { requestId: 33 });
  check('cancel: with nothing running it says ok:false instead of lying',
    (idle.frames[0] || {}).ok === false);
}

// ---------------------------------------------------------------------- cleanup

provider.close();
await rm(dataDir, { recursive: true, force: true });

console.log(`\n${passed}/${total} checks passed`);
if (passed !== total) process.exitCode = 1;
