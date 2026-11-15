/**
 * Handlers for the five navigation requests.
 *
 * Each one is the same three lines of glue: read the position, ask the
 * workspace, shape the reply. The interesting part is what happens when the
 * answer is "this server cannot do that" — every reply carries `unsupported`
 * instead of an empty list, because the panel must not render "install gopls"
 * as "no matches found".
 */
import type { WorkspaceService } from '../WorkspaceService.js';
import type { NavAction, NavEdit, NavLocation, NavSymbol } from '../PanelHub.js';
import { SYMBOL_KINDS, type CodeAction, type Location, type SymbolInformation, type TextEdit } from '../../lsp/navigation.js';
import { asLanguage } from './languages.js';

type Reply = (payload: unknown) => void;

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

/** LSP `Location` → the flat wire shape (line/character, not nested ranges). */
const toNavLocation = (l: Location): NavLocation => ({
  uri: l.uri,
  line: l.range.start.line,
  character: l.range.start.character,
});

const toNavEdit = (e: TextEdit): NavEdit => ({
  uri: e.uri,
  line: e.range.start.line,
  character: e.range.start.character,
  endLine: e.range.end.line,
  endCharacter: e.range.end.character,
  newText: e.newText,
});

const toNavAction = (a: CodeAction): NavAction => ({
  title: a.title,
  ...(a.kind ? { kind: a.kind } : {}),
  ...(a.edits?.length ? { edits: a.edits.map(toNavEdit) } : {}),
});

const toNavSymbol = (s: SymbolInformation): NavSymbol => ({
  name: s.name,
  kind: SYMBOL_KINDS[s.kind] ?? 'symbol',
  uri: s.uri,
  line: s.line,
  ...(s.containerName ? { containerName: s.containerName } : {}),
});

export async function handleDefinition(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: Reply,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const requestId = asNumber(msg.requestId);
  try {
    const r = await workspace.definition(language, asString(msg.code), asNumber(msg.line), asNumber(msg.character));
    reply(
      r.ok
        ? { kind: 'definitionResult', requestId, locations: r.value.map(toNavLocation) }
        : { kind: 'definitionResult', requestId, locations: [], unsupported: r.reason },
    );
  } catch (err) {
    reply({ kind: 'error', language, message: `definition failed: ${(err as Error).message}` });
  }
}

export async function handleReferences(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: Reply,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const requestId = asNumber(msg.requestId);
  const includeDeclaration = msg.includeDeclaration !== false;
  try {
    const r = await workspace.references(
      language,
      asString(msg.code),
      asNumber(msg.line),
      asNumber(msg.character),
      includeDeclaration,
    );
    if (!r.ok) {
      reply({ kind: 'referencesResult', requestId, locations: [], unsupported: r.reason });
      return;
    }
    // A server may return thousands of hits; the panel shows the first page and
    // the frame says so rather than pretending the list is complete.
    const MAX = 500;
    const locations = r.value.slice(0, MAX).map(toNavLocation);
    reply({
      kind: 'referencesResult',
      requestId,
      locations,
      ...(r.value.length > MAX ? { truncated: true } : {}),
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `references failed: ${(err as Error).message}` });
  }
}

export async function handleRenameSymbol(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: Reply,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const requestId = asNumber(msg.requestId);
  const newName = asString(msg.newName).trim();
  if (!newName) {
    reply({ kind: 'renameResult', requestId, edits: [], unsupported: 'a new name is required' });
    return;
  }
  try {
    const r = await workspace.renameSymbol(
      language,
      asString(msg.code),
      asNumber(msg.line),
      asNumber(msg.character),
      newName,
    );
    reply(
      r.ok
        ? { kind: 'renameResult', requestId, edits: r.value.map(toNavEdit) }
        : { kind: 'renameResult', requestId, edits: [], unsupported: r.reason },
    );
  } catch (err) {
    reply({ kind: 'error', language, message: `rename failed: ${(err as Error).message}` });
  }
}

export async function handleCodeAction(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: Reply,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const requestId = asNumber(msg.requestId);
  try {
    const r = await workspace.codeActions(language, asString(msg.code), asNumber(msg.line), asNumber(msg.character));
    reply(
      r.ok
        ? { kind: 'codeActionResult', requestId, actions: r.value.map(toNavAction) }
        : { kind: 'codeActionResult', requestId, actions: [], unsupported: r.reason },
    );
  } catch (err) {
    reply({ kind: 'error', language, message: `code action failed: ${(err as Error).message}` });
  }
}

export async function handleWorkspaceSymbol(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: Reply,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const requestId = asNumber(msg.requestId);
  try {
    const r = await workspace.workspaceSymbols(language, asString(msg.query));
    if (!r.ok) {
      reply({ kind: 'workspaceSymbolResult', requestId, symbols: [], unsupported: r.reason });
      return;
    }
    const MAX = 200;
    const symbols = r.value.slice(0, MAX).map(toNavSymbol);
    reply({
      kind: 'workspaceSymbolResult',
      requestId,
      symbols,
      ...(r.value.length > MAX ? { truncated: true } : {}),
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `workspace symbol failed: ${(err as Error).message}` });
  }
}
