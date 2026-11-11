/**
 * Snapshot diff — the pure module, no process and no socket.
 *
 * The interesting cases here are the ones where a naive diff lies: an insertion
 * at the head of a list, a truncated subtree, a value hidden behind `more`, a
 * cycle. Each of those has a check that would fail if the module guessed.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-diff.ts
 */
import { diffNodes, isUnchanged, renderNode, summariseDiff } from '../src/debugtool/diff.js';
import { serializeJs } from '../src/debugtool/serializer.js';
import type { SNode } from '../src/debugtool/protocol.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const prim = (v: string, t: 'int' | 'float' | 'str' | 'bool' | 'none' = 'int'): SNode => ({ k: 'prim', t, v });
const obj = (fields: Array<[string, SNode]>, t = 'Object'): SNode => ({ k: 'obj', t, fields });
const seq = (items: SNode[], t = 'Array', more?: number): SNode => ({ k: 'seq', t, n: items.length + (more ?? 0), items, ...(more ? { more } : {}) });
const map = (entries: Array<[SNode, SNode]>, t = 'dict', more?: number): SNode => ({ k: 'map', t, n: entries.length + (more ?? 0), entries, ...(more ? { more } : {}) });
const trunc = (why: 'depth' | 'size' | 'unsupported' | 'redacted', t?: string): SNode => ({ k: 'trunc', why, ...(t ? { t } : {}) });

// ------------------------------------------------------------ 1. no change

{
  const a = obj([['x', prim('1')], ['y', prim('hi', 'str')]]);
  const b = obj([['x', prim('1')], ['y', prim('hi', 'str')]]);
  const d = diffNodes(a, b);
  check('identical trees produce nothing', d.entries.length === 0 && !d.incomplete, JSON.stringify(d.summary));
  check('identical trees are "unchanged"', isUnchanged(d));
  check('an empty summary renders as an empty string', summariseDiff(d) === '', summariseDiff(d));
}

// ------------------------------------------------------------ 2. primitives

{
  const d = diffNodes(obj([['count', prim('1')]]), obj([['count', prim('2')]]));
  check('a changed field is reported with its path', d.entries.length === 1 && d.entries[0].path === '$.count', JSON.stringify(d.entries));
  check('a changed field shows both sides', d.entries[0]?.before === '1' && d.entries[0]?.after === '2', `${d.entries[0]?.before} -> ${d.entries[0]?.after}`);
  check('a changed field counts as one change', d.summary.changed === 1 && summariseDiff(d) === '1 changed', summariseDiff(d));
}

{
  // Same text, different type: `1` vs `"1"` is a real change and a value-only
  // comparison would miss it.
  const d = diffNodes(obj([['v', prim('1')]]), obj([['v', prim('1', 'str')]]));
  check('a type change with the same text still counts', d.entries.length === 1 && d.entries[0].kind === 'changed');
}

// ------------------------------------------------------------ 3. add / remove

{
  const d = diffNodes(obj([['a', prim('1')]]), obj([['a', prim('1')], ['b', prim('2')]]));
  check('an added field is reported once', d.entries.length === 1 && d.entries[0].kind === 'added' && d.entries[0].path === '$.b', JSON.stringify(d.entries));
  check('an added field has no "before"', d.entries[0].before === undefined && d.entries[0].after === '2');
}

{
  const d = diffNodes(obj([['a', prim('1')], ['b', prim('2')]]), obj([['a', prim('1')]]));
  check('a removed field is reported once', d.entries.length === 1 && d.entries[0].kind === 'removed' && d.entries[0].path === '$.b');
}

// ------------------------------------------------------------ 4. paths

{
  const deep = obj([['order', obj([['items', seq([obj([['price', prim('9')]])])]], 'Order')]], 'Root');
  const deep2 = obj([['order', obj([['items', seq([obj([['price', prim('10')]])])]], 'Order')]], 'Root');
  const d = diffNodes(deep, deep2);
  check('nested paths are dotted and indexed', d.entries.length === 1 && d.entries[0].path === '$.order.items[0].price', d.entries[0]?.path ?? '');
}

{
  // A field name that is not an identifier must not produce `$.my key`.
  const d = diffNodes(obj([['my key', prim('1')]]), obj([['my key', prim('2')]]));
  check('an awkward field name is bracketed and quoted', d.entries[0]?.path === '$["my key"]', d.entries[0]?.path ?? '');
}

// ------------------------------------------------------------ 5. sequences

{
  // The case index-wise comparison gets wrong: one item inserted at the head.
  const before = seq([prim('a', 'str'), prim('b', 'str'), prim('c', 'str')]);
  const after = seq([prim('z', 'str'), prim('a', 'str'), prim('b', 'str'), prim('c', 'str')]);
  const d = diffNodes(before, after);
  check('an insertion at the head is one added item', d.summary.added === 1 && d.summary.changed === 0 && d.summary.removed === 0, summariseDiff(d));
}

{
  const before = seq([prim('a', 'str'), prim('b', 'str'), prim('c', 'str')]);
  const after = seq([prim('a', 'str'), prim('c', 'str')]);
  const d = diffNodes(before, after);
  check('a removal in the middle is one removed item', d.summary.removed === 1 && d.summary.changed === 0, summariseDiff(d));
}

{
  const before = seq([prim('a', 'str'), prim('b', 'str')]);
  const after = seq([prim('a', 'str'), prim('B', 'str')]);
  const d = diffNodes(before, after);
  check('an edited item is one change, not a removal plus an addition', d.summary.changed === 1 && d.summary.added === 0 && d.summary.removed === 0, summariseDiff(d));
}

{
  const before = seq([prim('1'), prim('2')]);
  const after = seq([prim('1'), prim('2'), prim('3')]);
  const d = diffNodes(before, after);
  check('an append is one added item at the right index', d.summary.added === 1 && d.entries[0].path === '$[2]', d.entries[0]?.path ?? '');
}

{
  // Objects in a list: alignment is by content, so the edit lands on the item
  // that changed rather than on every index after it.
  const item = (id: number, price: number): SNode => obj([['id', prim(String(id))], ['price', prim(String(price))]], 'Item');
  const before = seq([item(1, 10), item(2, 20), item(3, 30)]);
  const after = seq([item(0, 5), item(1, 10), item(2, 99), item(3, 30)]);
  const d = diffNodes(before, after);
  check('objects in a list align by content', d.summary.changed === 1 && d.summary.added === 1, summariseDiff(d));
  // The path points into the *after* tree (index 2), and the before location is
  // kept so the shift stays traceable instead of being silently rewritten.
  const moved = d.entries.find((e) => e.kind === 'changed' && /price$/.test(e.path));
  check('the changed object is the one that changed', moved?.path === '$[2].price', d.entries.map((e) => e.path + ':' + e.kind).join(' '));
  check('a shifted item keeps its original location', moved?.pathBefore === '$[1].price', String(moved?.pathBefore));
}

{
  const d = diffNodes(seq([]), seq([]));
  check('two empty lists are unchanged', isUnchanged(d));
}

// ------------------------------------------------------------ 6. maps

{
  const k = (v: string): SNode => prim(v, 'str');
  const before = map([[k('a'), prim('1')], [k('b'), prim('2')]]);
  const after = map([[k('a'), prim('1')], [k('b'), prim('3')], [k('c'), prim('4')]]);
  const d = diffNodes(before, after);
  check('a map is diffed by key, not by position', d.summary.changed === 1 && d.summary.added === 1 && d.summary.removed === 0, summariseDiff(d));
  check('a map key appears in the path', d.entries.some((e) => e.path === '$["b"]' && e.kind === 'changed'), d.entries.map((e) => e.path).join(' '));
}

// ------------------------------------------------------------ 7. truncation

{
  const d = diffNodes(obj([['big', trunc('depth', 'Tree')]]), obj([['big', trunc('size', 'Tree')]]));
  check('two different truncations are "not comparable"', d.entries.length === 1 && d.entries[0].kind === 'unavailable', JSON.stringify(d.entries));
  check('a truncated subtree makes the result incomplete', d.incomplete);
}

{
  // Same ceiling on both sides: nothing to report, but "no change" is still not
  // a proof — the branch was never seen.
  const d = diffNodes(obj([['big', trunc('depth', 'Tree')]]), obj([['big', trunc('depth', 'Tree')]]));
  check('the same truncation on both sides reports nothing', d.entries.length === 0, JSON.stringify(d.entries));
  check('the same truncation still marks the diff incomplete', d.incomplete);
}

{
  // `more` means items exist that the tree never carried. Equal counts hide
  // nothing; different counts are a change the visible items cannot show.
  const before = seq([prim('1')], 'Array', 9);
  const after = seq([prim('1')], 'Array', 10);
  const d = diffNodes(before, after);
  check('a change in hidden items is reported', d.entries.length === 1 && d.entries[0].kind === 'changed', JSON.stringify(d.entries));
  check('hidden items make the diff incomplete', d.incomplete);
}

// ------------------------------------------------------------ 8. cycles

{
  const a: SNode = obj([['name', prim('x', 'str')]]);
  const b: SNode = obj([['name', prim('x', 'str')]]);
  // A cycle is reported as an obj with a `cycle` label and no fields; the diff
  // must not recurse into it forever.
  const withCycle = (label: string): SNode => obj([['self', { k: 'obj', t: 'Node', fields: [], cycle: label }]]);
  const d = diffNodes(withCycle('$'), withCycle('$'));
  check('a cycle node terminates the walk', d.entries.length === 0, JSON.stringify(d.entries));
  check('a cycle label difference is a change', diffNodes(withCycle('$'), withCycle('$.x')).entries.length === 1);
  void a;
  void b;
}

// ------------------------------------------------------------ 9. bounds

{
  const before = obj(Array.from({ length: 40 }, (_, i) => [`f${i}`, prim('0')] as [string, SNode]));
  const after = obj(Array.from({ length: 40 }, (_, i) => [`f${i}`, prim('1')] as [string, SNode]));
  const d = diffNodes(before, after, { maxEntries: 10 });
  check('the entry list is capped', d.entries.length === 10, String(d.entries.length));
  check('capped entries are counted, not dropped silently', d.suppressed === 30, String(d.suppressed));
  check('the summary still counts everything', d.summary.changed === 40, String(d.summary.changed));
  check('a capped diff is not "unchanged"', !isUnchanged(d));
  check('the summary mentions the suppressed count', /30 more/.test(summariseDiff(d)), summariseDiff(d));
}

{
  // Beyond the LCS cell guard the module falls back to positional comparison and
  // says the result is not trustworthy.
  const big = (v: string): SNode => seq(Array.from({ length: 201 }, () => prim(v, 'str')));
  const d = diffNodes(big('a'), big('b'), { maxEntries: 5 });
  check('an oversized sequence falls back instead of hanging', d.incomplete, `${d.entries.length} entries, ${d.suppressed} suppressed`);
}

// ------------------------------------------------------------ 10. rendering

{
  check('a string is quoted in the one-liner', renderNode(prim('hi', 'str')) === "'hi'");
  check('a container renders type and size', renderNode(seq([prim('1')], 'Array')) === 'Array[1]', renderNode(seq([prim('1')], 'Array')));
  check('a truncation renders its reason', renderNode(trunc('redacted', 'str')) === '[redacted str]', renderNode(trunc('redacted', 'str')));
  const long = renderNode(prim('x'.repeat(400), 'str'));
  check('a long value is clipped in the one-liner', long.length <= 121 && long.endsWith('…'), String(long.length));
}

// ------------------------------------------------------------ 11. real trees

{
  // The end-to-end shape: two serialized snapshots of a live object, which is
  // exactly what the page compares.
  const make = (qty: number, extra: boolean): unknown => ({
    order: { id: 7, items: [{ sku: 'A', qty }, { sku: 'B', qty: 2 }] },
    ...(extra ? { note: 'added' } : {}),
  });
  const before = serializeJs(make(1, false));
  const after = serializeJs(make(3, true));
  const d = diffNodes(before, after);
  check('two serialized snapshots diff at the edited leaf', d.entries.some((e) => e.path === '$.order.items[0].qty' && e.after === '3'), d.entries.map((e) => e.path).join(' '));
  check('an added top-level field is found', d.entries.some((e) => e.path === '$.note' && e.kind === 'added'), d.entries.map((e) => e.path).join(' '));
  check('untouched siblings stay out of the diff', !d.entries.some((e) => /items\[1\]/.test(e.path)), d.entries.map((e) => e.path).join(' '));
  check('the diff of two real trees is complete', !d.incomplete);
}

{
  // A redacted field must never be compared by value — the tree does not carry
  // the value, so "changed" would be an invention.
  const before = serializeJs({ api_token: 'sk-a', n: 1 });
  const after = serializeJs({ api_token: 'sk-b', n: 1 });
  const d = diffNodes(before, after);
  check('a redacted field is not reported as changed', !d.entries.some((e) => /api_token/.test(e.path)), d.entries.map((e) => e.path).join(' '));
  check('a redacted field marks the diff incomplete', d.incomplete);
}

// ------------------------------------------------------------------ verdict

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = 1;
}
