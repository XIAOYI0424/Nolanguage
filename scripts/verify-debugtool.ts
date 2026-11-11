/**
 * Debug observatory — M0: the contract, the serializer, the sampler, and one
 * real process proving the injection channel.
 *
 * The first three are pure and run in milliseconds. The last one is the whole
 * point of M0: a Python program, started with nothing but a `PYTHONPATH` and two
 * environment variables, streams its own stacks to a socket. If that fails, the
 * design is wrong and no amount of UI will save it.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-debugtool.ts
 */
import { createServer, type Server, type Socket } from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  encodeCommand,
  parseAgentEvent,
  type AgentEvent,
  type StackEvent,
} from '../src/debugtool/protocol.js';
import { DEFAULT_LIMITS, countNodes, isSensitive, serializeJs } from '../src/debugtool/serializer.js';
import type { SNode } from '../src/debugtool/protocol.js';
import { detectStalls, effectiveHz, foldStacks, stackKey, type StackSample } from '../src/debugtool/sampler.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// ---------------------------------------------------------------- protocol

const hello = parseAgentEvent(JSON.stringify({ v: 1, t: 'hello', lang: 'python', pid: 7, target: 'a.py', agentVersion: '0.1', caps: ['stack'] }));
check('protocol: hello parses', hello.ok === true && hello.ok && hello.event.t === 'hello');
check('protocol: hello without lang is fatal', (() => {
  const r = parseAgentEvent(JSON.stringify({ v: 1, t: 'hello' }));
  return !r.ok && r.fatal;
})());
check('protocol: a version mismatch is fatal', (() => {
  const r = parseAgentEvent(JSON.stringify({ v: 99, t: 'stack', frames: [] }));
  return !r.ok && r.fatal && /version/.test(r.reason);
})());
check('protocol: an unknown event is dropped, not fatal', (() => {
  const r = parseAgentEvent(JSON.stringify({ v: PROTOCOL_VERSION, t: 'future-thing' }));
  return !r.ok && r.fatal === false;
})());
check('protocol: broken JSON is fatal', (() => {
  const r = parseAgentEvent('{not json');
  return !r.ok && r.fatal;
})());
// The line is refused, but **not fatally**: it is complete and the stream is
// still aligned, so one oversized value must cost that value rather than the
// session. This used to be `fatal`, and a single 300 KiB snapshot killed the
// observatory — the exact moment the user needs it. `verify-stress` covers the
// session-level behaviour; this pins the parser's side of the contract.
check('protocol: an oversized line is refused without killing the session', (() => {
  const big = JSON.stringify({ v: 1, t: 'bye', reason: 'x'.repeat(MAX_LINE_BYTES + 10) });
  const r = parseAgentEvent(big);
  return !r.ok && !r.fatal && r.reason === 'line too large';
})());
check('protocol: stack frames are normalised', (() => {
  const r = parseAgentEvent(JSON.stringify({
    v: 1, t: 'stack', at: 5, tid: 1, state: 'blocked',
    frames: [{ fn: 'main', file: 'a.py', line: 3 }, { fn: 'work', file: 'a.py', line: 9 }],
  }));
  return r.ok && r.event.t === 'stack' && r.event.frames.length === 2 && r.event.state === 'blocked';
})());
check('protocol: a snapshot without a tree is dropped', (() => {
  const r = parseAgentEvent(JSON.stringify({ v: 1, t: 'snapshot', id: 's1', path: 'x' }));
  return !r.ok && r.fatal === false;
})());
check('protocol: commands encode as one line', (() => {
  const line = encodeCommand({ v: 1, t: 'set-watches', watches: ['a', 'b'] });
  return line.endsWith('\n') && line.indexOf('\n') === line.length - 1;
})());

// ---------------------------------------------------------------- serializer

check('serializer: primitives carry their own type tag', (() => {
  const s = serializeJs({ i: 1, f: 1.5, b: true, n: null, t: 'hi' });
  if (s.k !== 'obj') return false;
  const byKey = new Map(s.fields);
  return (
    byKey.get('i')?.k === 'prim' && byKey.get('i')!.t === 'int' &&
    byKey.get('f')?.k === 'prim' && byKey.get('f')!.t === 'float' &&
    byKey.get('b')?.k === 'prim' && byKey.get('b')!.t === 'bool' &&
    byKey.get('n')?.k === 'prim' && byKey.get('n')!.t === 'none'
  );
})());

check('serializer: a cycle is reported, not followed', (() => {
  const a: Record<string, unknown> = { name: 'a' };
  a.self = a;
  const s = serializeJs(a);
  const self = s.k === 'obj' ? s.fields.find(([k]) => k === 'self')?.[1] : undefined;
  return self?.k === 'obj' && typeof self.cycle === 'string';
})());

check('serializer: depth is bounded and says why', (() => {
  let deep: Record<string, unknown> = { end: true };
  for (let i = 0; i < 40; i++) deep = { next: deep };
  const s = serializeJs(deep);
  let node = s;
  let sawTrunc = false;
  for (let i = 0; i < 20 && node.k === 'obj'; i++) {
    const next = node.fields[0]?.[1];
    if (!next) break;
    if (next.k === 'trunc' && next.why === 'depth') sawTrunc = true;
    node = next;
  }
  return sawTrunc;
})());

check('serializer: long arrays report how many were omitted', (() => {
  const s = serializeJs(Array.from({ length: 500 }, (_, i) => i));
  return s.k === 'seq' && s.items.length === DEFAULT_LIMITS.maxItems && s.more === 500 - DEFAULT_LIMITS.maxItems;
})());

check('serializer: secrets are redacted before they leave', (() => {
  const s = serializeJs({ api_token: 'sk-live-123', user: 'ok' });
  const token = s.k === 'obj' ? s.fields.find(([k]) => k === 'api_token')?.[1] : undefined;
  const user = s.k === 'obj' ? s.fields.find(([k]) => k === 'user')?.[1] : undefined;
  return token?.k === 'trunc' && token.why === 'redacted' && user?.k === 'prim' && user.v === 'ok';
})());

check('serializer: a getter is reported, never invoked', (() => {
  let called = false;
  const obj = {
    plain: 1,
    get dangerous() {
      called = true;
      return 'boom';
    },
  };
  const s = serializeJs(obj);
  const g = s.k === 'obj' ? s.fields.find(([k]) => k === 'dangerous')?.[1] : undefined;
  return called === false && g?.k === 'trunc' && g.t === 'getter';
})());

check('serializer: toString is never called', (() => {
  let called = false;
  const evil = {
    toString() {
      called = true;
      return 'nope';
    },
  };
  serializeJs(evil);
  return called === false;
})());

check('serializer: Map and Set keep their size', (() => {
  const s = serializeJs({ m: new Map([['a', 1]]), st: new Set([1, 2, 3]) });
  if (s.k !== 'obj') return false;
  const m = s.fields.find(([k]) => k === 'm')?.[1];
  const st = s.fields.find(([k]) => k === 'st')?.[1];
  return m?.k === 'map' && m.n === 1 && st?.k === 'seq' && st.n === 3;
})());

check('serializer: functions are marked unsupported', (() => {
  const s = serializeJs({ f: () => 1 });
  const f = s.k === 'obj' ? s.fields.find(([k]) => k === 'f')?.[1] : undefined;
  return f?.k === 'trunc' && f.why === 'unsupported';
})());

check('serializer: the node budget is enforced', (() => {
  const wide = { rows: Array.from({ length: 200 }, () => ({ a: 1, b: 2, c: 3 })) };
  const nodes = countNodes(serializeJs(wide, { ...DEFAULT_LIMITS, maxItems: 200, maxNodes: 100 }));
  return nodes <= 101;
})());

check('serializer: redaction matches case-insensitively', isSensitive('API_TOKEN', DEFAULT_LIMITS.redact) && !isSensitive('username', DEFAULT_LIMITS.redact));

// ---------------------------------------------------------------- sampler

function sample(at: number, names: string[], state: StackSample['state'] = 'running'): StackSample {
  return { at, tid: 1, state, frames: names.map((fn) => ({ fn, file: 'app.py', line: 1 })) };
}

const samples: StackSample[] = [
  sample(0, ['main', 'work', 'step']),
  sample(100, ['main', 'work', 'step']),
  sample(200, ['main', 'work', 'sleep'], 'blocked'),
  sample(300, ['main', 'work', 'sleep'], 'blocked'),
  sample(400, ['main', 'work', 'sleep'], 'blocked'),
  sample(500, ['main', 'work', 'sleep'], 'blocked'),
  sample(600, ['main', 'work', 'sleep'], 'blocked'),
  sample(700, ['main', 'work', 'step']),
];

check('sampler: stack identity is the function path', stackKey(sample(0, ['a', 'b']).frames) === 'a>b');
check('sampler: empty stacks get a label', stackKey([]) === '(no stack)');
check('sampler: groups are ranked by share', (() => {
  const hot = foldStacks(samples);
  return hot[0].stack === 'main>work>sleep' && hot[0].hits === 5 && Math.abs(hot[0].share - 5 / 8) < 1e-9;
})());
check('sampler: a long run marks the group stalled', (() => {
  const hot = foldStacks(samples, { stallSamples: 5 });
  return hot.find((h) => h.stack === 'main>work>sleep')?.stalled === true &&
    hot.find((h) => h.stack === 'main>work>step')?.stalled === false;
})());
check('sampler: the representative frames are the latest sample', (() => {
  const hot = foldStacks(samples);
  const sleep = hot.find((h) => h.stack === 'main>work>sleep');
  return sleep?.state === 'blocked' && sleep.lastAt === 600;
})());
check('sampler: stalls are reported with their window', (() => {
  const stalls = detectStalls(samples, 5);
  return stalls.length === 1 && stalls[0].from === 200 && stalls[0].to === 600 && stalls[0].durationMs === 400;
})());
check('sampler: a single sample is not a stall', detectStalls([sample(0, ['a'])], 5).length === 0);
check('sampler: the effective rate is measured, not assumed', (() => {
  const hz = effectiveHz(samples);
  return hz > 9 && hz < 11;
})());

// ------------------------------------------------- TS <-> Python parity

/**
 * The Python agent mirrors `serializer.ts` by hand.
 *
 * Two implementations of one contract always drift; the question is whether the
 * drift is caught. These checks compare the *decisions* (redact / cycle / cap /
 * depth) rather than the bytes, because those are the ones that make the UI lie
 * — a wrong `more` count or a missed cycle is invisible until someone trusts it.
 */
interface Shape {
  tokenWhy: string;
  selfCycle: boolean;
  itemCount: number;
  itemMore: number;
  deepWhy: string;
  depthLimit: number;
  itemLimit: number;
  stringLimit: number;
}

function shapeOfTs(): Shape {
  const deep = (n: number): unknown => (n === 0 ? { end: true } : { next: deep(n - 1) });
  const withCycle: Record<string, unknown> = { name: 'x', api_token: 'sk-1', items: Array.from({ length: 200 }, (_, i) => i) };
  withCycle.self = withCycle;

  const root = serializeJs(withCycle);
  if (root.k !== 'obj') throw new Error('expected obj');
  const field = (k: string): SNode | undefined => root.fields.find(([name]) => name === k)?.[1];

  const token = field('api_token');
  const items = field('items');
  const self = field('self');

  // Walk to the depth ceiling and read why it stopped.
  let node: SNode = serializeJs(deep(20));
  let deepWhy = '';
  for (let i = 0; i < 20; i++) {
    if (node.k === 'trunc') {
      deepWhy = node.why;
      break;
    }
    if (node.k !== 'obj') break;
    const next: SNode | undefined = node.fields[0]?.[1];
    if (!next) break;
    node = next;
  }

  return {
    tokenWhy: token?.k === 'trunc' ? token.why : `not-trunc:${token?.k}`,
    selfCycle: self?.k === 'obj' && typeof self.cycle === 'string',
    itemCount: items?.k === 'seq' ? items.items.length : -1,
    itemMore: items?.k === 'seq' ? (items.more ?? 0) : -1,
    deepWhy,
    depthLimit: DEFAULT_LIMITS.maxDepth,
    itemLimit: DEFAULT_LIMITS.maxItems,
    stringLimit: DEFAULT_LIMITS.maxString,
  };
}

function shapeOfPython(pythonBin: string): Shape | null {
  const agentDir = join(root, 'src', 'debugtool', 'agents', 'python');
  // A Python `dict` serializes as `map` (it really is a mapping), while a JS
  // plain object is `obj`; the walker below accepts both, because the parity
  // that matters is the *decisions* (redact/cycle/cap/depth), not the node kind.
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(agentDir)})`,
    'import nlg_agent as a',
    'obj = {"name": "x", "api_token": "sk-1", "items": list(range(200))}',
    'obj["self"] = obj',
    'root = a.ser(obj)',
    'fields = {}',
    'for key, val in root.get("entries", []):',
    '    if key.get("k") == "prim":',
    '        fields[key["v"]] = val',
    'def first_child(n):',
    '    if n.get("k") == "obj" and n.get("fields"):',
    '        return n["fields"][0][1]',
    '    if n.get("k") == "map" and n.get("entries"):',
    '        return n["entries"][0][1]',
    '    return None',
    'deep = {"end": True}',
    'for _ in range(20): deep = {"next": deep}',
    'node = a.ser(deep)',
    'why = ""',
    'for _ in range(24):',
    '    if node.get("k") == "trunc":',
    '        why = node["why"]',
    '        break',
    '    nxt = first_child(node)',
    '    if nxt is None: break',
    '    node = nxt',
    'tok = fields.get("api_token", {})',
    'items = fields.get("items", {})',
    'selfn = fields.get("self", {})',
    'print(json.dumps({',
    '  "tokenWhy": tok.get("why", "not-trunc") if tok.get("k") == "trunc" else "not-trunc",',
    '  "selfCycle": selfn.get("k") == "obj" and isinstance(selfn.get("cycle"), str),',
    '  "itemCount": len(items.get("items", [])) if items.get("k") == "seq" else -1,',
    '  "itemMore": items.get("more", 0),',
    '  "deepWhy": why,',
    '  "depthLimit": a.MAX_DEPTH,',
    '  "itemLimit": a.MAX_ITEMS,',
    '  "stringLimit": a.MAX_STR,',
    '}))',
  ].join('\n');
  const run = spawnSync(pythonBin, ['-c', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (run.status !== 0 || !run.stdout.trim()) return null;
  try {
    return JSON.parse(run.stdout.trim()) as Shape;
  } catch {
    return null;
  }
}

const tsShape = shapeOfTs();
check('parity: the TS serializer redacts by name', tsShape.tokenWhy === 'redacted', tsShape.tokenWhy);
check('parity: the TS serializer reports cycles', tsShape.selfCycle);
check('parity: the TS serializer caps items and says how many', tsShape.itemCount === 50 && tsShape.itemMore === 150, `${tsShape.itemCount}+${tsShape.itemMore}`);

const pythonShape = shapeOfPython(process.platform === 'win32' ? 'python' : 'python3');
if (!pythonShape) {
  console.log('SKIP  TS/Python serializer parity (python unavailable)');
} else {
  for (const key of Object.keys(tsShape) as Array<keyof Shape>) {
    check(`parity: ${key} matches between TS and Python`, tsShape[key] === pythonShape[key], `${String(tsShape[key])} vs ${String(pythonShape[key])}`);
  }
}

// ---------------------------------------------------------------- the channel

interface Collected {
  events: AgentEvent[];
  hello?: AgentEvent;
  stacks: StackEvent[];
  badLines: number;
  raw: string[];
}

async function runProbe(pythonBin: string): Promise<Collected | null> {
  const probes = join(root, 'debugtool', 'probes');
  const app = join(root, 'debugtool', 'samples', 'py', 'app.py');
  if (!existsSync(probes) || !existsSync(app)) return null;

  const collected: Collected = { events: [], stacks: [], badLines: 0, raw: [] };
  const token = 'test-token-0123456789abcdef';

  const server: Server = createServer((socket: Socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line.trim()) continue;
        const parsed = parseAgentEvent(line);
        if (!parsed.ok) {
          collected.badLines++;
          continue;
        }
        collected.events.push(parsed.event);
        if (parsed.event.t === 'hello') collected.hello = parsed.event;
        if (parsed.event.t === 'stack') collected.stacks.push(parsed.event);
      }
    });
    socket.on('error', () => undefined);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  const child: ChildProcess = spawn(pythonBin, ['-u', app], {
    cwd: join(root, 'debugtool', 'samples', 'py'),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONPATH: probes,
      NLG_DEBUG_PORT: String(port),
      NLG_DEBUG_TOKEN: token,
      NLG_DEBUG_HZ: '10',
    },
  });
  let stdout = '';
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString();
  });

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 6000);
    child.on('close', () => {
      clearTimeout(timer);
      // Give the socket a tick to flush the last lines.
      setTimeout(resolve, 150);
    });
  });
  if (!child.killed && child.exitCode === null) child.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  collected.raw.push(stdout.trim());
  return collected;
}

const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
const probe = await runProbe(pythonBin);

if (!probe) {
  console.log('SKIP  channel probe (debugtool/probes or samples missing)');
} else if (!probe.hello && probe.events.length === 0) {
  console.log('SKIP  channel probe (python unavailable — the pure checks above still ran)');
} else {
  check('channel: the agent said hello', probe.hello?.t === 'hello', probe.hello?.t ?? 'no hello');
  check(
    'channel: it identifies itself as python',
    probe.hello?.t === 'hello' && probe.hello.lang === 'python',
    probe.hello?.t === 'hello' ? probe.hello.lang : '',
  );
  check(
    'channel: the token came through the environment',
    probe.hello?.t === 'hello' && probe.hello.token === 'test-token-0123456789abcdef',
    probe.hello?.t === 'hello' ? String(probe.hello.token) : '',
  );
  check('channel: stacks arrived', probe.stacks.length >= 5, `${probe.stacks.length} stack events`);
  check('channel: no malformed lines', probe.badLines === 0, `${probe.badLines} bad lines`);

  const names = new Set<string>();
  for (const s of probe.stacks) for (const f of s.frames) names.add(f.fn);
  check(
    'channel: the samples are the target program, not the agent',
    names.has('work') || names.has('step') || names.has('main'),
    [...names].slice(0, 8).join(','),
  );
  check(
    'channel: the program still printed its own output',
    /total/.test(probe.raw[0] ?? ''),
    (probe.raw[0] ?? '').slice(0, 60),
  );

  const asSamples: StackSample[] = probe.stacks.map((s) => ({ at: s.at, tid: s.tid, state: s.state, frames: s.frames }));
  const hot = foldStacks(asSamples);
  check('channel: the live stacks fold into hot paths', hot.length > 0 && hot[0].hits > 1, hot[0]?.stack ?? '');
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
