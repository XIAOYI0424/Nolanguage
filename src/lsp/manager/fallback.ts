/**
 * What answers when no language server can.
 *
 * This is a **lexical** provider, not a semantic one: it strips comments and
 * literals in one pass, then reports only what a scanner can know for certain —
 * an unterminated literal, an unbalanced brace. It deliberately does *not* guess
 * about types, because a wrong red squiggle is worse than no squiggle, and the
 * whole point of the fallback is to be trustworthy when the real server is
 * missing.
 *
 * The vocabulary comes from the plugin (`fallback.keywords`, `fallback.types`,
 * `fallback.declarationPattern`), so this file contains no language knowledge.
 * A `tree-sitter` provider implements the same interface and slots in above it.
 */
import type {
  FallbackCompletion,
  FallbackContext,
  FallbackDiagnostic,
  FallbackProvider,
} from './types.js';

export interface LexicalFallbackSpec {
  kind?: 'lexical';
  /** Reserved words, offered after the file's own declarations. */
  keywords?: string[];
  /** Built-in type names, offered before keywords. */
  types?: string[];
  /**
   * Regex source with one capture group naming a declaration.
   * Example: `(?:class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)`.
   */
  declarationPattern?: string;
  /** Shown in the Problems panel; defaults to a generic sentence. */
  note?: string;
}

/** Scanning a 4 MiB buffer on every keystroke is not a fallback, it is a stall. */
const MAX_SCAN_CHARS = 512 * 1024;
const MAX_COMPLETIONS = 200;

interface ScanResult {
  unterminated?: { line: number; character: number; what: 'string' | 'char' | 'comment' };
  depth: number;
  unmatchedClose?: { line: number; character: number };
  lastLine: number;
}

/**
 * One pass over the text, tracking just enough state to be sure.
 *
 * Comments and literals are skipped so a brace inside a string cannot unbalance
 * the count — the failure mode that makes naive brace checkers useless.
 */
export function scanText(text: string): ScanResult {
  const limit = Math.min(text.length, MAX_SCAN_CHARS);
  let line = 0;
  let col = 0;
  let depth = 0;
  let unmatchedClose: { line: number; character: number } | undefined;
  let unterminated: ScanResult['unterminated'];
  let state: 'code' | 'line' | 'block' | 'string' | 'char' = 'code';
  let startLine = 0;
  let startCol = 0;

  for (let i = 0; i < limit; i++) {
    const c = text[i];
    const next = i + 1 < limit ? text[i + 1] : '';

    if (c === '\n') {
      // An unterminated *single-line* literal ends here: C-family languages do
      // not allow a newline inside one, so this is a real error, not a
      // continuation.
      if (state === 'string' || state === 'char') {
        unterminated ??= { line: startLine, character: startCol, what: state };
        state = 'code';
      } else if (state === 'line') {
        state = 'code';
      }
      line++;
      col = 0;
      continue;
    }

    if (state === 'line') {
      col++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        i++;
        col += 2;
        continue;
      }
      col++;
      continue;
    }
    if (state === 'string' || state === 'char') {
      if (c === '\\') {
        i++;
        col += 2;
        continue;
      }
      if ((state === 'string' && c === '"') || (state === 'char' && c === "'")) {
        state = 'code';
        col++;
        continue;
      }
      col++;
      continue;
    }

    // code
    if (c === '/' && next === '/') {
      state = 'line';
      i++;
      col += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      state = 'block';
      startLine = line;
      startCol = col;
      i++;
      col += 2;
      continue;
    }
    if (c === '"') {
      // A Java text block opens with three quotes and may span lines.
      if (text.startsWith('"""', i)) {
        const end = text.indexOf('"""', i + 3);
        if (end < 0 || end >= limit) {
          unterminated ??= { line, character: col, what: 'string' };
          break;
        }
        const consumed = text.slice(i, end + 3);
        const lines = consumed.split('\n');
        line += lines.length - 1;
        col = lines.length > 1 ? lines[lines.length - 1].length : col + consumed.length;
        i = end + 2;
        continue;
      }
      state = 'string';
      startLine = line;
      startCol = col;
      col++;
      continue;
    }
    if (c === "'") {
      state = 'char';
      startLine = line;
      startCol = col;
      col++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth < 0 && !unmatchedClose) unmatchedClose = { line, character: col };
    }
    col++;
  }

  if (state === 'block') unterminated ??= { line: startLine, character: startCol, what: 'comment' };
  if (state === 'string' || state === 'char') {
    unterminated ??= { line: startLine, character: startCol, what: state };
  }

  return { unterminated, depth, unmatchedClose, lastLine: line };
}

/** The identifier the caret is inside, or an empty string. */
function wordAt(text: string, line: number, character: number): string {
  const lines = text.split('\n');
  const target = lines[line] ?? '';
  const upto = target.slice(0, character);
  const m = /[A-Za-z_$][\w$]*$/.exec(upto);
  if (!m) return '';
  const after = /^[\w$]*/.exec(target.slice(character))?.[0] ?? '';
  return m[0] + after;
}

export class LexicalFallback implements FallbackProvider {
  readonly kind = 'lexical' as const;
  readonly note: string;
  private readonly declarations: RegExp | undefined;

  constructor(private readonly spec: LexicalFallbackSpec) {
    this.note = spec.note ?? 'lexical analysis only — no language server is available';
    this.declarations = spec.declarationPattern
      ? new RegExp(spec.declarationPattern, 'g')
      : undefined;
  }

  /** Declarations found in the buffer, as `name → detail`. */
  private declared(text: string): Map<string, string> {
    const found = new Map<string, string>();
    if (!this.declarations) return found;
    // `matchAll` on a shared global regex would carry `lastIndex`; rebuild each
    // call so two concurrent requests cannot corrupt each other's position.
    const re = new RegExp(this.declarations.source, 'g');
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (!name) continue;
      const keyword = /^\s*([A-Za-z_]+)/.exec(m[0])?.[1] ?? 'symbol';
      found.set(name, `${keyword} declared in this file`);
    }
    return found;
  }

  completions(ctx: FallbackContext): FallbackCompletion[] {
    const prefix = wordAt(ctx.text, ctx.line, ctx.character).toLowerCase();
    const out: FallbackCompletion[] = [];
    const seen = new Set<string>();
    const push = (label: string, kind: number, detail: string): void => {
      if (seen.has(label)) return;
      if (prefix && !label.toLowerCase().startsWith(prefix)) return;
      seen.add(label);
      out.push({ label, kind, detail });
    };

    for (const [name, detail] of this.declared(ctx.text)) push(name, 7, detail);
    for (const t of this.spec.types ?? []) push(t, 7, 'type');
    for (const k of this.spec.keywords ?? []) push(k, 14, 'keyword');

    // Identifiers already in the buffer: enough to finish the name you started
    // typing, which is most of what a keyword list is good for.
    const words = new Set(ctx.text.match(/[A-Za-z_$][\w$]*/g) ?? []);
    for (const w of words) push(w, 13, 'in this file');

    return out.slice(0, MAX_COMPLETIONS);
  }

  diagnostics(ctx: FallbackContext): FallbackDiagnostic[] {
    const scan = scanText(ctx.text);
    const out: FallbackDiagnostic[] = [];
    if (scan.unterminated) {
      const what = scan.unterminated.what === 'comment' ? 'block comment' : `${scan.unterminated.what} literal`;
      out.push({
        line: scan.unterminated.line,
        character: scan.unterminated.character,
        endLine: scan.unterminated.line,
        endCharacter: scan.unterminated.character + 1,
        severity: 1,
        message: `unterminated ${what}`,
        source: 'lexical',
      });
    }
    if (scan.depth > 0) {
      out.push({
        line: scan.lastLine,
        character: 0,
        endLine: scan.lastLine,
        endCharacter: 1,
        severity: 1,
        message: `${scan.depth} unclosed '{'`,
        source: 'lexical',
      });
    } else if (scan.depth < 0 && scan.unmatchedClose) {
      out.push({
        line: scan.unmatchedClose.line,
        character: scan.unmatchedClose.character,
        endLine: scan.unmatchedClose.line,
        endCharacter: scan.unmatchedClose.character + 1,
        severity: 1,
        message: "unexpected '}'",
        source: 'lexical',
      });
    }
    return out;
  }

  hover(ctx: FallbackContext): string | undefined {
    const word = wordAt(ctx.text, ctx.line, ctx.character);
    if (!word) return undefined;
    const declared = this.declared(ctx.text).get(word);
    if (declared) return `**${word}** — ${declared} (lexical fallback)`;
    if ((this.spec.keywords ?? []).includes(word)) return `**${word}** — keyword (lexical fallback)`;
    if ((this.spec.types ?? []).includes(word)) return `**${word}** — type (lexical fallback)`;
    return undefined;
  }
}

/** A provider that answers nothing, for plugins that want no fallback at all. */
export class EmptyFallback implements FallbackProvider {
  readonly kind = 'text' as const;
  readonly note = 'no fallback available';
  completions(): FallbackCompletion[] {
    return [];
  }
  diagnostics(): FallbackDiagnostic[] {
    return [];
  }
  hover(): string | undefined {
    return undefined;
  }
}
