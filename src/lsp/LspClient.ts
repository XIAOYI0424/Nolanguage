/**
 * LSP client (spec 阶段 3 · 单语言闭环).
 *
 * Owns one language-server child process and speaks real LSP over stdio:
 *   initialize → initialized → didOpen → completion / hover / diagnostics
 *   → shutdown → exit
 *
 * Two things are instrumented (spec 阶段 3):
 *  - **RPC 埋点**: every roundtrip is timed into `rpc.roundtrip.<method>` and
 *    wrapped in a span, so latency is visible in the perf panel and the panel's
 *    slow-path capture picks up slow LSP calls automatically.
 *  - **LSP 日志采集**: stderr/stdout are piped through `LspLogCollector` and
 *    become structured `language-server` log records.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { planSpawn } from '../util/spawnPlan.js';
import { killTree } from '../util/killTree.js';
import { performance } from 'node:perf_hooks';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { JsonRpcConnection, type JsonRpcMessage } from './jsonrpc.js';
import { LspLogCollector, type LspLogStats } from './LspLogCollector.js';
import { embeddedAssetPath } from '../assets/embeddedAssets.js';
import {
  declaresFeature,
  normalizeCodeActions,
  normalizeLocations,
  normalizeSymbols,
  normalizeFoldingRanges,
  normalizeInlayHints,
  normalizeSignatureHelp,
  normalizeWorkspaceEdit,
  supported,
  unsupported,
  type CodeAction,
  type FoldingRange,
  type InlayHint,
  type Location,
  type NavFeature,
  type NavResult,
  type SignatureHelp,
  type SymbolInformation,
  type TextEdit,
} from './navigation.js';
import type { Kernel } from '../kernel/Kernel.js';
import type { Logger } from '../log/Logger.js';

// ---------------- LSP protocol subset ----------------

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
}

/** Result of a diagnostic wait: the latest published set, and whether it was fresh. */
export interface DiagnosticsWait {
  items: Diagnostic[];
  published: boolean;
  /**
   * Who produced the items. `fallback` means no language server answered and a
   * lexical provider did — the panel must not label those "from the server".
   */
  source?: 'lsp' | 'fallback';
}
export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  /** What accepting the item inserts. Often differs from `label` (`get(url, x)`). */
  insertText?: string;
  /** Server's ranking key; alphabetically sorting `label` throws it away. */
  sortText?: string;
  /** Key the fuzzy filter should match against, when it differs from `label`. */
  filterText?: string;
}
export interface Hover {
  contents: string | { value: string } | Array<string | { value: string }>;
  range?: Range;
}
export interface ServerCapabilities {
  completionProvider?: { triggerCharacters?: string[] };
  hoverProvider?: boolean | Record<string, unknown>;
  textDocumentSync?: number | Record<string, unknown>;
  [k: string]: unknown;
}

export interface LspLaunchSpec {
  languageId: string;
  command: string;
  args: string[];
  /** Human label for the panel/logs, e.g. `pyright`. */
  serverName: string;
  cwd?: string;
  /**
   * Extra environment for the server process.
   *
   * Some servers are not self-contained: gopls shells out to the `go` tool, so
   * it needs the toolchain's bin dir on PATH (and GOROOT). Without this, a
   * gopls launched from a process whose PATH lacks Go starts fine but answers
   * every request with "no active builds contain <file>".
   */
  env?: Record<string, string>;
  /**
   * `initialize.initializationOptions`, passed through verbatim.
   *
   * Servers that need configuration before they will do anything useful take it
   * here — jdtls decides whether to import a whole Maven workspace from
   * `settings.java.import.mode`. The engine used to hardcode `{}`, which made
   * every such server run with defaults no plugin could change.
   */
  initializationOptions?: Record<string, unknown>;
}

export interface LspClientOptions {
  /**
   * The server to launch. Required: this client used to default to
   * `discoverPythonServer()` when it was missing, so a caller that forgot the
   * spec silently started a Python server regardless of the language.
   */
  launch: LspLaunchSpec;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Diagnostics threshold for the `lsp.diagnostic` warning. */
  slowDiagnosticMs?: number;
}

export interface LspClientEvents {
  diagnostics: (params: { uri: string; diagnostics: Diagnostic[] }) => void;
  serverExit: (code: number | null) => void;
}

export class LspClient extends EventEmitter {
  readonly languageId: string;
  readonly serverName: string;
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: JsonRpcConnection;
  private logCollector?: LspLogCollector;
  private logger?: Logger;
  private kernel?: Kernel;
  private opts: LspClientOptions;
  private launch: LspLaunchSpec;
  private _capabilities: ServerCapabilities = {};
  private diagnosticsByUri = new Map<string, Diagnostic[]>();
  private openVersions = new Map<string, number>();
  private openUris = new Set<string>();
  /** Monotonic count of publishDiagnostics notifications (freshness tracking). */
  private publishCount = 0;
  private startedAt = 0;
  private stopped = false;

  constructor(opts: LspClientOptions) {
    super();
    this.opts = opts;
    this.launch = opts.launch;
    this.languageId = opts.launch.languageId;
    this.serverName = opts.launch.serverName ?? opts.launch.languageId;
  }

  get capabilities(): ServerCapabilities {
    return this._capabilities;
  }

  get isRunning(): boolean {
    return !!this.child && !this.stopped && this.child.exitCode === null;
  }

  get logStats(): LspLogStats | undefined {
    return this.logCollector?.stats;
  }

  /** Summary for the UI status bar. */
  status(): {
    running: boolean;
    serverName: string;
    capabilities: number;
    logRecords: number;
    logLines: number;
  } {
    return {
      running: this.isRunning,
      serverName: this.serverName,
      capabilities: Object.keys(this._capabilities).length,
      logRecords: this.logCollector?.stats.records ?? 0,
      logLines: this.logCollector?.stats.lines ?? 0,
    };
  }

  diagnostics(uri: string): Diagnostic[] {
    return this.diagnosticsByUri.get(diagnosticKey(uri)) ?? [];
  }

  /**
   * Start the language server and complete the LSP initialize handshake.
   * `kernel` supplies the perf spine (RPC instrumentation) and log factory.
   */
  async start(kernel: Kernel, rootUri: string): Promise<ServerCapabilities> {
    this.kernel = kernel;
    // Resolve the launch spec once into a non-optional local so the rest of the
    // method reads cleanly and cannot race on `this.launch`.
    const launch = this.launch;
    launch.cwd ??= process.cwd();
    this.launch = launch;
    this.logger = kernel.logger.forLanguageServer(this.languageId, `lsp.${launch.serverName}`);

    const span = kernel.tracer.startSpan('lsp.start', {
      attributes: { server: launch.serverName, command: launch.command },
    });
    const log = this.logger.span(span);
    log.info('Starting language server', {
      command: launch.command,
      args: launch.args.join(' '),
      cwd: launch.cwd,
    });

    const t0 = performance.now();
    // Resolve the command the way a shell would before spawning it. Every
    // npm-installed language server on Windows — `typescript-language-server`,
    // `pyright-langserver`, `vscode-json-languageserver` — is a `.cmd` shim, and
    // `spawn` cannot start one: a bare name gives ENOENT (CreateProcess ignores
    // PATHEXT) and the `.cmd` itself gives EINVAL (it is a script for cmd.exe,
    // not an image). The MCP client already learned this; the plan is shared.
    const plan = planSpawn(launch.command, launch.args, { PATH: launch.env?.PATH ?? process.env.PATH });
    this.child = spawn(plan.command, plan.args, {
      cwd: launch.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...(launch.env ?? {}) },
      windowsHide: true,
      shell: plan.shell,
    }) as ChildProcessWithoutNullStreams;

    this.child.on('error', (err) => {
      log.error('Language server failed to spawn', { command: launch.command }, err);
    });
    this.child.on('exit', (code) => {
      const ms = performance.now() - t0;
      log.warn('Language server exited', { code, uptimeMs: Math.round(ms) });
      this.emit('serverExit', code);
    });

    // ---- LSP log collection ----
    // stderr is the language server's log channel: parse it into structured
    // records (spec 18.2 · LspLogCollector).
    //
    // stdout is NOT a log channel — it is the JSON-RPC transport itself. We only
    // attach a stdout collector when explicitly debugging (LSP_TRACE_STDOUT=1),
    // otherwise the framed `Content-Length: …` protocol bytes would be logged
    // as if they were server diagnostics.
    this.logCollector = new LspLogCollector(this.logger, {
      languageId: this.languageId,
      component: `lsp.${launch.serverName}`,
      stream: 'stderr',
    });
    this.child.stderr.on('data', (c: Buffer) => this.logCollector!.write(c));
    if (process.env.LSP_TRACE_STDOUT === '1') {
      const stdoutCollector = new LspLogCollector(this.logger, {
        languageId: this.languageId,
        component: `lsp.${launch.serverName}.stdout`,
        stream: 'stdout',
      });
      this.child.stdout.on('data', (c: Buffer) => stdoutCollector.write(c));
    }

    // ---- RPC with instrumentation (spec 阶段 3: RPC 埋点) ----
    this.rpc = new JsonRpcConnection(this.child.stdin, this.child.stdout, {
      timeoutMs: this.opts.timeoutMs ?? 20_000,
      hooks: {
        onRoundtrip: ({ method, durationMs, ok, traceId }) => this.recordRpc(method, durationMs, ok, traceId),
        resolveTraceId: () => kernel.tracer.currentSpan()?.traceId,
        onNotify: (method) => {
          kernel.perfMetrics().record(`rpc.notify.${method}`, 0);
        },
        onInbound: (msg) => this.handleInbound(msg),
      },
    });
    // Note: stdout is consumed by the RPC parser above; it is not a log channel.

    this.startedAt = performance.now();

    const initResult = await this.rpc.request<{ capabilities: ServerCapabilities; serverInfo?: { name?: string; version?: string } }>(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'nolanguage', version: kernel.appVersion },
        rootUri,
        // `rootPath` is deprecated but gopls still consults it, and the
        // workspace-folders form is what makes gopls associate opened files
        // with a build. Without it gopls answers every request with
        // "no active builds contain <file>".
        rootPath: rootUri.startsWith('file://') ? fileURLToPath(rootUri) : null,
        workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
        capabilities: {
          textDocument: {
            completion: { completionItem: { snippetSupport: true } },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            synchronization: { didSave: true },
            publishDiagnostics: { relatedInformation: true },
          },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
        },
        initializationOptions: launch.initializationOptions ?? {},
      },
    );
    this._capabilities = initResult.capabilities ?? {};
    this.rpc.notify('initialized', {});
    kernel.perfMetrics().record('lsp.start', performance.now() - t0);

    log.info('Language server initialized', {
      server: initResult.serverInfo?.name ?? launch.serverName,
      version: initResult.serverInfo?.version,
      startMs: Math.round(performance.now() - t0),
      capabilities: Object.keys(this._capabilities).length,
    });
    span.end();
    return this._capabilities;
  }

  /** Send textDocument/didOpen. Returns the diagnostics if the server pushed any synchronously. */
  async openDocument(uri: string, text: string, languageId = this.languageId): Promise<Diagnostic[]> {
    this.requireRpc().notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.openVersions.set(uri, 1);
    this.openUris.add(uri);
    // Give the server a moment to publish diagnostics (push model).
    await delay(30);
    return this.diagnostics(uri);
  }

  /**
   * Send textDocument/didChange for an already-open document, bumping the
   * version. Falls back to didOpen if the document was never opened.
   */
  changeDocument(uri: string, text: string, languageId = this.languageId): void {
    if (!this.openUris.has(uri)) {
      void this.openDocument(uri, text, languageId);
      return;
    }
    const version = (this.openVersions.get(uri) ?? 1) + 1;
    this.openVersions.set(uri, version);
    this.requireRpc().notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /**
   * Resolve with the diagnostics for `uri` as soon as the server publishes a
   * **fresh** set, or with the cached value when `timeoutMs` elapses.
   *
   * Waiting for a new publish (rather than returning the cache immediately) is
   * what makes "Check" correct when the buffer just changed — otherwise a stale
   * result from a previous edit could be reported as current.
   *
   * The returned `published` flag distinguishes "the server answered and found
   * nothing" from "the server never answered" — a cold gopls loading a package
   * for the first time can need longer than one wait, and an empty answer must
   * not be mistaken for a clean bill of health.
   */
  waitForDiagnostics(uri: string, timeoutMs = 1500): Promise<DiagnosticsWait> {
    const before = this.publishCount;
    return new Promise<DiagnosticsWait>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('diagnostics', handler);
        resolve({
          items: this.diagnosticsByUri.get(diagnosticKey(uri)) ?? [],
          published: this.publishCount > before,
        });
      };
      const handler = (p: { uri: string; diagnostics: Diagnostic[] }): void => {
        if (diagnosticKey(p.uri) === diagnosticKey(uri) && this.publishCount > before) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.on('diagnostics', handler);
    });
  }

  async completion(uri: string, position: Position, onId?: (id: number) => void): Promise<CompletionItem[]> {
    const span = this.kernel?.tracer.startSpan('lsp.completion', {
      attributes: { fileUri: uri, line: position.line },
    });
    const log = this.logger?.span(span!).withScope({ fileUri: uri, line: position.line });
    log?.debug('Requesting completion', { character: position.character });
    const t0 = performance.now();
    try {
      const res = await this.requireRpc().request<
        CompletionItem[] | { items: CompletionItem[] } | null
      >('textDocument/completion', {
        textDocument: { uri },
        position,
        context: { triggerKind: 1 },
      }, onId);
      const ms = performance.now() - t0;
      const items = Array.isArray(res) ? res : (res?.items ?? []);
      this.kernel?.perfMetrics().record('lsp.completion', ms);
      this.kernel?.perfMetrics().record('lsp.completion.items', items.length);
      if (ms > 100) {
        log?.warn('Slow completion', { durationMs: Math.round(ms), items: items.length, file: uri });
      } else {
        log?.debug('Completion served', { durationMs: Math.round(ms), items: items.length });
      }
      span?.setAttribute('items', items.length).end();
      return items;
    } catch (err) {
      span?.recordException(err as Error);
      span?.end();
      log?.error('Completion failed', { file: uri }, err as Error);
      throw err;
    }
  }

  async hover(uri: string, position: Position, onId?: (id: number) => void): Promise<Hover | null> {
    const t0 = performance.now();
    const res = await this.requireRpc().request<Hover | null>('textDocument/hover', {
      textDocument: { uri },
      position,
    }, onId);
    this.kernel?.perfMetrics().record('lsp.hover', performance.now() - t0);
    return res;
  }

  // ---------------- navigation (definition / references / rename / actions) ----------------

  /**
   * One place for the four failure modes these five requests share:
   * not advertised, not implemented, a real RPC error, and success.
   *
   * `unsupported` is returned rather than thrown because "this server cannot do
   * that" is a normal answer — the panel shows the reason instead of an empty
   * list, which would read as "nothing found".
   */
  private async nav<T>(
    feature: NavFeature,
    method: string,
    params: unknown,
    normalize: (raw: unknown) => T,
    onId?: (id: number) => void,
  ): Promise<NavResult<T>> {
    if (!declaresFeature(this._capabilities as Record<string, unknown>, feature)) {
      return unsupported<T>(`${this.serverName} does not advertise ${feature}`);
    }
    const t0 = performance.now();
    try {
      const raw = await this.requireRpc().request<unknown>(method, params, onId);
      this.kernel?.perfMetrics().record(`lsp.${feature}`, performance.now() - t0);
      return supported(normalize(raw));
    } catch (err) {
      const code = (err as { rpcCode?: number }).rpcCode;
      if (code === -32601) return unsupported<T>(`${this.serverName} does not implement ${method}`);
      throw err;
    }
  }

  definition(uri: string, position: Position, onId?: (id: number) => void): Promise<NavResult<Location[]>> {
    return this.nav('definition', 'textDocument/definition', { textDocument: { uri }, position }, normalizeLocations, onId);
  }

  references(
    uri: string,
    position: Position,
    includeDeclaration = true,
    onId?: (id: number) => void,
  ): Promise<NavResult<Location[]>> {
    return this.nav(
      'references',
      'textDocument/references',
      { textDocument: { uri }, position, context: { includeDeclaration } },
      normalizeLocations,
      onId,
    );
  }

  async renameSymbol(uri: string, position: Position, newName: string): Promise<NavResult<TextEdit[]>> {
    const r = await this.nav('rename', 'textDocument/rename', { textDocument: { uri }, position, newName }, normalizeWorkspaceEdit);
    // LSP answers `null` for "this symbol cannot be renamed" (a keyword, a
    // builtin, an invalid new name). That is not the same as "nothing to change"
    // and must not render as an empty result the user cannot explain.
    if (r.ok && r.value.length === 0) return unsupported('the server cannot rename this symbol');
    return r;
  }

  /**
   * `textDocument/formatting` — the whole document, as edits to apply.
   *
   * Deliberately a `NavResult`: a server that does not implement formatting and
   * a server that returns "no changes needed" must stay distinguishable, or the
   * client cannot tell whether to fall back to its own indenter.
   */
  formatting(
    uri: string,
    options: { tabSize: number; insertSpaces: boolean } = { tabSize: 4, insertSpaces: true },
    onId?: (id: number) => void,
  ): Promise<NavResult<TextEdit[]>> {
    return this.nav(
      'format',
      'textDocument/formatting',
      { textDocument: { uri }, options },
      (raw) => (Array.isArray(raw) ? (raw as TextEdit[]) : []),
      onId,
    );
  }

  codeActions(uri: string, range: Range, diagnostics: unknown[] = []): Promise<NavResult<CodeAction[]>> {
    return this.nav(
      'codeAction',
      'textDocument/codeAction',
      { textDocument: { uri }, range, context: { diagnostics } },
      normalizeCodeActions,
    );
  }

  workspaceSymbols(query: string): Promise<NavResult<SymbolInformation[]>> {
    return this.nav('workspaceSymbol', 'workspace/symbol', { query }, normalizeSymbols);
  }

  /**
   * Ask the server for one completion item's details.
   *
   * Inline `documentation` in the list frame would be tens of kilobytes per
   * keystroke; this costs one round trip, and only for the row the user is
   * looking at.
   */
  async resolveCompletionItem(item: { label: string }): Promise<NavResult<{ documentation?: string; detail?: string }>> {
    const caps = this._capabilities as Record<string, unknown>;
    const provider = caps.completionProvider as { resolveProvider?: boolean } | undefined;
    if (!provider?.resolveProvider) {
      return unsupported(`${this.serverName} does not resolve completion items`);
    }
    try {
      const raw = await this.requireRpc().request<Record<string, unknown>>('completionItem/resolve', item);
      const doc = raw?.documentation;
      const text =
        typeof doc === 'string' ? doc : doc && typeof doc === 'object' ? String((doc as { value?: string }).value ?? '') : undefined;
      return supported({
        ...(text ? { documentation: text } : {}),
        ...(typeof raw?.detail === 'string' ? { detail: raw.detail } : {}),
      });
    } catch (err) {
      if ((err as { rpcCode?: number }).rpcCode === -32601) return unsupported(`${this.serverName} does not resolve completion items`);
      throw err;
    }
  }

  /**
   * Parameter hints for the call under the caret.
   *
   * Sent on `(` and `,` only - never per keystroke - so the extra round trip is
   * paid a few times per line rather than on every character.
   */
  signatureHelp(uri: string, position: Position): Promise<NavResult<SignatureHelp>> {
    return this.nav('signatureHelp', 'textDocument/signatureHelp', { textDocument: { uri }, position }, normalizeSignatureHelp);
  }

  /**
   * Foldable spans for the whole document.
   *
   * Requested on a debounce after edits, never per keystroke: the gutter is a
   * decoration, and a round trip per character would outbid diagnostics for the
   * same server process.
   */
  foldingRanges(uri: string): Promise<NavResult<FoldingRange[]>> {
    return this.nav('foldingRange', 'textDocument/foldingRange', { textDocument: { uri } }, normalizeFoldingRanges);
  }

  /**
   * Inline type/parameter hints for a line window.
   *
   * The window is sent to the server because inlay hints are the one request
   * whose answer grows with the file: asking for a 5000-line document to render
   * 40 visible lines would cost a transcript-sized reply for a decoration.
   */
  inlayHints(uri: string, fromLine: number, toLine: number): Promise<NavResult<InlayHint[]>> {
    return this.nav(
      'inlayHint',
      'textDocument/inlayHint',
      { textDocument: { uri }, range: { start: { line: fromLine, character: 0 }, end: { line: toLine, character: 0 } } },
      normalizeInlayHints,
    );
  }

  /** Ask for diagnostics explicitly (pull) when the server supports it. */
  async diagnosticsPull(uri: string): Promise<Diagnostic[]> {
    const t0 = performance.now();
    try {
      const res = await this.requireRpc().request<{ items?: Diagnostic[] } | Diagnostic[]>(
        'textDocument/diagnostic',
        { textDocument: { uri } },
      );
      const items = Array.isArray(res) ? res : (res?.items ?? []);
      const ms = performance.now() - t0;
      this.kernel?.perfMetrics().record('lsp.diagnostic', ms);
      if (ms > (this.opts.slowDiagnosticMs ?? 300)) {
        this.logger?.warn('Slow diagnostics pass', { durationMs: Math.round(ms), file: uri });
      }
      this.diagnosticsByUri.set(diagnosticKey(uri), items);
      return items;
    } catch {
      // Many servers are push-only; fall back to whatever was published.
      return this.diagnostics(uri);
    }
  }

  /**
   * Forward `$/cancelRequest` for an in-flight request.
   *
   * A cancelled request still answers (LSP requires error `-32800`), so the
   * promise resolves or rejects as usual; the caller decides whether the answer
   * is still wanted. That is the scheduler's job, not the transport's.
   */
  cancelRequest(id: number): boolean {
    return this.rpc?.cancel(id) ?? false;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const log = this.logger;
    try {
      if (this.rpc && !this.rpc.isClosed) {
        await this.rpc.request('shutdown', null).catch(() => undefined);
        this.rpc.notify('exit', null);
      }
    } catch {
      /* ignore */
    }
    this.logCollector?.flush();
    this.rpc?.dispose();
    if (this.child && this.child.exitCode === null) {
      const child = this.child;
      // `exit` is the protocol's clean shutdown, so give the server the chance to
      // take it. Killing a JVM mid-shutdown leaves its workspace locked, and the
      // *next* start then handshakes and never imports anything — every request
      // answers empty with no error. That is what a second run against a reused
      // jdtls data directory looked like.
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        // `child.kill()` is TerminateProcess on one pid. pyright and tsserver
        // launch through a `.cmd` shim (`cmd /d /s /c node …`), so killing the
        // wrapper leaves the real server running — and it still holds the stdio
        // pipes, which means this process never sees the child exit and never
        // exits either. `taskkill /T /F` walks the tree.
        killTree(child.pid);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), 2000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    const uptime = Math.round(performance.now() - this.startedAt);
    log?.info('Language server stopped', {
      uptimeMs: uptime,
      logLines: this.logCollector?.stats.lines ?? 0,
      logRecords: this.logCollector?.stats.records ?? 0,
    });
  }

  // ---------------- internals ----------------

  private recordRpc(method: string, durationMs: number, ok: boolean, traceId?: string): void {
    if (!this.kernel) return;
    const opts = {
      unit: 'ms',
      traceId,
      scope: 'language-server' as const,
      languageId: this.languageId,
    };
    // Trace-correlated metrics: they land in the live window *and* the hot
    // store, so a log record's traceId can be cross-queried against them.
    this.kernel.perfMetric(`rpc.roundtrip.${method}`, durationMs, opts);
    this.kernel.perfMetric('rpc.roundtrip', durationMs, opts);
    if (!ok) this.kernel.perfMetric(`rpc.error.${method}`, 1, { ...opts, unit: 'count' });
    // RPC roundtrips participate in slow-path capture (spec: 慢路径立即捕获).
    if (ok) {
      const slow = this.kernel.checkSlow(`rpc:${method}`, durationMs, {
        languageId: this.languageId,
        server: this.serverName,
        rpcMethod: method,
      });
      if (slow) {
        this.logger?.warn('Slow RPC roundtrip', {
          method,
          durationMs: Math.round(durationMs),
          thresholdMs: this.kernel.slowThresholdMs,
        });
      }
    }
  }

  private handleInbound(msg: JsonRpcMessage): void {
    if (msg.method === 'textDocument/publishDiagnostics') {
      const p = msg.params as { uri: string; diagnostics: Diagnostic[] };
      this.diagnosticsByUri.set(diagnosticKey(p.uri), p.diagnostics ?? []);
      this.publishCount++;
      const errors = (p.diagnostics ?? []).filter((d) => d.severity === 1).length;
      const warns = (p.diagnostics ?? []).filter((d) => d.severity === 2).length;
      this.logger
        ?.withScope({ fileUri: p.uri })
        .info('Diagnostics published', {
          total: (p.diagnostics ?? []).length,
          errors,
          warnings: warns,
        });
      this.emit('diagnostics', p);
      return;
    }
    if (msg.method === 'window/logMessage' || msg.method === 'window/showMessage') {
      const p = msg.params as { type?: number; message?: string };
      const level = p.type === 1 ? 'error' : p.type === 2 ? 'warn' : 'info';
      this.logger
        ?.forComponent(`lsp.${this.launch?.serverName ?? 'server'}`)
        [level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](
          p.message ?? '(server message)',
          { lspMethod: msg.method },
        );
      return;
    }
    // Server-initiated requests need a response so the server doesn't hang.
    if (msg.method === 'workspace/configuration' && msg.id !== undefined) {
      const items = (msg.params as { items?: unknown[] })?.items ?? [];
      this.rpc?.respond(msg.id, items.map(() => ({})));
      return;
    }
    if (msg.method === 'client/registerCapability' && msg.id !== undefined) {
      this.rpc?.respond(msg.id, null);
      return;
    }
  }

  private requireRpc(): JsonRpcConnection {
    if (!this.rpc) throw new Error('LSP client not started');
    return this.rpc;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cheap PATH probe for an executable on PATH (plus explicit paths). */
export function commandExists(cmd: string): boolean {
  if (cmd.includes('/') || cmd.includes('\\')) return existsSync(cmd);
  const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of paths) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = `${dir}${process.platform === 'win32' ? '\\' : '/'}${cmd}${ext}`;
      if (existsSync(full)) return true;
    }
  }
  return false;
}

/**
 * Canonical key for the diagnostics map.
 *
 * A server may echo a URI back in a different spelling than the one it was
 * given: tsserver answers `file:///d%3A/...` for a document opened as
 * `file:///D:/...`. Comparing raw strings then never matches, so the published
 * diagnostics are stored under a key nobody looks up — and Check reports "no
 * problems" while the server's own log says it published one. Python's stub
 * echoed the URI verbatim, which is why this survived until a real server was
 * installed.
 *
 * Normalising cannot merge two genuinely different files: NTFS is
 * case-insensitive and `%3A` is just `:`.
 */
function diagnosticKey(uri: string): string {
  let out = uri;
  try {
    out = decodeURIComponent(uri);
  } catch {
    /* malformed escape: compare the raw form */
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

export function fileUri(p: string): string {
  return pathToFileURL(p).toString();
}
