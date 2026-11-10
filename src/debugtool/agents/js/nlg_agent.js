/**
 * Debug Observatory agent for JavaScript — loaded with `node --require`.
 *
 * How it samples: Node has no "read another thread's stack" API. The one
 * mechanism that produces real stacks while the program runs is the inspector's
 * CPU profiler. So the agent runs the profiler in **500 ms windows**: start,
 * wait, stop, read the samples, restart. Each sample becomes one `stack` event.
 *
 * What that means, stated plainly because the UI has to be honest about it:
 *
 *   - samples are **windows, not a continuous clock** — there is a gap while the
 *     profiler restarts, and a call shorter than the gap can be missed;
 *   - the sampling interval is 10 ms, so ~50 samples per window (~100/s), well
 *     under the engine's 500/s ceiling;
 *   - **no live locals**: a JS frame's variables are not reachable from outside.
 *     Watches therefore evaluate in **global scope** only, and the page shows no
 *     locals pane for this language.
 *
 * Everything is guarded: the agent must never change program behaviour, and it
 * must disappear quietly when the engine is not there.
 */
'use strict';

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');

const V = 1;
const WINDOW_MS = 500;
const INTERVAL_US = 10_000; // 10 ms
const MAX_FRAMES = 12;
const MAX_SAMPLES_PER_WINDOW = 60;

const PORT = Number(process.env.NLG_DEBUG_PORT || 0);
const TOKEN = process.env.NLG_DEBUG_TOKEN || '';
const WATCH_EVERY_MS = 1000;

if (PORT > 0) boot();

function boot() {
  let sock;
  try {
    sock = net.createConnection({ host: '127.0.0.1', port: PORT });
    sock.setNoDelay(true);
  } catch {
    return;
  }

  let closed = false;
  let sent = 0;
  let dropped = 0;
  const watches = new Set();

  sock.on('error', () => {
    closed = true;
  });
  sock.on('close', () => {
    closed = true;
  });

  function send(event) {
    if (closed || !sock.writable) return;
    try {
      sock.write(JSON.stringify(event) + '\n');
      sent++;
    } catch {
      dropped++;
    }
  }

  send({
    v: V,
    t: 'hello',
    token: TOKEN,
    lang: 'javascript',
    pid: process.pid,
    target: path.basename(process.argv[1] || ''),
    agentVersion: '0.1',
    // No 'snapshot': a JS frame's locals are not reachable, and pretending
    // otherwise would put a permanently empty pane in the UI.
    caps: ['stack', 'watch', 'exception'],
  });

  // ------------------------------------------------------------- commands
  let buffer = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (!line.trim()) continue;
      let cmd;
      try {
        cmd = JSON.parse(line);
      } catch {
        continue;
      }
      if (cmd.t === 'set-watches' && Array.isArray(cmd.watches)) {
        watches.clear();
        for (const w of cmd.watches) if (typeof w === 'string') watches.add(w);
      } else if (cmd.t === 'bye') {
        closed = true;
        try {
          sock.end();
        } catch {
          /* ignore */
        }
      }
      // `snapshot` is intentionally ignored: see `caps` above.
    }
  });

  // ------------------------------------------------------------- watches
  setInterval(() => {
    if (closed || !watches.size) return;
    const now = Date.now();
    for (const expr of watches) {
      try {
        // Global scope only — `eval` here cannot see the user's locals, and the
        // page says so.
        const value = global.eval(expr);
        send({ v: V, t: 'watch', at: now, id: expr, ok: true, value: ser(value) });
      } catch (err) {
        send({ v: V, t: 'watch', at: now, id: expr, ok: false, error: `${err.name}: ${err.message}` });
      }
    }
  }, WATCH_EVERY_MS).unref();

  // ---------------------------------------------------------- exceptions
  //
  // `uncaughtExceptionMonitor` observes *without* changing behaviour: a plain
  // `uncaughtException` listener would keep a crashing program alive, which is
  // exactly the kind of "attaching changed the bug" an observatory must not do.
  // For the same reason there is no `unhandledRejection` listener: adding one
  // suppresses the default crash.
  process.on('uncaughtExceptionMonitor', (err) => {
    send({
      v: V,
      t: 'exception',
      at: Date.now(),
      tid: process.pid,
      type: err && err.name ? err.name : 'Error',
      message: err && err.message ? err.message : String(err),
      frames: framesFromStack(err && err.stack),
    });
  });
  // ------------------------------------------------------------- sampling
  let inspector;
  try {
    inspector = require('node:inspector');
  } catch {
    return; // older runtime: attach anyway (hello already sent), no stacks
  }
  const session = new inspector.Session();
  try {
    session.connect();
  } catch {
    return;
  }

  const post = (method, params) =>
    new Promise((resolve, reject) => {
      session.post(method, params || {}, (err, result) => (err ? reject(err) : resolve(result)));
    });

  async function runWindow() {
    if (closed) return;
    try {
      await post('Profiler.enable');
      await post('Profiler.setSamplingInterval', { interval: INTERVAL_US });
      await post('Profiler.start');
    } catch {
      return; // profiling unsupported: keep the connection, stop trying
    }
    setTimeout(async () => {
      let profile;
      try {
        ({ profile } = await post('Profiler.stop'));
      } catch {
        return;
      }
      try {
        emitProfile(profile);
      } catch {
        /* a malformed profile must not break the agent */
      }
      runWindow(); // next window
    }, WINDOW_MS).unref();
  }

  function emitProfile(profile) {
    const byId = new Map();
    for (const node of profile.nodes) byId.set(node.id, node);

    const memo = new Map();
    function pathOf(id) {
      if (memo.has(id)) return memo.get(id);
      const node = byId.get(id);
      if (!node) return [];
      const cf = node.callFrame || {};
      const url = cf.url || '';
      const name = cf.functionName || '(anonymous)';
      const file = url.split(/[\\/]/).pop() || '';
      const line = typeof cf.lineNumber === 'number' && cf.lineNumber >= 0 ? cf.lineNumber + 1 : 0;
      // Node's own frames (timers, async_hooks, inspector) are not the program.
      // Marking them here lets the filter below drop them without guessing from
      // the file name — a user file called `timers.js` stays visible.
      const internal = !url || url.startsWith('node:') || url.startsWith('internal/');
      const parent = node.parent ? pathOf(node.parent) : [];
      const full = parent.concat([{ fn: name, file, line, internal }]);
      memo.set(id, full);
      return full;
    }

    const samples = profile.samples || [];
    if (!samples.length) return;

    // Even out the window: a 500 ms window at 10 ms is ~50 samples, but a busy
    // program can produce far more. Emitting all of them would spend the wire on
    // one window; emitting an even subset keeps the proportions right.
    const step = Math.max(1, Math.ceil(samples.length / MAX_SAMPLES_PER_WINDOW));
    const base = Date.now() - WINDOW_MS;

    for (let i = 0; i < samples.length; i += step) {
      const frames = pathOf(samples[i])
        .filter((f) => !f.internal && f.fn !== '(root)' && f.fn !== '(program)' && f.fn !== '(idle)')
        .slice(-MAX_FRAMES)
        .map(({ fn, file, line }) => ({ fn, file, line }));
      if (!frames.length) continue;
      // Drop samples produced by the agent itself. Starting and stopping the
      // profiler *is* JavaScript, so the first samples of every window land in
      // `Session.post` / internal `dispatch`; left in, they become the hottest
      // stack on the page and hide the program.
      if (isAgentNoise(frames)) continue;
      send({
        v: V,
        t: 'stack',
        at: base + Math.round((i / samples.length) * WINDOW_MS),
        tid: process.pid,
        state: 'running',
        frames,
      });
    }
  }

  runWindow();

  process.on('exit', () => {
    send({ v: V, t: 'bye', reason: 'exit', sent, dropped });
  });
}

// ------------------------------------------------------------------ helpers

/**
 * Is this stack our own instrumentation rather than the observed program?
 *
 * The profiler samples the moment it starts, so the call that started it is
 * always in the first sample of a window. Those frames carry `node:inspector`
 * (or no file at all, for internals) and would otherwise outrank the user's code.
 */
function isAgentNoise(frames) {
  const internal = (f) => f.file === '' || f.file === 'node:inspector' || f.file === 'nlg_agent.js';
  const innermost = frames[frames.length - 1];
  if (innermost && (innermost.fn === 'post' || innermost.fn === 'dispatch') && internal(innermost)) return true;
  return frames.every(internal);
}

/** `Error.stack` -> frames (best effort; V8 formats them, we do not guess). */
function framesFromStack(stack) {
  if (typeof stack !== 'string') return [];
  const out = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    out.push({
      fn: (m[1] || '(anonymous)').replace(/^async\s+/, ''),
      file: path.basename(m[2] || ''),
      line: Number(m[3]) || 0,
    });
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

/**
 * Bounded serializer — the same contract as `src/debugtool/serializer.ts`.
 *
 * Reimplemented (not imported) because this file is injected with `--require`
 * and must be self-contained: it runs inside the user's process, in whatever
 * directory, before any of our code exists.
 */
const LIMITS = { depth: 6, items: 50, str: 512, nodes: 4000 };
const REDACT = ['password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'cookie', 'credential'];

function ser(value, depth, seen, budget, key) {
  depth = depth || 0;
  seen = seen || new Map();
  budget = budget || { left: LIMITS.nodes };

  if (--budget.left < 0) return { k: 'trunc', why: 'size' };
  if (key && REDACT.some((r) => String(key).toLowerCase().includes(r))) {
    return { k: 'trunc', why: 'redacted', t: typeof value };
  }
  if (value === null) return { k: 'prim', t: 'none', v: 'null' };
  if (value === undefined) return { k: 'prim', t: 'none', v: 'undefined' };

  const t = typeof value;
  if (t === 'boolean') return { k: 'prim', t: 'bool', v: value ? 'true' : 'false' };
  if (t === 'number') return { k: 'prim', t: Number.isInteger(value) ? 'int' : 'float', v: String(value) };
  if (t === 'bigint') return { k: 'prim', t: 'int', v: String(value) + 'n' };
  if (t === 'string') {
    return { k: 'prim', t: 'str', v: value.length <= LIMITS.str ? value : value.slice(0, LIMITS.str) + '…' };
  }
  if (t === 'function') return { k: 'trunc', why: 'unsupported', t: 'function' };
  if (t === 'symbol') return { k: 'prim', t: 'str', v: String(value) };

  const obj = value;
  const back = seen.get(obj);
  if (back !== undefined) return { k: 'obj', t: typeName(obj), fields: [], cycle: back };
  if (depth >= LIMITS.depth) return { k: 'trunc', why: 'depth', t: typeName(obj) };
  seen.set(obj, '$' + depth);

  try {
    if (Array.isArray(obj)) {
      const items = [];
      for (let i = 0; i < obj.length && items.length < LIMITS.items && budget.left > 0; i++) {
        items.push(ser(obj[i], depth + 1, seen, budget));
      }
      const node = { k: 'seq', t: 'Array', n: obj.length, items };
      if (obj.length > items.length) node.more = obj.length - items.length;
      return node;
    }
    if (obj instanceof Date) return { k: 'prim', t: 'str', v: obj.toISOString() };
    if (obj instanceof Map) {
      const entries = [];
      for (const [k, v] of obj) {
        if (entries.length >= LIMITS.items || budget.left <= 0) break;
        entries.push([ser(k, depth + 1, seen, budget), ser(v, depth + 1, seen, budget)]);
      }
      const node = { k: 'map', t: 'Map', n: obj.size, entries };
      if (obj.size > entries.length) node.more = obj.size - entries.length;
      return node;
    }
    if (obj instanceof Set) {
      const items = [];
      for (const v of obj) {
        if (items.length >= LIMITS.items || budget.left <= 0) break;
        items.push(ser(v, depth + 1, seen, budget));
      }
      const node = { k: 'seq', t: 'Set', n: obj.size, items };
      if (obj.size > items.length) node.more = obj.size - items.length;
      return node;
    }
    if (obj instanceof Promise || obj instanceof WeakMap || obj instanceof WeakSet) {
      return { k: 'trunc', why: 'unsupported', t: typeName(obj) };
    }

    const fields = [];
    let total = 0;
    for (const name of Object.getOwnPropertyNames(obj)) {
      if (name === '__proto__') continue;
      total++;
      if (fields.length >= LIMITS.items || budget.left <= 0) continue;
      const desc = Object.getOwnPropertyDescriptor(obj, name);
      if (!desc) continue;
      if (!('value' in desc)) {
        fields.push([name, { k: 'trunc', why: 'unsupported', t: 'getter' }]);
        continue;
      }
      fields.push([name, ser(desc.value, depth + 1, seen, budget, name)]);
    }
    const node = { k: 'obj', t: typeName(obj), fields };
    if (total > fields.length) node.more = total - fields.length;
    return node;
  } finally {
    seen.delete(obj);
  }
}

function typeName(obj) {
  const name = obj && obj.constructor && obj.constructor.name;
  return !name || name === 'Object' ? 'Object' : name;
}

// Keep `util` referenced: it is the one thing a reader expects an agent to use
// for inspection, and its absence here is the deliberate choice (we never call
// `util.inspect`, because it executes getters and can run arbitrary code).
void util;
void os;
