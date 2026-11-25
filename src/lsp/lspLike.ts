/**
 * The slice of `LspClient` the panel actually uses.
 *
 * A slot used to hold a concrete `LspClient`, which meant every language got its
 * own process with no pooling, no fallback and no scheduling. The manager's
 * `ManagedLsp` provides the same surface but may be backed by a shared, pooled
 * client — or by nothing at all, in which case a lexical fallback answers.
 *
 * Declaring the surface structurally is what lets `WorkspaceService` stay
 * unchanged: it asks for a language server, not for a particular class.
 */
import type {
  CompletionItem,
  Diagnostic,
  DiagnosticsWait,
  Hover,
  Position,
  Range,
  ServerCapabilities,
} from './LspClient.js';
import type { CodeAction, FoldingRange, InlayHint, Location, NavResult, SignatureHelp, SymbolInformation, TextEdit } from './navigation.js';

export interface LspStatus {
  running: boolean;
  serverName: string;
  capabilities: number;
  logRecords: number;
  logLines: number;
}

export interface LspLike {
  readonly languageId: string;
  readonly serverName: string;
  readonly capabilities: ServerCapabilities;
  status(): LspStatus;
  diagnostics(uri: string): Diagnostic[];
  openDocument(uri: string, text: string, languageId?: string): Promise<Diagnostic[]>;
  changeDocument(uri: string, text: string, languageId?: string): void;
  waitForDiagnostics(uri: string, timeoutMs?: number): Promise<DiagnosticsWait>;
  completion(uri: string, position: Position, onId?: (id: number) => void): Promise<CompletionItem[]>;
  hover(uri: string, position: Position, onId?: (id: number) => void): Promise<Hover | null>;
  definition(uri: string, position: Position, onId?: (id: number) => void): Promise<NavResult<Location[]>>;
  references(
    uri: string,
    position: Position,
    includeDeclaration?: boolean,
    onId?: (id: number) => void,
  ): Promise<NavResult<Location[]>>;
  renameSymbol(uri: string, position: Position, newName: string): Promise<NavResult<TextEdit[]>>;
  formatting(
    uri: string,
    options?: { tabSize: number; insertSpaces: boolean },
    onId?: (id: number) => void,
  ): Promise<NavResult<TextEdit[]>>;
  codeActions(uri: string, range: Range, diagnostics?: unknown[]): Promise<NavResult<CodeAction[]>>;
  workspaceSymbols(query: string): Promise<NavResult<SymbolInformation[]>>;
  resolveCompletionItem(item: { label: string }): Promise<NavResult<{ documentation?: string; detail?: string }>>;
  signatureHelp(uri: string, position: Position, onId?: (id: number) => void): Promise<NavResult<SignatureHelp>>;
  /** Foldable spans; `unsupported` means the caller keeps its own finders. */
  foldingRanges(uri: string): Promise<NavResult<FoldingRange[]>>;
  /** Inline hints for `[fromLine, toLine]`; `unsupported` means none are drawn. */
  inlayHints(uri: string, fromLine: number, toLine: number): Promise<NavResult<InlayHint[]>>;
  stop(): Promise<void>;
}
