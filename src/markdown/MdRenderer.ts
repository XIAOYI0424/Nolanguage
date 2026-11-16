/**
 * MdRenderer — a zero-dependency Markdown -> HTML renderer.
 *
 * Stage 8 of the spec ("Markdown: marksman + rendering") names markdown-it as
 * the renderer. The project's hard constraint is stricter: only `node:`
 * builtins, no npm dependencies at all — the same rule that made us write our
 * own WebSocket server, JSON-RPC framing and LSP client. So this file is that
 * renderer: a line-based block parser plus a single-pass inline parser that
 * covers the CommonMark subset real documents actually use.
 *
 * Deliberate simplifications, each pinned by a test in verify-markdown:
 *   - **Raw HTML is escaped, never passed through** (markdown-it's
 *     `html: false` mode). The preview pane assigns the result to
 *     `innerHTML`, so accepting `<script>` would be a stored-XSS hole in a
 *     panel that can also read local files.
 *   - Link and image URLs are scheme-filtered: http/https/mailto/tel,
 *     relative, query and fragment targets only. Everything else
 *     (`javascript:`, `data:`, protocol-relative `//host`) is dropped to
 *     plain text.
 *   - Emphasis covers the common flanking forms (`**b**`, `*i*`, `__b__`,
 *     `_i_`, `~~s~~`) with simplified intraword rules; CommonMark's 17
 *     pathological cases are out of scope.
 *   - Lists are always rendered tight (single-paragraph items get no `<p>`),
 *     and different bullet characters do not start a new list.
 */

// ---------------------------------------------------------------- public types

export interface MdHeading {
  level: number;
  text: string;
  slug: string;
  /** 1-based line in the original source (frontmatter counted). */
  line: number;
}

export interface MdFrontmatter {
  title: string;
  tags: string[];
  date: string;
  raw: Record<string, string>;
}

export interface MdStats {
  blocks: number;
  words: number;
  codeBlocks: number;
  links: number;
  headings: number;
}

export interface MdRenderResult {
  html: string;
  /** Frontmatter title, else the first H1, else ''. */
  title: string;
  headings: MdHeading[];
  frontmatter: MdFrontmatter;
  stats: MdStats;
  /** True when a safety guard clipped the source (see MAX_* below). */
  truncated: boolean;
}

/** Safety valves: pathological input must degrade, never hang the panel. */
export const MAX_SRC_BYTES = 1_000_000;
export const MAX_LINES = 50_000;

// ---------------------------------------------------------------- text helpers

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

const SAFE_SCHEME = /^(?:https?|mailto|tel):/i;

/**
 * A URL the preview may link to, or null when the scheme is not allowed.
 *
 * Only an explicit scheme can be dangerous: a leading `//` is
 * protocol-relative (a scheme-less remote), and anything without a colon is a
 * relative path. Control characters are stripped so a `java\nscript:`-style
 * bypass cannot slip past the scheme check.
 */
export function safeUrl(url: string): string | null {
  const u = url.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!u) return null;
  if (u.startsWith('//')) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  if (scheme) return SAFE_SCHEME.test(scheme[1] + ':') ? u : null;
  return u;
}

/** GitHub-style heading slug; duplicate slugs get a numeric suffix. */
export function slugify(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'section';
}

/** Rough plain text: enough for slugs, image alt text and word counts. */
export function plainText(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~|\*|_)/g, '');
}

// ---------------------------------------------------------------- block parser

interface Ctx {
  headings: MdHeading[];
  /** Link reference definitions: lowercase id -> { url, title }. */
  refs: Map<string, { url: string; title: string }>;
  stats: MdStats;
  slugCount: Map<string, number>;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BULLET_ITEM = /^( {0,3})([-+*])([ \t]+)(.*)$/;
const ORDERED_ITEM = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/;
const SETTEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const REF_DEF = /^ {0,3}\[([^\]]+)]:[ \t]*(\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;

/** Block starters that end a paragraph. `next` is the lookahead line. */
function startsNewBlock(line: string, next: string): boolean {
  return (
    FENCE_OPEN.test(line) ||
    ATX.test(line) ||
    THEMATIC.test(line) ||
    BULLET_ITEM.test(line) ||
    ORDERED_ITEM.test(line) ||
    /^ {0,3}>/.test(line) ||
    REF_DEF.test(line) ||
    isTableStart(line, next)
  );
}

/** True when `line` is a GFM table header and `next` its delimiter row. */
function isTableStart(line: string, next: string): boolean {
  if (!next) return false;
  if (!line.includes('|')) return false;
  const cells = splitRow(line);
  if (cells.length < 2) return false;
  const delim = splitRow(next);
  if (delim.length !== cells.length) return false;
  return delim.every((c) => /^[ \t]*:?-{1,}:?[ \t]*$/.test(c));
}

/** Split a table row into cells, ignoring the outer pipes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split('|');
}

/** Parse `lines[start..]` (0-based window) into HTML blocks. */
function parseBlocks(ctx: Ctx, lines: string[], baseLine: number): string {
  const out: string[] = [];
  let i = 0;
  const at = (idx: number): string => lines[idx] ?? '';

  while (i < lines.length) {
    const line = at(i);
    if (!line.trim()) {
      i++;
      continue;
    }

    // ---- fenced code ------------------------------------------------------
    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[1]![0] === '`' && fence[2]!.includes('`'))) {
      const marker = fence[1]!;
      const info = fence[2]!.trim().split(/\s+/)[0] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = FENCE_CLOSE.exec(at(i));
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
          i++;
          break;
        }
        body.push(at(i));
        i++;
      }
      const cls = info ? ` class="language-${escapeHtml(info.replace(/[^\w-]/g, ''))}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      ctx.stats.blocks++;
      ctx.stats.codeBlocks++;
      continue;
    }

    // ---- ATX heading ------------------------------------------------------
    const atx = ATX.exec(line);
    if (atx) {
      const level = atx[1]!.length;
      const text = (atx[2] ?? '').trim();
      out.push(headingHtml(ctx, level, text, baseLine + i));
      i++;
      continue;
    }

    // ---- thematic break ---------------------------------------------------
    if (THEMATIC.test(line)) {
      out.push('<hr />');
      ctx.stats.blocks++;
      i++;
      continue;
    }

    // ---- indented code block ----------------------------------------------
    // Four spaces (or a tab) at the *start of a block* — paragraph
    // continuation lines are consumed before this point, so this cannot fire
    // mid-paragraph the way CommonMark forbids. The language-untagged form
    // renders without a `language-*` class.
    const indented = /^(?: {4}|\t)(\S.*)$/.exec(line);
    if (indented) {
      const body: string[] = [indented[1]!];
      i++;
      while (i < lines.length) {
        const l = at(i);
        if (!l.trim()) {
          body.push('');
          i++;
          continue;
        }
        const m = /^(?: {4}|\t)(.*)$/.exec(l);
        if (!m) break;
        body.push(m[1]!);
        i++;
      }
      while (body.length && !body[body.length - 1]!.trim()) body.pop();
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      ctx.stats.blocks++;
      ctx.stats.codeBlocks++;
      continue;
    }

    // ---- blockquote (only `>`-prefixed lines; lazy continuation omitted) ---
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(at(i))) {
        body.push(at(i).replace(/^ {0,3}>[ \t]?/, ''));
        i++;
      }
      out.push(`<blockquote>\n${parseBlocks(ctx, body, baseLine + i)}\n</blockquote>`);
      ctx.stats.blocks++;
      continue;
    }

    // ---- list --------------------------------------------------------------
    if (BULLET_ITEM.test(line) || ORDERED_ITEM.test(line)) {
      const [rendered, consumed] = parseList(ctx, lines, i, baseLine);
      out.push(rendered);
      i += consumed;
      continue;
    }

    // ---- table -------------------------------------------------------------
    if (isTableStart(line, at(i + 1))) {
      out.push(parseTable(ctx, lines, i));
      // figure out how many lines the table consumed
      i++;
      i++;
      while (i < lines.length && at(i).includes('|') && at(i).trim() && !startsNewBlock(at(i), at(i + 1))) i++;
      ctx.stats.blocks++;
      continue;
    }

    // ---- paragraph (with setext underline) ---------------------------------
    // The underline is checked *while* gathering, not after: appending it to
    // the paragraph first would let the old "single line only" rule swallow
    // multi-line setext headings.
    const para: string[] = [line];
    i++;
    let setext = false;
    while (i < lines.length) {
      const cur = at(i);
      if (!cur.trim()) break;
      const under = SETTEXT.exec(cur);
      // A contiguous `=`/`-` run directly under a paragraph is a setext
      // underline and wins over a thematic break (CommonMark priority): a
      // `---` that follows text is an <h2>, not a rule.
      if (under && para.length > 0) {
        const level = under[1]![0] === '=' ? 1 : 2;
        out.push(headingHtml(ctx, level, para.join('\n').trim(), baseLine + i - para.length));
        i++;
        setext = true;
        break;
      }
      if (startsNewBlock(cur, at(i + 1))) break;
      para.push(cur);
      i++;
    }
    if (setext) {
      ctx.stats.blocks++;
      continue;
    }
    out.push(`<p>${renderInline(ctx, para.join('\n'))}</p>`);
    ctx.stats.blocks++;
  }
  return out.join('\n');
}

function headingHtml(ctx: Ctx, level: number, text: string, line: number): string {
  const plain = plainText(text).trim();
  let slug = slugify(plain);
  const seen = ctx.slugCount.get(slug) ?? 0;
  ctx.slugCount.set(slug, seen + 1);
  if (seen > 0) slug = `${slug}-${seen}`;
  ctx.headings.push({ level, text: plain, slug, line });
  ctx.stats.headings++;
  return `<h${level} id="${slug}">${renderInline(ctx, text)}</h${level}>`;
}

/**
 * Parse one list starting at `lines[i]`.
 *
 * Returns the rendered HTML and how many lines were consumed. Items are
 * gathered by indent: a line indented at least to the first item's content
 * column continues that item, so nested lists and multi-paragraph items
 * recurse through `parseBlocks`.
 */
function parseList(ctx: Ctx, lines: string[], start: number, baseLine: number): [string, number] {
  const b = BULLET_ITEM.exec(lines[start]!);
  const o = b ? null : ORDERED_ITEM.exec(lines[start]!)!;
  const ordered = !b;
  // Continuation lines align to the first marker's content column: `- x` is 2,
  // `12. x` is 4.
  const markerWidth = b ? b[1]!.length + 2 : o![1]!.length + o![2]!.length + o![3]!.length + o![4]!.length;
  const startNum = ordered ? parseInt(o![2]!, 10) : 1;

  const items: string[][] = [];
  let i = start;
  let current: string[] | null = null;

  while (i < lines.length) {
    const line = lines[i]!;
    const bulletM = BULLET_ITEM.exec(line);
    const orderedM = bulletM ? null : ORDERED_ITEM.exec(line);
    // A different marker type never joins this list.
    const marker = ordered ? orderedM : bulletM;

    if (line.trim() && marker) {
      if (current) items.push(current);
      current = [line.slice(markerWidth)];
      i++;
      continue;
    }
    if (!line.trim()) {
      // A blank line ends the list unless a same-type item or an indented
      // continuation follows — that makes the list loose, but it stays one list.
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim()) j++;
      const next = lines[j] ?? '';
      const nextBullet = BULLET_ITEM.exec(next);
      const nextOrdered = nextBullet ? null : ORDERED_ITEM.exec(next);
      const nextMarker = ordered ? nextOrdered : nextBullet;
      const indented = /^[ \t]*/.exec(next)![0].length >= markerWidth;
      if (nextMarker || indented) {
        if (current) current.push('');
        i = j;
        continue;
      }
      break;
    }
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (current && indent >= markerWidth) {
      current.push(line.slice(markerWidth));
      i++;
      continue;
    }
    break;
  }
  if (current) items.push(current);

  const tag = ordered ? 'ol' : 'ul';
  const attr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  const body = items.map((raw) => `<li>${renderItem(ctx, raw, baseLine)}</li>`).join('\n');
  ctx.stats.blocks++;
  return [`<${tag}${attr}>\n${body}\n</${tag}>`, i - start];
}

/** Lists render tight: a single-paragraph item gets no <p> wrapper. */
function unwrapP(html: string): string {
  const m = /^<p>([\s\S]*)<\/p>$/.exec(html);
  return m ? m[1]! : html;
}

/** Render one list item's collected lines; task lists get a checkbox. */
function renderItem(ctx: Ctx, raw: string[], baseLine: number): string {
  const task = /^\[([ xX])][ \t]+(.*)$/.exec(raw[0] ?? '');
  if (task) {
    const checked = task[1] !== ' ';
    const box = `<input type="checkbox" disabled${checked ? ' checked' : ''} /> `;
    const rest = [task[2]!, ...raw.slice(1)].join('\n');
    const html = parseBlocks(ctx, rest.split('\n'), baseLine);
    return `<span class="task-list">${box}${unwrapP(html)}</span>`;
  }
  return unwrapP(parseBlocks(ctx, raw, baseLine));
}

/** Parse a GFM table starting at its header row `lines[i]`. */
function parseTable(ctx: Ctx, lines: string[], i: number): string {
  const head = splitRow(lines[i]!);
  const aligns = splitRow(lines[i + 1]!).map((c) => {
    const t = c.trim();
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.endsWith(':')) return 'right';
    if (t.startsWith(':')) return 'left';
    return '';
  });
  const rows: string[][] = [];
  let j = i + 2;
  while (j < lines.length && lines[j]!.trim() && lines[j]!.includes('|')) {
    rows.push(splitRow(lines[j]!));
    j++;
  }
  const cell = (text: string, k: number): string => {
    const a = aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
    return `<td${a}>${renderInline(ctx, text.trim())}</td>`;
  };
  const thead = `<tr>${head.map((c, k) => {
    const a = aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
    return `<th${a}>${renderInline(ctx, c.trim())}</th>`;
  }).join('')}</tr>`;
  const tbody = rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('\n');
  ctx.stats.blocks++;
  return `<table>\n<thead>\n${thead}\n</thead>\n<tbody>\n${tbody}\n</tbody>\n</table>`;
}

// ---------------------------------------------------------------- inline parser

/**
 * Inline link/image pattern. The URL allows no whitespace but one level of
 * balanced parens, so `[x](https://en.wikipedia.org/wiki/A_(b))` parses as
 * one link instead of leaving a stray `)` behind. Built with `new RegExp`
 * because a regex *literal* cannot interpolate a pattern string.
 *
 * The title is matched as `&quot;..&quot;`: by the time this runs the text
 * has been escaped, so a double quote is already an entity.
 */
const INLINE_URL = '(?:[^\\s()]|\\([^\\s()]*\\))+';
const IMG_RE = new RegExp(`!\\[([^\\]]*)]\\([ \\t]*(${INLINE_URL})(?:[ \\t]+&quot;([^&]*)&quot;)?[ \\t]*\\)`, 'g');
const LINK_RE = new RegExp(`\\[([^\\]]*)]\\([ \\t]*(${INLINE_URL})(?:[ \\t]+&quot;([^&]*)&quot;)?[ \\t]*\\)`, 'g');

/**
 * Render inline markdown to HTML.
 *
 * Four passes over the text, each guarded by placeholders so a later pass
 * never re-processes what an earlier one produced:
 *   1. protect  — backslash escapes and code spans become opaque slots
 *   2. emphasis — strong / em / strike (non-nested regexes, applied in order)
 *   3. links    — inline and reference links, images, autolinks
 *   4. finish   — escape the remaining text, restore the slots, hard breaks
 */
function renderInline(ctx: Ctx, text: string): string {
  const slots: string[] = [];
  const keep = (html: string): string => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };

  // ---- pass 1: protect escapes and code spans ------------------------------
  // Backslash escapes and code spans become opaque slots so later passes can
  // neither mangle their content nor re-generate tags inside them.
  let s = '';
  let k = 0;
  while (k < text.length) {
    const c = text[k]!;
    if (c === '\\' && k + 1 < text.length && /[!-/:-@[-`{-~ ]/.test(text[k + 1]!)) {
      s += keep(escapeHtml(text[k + 1]!));
      k += 2;
      continue;
    }
    if (c === '`') {
      let n = 0;
      while (text[k + n] === '`') n++;
      const close = text.indexOf('`'.repeat(n), k + n);
      if (close !== -1) {
        let code = text.slice(k + n, close);
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        s += keep(`<code>${escapeHtml(code)}</code>`);
        k = close + n;
        continue;
      }
    }
    s += c;
    k++;
  }

  // ---- escape everything else BEFORE any tag is generated ------------------
  // Emphasis/link regexes below emit literal `<strong>`/`<a>` tags; escaping
  // first means those tags survive untouched while plain text can never
  // smuggle in markup. Slot markers (NUL + digits) are escape-proof, and the
  // `"`/`'`/`&` inside a URL are already entities by the time it is built,
  // so it cannot break out of the href attribute.
  s = escapeHtml(s);

  // ---- pass 2: emphasis ----------------------------------------------------
  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, '$1<strong>$2</strong>')
    .replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?![\w])/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');

  // ---- pass 3: links and images -------------------------------------------
  // Images first: their payload is the alt text, never nested markup.
  s = s.replace(IMG_RE,
    (_m, alt: string, url: string) => {
      const safe = safeUrl(url);
      if (!safe) return escapeHtml(plainText(alt));
      ctx.stats.links++;
      return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(plainText(alt))}" />`;
    });
  s = s.replace(LINK_RE,
    (_m, label: string, url: string, title: string) => {
      const safe = safeUrl(url);
      ctx.stats.links++;
      if (!safe) return label;
      const t = title ? ` title="${title}"` : '';
      return `<a href="${escapeHtml(safe)}"${t}>${label}</a>`;
    });
  s = s.replace(/\[([^\]]*)]\[([^\]]*)]/g, (_m, label: string, id: string) => {
    const key = (id || label).trim().toLowerCase();
    const ref = ctx.refs.get(key);
    if (!ref) return label;
    const safe = safeUrl(ref.url);
    if (!safe) return label;
    ctx.stats.links++;
    return `<a href="${escapeHtml(safe)}"${ref.title ? ` title="${escapeHtml(ref.title)}"` : ''}>${label}</a>`;
  });
  // Autolinks arrive already escaped: pass 1 ran `escapeHtml` over the whole
  // string, so `<https://…>` is `&lt;https://…&gt;` by the time we get here.
  // The pattern used to look for a literal `<`, which never matched — every
  // autolink rendered as inert text. Matching the escaped form is the fix, and
  // the `[^&\s]+` body keeps a URL from swallowing the `&gt;` that closes it.
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, (_m, url: string) => {
    ctx.stats.links++;
    return `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
  });

  // ---- pass 4: hard breaks, restore slots ----------------------------------
  s = s.replace(/ {2,}\n/g, '<br />\n').replace(/\\\n/g, '<br />\n');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => slots[Number(idx)] ?? '');
  return s;
}

// ---------------------------------------------------------------- frontmatter & refs

/** Minimal YAML subset: `key: value` pairs, `[a, b]` tag lists. */
export function parseFrontmatter(block: string): MdFrontmatter {
  const raw: Record<string, string> = {};
  const tags: string[] = [];
  const lines = block.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    const m = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line.trim());
    if (m) {
      const key = m[1]!.toLowerCase();
      const val = m[2]!.trim();
      raw[key] = val;
      continue;
    }
    // A nested list item belongs to the most recent key with an empty value
    // (the YAML `key:\n  - a\n  - b` form used by Hugo / Obsidian / Jekyll).
    const li = /^[ \t]*-[ \t]+(.*)$/.exec(line);
    if (li) {
      const keys = Object.keys(raw);
      const lastKey = keys[keys.length - 1];
      if (lastKey && raw[lastKey] === '') {
        if (lastKey === 'tags') tags.push(li[1]!.trim());
        else raw[lastKey] = (raw[lastKey] ? raw[lastKey] + ' ' : '') + li[1]!.trim();
      }
    }
  }
  // Inline form `tags: [a, b]` or `tags: a b` wins only when no nested list.
  const tagList = tags.length
    ? tags
    : (raw['tags'] ?? '')
        .replace(/^\[|]$/g, '')
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
  return { title: raw['title'] ?? '', tags: tagList, date: raw['date'] ?? '', raw };
}

/** Collect link reference definitions from the whole document (forward refs work). */
function collectRefs(ctx: Ctx, lines: string[]): void {
  for (const line of lines) {
    const m = REF_DEF.exec(line);
    if (!m) continue;
    const id = m[1]!.trim().toLowerCase();
    if (ctx.refs.has(id)) continue;
    ctx.refs.set(id, { url: m[2]!, title: m[3] ?? m[4] ?? m[5] ?? '' });
  }
}

// ---------------------------------------------------------------- entry point

/**
 * Render a Markdown document to sanitized HTML.
 *
 * Pure and synchronous: no clocks, no IO. The caller measures the render
 * latency (the spec's "render latency" metric) so this function stays
 * deterministic under test.
 */
export function renderMarkdown(src: string): MdRenderResult {
  let text = src;
  let truncated = false;
  if (text.length > MAX_SRC_BYTES) {
    text = text.slice(0, MAX_SRC_BYTES);
    truncated = true;
  }
  text = text.replace(/\r\n?/g, '\n');
  let lines = text.split('\n');
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    truncated = true;
  }

  // ---- frontmatter ---------------------------------------------------------
  let frontmatter: MdFrontmatter = { title: '', tags: [], date: '', raw: {} };
  let bodyStart = 0;
  if ((lines[0] ?? '').trim() === '---') {
    for (let j = 1; j < Math.min(lines.length, 60); j++) {
      const close = lines[j]!.trim();
      if (close === '---' || close === '...') {
        frontmatter = parseFrontmatter(lines.slice(1, j).join('\n'));
        bodyStart = j + 1;
        break;
      }
    }
  }
  const body = lines.slice(bodyStart);

  const ctx: Ctx = {
    headings: [],
    refs: new Map(),
    slugCount: new Map(),
    stats: { blocks: 0, words: 0, codeBlocks: 0, links: 0, headings: 0 },
  };
  collectRefs(ctx, body);
  const html = parseBlocks(ctx, body, bodyStart + 1).trim();
  ctx.stats.words = plainText(text).split(/\s+/).filter(Boolean).length;

  const title = frontmatter.title || ctx.headings.find((h) => h.level === 1)?.text || '';
  return { html, title, headings: ctx.headings, frontmatter, stats: ctx.stats, truncated };
}
