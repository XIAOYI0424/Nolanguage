/**
 * One pooled language server, plus the fallback that answers when it cannot.
 *
 * This is the object a slot holds. It presents the same surface as `LspClient`
 * (`LspLike`), so `WorkspaceService` needs no branch per language: it asks for a
 * language server and gets either a real one, a shared one, or a lexical answer.
 *
 * The three rules that matter here:
 *
 * 1. **Nothing spawns until a request arrives.** Construction is free; `start()`
 *    runs on the first `ready()`.
 * 2. **A request never waits longer than its budget.** jdtls can spend 40 s
 *    importing a Maven workspace; the keystroke that arrives at second 2 gets the
 *    fallback, and the server takes over when it is up.
 * 3. **A failed start is not retried per keystroke.** Without a backoff, a broken
 *    jdtls would be spawned once per character typed.
 */
import { EventEmitter } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { LspClient, type CompletionItem, type Diagnostic, type DiagnosticsWait, type Hover } from '../LspClient.js';
import type { LspLike, LspStatus } from '../lspLike.js';
import type { CodeAction, Location, NavResult, SignatureHelp, SymbolInformation, TextEdit } from '../navigation.js';
import { unsupported } from '../navigation.js';
import type { Kernel } from '../../kernel/Kernel.js';
import type { CacheValidator } from './CacheValidator.js';
import type { DiagnosticsBuffer } from './DiagnosticsBuffer.js';
import type { Scheduler } from './Scheduler.js';
import type { FallbackProvider, LanguagePlugin, Position } from './types.js';

/** 30 s: long enough that a broken server costs one spawn per half-minute. */
const RETRY_BACKOFF_MS = 30_000;

export interface ManagedDeps {
  kernel: Kernel;
  plugin: LanguagePlugin;
  root: string;
  scheduler: Scheduler;
  buffer: DiagnosticsBuffer;
  cache: CacheValidator;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /** Counters, kept by the manager so a reaped entry's history is not lost. */
  onStart?: (info: { ok: boolean; startMs: number }) => void;
  onCache?: (rebuilt: boolean) => void;
  onFallback?: () => void;
}

export interface StartInfo {
  started: boolean;
  startMs?: number;
  error?: string;
  /** True when the pool handed back an existing client instead of spawning. */
  reused: boolean;
  /** Signature the cache was validated against. */
  signature?: string;
  cacheRebuilt?: boolean;
  cacheReason?: string;
}

/** Resolve with `undefined` after `ms`, without cancelling the underlying work. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** Thrown when a request exceeded its budget, so the caller can fall back. */
class RequestTimeout extends Error {
  constructor(readonly method: string, readonly budgetMs: number) {
    super(`${method} exceeded ${budgetMs} ms`);
    this.name = 'RequestTimeout';
  }
}

type Budgeted<T> = { kind: 'value'; value: T } | { kind: 'timeout' } | { kind: 'error'; error: Error };

/**
 * Race a request against its budget, keeping the three outcomes apart.
 *
 * A plain `Promise.race` would collapse "timed out", "returned null" and "failed"
 * into one value, and those three need different answers: fallback, nothing, and
 * an error the user should see.
 */
function withBudget<T>(p: Promise<T>, ms: number): Promise<Budgeted<T>> {
  if (!(ms > 0)) return p.then((value) => ({ kind: 'value', value }), (error: Error) => ({ kind: 'error', error }));
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: 'value', value });
      },
      (error: Error) => {
        clearTimeout(timer);
        resolve({ kind: 'error', error });
      },
    );
  });
}

export class ManagedLsp extends EventEmitter implements LspLike {
  readonly languageId: string;
  readonly serverName: string;
  readonly plugin: LanguagePlugin;
  readonly root: string;
  /** Stable identity for scheduler keys and logs. */
  readonly key: string;

  private client?: LspClient;
  private starting?: Promise<void>;
  private startError?: string;
  private retryAt = 0;
  private info: StartInfo;
  private lastText = new Map<string, string>();
  private lastUsed = Date.now();
  private budgetMs = 500;
  /** Explicit actions get longer than a keystroke, but not forever. */
  private navBudgetMs = 5000;
  private closed = false;
  private fallbackCount = 0;

  constructor(private readonly deps: ManagedDeps) {
    super();
    this.plugin = deps.plugin;
    this.root = deps.root;
    this.languageId = deps.plugin.id;
    this.serverName = deps.plugin.lspConfig(deps.root)?.serverName ?? deps.plugin.id;
    this.key = `${deps.plugin.id}\u0000${deps.root}`;
    this.info = { started: false, reused: false };
    this.budgetMs = deps.plugin.lspConfig(deps.root)?.firstRequestBudgetMs ?? 500;
    this.navBudgetMs = deps.plugin.lspConfig(deps.root)?.navBudgetMs ?? 5000;
    // A dead server must not be reported as a live one by the status bar.
    this.on('serverExit', () => {
      this.client = undefined;
      this.info.started = false;
      this.startError = 'language server exited';
      this.retryAt = Date.now() + RETRY_BACKOFF_MS;
    });
  }

  get capabilities(): Record<string, unknown> {
    return this.client?.capabilities ?? {};
  }

  get isRunning(): boolean {
    return this.client?.isRunning ?? false;
  }

  /** Diagnostics, cache and pool facts for tests and the status bar. */
  describe(): StartInfo & { fallbacks: number; idleMs: number } {
    return { ...this.info, fallbacks: this.fallbackCount, idleMs: Date.now() - this.lastUsed };
  }

  touch(): void {
    this.lastUsed = Date.now();
  }

  /** Forward `$/cancelRequest`; false when the id is already answered. */
  cancelRequest(id: number): boolean {
    return this.client?.cancelRequest(id) ?? false;
  }

  /** URIs this entry has been given text for. */
  openDocuments(): string[] {
    return [...this.lastText.keys()];
  }

  /**
   * The server, if it is ready within `budgetMs`.
   *
   * Returns undefined rather than throwing: "not ready yet" is the normal state
   * for the first request after opening a project, and every caller answers from
   * the fallback in that case.
   */
  private async ready(): Promise<LspClient | undefined> {
    this.touch();
    if (this.client) return this.client;
    if (this.closed) return undefined;
    if (this.startError && Date.now() < this.retryAt) return undefined;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    await within(this.starting, this.budgetMs);
    return this.client;
  }

  /** Block until the server is up (tests and the first-open path). */
  async waitUntilReady(ms: number): Promise<boolean> {
    if (this.client) return true;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    await within(this.starting, ms);
    return !!this.client;
  }

  private async start(): Promise<void> {
    const cfg = this.plugin.lspConfig(this.root);
    if (!cfg) {
      this.startError = this.plugin.degradedNote ?? `${this.plugin.id}: no language server configured`;
      this.retryAt = Number.POSITIVE_INFINITY;
      this.deps.log?.(`${this.plugin.id}: no server — fallback only`, { reason: this.startError });
      return;
    }

    // Cache check first, and only then spawn: an index built by a different
    // server build is discarded before it can influence a single answer.
    const cache = await this.deps.cache.ensure(this.plugin, this.root).catch(() => undefined);
    if (cache) {
      this.info.signature = cache.metadata.signature;
      this.info.cacheRebuilt = cache.rebuilt;
      this.info.cacheReason = cache.reason;
      this.deps.onCache?.(cache.rebuilt);
      if (cache.rebuilt) {
        this.deps.log?.(`${this.plugin.id}: index invalidated — ${cache.reason}`, { signature: cache.metadata.signature.slice(0, 12) });
      }
    }

    const client = new LspClient({
      launch: {
        languageId: cfg.languageId,
        serverName: cfg.serverName,
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd ?? this.root,
        ...(cfg.env ? { env: cfg.env } : {}),
        ...(cfg.initializationOptions ? { initializationOptions: cfg.initializationOptions } : {}),
      },
      timeoutMs: cfg.startTimeoutMs && cfg.startTimeoutMs > 20_000 ? cfg.startTimeoutMs : 20_000,
    });

    const t0 = Date.now();
    try {
      const rootUri = pathToFileURL(this.root).href;
      await client.start(this.deps.kernel, rootUri);
      client.on('diagnostics', (payload: { uri: string; diagnostics: Diagnostic[] }) => {
        this.deps.buffer.set(payload.uri, payload.diagnostics);
        this.emit('diagnostics', payload);
      });
      client.on('serverExit', (code: number | null) => this.emit('serverExit', code));
      // Documents that arrived while the server was booting are opened now, so a
      // request that was answered by the fallback is not left out of the server's
      // world once it is up.
      for (const [uri, text] of this.lastText) {
        await client.openDocument(uri, text, this.languageId).catch(() => undefined);
      }
      this.client = client;
      this.startError = undefined;
      this.info = { ...this.info, started: true, startMs: Date.now() - t0, error: undefined };
      this.deps.onStart?.({ ok: true, startMs: this.info.startMs ?? 0 });
      this.deps.log?.(`${this.plugin.id}: ${cfg.serverName} ready`, { startMs: this.info.startMs, root: this.root });
    } catch (err) {
      this.startError = (err as Error).message;
      this.retryAt = Date.now() + RETRY_BACKOFF_MS;
      this.info = { ...this.info, started: false, error: this.startError, startMs: Date.now() - t0 };
      this.deps.onStart?.({ ok: false, startMs: this.info.startMs ?? 0 });
      await client.stop().catch(() => undefined);
      this.deps.log?.(`${this.plugin.id}: server failed to start`, { error: this.startError });
    }
  }

  private fallback(): FallbackProvider | undefined {
    return this.plugin.fallback();
  }

  private pathOf(uri: string): string {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  }

  private textOf(uri: string): string {
    return this.lastText.get(uri) ?? '';
  }

  private toDiagnostics(uri: string): Diagnostic[] {
    const fb = this.fallback();
    if (!fb) return [];
    return fb.diagnostics({ file: this.pathOf(uri), text: this.textOf(uri), line: 0, character: 0 }).map((d) => ({
      range: {
        start: { line: d.line, character: d.character },
        end: { line: d.endLine, character: d.endCharacter },
      },
      severity: d.severity,
      message: d.message,
      ...(d.source ? { source: d.source } : {}),
    }));
  }

  private fallbackCompletions(uri: string, position: Position): CompletionItem[] {
    const fb = this.fallback();
    if (!fb) return [];
    this.fallbackCount++;
    this.deps.onFallback?.();
    return fb.completions({ file: this.pathOf(uri), text: this.textOf(uri), line: position.line, character: position.character }).map((c) => ({
      label: c.label,
      ...(c.kind !== undefined ? { kind: c.kind } : {}),
      ...(c.detail ? { detail: c.detail } : {}),
    }));
  }

  // ---------------- document sync ----------------

  async openDocument(uri: string, text: string, languageId = this.languageId): Promise<Diagnostic[]> {
    this.lastText.set(uri, text);
    this.touch();
    if (!this.client) return this.toDiagnostics(uri);
    return this.client.openDocument(uri, text, languageId);
  }

  changeDocument(uri: string, text: string, languageId = this.languageId): void {
    this.lastText.set(uri, text);
    this.touch();
    this.client?.changeDocument(uri, text, languageId);
  }

  async waitForDiagnostics(uri: string, timeoutMs = 1500): Promise<DiagnosticsWait> {
    this.touch();
    // Check is an explicit action, so it may wait for a cold server — unlike a
    // keystroke. The caller passes its own budget, and the fallback answers when
    // that expires rather than reporting "no problems" for a server still
    // importing the project.
    if (!this.client) await this.waitUntilReady(timeoutMs);
    if (!this.client) {
      return { items: this.toDiagnostics(uri), published: false, source: 'fallback' };
    }
    const r = await this.client.waitForDiagnostics(uri, timeoutMs);
    this.deps.buffer.set(uri, r.items);
    return { ...r, source: 'lsp' };
  }

  diagnostics(uri: string): Diagnostic[] {
    return this.client ? this.client.diagnostics(uri) : this.toDiagnostics(uri);
  }

  status(): LspStatus {
    const caps = Object.keys(this.capabilities).length;
    const base = this.client?.status();
    return {
      running: base?.running ?? false,
      serverName: this.serverName,
      capabilities: caps,
      logRecords: base?.logRecords ?? 0,
      logLines: base?.logLines ?? 0,
    };
  }

  // ---------------- position-sensitive (latest-only) ----------------

  async completion(uri: string, position: Position): Promise<CompletionItem[]> {
    const client = await this.ready();
    if (!client) return this.fallbackCompletions(uri, position);
    try {
      const out = await this.deps.scheduler.latest(`${this.key}|completion|${uri}`, async (report) => {
        const r = await withBudget(client.completion(uri, position, report), this.budgetMs);
        if (r.kind === 'value') return r.value;
        if (r.kind === 'timeout') throw new RequestTimeout('textDocument/completion', this.budgetMs);
        throw r.error;
      });
      // A superseded answer is dropped rather than shown: that is the entire point
      // of latest-only, and the newer request is already on the wire.
      return out.stale ? [] : (out.value ?? []);
    } catch (err) {
      // jdtls spends tens of seconds importing a Maven reactor before it can
      // complete anything. Blocking a keystroke for that is worse than answering
      // from the fallback and switching over once the import finishes.
      if (err instanceof RequestTimeout) return this.fallbackCompletions(uri, position);
      throw err;
    }
  }

  async hover(uri: string, position: Position): Promise<Hover | null> {
    const client = await this.ready();
    if (!client) {
      const fb = this.fallback();
      const text = fb?.hover({ file: this.pathOf(uri), text: this.textOf(uri), line: position.line, character: position.character });
      if (!text) return null;
      this.fallbackCount++;
      this.deps.onFallback?.();
      return { contents: { value: text } };
    }
    try {
      const out = await this.deps.scheduler.latest(`${this.key}|hover|${uri}`, async (report) => {
        const r = await withBudget(client.hover(uri, position, report), this.budgetMs);
        if (r.kind === 'value') return r.value;
        if (r.kind === 'timeout') throw new RequestTimeout('textDocument/hover', this.budgetMs);
        throw r.error;
      });
      return out.stale ? null : (out.value ?? null);
    } catch (err) {
      if (err instanceof RequestTimeout) return null;
      throw err;
    }
  }

  // ---------------- explicit actions (deduped, never cancelled) ----------------

  async definition(uri: string, position: Position): Promise<NavResult<Location[]>> {
    const client = await this.ready();
    if (!client) return unsupported<Location[]>(this.startError ?? this.plugin.degradedNote ?? 'no language server');
    const out = await this.deps.scheduler.dedupe(`${this.key}|definition|${uri}|${position.line}:${position.character}`, () =>
      withBudget(client.definition(uri, position), this.navBudgetMs),
    );
    if (out.kind === 'timeout') return unsupported<Location[]>(`definition timed out after ${this.navBudgetMs} ms`);
    if (out.kind === 'error') return unsupported<Location[]>(out.error.message);
    return out.value;
  }

  async references(uri: string, position: Position, includeDeclaration = true): Promise<NavResult<Location[]>> {
    const client = await this.ready();
    if (!client) return unsupported<Location[]>(this.startError ?? this.plugin.degradedNote ?? 'no language server');
    return this.deps.scheduler.dedupe(`${this.key}|references|${uri}|${position.line}:${position.character}`, () =>
      client.references(uri, position, includeDeclaration),
    );
  }

  async renameSymbol(uri: string, position: Position, newName: string): Promise<NavResult<TextEdit[]>> {
    const client = await this.ready();
    if (!client) return unsupported<TextEdit[]>(this.startError ?? this.plugin.degradedNote ?? 'no language server');
    return client.renameSymbol(uri, position, newName);
  }

  async formatting(
    uri: string,
    options: { tabSize: number; insertSpaces: boolean } = { tabSize: 4, insertSpaces: true },
  ): Promise<NavResult<TextEdit[]>> {
    const client = await this.ready();
    if (!client) return unsupported<TextEdit[]>(this.startError ?? this.plugin.degradedNote ?? 'no language server');
    const out = await this.deps.scheduler.dedupe(`${this.key}|format|${uri}`, () =>
      withBudget(client.formatting(uri, options), this.navBudgetMs),
    );
    if (out.kind === 'timeout') return unsupported<TextEdit[]>(`formatting timed out after ${this.navBudgetMs} ms`);
    if (out.kind === 'error') return unsupported<TextEdit[]>(out.error.message);
    return out.value;
  }

  async codeActions(uri: string, range: { start: Position; end: Position }, diagnostics: unknown[] = []): Promise<NavResult<CodeAction[]>> {
    const client = await this.ready();
    if (!client) return unsupported<CodeAction[]>(this.startError ?? this.plugin.degradedNote ?? 'no language server');
    return client.codeActions(uri, range, diagnostics);
  }

  async workspaceSymbols(query: string): Promise<NavResult<SymbolInformation[]>> {
    const client = await this.ready();
    if (!client) return unsupported<SymbolInformation[]>(this.startError ?? this.plugin.degradedNote ?? 'no language server');
    return this.deps.scheduler.dedupe(`${this.key}|symbols|${query}`, () => client.workspaceSymbols(query));
  }

  async resolveCompletionItem(item: { label: string }): Promise<NavResult<{ documentation?: string; detail?: string }>> {
    const client = await this.ready();
    if (!client) return unsupported('no language server');
    return client.resolveCompletionItem(item);
  }

  async signatureHelp(uri: string, position: Position): Promise<NavResult<SignatureHelp>> {
    const client = await this.ready();
    if (!client) return unsupported<SignatureHelp>(this.startError ?? this.plugin.degradedNote ?? 'no language server');
    const out = await this.deps.scheduler.dedupe(`${this.key}|signature|${uri}|${position.line}:${position.character}`, () =>
      withBudget(client.signatureHelp(uri, position), this.navBudgetMs),
    );
    if (out.kind === 'timeout') return unsupported<SignatureHelp>(`signature help timed out after ${this.navBudgetMs} ms`);
    if (out.kind === 'error') return unsupported<SignatureHelp>(out.error.message);
    return out.value;
  }

  // ---------------- lifecycle ----------------

  /** Stop the server but keep the object: the next request may restart it. */
  async stopServer(reason = 'idle'): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.info.started = false;
    if (!client) return;
    this.deps.log?.(`${this.plugin.id}: stopping server`, { reason, root: this.root });
    await client.stop().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.stopServer('closed');
    this.lastText.clear();
    this.removeAllListeners();
  }
}
