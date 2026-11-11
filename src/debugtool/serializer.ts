/**
 * Bounded, side-effect-free serialization of runtime values.
 *
 * This is the **normative** implementation of the snapshot schema: the Python
 * and Go agents mirror these rules, and the engine validates whatever they send
 * against `parseNode`. It exists in TypeScript because the JS agent is JS, and
 * because the rules need tests that run in a second.
 *
 * Three invariants, each with a reason:
 *
 *   1. **It terminates.** Depth, width, total node count and string length all
 *      have ceilings; cycles are detected by identity. A debug tool that hangs
 *      on a self-referential object is worse than no debug tool.
 *   2. **It never runs user code.** Only *own* properties are read, and only
 *      through data descriptors — an accessor (`get total()`) is reported as
 *      `[getter]` instead of being invoked. `toString`/`toJSON` are never
 *      called. This is the difference between observing a program and changing
 *      it (and between reading a config object and leaking its secrets).
 *   3. **Omission is visible.** Every truncation says *why* (`depth`/`size`/
 *      `unsupported`/`redacted`) and how many entries were left out (`more`), so
 *      the UI can say "38 more" instead of implying the object is that small.
 */
import type { SNode } from './protocol.js';

export interface SerializeLimits {
  /** Container nesting before a branch becomes `trunc{depth}`. */
  maxDepth: number;
  /** Members per object / items per array before `more` kicks in. */
  maxItems: number;
  /** Characters kept per string before `…` truncation. */
  maxString: number;
  /** Total nodes emitted for one snapshot (hard budget). */
  maxNodes: number;
  /** Field names (case-insensitive substring) whose values are redacted. */
  redact: string[];
  /** Substrings that exempt a field even when it matches `redact`. */
  redactAllow?: string[];
}

export const DEFAULT_LIMITS: SerializeLimits = {
  maxDepth: 6,
  maxItems: 50,
  maxString: 512,
  maxNodes: 5000,
  redact: ['password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'cookie', 'credential'],
};

/**
 * `true` when a field name looks like a secret.
 *
 * The allowlist is checked first and wins: it exists to override a match, and an
 * exemption that only applied when nothing matched would never apply at all.
 */
export function isSensitive(name: string, redact: string[], allow: string[] = []): boolean {
  const lower = name.toLowerCase();
  if (allow.some((a) => a && lower.includes(a))) return false;
  return redact.some((r) => r && lower.includes(r));
}

/**
 * Serialize a JavaScript value.
 *
 * Deterministic for plain data: object keys keep insertion order, so two
 * snapshots of the same object produce identical trees (which is what makes a
 * diff meaningful later).
 */
export function serializeJs(value: unknown, limits: SerializeLimits = DEFAULT_LIMITS): SNode {
  const seen = new Map<object, string>();
  let budget = limits.maxNodes;

  // A hard budget: once it is gone, containers stop adding children instead of
  // emitting one `trunc` per remaining item (which would still walk the whole
  // object graph and defeat the point of a budget).
  const spend = (): boolean => {
    if (budget <= 0) return false;
    budget -= 1;
    return true;
  };

  function walk(v: unknown, depth: number, path: string, key?: string): SNode {
    if (!spend()) return { k: 'trunc', why: 'size' };

    if (key !== undefined && isSensitive(key, limits.redact, limits.redactAllow)) return { k: 'trunc', why: 'redacted', t: typeof v };

    if (v === null) return { k: 'prim', t: 'none', v: 'null' };
    if (v === undefined) return { k: 'prim', t: 'none', v: 'undefined' };

    switch (typeof v) {
      case 'boolean':
        return { k: 'prim', t: 'bool', v: v ? 'true' : 'false' };
      case 'number':
        return Number.isInteger(v)
          ? { k: 'prim', t: 'int', v: String(v) }
          : { k: 'prim', t: 'float', v: Number.isFinite(v) ? String(v) : String(v) };
      case 'bigint':
        return { k: 'prim', t: 'int', v: `${v}n` };
      case 'string':
        return { k: 'prim', t: 'str', v: clip(v, limits.maxString) };
      case 'function':
        return { k: 'trunc', why: 'unsupported', t: 'function' };
      case 'symbol':
        return { k: 'prim', t: 'str', v: String(v) };
    }

    const obj = v as object;

    // Identity check first: a cycle must be reported even at max depth, because
    // "there is a cycle here" is the useful fact, not "too deep".
    const back = seen.get(obj);
    if (back !== undefined) return { k: 'obj', t: typeName(obj), fields: [], cycle: back };

    if (depth >= limits.maxDepth) return { k: 'trunc', why: 'depth', t: typeName(obj) };
    seen.set(obj, path);

    try {
      if (Array.isArray(obj)) {
        const items: SNode[] = [];
        for (let i = 0; i < obj.length && items.length < limits.maxItems; i++) {
          if (budget <= 0) break;
          items.push(walk(obj[i], depth + 1, `${path}[${i}]`));
        }
        return {
          k: 'seq',
          t: 'Array',
          n: obj.length,
          items,
          ...(obj.length > items.length ? { more: obj.length - items.length } : {}),
        };
      }
      if (obj instanceof Date) {
        return { k: 'prim', t: 'str', v: Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString() };
      }
      if (obj instanceof RegExp) {
        return { k: 'prim', t: 'str', v: String(obj) };
      }
      if (obj instanceof Map) {
        const entries: Array<[SNode, SNode]> = [];
        let i = 0;
        for (const [k, val] of obj) {
          if (i >= limits.maxItems || budget <= 0) break;
          entries.push([walk(k, depth + 1, `${path}.key${i}`), walk(val, depth + 1, `${path}[${i}]`)]);
          i++;
        }
        return { k: 'map', t: 'Map', n: obj.size, entries, ...(obj.size > entries.length ? { more: obj.size - entries.length } : {}) };
      }
      if (obj instanceof Set) {
        const items: SNode[] = [];
        let i = 0;
        for (const item of obj) {
          if (i >= limits.maxItems || budget <= 0) break;
          items.push(walk(item, depth + 1, `${path}[${i}]`));
          i++;
        }
        return { k: 'seq', t: 'Set', n: obj.size, items, ...(obj.size > items.length ? { more: obj.size - items.length } : {}) };
      }
      if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
        const arr = obj as unknown as ArrayLike<number>;
        // `Array.from(arr)` copies the **whole** buffer: a 10M-element
        // Float64Array became a 10M-element JS array (measured: 151 MiB, 263 ms)
        // just to show 50 numbers. Read the prefix instead.
        const shown: SNode[] = [];
        const limit = Math.min(arr.length, limits.maxItems);
        for (let i = 0; i < limit; i++) {
          if (budget <= 0) break;
          shown.push({ k: 'prim', t: 'float', v: String(arr[i]) });
        }
        return {
          k: 'seq',
          t: typeName(obj),
          n: arr.length,
          items: shown,
          ...(arr.length > shown.length ? { more: arr.length - shown.length } : {}),
        };
      }
      if (obj instanceof Promise || obj instanceof WeakMap || obj instanceof WeakSet) {
        return { k: 'trunc', why: 'unsupported', t: typeName(obj) };
      }

      // Plain object or class instance: own properties only, data descriptors
      // only. `getOwnPropertyNames` (not `keys`) so non-enumerables like
      // `__slots__`-style fields are still visible.
      const fields: Array<[string, SNode]> = [];
      let total = 0;
      for (const name of Object.getOwnPropertyNames(obj)) {
        if (name === '__proto__') continue;
        total++;
        if (budget <= 0) continue;
        if (fields.length >= limits.maxItems) continue;
        const desc = Object.getOwnPropertyDescriptor(obj, name);
        if (!desc) continue;
        if (!('value' in desc)) {
          // Accessor: report it, never call it.
          fields.push([name, { k: 'trunc', why: 'unsupported', t: 'getter' }]);
          continue;
        }
        fields.push([name, walk(desc.value, depth + 1, `${path}.${name}`, name)]);
      }
      return {
        k: 'obj',
        t: typeName(obj),
        fields,
        ...(total > fields.length ? { more: total - fields.length } : {}),
      };
    } finally {
      // Only the *current* path matters for cycle detection; keeping every object
      // alive would make the map grow with the snapshot size.
      if (seen.get(obj) === path) seen.delete(obj);
    }
  }

  return walk(value, 0, '$');
}

/** Constructor name without the `Object` default; used as the tree's type tag. */
function typeName(obj: object): string {
  const proto = Object.getPrototypeOf(obj) as { constructor?: { name?: string } } | null;
  const name = proto?.constructor?.name;
  if (!name || name === 'Object') return 'Object';
  return name;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (${s.length - max} more chars)`;
}

/**
 * Count the nodes in a tree — the engine uses it to enforce its own budget on
 * trees that arrive from an agent (which may not share these limits).
 */
export function countNodes(node: SNode): number {
  switch (node.k) {
    case 'seq':
      return 1 + node.items.reduce((a, n) => a + countNodes(n), 0);
    case 'map':
      return 1 + node.entries.reduce((a, [k, v]) => a + countNodes(k) + countNodes(v), 0);
    case 'obj':
      return 1 + node.fields.reduce((a, [, v]) => a + countNodes(v), 0);
    default:
      return 1;
  }
}
