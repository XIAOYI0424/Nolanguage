/**
 * The manager's vocabulary — and the whole of a language's obligations.
 *
 * The core (`LspManager`, `LspPool`, `Scheduler`, `CacheValidator`) knows how to
 * pool processes, route files, cancel requests and invalidate caches. It knows
 * nothing about any language: every language-specific fact arrives through a
 * `LanguagePlugin`, and in this product a plugin is built from a manifest, so a
 * new language never adds a branch here.
 *
 * ## Mapping to the Rust design this implements
 *
 * | Rust | here | why |
 * |---|---|---|
 * | `trait LanguagePlugin` | `interface LanguagePlugin` | same contract |
 * | `fn id() -> &'static str` | `readonly id: string` | a frozen field *is* a static str |
 * | `Option<&dyn FallbackProvider>` | `fallback(): FallbackProvider \| undefined` | — |
 * | `inventory::submit!` | `BUILTIN_PLUGINS` + `LanguageRegistry` | compile-time list; the registry adds the manifest-driven ones |
 * | `Arc<Mutex<..>>` | single-threaded event loop | Node's model; the "lock" is the in-flight map |
 */

/** 0-based line/character, as LSP counts them. */
export interface Position {
  line: number;
  character: number;
}

/**
 * Everything needed to launch one server for one project root.
 *
 * Deliberately plain data: a plugin resolves its binary once, at registration
 * time, so `lspConfig()` is synchronous and the pool can decide in one tick
 * whether it has anything to start.
 */
export interface LspServerConfig {
  serverName: string;
  languageId: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  /** Time budget for the initialize handshake before the pool gives up. */
  startTimeoutMs?: number;
  /**
   * How long a *request* may wait for a cold server before the fallback answers.
   *
   * This is not the same as the start timeout: jdtls can spend 40 s importing a
   * Maven workspace, and blocking a keystroke for that long is worse than
   * answering from the fallback and switching over when the server is ready.
   */
  firstRequestBudgetMs?: number;
  /** Budget for an explicit action (definition, formatting, signature help). */
  navBudgetMs?: number;
}

// ---------------- fallback ----------------

export interface FallbackContext {
  /** Absolute path of the file the request is about. */
  file: string;
  text: string;
  line: number;
  character: number;
}

export interface FallbackCompletion {
  label: string;
  kind?: number;
  detail?: string;
}

export interface FallbackDiagnostic {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  severity: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
}

/**
 * What answers when no language server can.
 *
 * Ordered by the manager as: LSP → `tree-sitter` → `lexical` → `text`. Only
 * `lexical` is implemented here; the interface exists so a tree-sitter provider
 * can be added without touching the manager.
 */
export interface FallbackProvider {
  readonly kind: 'tree-sitter' | 'lexical' | 'text';
  /** Shown in the Problems panel, e.g. "lexical analysis only (no jdtls)". */
  readonly note: string;
  completions(ctx: FallbackContext): FallbackCompletion[];
  diagnostics(ctx: FallbackContext): FallbackDiagnostic[];
  hover(ctx: FallbackContext): string | undefined;
}

// ---------------- incremental invalidation ----------------

/**
 * What an index was built from.
 *
 * `signature` is the only field that decides whether the persisted state may be
 * reused: a cache built by a different server build is not "stale", it is
 * wrong, and reusing it would report problems that no longer exist.
 */
export interface IndexMetadata {
  signature: string;
  /** Commit the index was built at, when the project is a git checkout. */
  indexedCommit: string | null;
  indexedAt: string;
  /** `relPath → "mtimeMs:size"`, for the content-hash strategy. */
  stamps?: Record<string, string>;
}

export type DirtySource = 'git' | 'content-hash' | 'none';

export interface DirtyReport {
  /** Project-root-relative paths, POSIX separators. */
  files: string[];
  source: DirtySource;
  reason?: string;
}

export interface IncrementalStrategy {
  readonly kind: 'git-diff' | 'content-hash';
  /** Files changed since the last index. Never throws: a failure is `source: 'none'`. */
  dirtyFiles(root: string, last: IndexMetadata | undefined): Promise<DirtyReport>;
  isLargeChange(dirty: DirtyReport, threshold: number): boolean;
}

// ---------------- the plugin ----------------

export interface LanguagePlugin {
  readonly id: string;
  /** True for the files this plugin owns. Extension-based in practice. */
  matches(file: string): boolean;
  /** Nearest ancestor that is a project root, or undefined when there is none. */
  projectRoot(file: string): string | undefined;
  /** Undefined means "no server here" — the manager degrades, it does not throw. */
  lspConfig(root: string): LspServerConfig | undefined;
  /** Identifies the exact server build; see `versionSignature()` in `signature.ts`. */
  versionSignature(): string;
  fallback(): FallbackProvider | undefined;
  incremental(): IncrementalStrategy | undefined;
  /** Higher wins when two plugins match the same file. Default 0. */
  serverPriority(): number;
  /** Idle time before the pool stops this plugin's server. */
  idleTtlMs(): number;
  /** Why no server is available, for the status bar and the Problems panel. */
  readonly degradedNote?: string;
}

/** A pool key: one server per (plugin, project root). */
export interface PoolKey {
  pluginId: string;
  root: string;
}

export const poolKey = (k: PoolKey): string => `${k.pluginId}\u0000${k.root}`;

/** Manager-wide counters, surfaced in the perf panel and the tests. */
export interface ManagerStats {
  starts: number;
  startFailures: number;
  reused: number;
  converged: number;
  reaped: number;
  cancelled: number;
  deduped: number;
  staleDropped: number;
  fallbacks: number;
  cacheHits: number;
  cacheMisses: number;
  live: number;
}
