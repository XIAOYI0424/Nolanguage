/**
 * Structural diff between two snapshots.
 *
 * A debugger's most common question is not "what is this value" but "what
 * changed". Comparing two `SNode` trees answers it without ever touching the
 * target process again — the trees are already bounded, already redacted, and
 * already serialized, so the diff is pure, instant, and safe to run on every
 * frame.
 *
 * Four decisions worth stating, because each one is a way this could lie:
 *
 *   1. **Paths, not positions.** Every entry names the field (`$.order.items[2]
 *      .price`) so the reader can go look at it. A diff that only says "3
 *      changes" is a notification, not an answer. The path points into the
 *      **after** tree — that is the state the user is looking at — except for
 *      `removed`, which only exists in the before tree; when the two indices
 *      differ (an insertion shifted the list) the original location is kept in
 *      `pathBefore` rather than thrown away.
 *
 *   2. **A truncated subtree is `unavailable`, never `removed`.** When one side
 *      stopped at the depth/size ceiling the two values were never compared, and
 *      claiming a change (or its absence) would be a fabrication. Those entries
 *      are reported with the reason and flip `incomplete`, so the caller can say
 *      "no *visible* change" instead of "no change".
 *
 *   3. **Sequences align by content, not index.** An item inserted at the head of
 *      a list shifts every index; index-wise comparison would report the whole
 *      list as changed and hide the one real edit. A bounded LCS pairs equal
 *      items first, then treats the gaps as insertions/removals.
 *
 *   4. **The output is bounded.** `maxEntries` caps what is listed and the rest
 *      is counted, because a diff of two 4,000-node trees can be 4,000 entries
 *      and the page renders all of them.
 */
import type { SNode } from './protocol.js';

export type DiffKind = 'added' | 'removed' | 'changed' | 'unavailable';

export interface DiffEntry {
  /** `$.order.items[2].price` — where to look. */
  path: string;
  kind: DiffKind;
  /** Where the value lived in the before tree, when that differs from `path`. */
  pathBefore?: string;
  /** One-line rendering of each side, already bounded. */
  before?: string;
  after?: string;
  /** Why this subtree could not be compared, for `unavailable`. */
  note?: string;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  unavailable: number;
}

export interface DiffResult {
  entries: DiffEntry[];
  /** Changes beyond `maxEntries`, counted but not listed. */
  suppressed: number;
  /**
   * True when either side was truncated somewhere (or hid items behind `more`).
   * An empty `entries` list is only proof of equality when this is false.
   */
  incomplete: boolean;
  summary: DiffSummary;
}

export interface DiffOptions {
  /** Default 200. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const MAX_RENDER_CHARS = 120;

/** One-line rendering of a node, for the `before`/`after` columns. */
export function renderNode(node: SNode): string {
  const text = renderRaw(node);
  return text.length > MAX_RENDER_CHARS ? `${text.slice(0, MAX_RENDER_CHARS)}…` : text;
}

function renderRaw(n: SNode): string {
  switch (n.k) {
    case 'prim':
      if (n.t === 'str') return `'${n.v}'`;
      return n.v;
    case 'trunc':
      return `[${n.why}${n.t ? ' ' + n.t : ''}]`;
    case 'seq':
      return `${n.t}[${n.n}]`;
    case 'map':
      return `${n.t}{${n.n}}`;
    case 'obj':
      return `${n.t}{${n.fields.length}${n.more ? '+' + n.more : ''}}`;
    default:
      return '?';
  }
}

/**
 * Identity fingerprint used to align sequence items.
 *
 * Shallow on purpose: it must be cheap (it runs per item) and stable (it decides
 * what counts as "the same item"). Containers get their type, size and the first
 * few children, which is enough to survive a reordering without being so
 * specific that a one-field edit makes two items look unrelated.
 */
function sigOf(n: SNode, depth = 2): string {
  switch (n.k) {
    case 'prim':
      return `p:${n.t}:${n.v}`;
    case 'trunc':
      return `x:${n.why}`;
    case 'seq':
      if (depth <= 0) return `s:${n.t}:${n.n}`;
      return `s:${n.t}:${n.n}:${n.items.slice(0, 3).map((i) => sigOf(i, depth - 1)).join(',')}`;
    case 'map':
      if (depth <= 0) return `m:${n.t}:${n.n}`;
      return `m:${n.t}:${n.n}:${n.entries.slice(0, 3).map((e) => `${sigOf(e[0], depth - 1)}=${sigOf(e[1], depth - 1)}`).join(',')}`;
    case 'obj':
      if (depth <= 0) return `o:${n.t}`;
      return `o:${n.t}:${n.fields.slice(0, 3).map((f) => `${f[0]}=${sigOf(f[1], depth - 1)}`).join(',')}`;
    default:
      return '?';
  }
}

function joinField(parent: string, name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `${parent}.${name}` : `${parent}[${JSON.stringify(name)}]`;
}

/**
 * Diff two trees.
 *
 * Neither side is mutated and neither is walked twice: the result is derived in
 * one pass, so calling this at 4 Hz (the page's tick) costs nothing measurable.
 */
export function diffNodes(before: SNode, after: SNode, opts: DiffOptions = {}): DiffResult {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries: DiffEntry[] = [];
  const summary: DiffSummary = { added: 0, removed: 0, changed: 0, unavailable: 0 };
  let suppressed = 0;
  let incomplete = false;

  const emit = (entry: DiffEntry): void => {
    summary[entry.kind] += 1;
    if (entries.length >= maxEntries) {
      suppressed += 1;
      return;
    }
    entries.push(entry);
  };

  /** `more` means items exist on one side that the tree never carried. */
  const noteHidden = (a: SNode, b: SNode, path: string): void => {
    const moreA = 'more' in a && typeof a.more === 'number' ? a.more : 0;
    const moreB = 'more' in b && typeof b.more === 'number' ? b.more : 0;
    if (moreA || moreB) {
      incomplete = true;
      if (moreA !== moreB) {
        emit({
          path,
          kind: 'changed',
          before: `${moreA} hidden`,
          after: `${moreB} hidden`,
          note: 'only the visible part of this container was compared',
        });
      }
    }
  };

  function walk(a: SNode, b: SNode, path: string, pathBefore?: string): void {
    // A truncated branch was never fully seen. Saying "changed" would be a guess
    // and saying nothing would be a lie, so it gets its own kind.
    if (a.k === 'trunc' || b.k === 'trunc') {
      incomplete = true;
      const bothSame = a.k === 'trunc' && b.k === 'trunc' && a.why === b.why;
      if (bothSame) return;
      emit({
        path,
        kind: 'unavailable',
        ...(a.k === 'trunc' ? { before: renderNode(a), note: `before: ${a.why}` } : { before: renderNode(a) }),
        ...(b.k === 'trunc' ? { after: renderNode(b), note: `after: ${b.why}` } : { after: renderNode(b) }),
      });
      return;
    }

    if (a.k !== b.k) {
      emit({ path, kind: 'changed', before: renderNode(a), after: renderNode(b), note: 'type changed', ...(pathBefore ? { pathBefore } : {}) });
      return;
    }

    if (a.k === 'prim' && b.k === 'prim') {
      if (a.t !== b.t || a.v !== b.v) {
        emit({ path, kind: 'changed', before: renderNode(a), after: renderNode(b), ...(pathBefore ? { pathBefore } : {}) });
      }
      return;
    }

    if (a.k === 'obj' && b.k === 'obj') {
      const beforeMap = new Map(a.fields);
      const afterMap = new Map(b.fields);
      for (const [name, node] of beforeMap) {
        if (!afterMap.has(name)) {
          emit({ path: joinField(path, name), kind: 'removed', before: renderNode(node) });
        }
      }
      for (const [name, node] of afterMap) {
        const prev = beforeMap.get(name);
        if (!prev) {
          emit({ path: joinField(path, name), kind: 'added', after: renderNode(node) });
          continue;
        }
        walk(prev, node, joinField(path, name), pathBefore ? joinField(pathBefore, name) : undefined);
      }
      if (a.t !== b.t) {
        emit({ path, kind: 'changed', before: a.t, after: b.t, note: 'type changed' });
      }
      // The `cycle` label is the path the back-reference points at. When it
      // differs the object graph is shaped differently, even though neither side
      // has fields to walk — saying nothing would hide a real structural change.
      if (a.cycle !== b.cycle) {
        emit({
          path,
          kind: 'changed',
          before: a.cycle ? `cycle -> ${a.cycle}` : 'no cycle',
          after: b.cycle ? `cycle -> ${b.cycle}` : 'no cycle',
          note: 'cycle target changed',
        });
      }
      noteHidden(a, b, path);
      return;
    }

    if (a.k === 'map' && b.k === 'map') {
      const beforeMap = new Map(a.entries.map(([k, v]) => [sigOf(k), { key: k, value: v }]));
      const afterMap = new Map(b.entries.map(([k, v]) => [sigOf(k), { key: k, value: v }]));
      const label = (key: SNode): string => (key.k === 'prim' ? key.v : renderNode(key));
      for (const [sig, entry] of beforeMap) {
        if (!afterMap.has(sig)) {
          emit({ path: `${path}[${JSON.stringify(label(entry.key))}]`, kind: 'removed', before: renderNode(entry.value) });
        }
      }
      for (const [sig, entry] of afterMap) {
        const prev = beforeMap.get(sig);
        const at = `${path}[${JSON.stringify(label(entry.key))}]`;
        if (!prev) {
          emit({ path: at, kind: 'added', after: renderNode(entry.value) });
          continue;
        }
        walk(prev.value, entry.value, at);
      }
      noteHidden(a, b, path);
      return;
    }

    if (a.k === 'seq' && b.k === 'seq') {
      diffSeq(a, b, path, walk, emit, () => {
        incomplete = true;
      });
      noteHidden(a, b, path);
    }
  }

  walk(before, after, '$');
  return { entries, suppressed, incomplete, summary };
}

/**
 * Align two sequences by content, then diff the aligned pairs.
 *
 * LCS is affordable here because the serializer caps arrays at 50 items; the
 * cell guard is for trees that arrived from an agent with looser limits, where a
 * quadratic walk would be the exact thing this module exists to avoid.
 */
function diffSeq(
  a: Extract<SNode, { k: 'seq' }>,
  b: Extract<SNode, { k: 'seq' }>,
  path: string,
  walk: (a: SNode, b: SNode, path: string, pathBefore?: string) => void,
  emit: (entry: DiffEntry) => void,
  markIncomplete: () => void,
): void {
  const left = a.items;
  const right = b.items;

  if (left.length * right.length > 40_000) {
    // Too large to align: fall back to position, and say so. A silent fallback
    // would make an insertion look like N edits.
    markIncomplete();
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i++) walk(left[i], right[i], `${path}[${i}]`);
    for (let i = n; i < left.length; i++) emit({ path: `${path}[${i}]`, kind: 'removed', before: renderNode(left[i]) });
    for (let i = n; i < right.length; i++) emit({ path: `${path}[${i}]`, kind: 'added', after: renderNode(right[i]) });
    return;
  }

  const pairs = lcsPairs(left, right);
  pairs.push([left.length, right.length]); // sentinel closes the last run

  let i = 0;
  let j = 0;
  for (const [ai, bj] of pairs) {
    // The gap before this match is an edit region: pair what we can by position,
    // and report the surplus as a pure insertion or removal.
    const runA = left.slice(i, ai);
    const runB = right.slice(j, bj);
    const shared = Math.min(runA.length, runB.length);
    for (let k = 0; k < shared; k++) {
      walk(runA[k], runB[k], `${path}[${j + k}]`, i + k !== j + k ? `${path}[${i + k}]` : undefined);
    }
    // A removal has no after index — it is only findable in the before tree.
    for (let k = shared; k < runA.length; k++) {
      emit({ path: `${path}[${i + k}]`, kind: 'removed', before: renderNode(runA[k]) });
    }
    for (let k = shared; k < runB.length; k++) {
      emit({ path: `${path}[${j + k}]`, kind: 'added', after: renderNode(runB[k]) });
    }

    // Point at the *after* index: an insertion earlier in the list shifts every
    // later item, and the user is navigating the current snapshot.
    if (ai < left.length && bj < right.length) {
      walk(left[ai], right[bj], `${path}[${bj}]`, ai !== bj ? `${path}[${ai}]` : undefined);
    }
    i = ai + 1;
    j = bj + 1;
  }
}

/** Indices of a longest common subsequence, by fingerprint. */
function lcsPairs(a: SNode[], b: SNode[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [];

  // `a.map(sigOf)` would pass the *index* as `depth` (map's second argument),
  // so item 0 got a shallower signature than item 2 and the alignment matched
  // the wrong pairs. Wrap the call: the depth must be the default everywhere.
  const sa = a.map((n) => sigOf(n));
  const sb = b.map((n) => sigOf(n));

  // dp[i][j] = LCS length of a[i..] and b[j..]; filled backwards so the forward
  // walk below can emit matches in order.
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = sa[i] === sb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sa[i] === sb[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/** True when the two trees are equal as far as the diff could see. */
export function isUnchanged(result: DiffResult): boolean {
  return result.entries.length === 0 && result.suppressed === 0;
}

/** Human summary: `3 changed · 1 added`. Empty string when nothing changed. */
export function summariseDiff(result: DiffResult): string {
  const parts: string[] = [];
  const { changed, added, removed, unavailable } = result.summary;
  if (changed) parts.push(`${changed} changed`);
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  if (unavailable) parts.push(`${unavailable} not comparable`);
  if (result.suppressed) parts.push(`${result.suppressed} more`);
  return parts.join(' · ');
}
