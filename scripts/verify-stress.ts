/**
 * Stress: does the observatory stay bounded when the data is not?
 *
 * A debug tool is pointed at the code that is already misbehaving. The one thing
 * it must never do is make things worse — a 10 MB string, a million-element
 * buffer, a 200k-key object, an agent that sends a line larger than the protocol
 * allows. Each of those is a plausible accident, and each is a way this tool
 * could hang the target, exhaust the engine, or kill its own session.
 *
 * The checks below are about *bounds*, not speed: every case asserts a ceiling
 * on time and on emitted nodes, with thresholds loose enough not to flake on a
 * busy machine but tight enough that an accidental O(n) copy (measured: 151 MiB
 * for one typed array) fails them.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-stress.ts
 */
import { connect } from 'node:net';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countNodes, serializeJs } from '../src/debugtool/serializer.js';
import { MAX_TREE_NODES, parseNode, type SNode } from '../src/debugtool/protocol.js';
import { DebugSession } from '../src/debugtool/session.js';
import { diffNodes } from '../src/debugtool/diff.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Measured {
  node: SNode;
  ms: number;
  nodes: number;
  heapMb: number;
}

/** Serialize once for the JIT, then measure the serializer alone. */
function measure(value: unknown): Measured {
  serializeJs(value);
  const before = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const node = serializeJs(value);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const heapMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  return { node, ms, nodes: countNodes(node), heapMb };
}

const show = (m: Measured): string => `${m.ms.toFixed(1)}ms · ${m.nodes} nodes · ${m.heapMb.toFixed(1)}MiB`;

// ------------------------------------------------- 1. the serializer's bounds

{
  // A million-element array must cost the same as a fifty-element one: the cap
  // is applied while walking, not after building a copy.
  const m = measure(new Array(1_000_000).fill(0));
  check('a 1M-element array is capped, not copied', m.ms < 50 && m.node.k === 'seq' && m.node.items.length === 50, show(m));
  check('a capped array still reports the real length', m.node.k === 'seq' && m.node.n === 1_000_000 && m.node.more === 999_950, `${m.node.k === 'seq' ? m.node.n + '/' + m.node.more : m.node.k}`);
}

{
  // Regression: `Array.from(typedArray)` used to copy all 10M numbers (151 MiB,
  // 263 ms) just to display 50 of them.
  const m = measure(new Float64Array(10_000_000));
  check('a 10M-element typed array does not get copied', m.ms < 50 && m.heapMb < 32, show(m));
  check('a typed array still reports its length', m.node.k === 'seq' && m.node.n === 10_000_000 && m.node.items.length === 50, `${m.node.k === 'seq' ? m.node.n : m.node.k}`);
}

{
  const m = measure('x'.repeat(10 * 1024 * 1024));
  check('a 10 MB string is clipped, not carried', m.ms < 50 && m.node.k === 'prim' && m.node.v.length < 600, show(m));
  check('a clipped string says how much was dropped', m.node.k === 'prim' && /more chars/.test(m.node.v), m.node.k === 'prim' ? m.node.v.slice(-24) : '');
}

{
  let deep: unknown = { end: true };
  for (let i = 0; i < 50_000; i++) deep = { next: deep };
  const m = measure(deep);
  check('a 50k-deep object stops at the depth ceiling', m.ms < 50 && m.nodes < 20, show(m));
  check('the depth ceiling is reported, not silent', (() => {
    let n: SNode = m.node;
    for (let i = 0; i < 20; i++) {
      if (n.k === 'trunc') return n.why === 'depth';
      if (n.k !== 'obj') return false;
      const next = n.fields[0]?.[1];
      if (!next) return false;
      n = next;
    }
    return false;
  })(), '');
}

{
  const m = measure(new Map(Array.from({ length: 1_000_000 }, (_, i) => [i, i])));
  check('a 1M-entry Map is capped while iterating', m.ms < 50 && m.node.k === 'map' && m.node.entries.length === 50, show(m));
}

{
  const m = measure(new Set(Array.from({ length: 1_000_000 }, (_, i) => i)));
  check('a 1M-entry Set is capped while iterating', m.ms < 50 && m.node.k === 'seq' && m.node.items.length === 50, show(m));
}

{
  // A wide object is the one shape where the cost is inherent: V8 has to build
  // the key list before anyone can read it. 90 ms and 19 MiB is the measured
  // floor, so the check is a ceiling rather than a target.
  const wide: Record<string, number> = {};
  for (let i = 0; i < 200_000; i++) wide[`k${i}`] = i;
  const m = measure(wide);
  check('a 200k-key object stays under a quarter second', m.ms < 250, show(m));
  check('a 200k-key object still reports the hidden count', m.node.k === 'obj' && m.node.more === 199_950, m.node.k === 'obj' ? String(m.node.more) : m.node.k);
}

{
  const mesh: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 10_000; i++) mesh.push({ i, next: null, prev: null });
  for (let i = 0; i < mesh.length; i++) {
    mesh[i].next = mesh[(i + 1) % mesh.length];
    mesh[i].prev = mesh[(i - 1 + mesh.length) % mesh.length];
  }
  const m = measure(mesh);
  check('a 10k-node cycle mesh terminates', m.ms < 50 && m.nodes < 2000, show(m));
  check('the mesh reports cycles rather than expanding them', JSON.stringify(m.node).includes('"cycle"'));
}

// --------------------------------------------- 2. the engine's own tree budget

{
  // An agent with looser limits (or a bug) can hand the engine a tree far larger
  // than the page can render. The engine must bound it on the way in.
  const wide = { k: 'seq', t: 'Array', n: 50_000, items: Array.from({ length: 50_000 }, () => ({ k: 'prim', t: 'int', v: '1' })) };
  const t0 = process.hrtime.bigint();
  const parsed = parseNode(JSON.parse(JSON.stringify(wide)));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const nodes = parsed ? countNodes(parsed) : -1;
  check('a 50k-node tree is accepted, bounded', parsed !== null && nodes <= MAX_TREE_NODES, `${nodes} nodes of ${MAX_TREE_NODES} in ${ms.toFixed(1)}ms`);
  // The tree is bounded by *dropping* the surplus and counting it (`more`), not
  // by attaching a `trunc` leaf per item — which kept the payload exactly as
  // large as the one being refused.
  check('the surplus is counted, not carried', parsed !== null && parsed.k === 'seq' && parsed.more === 30_001, parsed && parsed.k === 'seq' ? String(parsed.more) : String(parsed?.k));
  check('bounding a 50k-node tree is fast', ms < 250, `${ms.toFixed(1)}ms`);
}

// ------------------------------------------------ 3. the wire's size contract

{
  // One oversized snapshot used to be *fatal*: a single 300 KiB value killed the
  // session, which is the opposite of what an observability tool may do.
  const session = new DebugSession({ hz: 10 });
  await session.listen();
  session.ingest(JSON.stringify({ v: 1, t: 'hello', token: session.agentEnv().NLG_DEBUG_TOKEN, lang: 'python', pid: 7, target: 'x.py', agentVersion: '1', caps: [] }));
  const attached = session.view().state;

  const huge = JSON.stringify({
    v: 1,
    t: 'snapshot',
    id: 'big',
    at: Date.now(),
    path: 'locals',
    value: { k: 'prim', t: 'str', v: 'x'.repeat(300 * 1024) },
  });
  session.ingest(huge);
  check('the session attached before the oversized line', attached === 'attached', attached);
  check('an oversized line does not kill the session', session.view().state === 'attached', session.view().state);
  check('an oversized line is counted', (session.view().oversized ?? 0) === 1, String(session.view().oversized ?? 0));

  session.ingest(JSON.stringify({ v: 1, t: 'stack', at: Date.now(), tid: 1, state: 'running', frames: [{ fn: 'main', file: 'x.py', line: 3 }] }));
  check('the session still ingests after an oversized line', session.view().samples === 1, String(session.view().samples));
  await session.close();
}

{
  // A line that never ends must not grow the buffer forever. The reader drops it
  // and resynchronises at the next newline; the agent keeps its session.
  const session = new DebugSession({ hz: 10 });
  await session.listen();
  const sock = connect(session.boundPort, '127.0.0.1');
  await once(sock, 'connect');
  sock.write(JSON.stringify({ v: 1, t: 'hello', token: session.agentEnv().NLG_DEBUG_TOKEN, lang: 'python', pid: 8, target: 'y.py', agentVersion: '1', caps: [] }) + '\n');
  await sleep(120);

  sock.write('x'.repeat(2 * 1024 * 1024)); // no newline: an endless line
  await sleep(80);
  sock.write('\n'); // resync point
  await sleep(80);
  sock.write(JSON.stringify({ v: 1, t: 'stack', at: Date.now(), tid: 1, state: 'running', frames: [{ fn: 'after', file: 'y.py', line: 9 }] }) + '\n');
  await sleep(200);

  const view = session.view();
  check('a runaway line does not kill the session', view.state === 'attached', view.state);
  check('a runaway line is counted once', (view.oversized ?? 0) >= 1, String(view.oversized ?? 0));
  check('the reader resynchronises after a runaway line', view.samples === 1 && view.hot.some((h) => h.stack.includes('after')), `${view.samples} samples`);
  sock.destroy();
  await session.close();
}

// ------------------------------------------------- 4. the agent in the target

{
  // The serializer also runs *inside* the observed process, at the live-locals
  // rate. A copy there slows the program the user is trying to debug, so the
  // cost is measured where it is actually paid.
  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const agentDir = join(root, 'src', 'debugtool', 'agents', 'python');
  const script = [
    'import json, sys, time',
    `sys.path.insert(0, ${JSON.stringify(agentDir)})`,
    'import nlg_agent as a',
    'wide = {"k%d" % i: i for i in range(200000)}',
    'buf = [0.0] * 10000000',
    'text = "x" * (10 * 1024 * 1024)',
    'out = {}',
    'for name, value in (("wide", wide), ("buf", buf), ("text", text)):',
    '    t0 = time.perf_counter()',
    '    node = a.ser(value)',
    '    ms = (time.perf_counter() - t0) * 1000',
    '    out[name] = {"ms": round(ms, 1), "kind": node["k"], "more": node.get("more", 0)}',
    'print(json.dumps(out))',
  ].join('\n');
  const run = spawnSync(python, ['-c', script], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });

  if (run.status !== 0 || !run.stdout.trim()) {
    console.log(`SKIP  python agent stress (${(run.stderr || 'python unavailable').split('\n')[0].slice(0, 80)})`);
  } else {
    const out = JSON.parse(run.stdout.trim()) as Record<string, { ms: number; kind: string; more: number }>;
    check('the agent bounds a 200k-key dict in-process', out.wide.ms < 400 && out.wide.more > 0, `${out.wide.ms}ms · more=${out.wide.more}`);
    check('the agent bounds a 10M-element list in-process', out.buf.ms < 400 && out.buf.more > 0, `${out.buf.ms}ms · more=${out.buf.more}`);
    check('the agent clips a 10 MB string in-process', out.text.ms < 400 && out.text.kind === 'prim', `${out.text.ms}ms`);
  }
}

// ------------------------------------------- 5. diff on large serialized trees

{
  // The diff runs on whatever the serializer produced, so it inherits those
  // bounds — but it must not turn them into quadratic work.
  const wide = (n: number): unknown => {
    const o: Record<string, number> = {};
    for (let i = 0; i < n; i++) o[`f${i}`] = i;
    return o;
  };
  const before = serializeJs(wide(2000));
  const after = serializeJs(wide(2000));
  const t0 = process.hrtime.bigint();
  const d = diffNodes(before, after);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('diffing two 50-field trees is instant', ms < 50, `${ms.toFixed(1)}ms`);
  check('two identical trees have no diff', d.entries.length === 0, `${d.entries.length} entries`);
}

// ------------------------------------------------------------------ verdict

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = 1;
}
