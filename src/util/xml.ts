/**
 * Minimal XML reader for JetBrains project files.
 *
 * `.idea/*.xml` is machine-written XML with a fixed shape: elements, attributes,
 * text, comments, CDATA. That is the whole language — no DTD, no namespaces, no
 * XPath — so a dependency-free scanner is both sufficient and safer than pulling
 * in a parser (the engine ships with zero third-party runtime dependencies).
 *
 * Tolerant by design: a malformed file must degrade to "some elements were
 * skipped", never to an exception that takes the importer down. Callers get a
 * `#document` root and walk it.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content (CDATA included), entity-decoded. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/** Decode the five XML entities plus numeric references. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Index of the `>` that closes a tag, skipping quoted attribute values. */
function tagEnd(src: string, from: number): number {
  let quote = '';
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return src.length;
}

const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parse `name attr="v" attr2='v2'` into a node. */
function parseTag(body: string): XmlNode {
  const nameMatch = /^([\w:.-]+)/.exec(body);
  const node: XmlNode = { name: nameMatch ? nameMatch[1] : '', attrs: {}, children: [], text: '' };
  if (!nameMatch) return node;
  ATTR.lastIndex = nameMatch[0].length;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(body))) {
    node.attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return node;
}

/**
 * Parse a document. Never throws: unclosed tags are closed at EOF and stray
 * closing tags are ignored, which is what "tolerant" means for this format.
 */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const top = (): XmlNode => stack[stack.length - 1];
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      top().text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      top().text += source.slice(lt + 9, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      // DOCTYPE and friends: skip to the next '>'.
      i = tagEnd(source, lt + 2) + 1;
      continue;
    }
    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt + 2);
      const name = source.slice(lt + 2, end === -1 ? source.length : end).trim();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) {
          stack.length = s;
          break;
        }
      }
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const end = tagEnd(source, lt + 1);
    const raw = source.slice(lt + 1, end);
    const selfClosing = raw.trimEnd().endsWith('/');
    const node = parseTag(selfClosing ? raw.trimEnd().slice(0, -1) : raw);
    if (node.name) top().children.push(node);
    if (!selfClosing && node.name) stack.push(node);
    i = end + 1;
  }

  return root;
}

/** First direct child with this tag name. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

/** All direct children with this tag name. */
export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Depth-first search for the first descendant with this name. */
export function find(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) {
    if (c.name === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Depth-first search for every descendant with this name. */
export function findAll(node: XmlNode | undefined, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    out.push(...findAll(c, name));
  }
  return out;
}

/** `option` children of `node`, keyed by their `name` attribute. */
export function options(node: XmlNode | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of children(node, 'option')) {
    const key = o.attrs.name;
    if (key) out[key] = o.attrs.value ?? '';
  }
  return out;
}
