/**
 * Apply a Language Server WorkspaceEdit to file text.
 *
 * This is deliberately pure: the networking, containment checks and writes
 * belong to the panel handler, while this module answers the question that is
 * easy to get wrong — given text and line/character spans, what is the new
 * text, and is the edit safe to apply at all?
 *
 * Two rules matter:
 *   - validation happens before any mutation. An out-of-range or overlapping
 *     edit must fail the whole file, not silently truncate part of it;
 *   - edits are applied bottom-up so earlier offsets stay valid.
 */
export interface WorkspaceTextEdit {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  newText: string;
}

export type EditResult =
  | { ok: true; text: string; applied: number }
  | { ok: false; reason: string };

const whole = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : -1);

/** Convert a line/character position to an absolute offset in `text`. */
function position(text: string, line: number, character: number): number {
  let at = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return -1;
    at = nl + 1;
  }
  const end = text.indexOf('\n', at);
  const limit = end < 0 ? text.length : end;
  // LSP counts UTF-16 code units, which is exactly what JS string indices do.
  return character <= limit - at ? at + character : -1;
}

/**
 * Apply `edits` to `text`. Returns an error string when a range is invalid,
 * reversed or overlapping; no partial edit is ever returned.
 */
export function applyTextEdits(text: string, edits: readonly WorkspaceTextEdit[]): EditResult {
  if (!Array.isArray(edits)) return { ok: false, reason: 'edits must be an array' };
  if (!edits.length) return { ok: true, text, applied: 0 };

  const spans: Array<{ start: number; end: number; text: string }> = [];
  for (const e of edits) {
    if (!e || typeof e !== 'object') return { ok: false, reason: 'invalid edit' };
    const line = whole(e.line);
    const character = whole(e.character);
    const endLine = whole(e.endLine);
    const endCharacter = whole(e.endCharacter);
    if (line < 0 || character < 0 || endLine < 0 || endCharacter < 0) {
      return { ok: false, reason: 'edit has a negative or non-integer position' };
    }
    if (typeof e.newText !== 'string') return { ok: false, reason: 'edit has no replacement text' };
    const start = position(text, line, character);
    const end = position(text, endLine, endCharacter);
    if (start < 0 || end < 0) return { ok: false, reason: `edit range is outside the file (${line}:${character}-${endLine}:${endCharacter})` };
    if (end < start) return { ok: false, reason: 'edit range ends before it starts' };
    spans.push({ start, end, text: e.newText });
  }

  spans.sort((a, b) => b.start - a.start || b.end - a.end);
  let lowestEnd = text.length + 1;
  for (const s of spans) {
    // After sorting descending, a later span must end at or before the
    // lowest start already consumed. Anything else overlaps.
    if (s.end > lowestEnd) return { ok: false, reason: 'overlapping edits' };
    lowestEnd = s.start;
  }

  let out = text;
  for (const s of spans) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return { ok: true, text: out, applied: spans.length };
}

/** Split an edit's URI into the workspace-relative path it names. */
export function editPath(uri: unknown): string {
  let p = typeof uri === 'string' ? uri : '';
  if (/^file:/i.test(p)) {
    try {
      // fileURLToPath handles the percent-encoded Windows drive that pyright
      // sends (`file:///c%3A/tmp/a.py`); decodeURIComponent covers servers
      // that emit a URL-shaped path without a valid authority.
      p = new URL(p).pathname;
    } catch {
      p = p.replace(/^file:\/\//i, '');
    }
  }
  try { p = decodeURIComponent(p); } catch { /* keep the raw form */ }
  p = p.replace(/\\/g, '/').replace(/^\.\//, '');
  // A leading slash before a drive letter is the URL form (`/c:/tmp/a.py`).
  p = p.replace(/^\/([A-Za-z]:)/, '$1');
  return p;
}
