/**
 * WorkspaceService — the backend behind the IDE UI, now multi-language.
 *
 * Each language gets its own *slot*: a real buffer file on disk (so the
 * language server sees it), an execution runner, and a lazily-started LSP
 * client. Slots are independent — a broken gopls cannot stop Python from
 * running, and vice versa.
 *
 *   run(lang, code)        → executes, returns stdout/stderr/exit code
 *   diagnose(lang, code)   → syncs the buffer, returns problems
 *   complete(lang, code,p) → completion items at a position
 *   hover(lang, code, p)   → hover text at a position
 *
 * Two deliberate asymmetries between the languages:
 *
 *  - **Python's server starts eagerly, Go's lazily.** gopls is a large process
 *    with a multi-second warm-up; most sessions never touch Go. Starting it on
 *    first use keeps startup fast without changing Python's behaviour (the
 *    Stage-3 checks depend on a ready server right after init).
 *
 *  - **Go is compiled.** There is no REPL namespace to carry between runs, so a
 *    Go "session" is a module directory rather than a pickled environment.
 *
 * Every operation flows through the kernel's spines, so the Performance and
 * Logs tabs show the work the editor just triggered, tagged with languageId.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LspClient,
  discoverPythonServer,
  fileUri,
  type CompletionItem,
  type Hover,
  type LspLaunchSpec,
} from '../lsp/LspClient.js';
import { PythonRunner, type RunResult as PyRunResult } from '../python/PythonRunner.js';
import { GoRunner, type GoRunResult } from '../go/GoRunner.js';
import { discoverGoServer, goVersion } from '../go/discover.js';
import { LANGUAGES, defaultSample, language, type LanguageId, type RunMode } from './samples.js';
import type { Kernel } from '../kernel/Kernel.js';

export interface WorkspaceServiceOptions {
  pythonBin?: string;
  /** Override Go discovery (else GO_BIN → PATH → known install dirs). */
  goBin?: string;
  /** Override language-server discovery, per language. */
  launch?: Partial<Record<LanguageId, LspLaunchSpec>>;
  /** Where the buffer files live (defaults to a temp dir). */
  workspaceDir?: string;
  /** Hard timeout for a single run. */
  runTimeoutMs?: number;
  /**
   * Start every language server during init. Default: only Python is eager,
   * everything else starts on first use.
   */
  eagerLsp?: boolean;
}

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
  languageId: LanguageId;
  sessionId: string;
  runId: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  logLines: number;
  mode: RunMode;
  /** Which binary produced the output (interpreter / toolchain). */
  binary: string;
  /** Go only: which phase decided the outcome. */
  phase?: 'build' | 'run' | 'test';
  /** Go only: the compiler rejected the source. */
  compileError?: boolean;
  /** Go only: wall time spent compiling. */
  buildMs?: number;
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

const SEVERITY_NAMES: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

/** One language's buffer + runner + (lazy) language server. */
interface Slot {
  id: LanguageId;
  runner: PythonRunner | GoRunner;
  lsp?: LspClient;
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

export class WorkspaceService {
  private slots = new Map<LanguageId, Slot>();
  private rootDir = '';
  private ready = false;
  private readonly opts: WorkspaceServiceOptions;

  constructor(private kernel: Kernel, opts: WorkspaceServiceOptions = {}) {
    this.opts = opts;
  }

  /** Create buffer files and bring up the eager language server(s). */
  async init(initial?: Partial<Record<LanguageId, string>>): Promise<void> {
    if (this.ready) return;
    const dir = this.opts.workspaceDir ?? join(tmpdir(), `nolanguage-ide-${process.pid}`);
    this.rootDir = dir;
    await mkdir(dir, { recursive: true });

    for (const desc of LANGUAGES) {
      const langDir = join(dir, desc.id);
      await mkdir(langDir, { recursive: true });
      const docPath = join(langDir, desc.fileName);
      const code = initial?.[desc.id] ?? defaultSample(desc.id).code;
      await writeFile(docPath, code, 'utf8');

      // Go needs a module: `go test` requires one, and gopls wants a workspace
      // root it recognises.
      if (desc.id === 'go') await writeFile(join(langDir, 'go.mod'), GO_MOD, 'utf8');

      const runner =
        desc.id === 'go'
          ? new GoRunner(this.kernel, this.opts.goBin)
          : new PythonRunner(this.kernel, this.opts.pythonBin);

      const slot: Slot = {
        id: desc.id,
        runner,
        lspPending: true,
        docPath,
        docUri: fileUri(docPath),
        queue: Promise.resolve(),
      };
      // Resolve the Go version now: it needs a process, and status() must stay
      // synchronous for the UI.
      if (runner instanceof GoRunner && runner.available) {
        slot.version = (await goVersion(runner.binary)) ?? undefined;
      }
      this.slots.set(desc.id, slot);
    }

    const eager: LanguageId[] = this.opts.eagerLsp === true ? LANGUAGES.map((l) => l.id) : ['python'];
    for (const id of eager) await this.ensureLsp(id);

    this.kernel.logger.root().info('Workspace ready', {
      root: dir,
      languages: [...this.slots.keys()].join(','),
      buffers: [...this.slots.values()].map((s) => s.docPath).join(' | '),
    });
    this.ready = true;
  }

  // ---------------- language-server lifecycle ----------------

  /**
   * Start a language server on first use. Concurrent callers share one launch
   * via `lspStarting`, so a double Check does not spawn two gopls processes.
   */
  private ensureLsp(id: LanguageId): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot || !slot.lspPending) return Promise.resolve();
    if (slot.lspStarting) return slot.lspStarting;
    slot.lspStarting = this.startLsp(slot).finally(() => {
      slot.lspPending = false;
      slot.lspStarting = undefined;
    });
    return slot.lspStarting;
  }

  private async startLsp(slot: Slot): Promise<void> {
    const log = this.kernel.logger.forComponent(`ide.workspace.${slot.id}`);

    let launch: LspLaunchSpec | undefined = this.opts.launch?.[slot.id];
    let note: string | undefined;

    if (!launch && slot.id === 'python') {
      launch = await discoverPythonServer(this.opts.pythonBin);
    } else if (!launch) {
      const res = discoverGoServer((slot.runner as GoRunner).discovery);
      if (!res.launch) {
        slot.lspError = res.note;
        log.warn('Language server unavailable — Check/completion disabled', {
          language: slot.id,
          searched: res.searched.join(', ') || '(none)',
        });
        return;
      }
      launch = res.launch;
      note = `gopls (${res.source})`;
    }
    if (!launch) return;

    const client = new LspClient({ launch });
    try {
      const caps = await client.start(this.kernel, fileUri(join(this.rootDir, slot.id)));
      await client.openDocument(slot.docUri, await readText(slot.docPath), slot.id);
      slot.lsp = client;
      slot.lspNote = note;
      log.info('Language server ready', {
        language: slot.id,
        server: launch.serverName,
        capabilities: Object.keys(caps).length,
      });
    } catch (err) {
      // Diagnostics degrade gracefully: the editor still runs code.
      slot.lspError = (err as Error).message;
      await client.stop().catch(() => undefined);
      log.error('Language server unavailable — Check/completion disabled', { language: slot.id }, err as Error);
    }
  }

  // ---------------- public API ----------------

  bufferUri(id: LanguageId): string {
    return this.slots.get(id)?.docUri ?? '';
  }

  bufferPath(id: LanguageId): string {
    return this.slots.get(id)?.docPath ?? '';
  }

  /**
   * Status for every language. Python's values are also mirrored at the top
   * level so the Stage-3 checks (written before Go existed) keep working.
   */
  status(): {
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
  } {
    const languages = LANGUAGES.map((d) => this.languageStatus(d.id));
    const py = languages.find((l) => l.id === 'python')!;
    return {
      bufferPath: py.bufferPath,
      pythonBin: py.binary,
      sessions: py.sessions,
      lsp: {
        available: py.lsp.state === 'ready',
        running: py.lsp.running,
        serverName: py.lsp.serverName,
        capabilities: py.lsp.capabilities,
        logRecords: py.lsp.logRecords,
        error: py.lsp.error,
      },
      languages,
    };
  }

  languageStatus(id: LanguageId): LanguageStatus {
    const desc = language(id);
    const slot = this.slots.get(id);
    if (!slot) {
      return {
        id,
        displayName: desc.displayName,
        extension: desc.extension,
        fileName: desc.fileName,
        supportsTest: desc.supportsTest,
        available: false,
        binary: '',
        binarySource: 'missing',
        sessions: 0,
        bufferPath: '',
        bufferUri: '',
        lsp: { state: 'unavailable', running: false, serverName: 'none', capabilities: 0, logRecords: 0 },
      };
    }

    const isGo = slot.runner instanceof GoRunner;
    const go = isGo ? (slot.runner as GoRunner) : undefined;
    const binary = isGo ? go!.binary : (slot.runner as PythonRunner).binary;
    const available = isGo ? go!.available : true;
    const lspStatus = slot.lsp?.status();

    return {
      id,
      displayName: desc.displayName,
      extension: desc.extension,
      fileName: desc.fileName,
      supportsTest: desc.supportsTest,
      available,
      binary,
      binarySource: go ? go.discovery.source : 'configured',
      version: slot.version,
      sessions: slot.runner.sessionCount(),
      bufferPath: slot.docPath,
      bufferUri: slot.docUri,
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

  /** Execute code in the given (or default) session. */
  async run(
    id: LanguageId,
    code: string,
    opts: { sessionId?: string; reset?: boolean; mode?: RunMode; timeoutMs?: number } = {},
  ): Promise<WorkspaceRunResult> {
    const slot = this.requireSlot(id);
    const sessionId = opts.sessionId ?? 'ide';
    const mode: RunMode = opts.mode ?? 'run';
    // Go compiles before it runs, so it needs more headroom than Python.
    const timeoutMs = opts.timeoutMs ?? this.opts.runTimeoutMs ?? (id === 'go' ? 30_000 : 15_000);

    if (opts.reset) await slot.runner.resetSession(sessionId);

    if (slot.runner instanceof GoRunner) {
      const r: GoRunResult = await slot.runner.run({ code, sessionId, mode, timeoutMs });
      return {
        languageId: id,
        sessionId: r.sessionId,
        runId: r.runId,
        exitCode: r.exitCode,
        signal: r.signal,
        durationMs: r.durationMs,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        logLines: r.logLines,
        mode,
        binary: r.goBin,
        phase: r.phase,
        compileError: r.compileError,
        buildMs: r.buildMs,
      };
    }

    const r: PyRunResult = await (slot.runner as PythonRunner).run({ code, sessionId, timeoutMs });
    return {
      languageId: id,
      sessionId: r.sessionId,
      runId: r.runId,
      exitCode: r.exitCode,
      signal: r.signal,
      durationMs: r.durationMs,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      logLines: r.logLines,
      mode: 'run',
      binary: r.pythonBin,
    };
  }

  async resetSession(id: LanguageId, sessionId = 'ide'): Promise<boolean> {
    return this.requireSlot(id).runner.resetSession(sessionId);
  }

  /** Sync the buffer and return the problems the language server reports. */
  async diagnose(id: LanguageId, code: string): Promise<DiagnoseResult> {
    const slot = this.requireSlot(id);
    await this.ensureLsp(id);
    return this.serialize(slot, async () => {
      await writeFile(slot.docPath, code, 'utf8').catch(() => undefined);
      if (!slot.lsp) {
        return { uri: slot.docUri, items: [], errors: 0, warnings: 0, fromLsp: false, note: slot.lspError };
      }
      slot.lsp.changeDocument(slot.docUri, code, id);
      // gopls does a full type-check on the first pass; give it longer.
      let wait = await slot.lsp.waitForDiagnostics(slot.docUri, id === 'go' ? 6000 : 2500);
      // A cold server (fresh process, uncached module) can still be loading when
      // the first wait expires. `published: false` means it never answered, so
      // nudge the document and wait once more — without this, "no answer yet"
      // is reported to the user as "no problems", which is a lie that hides real
      // errors on the very first Check of a session.
      if (!wait.published) {
        slot.lsp.changeDocument(slot.docUri, code, id);
        wait = await slot.lsp.waitForDiagnostics(slot.docUri, id === 'go' ? 20000 : 2500);
      }
      const mapped = wait.items.map((d) => ({
        line: d.range.start.line,
        character: d.range.start.character,
        endLine: d.range.end.line,
        endCharacter: d.range.end.character,
        severity: d.severity ?? 1,
        severityName: SEVERITY_NAMES[d.severity ?? 1] ?? 'error',
        message: d.message,
        code: d.code,
        source: d.source,
      }));
      return {
        uri: slot.docUri,
        items: mapped,
        errors: mapped.filter((m) => m.severity === 1).length,
        warnings: mapped.filter((m) => m.severity === 2).length,
        fromLsp: true,
      };
    });
  }

  async complete(id: LanguageId, code: string, line: number, character: number): Promise<CompletionItem[]> {
    const slot = this.requireSlot(id);
    await this.ensureLsp(id);
    return this.serialize(slot, async () => {
      if (!slot.lsp) return [];
      slot.lsp.changeDocument(slot.docUri, code, id);
      try {
        return await slot.lsp.completion(slot.docUri, { line, character });
      } catch {
        return [];
      }
    });
  }

  async hover(id: LanguageId, code: string, line: number, character: number): Promise<Hover | null> {
    const slot = this.requireSlot(id);
    await this.ensureLsp(id);
    return this.serialize(slot, async () => {
      if (!slot.lsp) return null;
      slot.lsp.changeDocument(slot.docUri, code, id);
      try {
        return await slot.lsp.hover(slot.docUri, { line, character });
      } catch {
        return null;
      }
    });
  }

  async close(): Promise<void> {
    for (const slot of this.slots.values()) {
      await slot.lsp?.stop().catch(() => undefined);
      await slot.runner.close().catch(() => undefined);
    }
  }

  // ---------------- internals ----------------

  private requireSlot(id: LanguageId): Slot {
    const slot = this.slots.get(id);
    if (!slot) throw new Error(`WorkspaceService: unknown language "${id}" (call init() first)`);
    return slot;
  }

  /** Run `task` after all previously queued LSP work for this language. */
  private serialize<T>(slot: Slot, task: () => Promise<T>): Promise<T> {
    const run = slot.queue.then(task, task);
    // Keep the chain alive even if a task rejects.
    slot.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const GO_MOD = `// Generated by Nolanguage — one module per IDE workspace.
module nolanguage/ide

go 1.21
`;

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}
