/**
 * The five navigation capabilities, in one shape.
 *
 * # Why a result type instead of a bare value
 *
 * "No results" and "this language server cannot do that" look identical if both
 * are an empty array, and they need different UI: one says "nothing here", the
 * other says "install gopls". `NavResult` keeps them apart, and the panel
 * renders the second as a note rather than an empty list — the same honesty the
 * existing `degradedNote` already applies to a missing server.
 *
 * # Why normalize here
 *
 * LSP is generous about shapes. `textDocument/definition` returns
 * `Location | Location[] | LocationLink[] | null`; `workspace/symbol` returns
 * `SymbolInformation[] | WorkspaceSymbol[] | null`. Every consumer would
 * otherwise need all four branches, so the branching lives here once.
 */

/** 0-based line/character, as LSP counts them. */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface TextEdit {
  uri: string;
  range: Range;
  newText: string;
}

export interface CodeAction {
  title: string;
  kind?: string;
  /** Absent for a command-only action (nothing to apply locally). */
  edits?: TextEdit[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  uri: string;
  line: number;
  containerName?: string;
}

export type NavFeature = 'definition' | 'references' | 'rename' | 'codeAction' | 'workspaceSymbol';

/**
 * Either a value, or a reason there is none.
 *
 * `unsupported` is the case the UI must not render as "no matches": the server
 * answered, but it does not implement the request (or the plugin never declared
 * the capability).
 */
export type NavResult<T> =
  | { ok: true; value: T }
  | { ok: false; unsupported: true; reason: string };

export const unsupported = <T>(reason: string): NavResult<T> => ({ ok: false, unsupported: true, reason });
export const supported = <T>(value: T): NavResult<T> => ({ ok: true, value });

/** LSP `SymbolKind` → a short label the panel can show. */
export const SYMBOL_KINDS: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enum-member',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'type-parameter',
};

/** `Location | Location[] | LocationLink[] | null` → `Location[]`. */
export function normalizeLocations(raw: unknown): Location[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: Location[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    // A LocationLink carries `targetUri`/`targetRange` instead of `uri`/`range`.
    const uri = typeof o.uri === 'string' ? o.uri : typeof o.targetUri === 'string' ? o.targetUri : undefined;
    const range = (o.range ?? o.targetSelectionRange ?? o.targetRange) as Range | undefined;
    if (!uri || !range || !range.start) continue;
    out.push({ uri, range });
  }
  return out;
}

/**
 * `WorkspaceEdit` → flat `TextEdit[]`.
 *
 * The LSP shape allows three levels (`changes`, `documentChanges`, annotated
 * text edits). Collapsing them here means the panel never has to know which one
 * a server chose.
 */
export function normalizeWorkspaceEdit(raw: unknown): TextEdit[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const out: TextEdit[] = [];

  const changes = o.changes;
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    for (const [uri, edits] of Object.entries(changes as Record<string, unknown>)) {
      if (!Array.isArray(edits)) continue;
      for (const e of edits) {
        const edit = e as Record<string, unknown>;
        if (edit && typeof edit.newText === 'string' && edit.range) {
          out.push({ uri, range: edit.range as Range, newText: edit.newText });
        }
      }
    }
  }

  const documentChanges = o.documentChanges;
  if (Array.isArray(documentChanges)) {
    for (const change of documentChanges) {
      const c = change as Record<string, unknown>;
      // A create/rename/delete operation has `kind` and no `edits`.
      const uri = (c.textDocument as { uri?: string } | undefined)?.uri;
      if (!uri || !Array.isArray(c.edits)) continue;
      for (const e of c.edits) {
        const edit = e as Record<string, unknown>;
        if (edit && typeof edit.newText === 'string' && edit.range) {
          out.push({ uri, range: edit.range as Range, newText: edit.newText });
        }
      }
    }
  }
  return out;
}

/** `CodeAction[] | Command[] | null` → the actions that carry an edit. */
export function normalizeCodeActions(raw: unknown): CodeAction[] {
  if (!Array.isArray(raw)) return [];
  const out: CodeAction[] = [];
  for (const item of raw) {
    const o = item as Record<string, unknown>;
    if (!o || typeof o.title !== 'string') continue;
    // A bare Command has `command` and no `edit`; keep it visible but inert.
    const edits = normalizeWorkspaceEdit(o.edit);
    out.push({
      title: o.title,
      kind: typeof o.kind === 'string' ? o.kind : undefined,
      ...(edits.length ? { edits } : {}),
    });
  }
  return out;
}

/** `SymbolInformation[] | WorkspaceSymbol[] | null` → flat symbols. */
export function normalizeSymbols(raw: unknown): SymbolInformation[] {
  if (!Array.isArray(raw)) return [];
  const out: SymbolInformation[] = [];
  for (const item of raw) {
    const o = item as Record<string, unknown>;
    if (!o || typeof o.name !== 'string') continue;
    const uri = typeof o.location === 'object' ? (o.location as { uri?: string })?.uri : undefined;
    const range = typeof o.location === 'object' ? ((o.location as { range?: Range })?.range ?? undefined) : undefined;
    if (!uri) continue;
    out.push({
      name: o.name,
      kind: typeof o.kind === 'number' ? o.kind : 13,
      uri,
      line: range?.start?.line ?? 0,
      ...(typeof o.containerName === 'string' && o.containerName ? { containerName: o.containerName } : {}),
    });
  }
  return out;
}

/**
 * True when the initialize result says the server implements `feature`.
 *
 * `undefined` counts as "not declared": LSP only requires a server to advertise
 * what it supports, and guessing would turn a missing capability into a
 * confusing empty result.
 */
export function declaresFeature(capabilities: Record<string, unknown>, feature: NavFeature): boolean {
  const key =
    feature === 'workspaceSymbol'
      ? 'workspaceSymbolProvider'
      : feature === 'codeAction'
        ? 'codeActionProvider'
        : `${feature}Provider`;
  const value = capabilities[key];
  return value !== undefined && value !== null && value !== false;
}
