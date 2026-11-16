/**
 * The wire shapes of a workspace, and the functions that build them.
 *
 * `WorkspaceService` is an aggregate: it owns the slots, the LSP clients and the
 * runs. Building the JSON that the status bar and the plugins page consume is a
 * *projection* of that state, not part of owning it — so it lives here, over a
 * declared view instead of over `this`. The class keeps four one-line delegates.
 *
 * The shapes had to move with the functions: leaving them in
 * `WorkspaceService.ts` and importing them back here would make the two files
 * import each other, which the architecture contract rejects (R2).
 */
import {
  bufferName,
  primaryExtension,
  supportsRun as manifestSupportsRun,
  supportsTest as manifestSupportsTest,
  type LanguageManifest,
} from '../langs/manifest.js';
import type { LanguageRegistry } from '../langs/Registry.js';
import type { ProfileManager } from '../langs/ProfileManager.js';
import { parseMemoryHint, runtimeMemoryBytes, type ResourceProfile } from '../langs/ProfileManager.js';
import type { CompletionItem } from '../lsp/LspClient.js';
import type { LspLike } from '../lsp/lspLike.js';
import type { Runner } from '../runtimes/types.js';
import type { LanguageId } from './samples.js';

/**
 * Completion items, plus why there are none when the server could not answer.
 *
 * `unsupported` is absent when a server answered and simply had nothing — that
 * distinction is the whole point of the type, and it is the same one the five
 * navigation requests make.
 */
export interface CompletionResult {
  items: CompletionItem[];
  unsupported?: string;
}

/** What `diagnose` reports: the problems, and whether a server produced them. */
export interface DiagnoseResult {
  uri: string;
  items: Array<{
    line: number;
    character: number;
    endLine: number;
    endCharacter: number;
    severity: number;
    severityName: string;
    message: string;
    code?: string | number;
    source?: string;
  }>;
  errors: number;
  warnings: number;
  /** True when the language server answered; false when it is unavailable. */
  fromLsp: boolean;
  /** Populated when the server could not be reached, to explain why. */
  note?: string;
}

/** Uniform run result across languages (the IDE consumes only this). */
export interface WorkspaceRunResult {
  languageId: string;
  sessionId: string;
  runId: string;
  exitCode: number | null;
  signal: string | null;
  /** The host stopped this run (Stop button), not the program exiting. */
  cancelled?: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  logLinesTruncated?: boolean;
  timedOut: boolean;
  logLines: number;
  mode: string;
  /** Which binary produced the output (interpreter / toolchain). */
  binary: string;
  /** Set when a multi-step run failed part-way (compiled languages). */
  phase?: 'build' | 'run' | 'test';
  /** The compiler rejected the source. */
  compileError?: boolean;
  /** Wall time spent in the build step. */
  buildMs?: number;
}

export interface Slot {
  id: string;
  manifest: LanguageManifest;
  /**
   * Absent for languages that render rather than execute, and for languages
   * whose runner could not be built (see `runnerError`). Every consumer must
   * degrade instead of assuming a runner exists.
   */
  runner?: Runner;
  runnerError?: string;
  /** Resolved toolchain from `manifest.run.discovery`. */
  toolchain?: string;
  toolchainSource?: string;
  /**
   * A language server for this slot: a per-language `LspClient`, or the pooled
   * `ManagedLsp` from `LspManager`. Both satisfy `LspLike`, which is why nothing
   * else in this service has to know which one it got.
   */
  lsp?: LspLike;
  lspError?: string;
  lspNote?: string;
  /** True until the LSP has been started (or attempted) for the first time. */
  lspPending: boolean;
  /** In-flight start, so concurrent Check/Complete share one launch. */
  lspStarting?: Promise<void>;
  docPath: string;
  docUri: string;
  /**
   * Toolchain version string, resolved once during init. `status()` is polled
   * by the UI, and probing for it spawns a process — so it is cached rather
   * than recomputed per render.
   */
  version?: string;
  /**
   * Serialises language-server interactions *per language*.
   *
   * The editor is asynchronous: a user can hit Check and Run back-to-back, and
   * the transport delivers messages without waiting for the previous handler.
   * Every LSP operation mutates the one shared document (didChange) and then
   * awaits a notification, so interleaving two of them would let one
   * operation's document state leak into the other's result.
   */
  queue: Promise<unknown>;
}

export interface LanguageStatus {
  id: LanguageId;
  displayName: string;
  extension: string;
  fileName: string;
  supportsTest: boolean;
  /** The runner can actually execute code. */
  available: boolean;
  binary: string;
  binarySource: string;
  version?: string;
  sessions: number;
  bufferPath: string;
  bufferUri: string;
  /** Why the runner could not be built, when it could not. */
  runnerError?: string;
  /** Runtime id from `manifest.run.mode`. */
  runMode?: string;
  lsp: {
    /** `pending` = not started yet (lazy). */
    state: 'ready' | 'pending' | 'unavailable';
    running: boolean;
    serverName: string;
    source?: string;
    capabilities: number;
    logRecords: number;
    error?: string;
    note?: string;
  };
}

export interface LanguageDescriptorWire {
  id: string;
  displayName: string;
  version: string;
  extensions: string[];
  defaultExt: string;
  fileName: string;
  supportsRun: boolean;
  supportsTest: boolean;
  runMode?: string;
  hasLsp: boolean;
  lspServerName?: string;
  memoryHint?: string;
  /**
   * Built-in (word-list) completion for this language. Defaults to true and is
   * only false when the manifest says `contributes.completion.lexical.enabled:
   * false` — the UI treats a missing field as "on".
   */
  lexical: boolean;
  /** Highlighting rules straight from `manifest.grammar`. */
  grammar: Array<{ re: string; cls: string; flags?: string }>;
  /** True when the plugin came with the binary (vs. user-installed). */
  builtin: boolean;
}


/** What the projections read. Nothing here mutates. */
export interface WorkspaceView {
  slots: Map<string, Slot>;
  /** Slot ids in manifest order. */
  order: string[];
  registry: LanguageRegistry;
  resourceSummary(): ReturnType<ProfileManager['summary']>;
}

export function languageList(view: WorkspaceView): LanguageDescriptorWire[] {
    const out: LanguageDescriptorWire[] = [];
    for (const id of view.order) {
      const slot = view.slots.get(id)!;
      const m = slot.manifest;
      const source = view.registry.sourceOf(m.id);
      out.push({
        id: m.id,
        displayName: m.displayName,
        version: m.version,
        extensions: (m.file.extensions ?? []).map((e) => e.replace(/^\./, '').toLowerCase()),
        defaultExt: (m.file.defaultExt ?? m.file.extensions?.[0] ?? '').replace(/^\./, ''),
        fileName: bufferName(m),
        supportsRun: manifestSupportsRun(m),
        supportsTest: manifestSupportsTest(m),
        runMode: m.run?.mode,
        hasLsp: !!m.lsp && !m.lsp.disabled,
        lspServerName: m.lsp?.serverName,
        memoryHint: m.lsp?.memoryHint,
        // Opt-out, not opt-in: a new plugin gets completion without saying a word.
        lexical: m.contributes?.completion?.lexical?.enabled !== false,
        grammar: m.grammar?.rules ?? [],
        builtin: source?.kind === 'builtin',
      });
    }
    return out;
  }

  /**
   * Status for every language.
   *
   * The four scalar fields are a *mirror* of the first language, kept because
   * the Stage-3 wire shape (written when Python was the only language) is still
   * consumed by the status bar. "First" means first in manifest order — Python
   * declares `order: 10`, so it keeps winning without this file naming it.
   */
export function statusOf(view: WorkspaceView): {
    bufferPath: string;
    pythonBin: string;
    sessions: number;
    lsp: {
      available: boolean;
      running: boolean;
      serverName: string;
      capabilities: number;
      logRecords: number;
      error?: string;
    };
    languages: LanguageStatus[];
    /** Phase 4 · memory accounting for every language. */
    resource: ReturnType<ProfileManager['summary']>;
  } {
    const languages = view.order.map((id) => languageStatus(view, id));
    // Never `undefined`: a workspace with every plugin disabled still has to
    // answer with the old shape.
    const primary = languages[0];
    return {
      bufferPath: primary?.bufferPath ?? '',
      pythonBin: primary?.binary ?? '',
      sessions: primary?.sessions ?? 0,
      lsp: {
        available: primary?.lsp.state === 'ready',
        running: primary?.lsp.running ?? false,
        serverName: primary?.lsp.serverName ?? 'none',
        capabilities: primary?.lsp.capabilities ?? 0,
        logRecords: primary?.lsp.logRecords ?? 0,
        error: primary?.lsp.error,
      },
      languages,
      resource: view.resourceSummary(),
    };
  }

export function languageStatus(view: WorkspaceView, id: LanguageId): LanguageStatus {
    const slot = view.slots.get(id);
    if (!slot) {
      const entry = view.registry.entry(id);
      const m = entry?.manifest;
      return {
        id,
        displayName: m?.displayName ?? id,
        extension: m ? primaryExtension(m) : '',
        fileName: m ? bufferName(m) : '',
        supportsTest: m ? manifestSupportsTest(m) : false,
        available: false,
        binary: '',
        binarySource: 'missing',
        sessions: 0,
        bufferPath: '',
        bufferUri: '',
        runnerError: `"${id}" is not part of this workspace`,
        lsp: { state: 'unavailable', running: false, serverName: 'none', capabilities: 0, logRecords: 0 },
      };
    }

    const m = slot.manifest;
    const lspStatus = slot.lsp?.status();
    const hasRunner = !!slot.runner;

    return {
      id,
      displayName: m.displayName,
      extension: primaryExtension(m),
      fileName: bufferName(m),
      supportsTest: manifestSupportsTest(m),
      available: hasRunner ? slot.runner!.available : !manifestSupportsRun(m),
      binary: slot.runner?.binary ?? slot.toolchain ?? '',
      binarySource: slot.toolchainSource ?? 'configured',
      version: slot.version,
      sessions: slot.runner?.sessionCount() ?? 0,
      bufferPath: slot.docPath,
      bufferUri: slot.docUri,
      runnerError: slot.runnerError,
      runMode: m.run?.mode,
      lsp: {
        state: slot.lsp ? 'ready' : slot.lspError ? 'unavailable' : 'pending',
        running: lspStatus?.running ?? false,
        serverName: lspStatus?.serverName ?? (slot.lspError ? 'none' : '…'),
        source: slot.lspNote,
        capabilities: lspStatus?.capabilities ?? 0,
        logRecords: lspStatus?.logRecords ?? 0,
        error: slot.lspError,
        note: slot.lspNote,
      },
    };
  }

/**
 * What every language currently costs, straight from its manifest.
 *
 * The manifest's `memoryHint` is the only number available without shelling out
 * to the OS, and it is a *hint*: it keeps the accounting honest about the
 * difference between a full language server and a Markdown one, which is what the
 * budget needs. Only the reclaimable LSP estimate is counted while that process
 * is alive — otherwise an idle, never-started server would make the total look
 * exceeded and evict servers the user is about to need.
 *
 * Moved out of `WorkspaceService` with the other projections: it reads slot
 * state, it does not own it.
 */
export function resourceProfilesOf(
  slots: Iterable<Slot>,
  lastUsedAt: (id: string, now: number) => number,
  now = Date.now(),
): ResourceProfile[] {
  const out: ResourceProfile[] = [];
  for (const slot of slots) {
    const m = slot.manifest;
    const lspBytes = slot.lsp ? parseMemoryHint(m.lsp?.memoryHint) : 0;
    out.push({
      languageId: slot.id,
      memoryBytes: lspBytes + parseMemoryHint(m.profiler?.memoryHint) + (slot.runner ? runtimeMemoryBytes(m.run?.mode) : 0),
      lspMemoryBytes: lspBytes,
      lspRunning: !!slot.lsp,
      eager: m.lsp?.eager === true,
      lastUsedAt: lastUsedAt(slot.id, now),
    });
  }
  return out;
}
