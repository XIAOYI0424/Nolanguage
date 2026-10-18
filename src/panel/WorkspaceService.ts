/**
 * WorkspaceService — the backend behind the IDE UI, driven by language plugins.
 *
 * **This file knows no language.** Every language is a manifest read by
 * `LanguageRegistry`; every runner is built by `RunnerFactory` from
 * `manifest.run.mode`; every toolchain path comes from `manifest.run.discovery`.
 * If a language-specific `if` ever appears here again, the plugin boundary has
 * been broken.
 *
 * Each language still gets its own *slot*: a real buffer file on disk (so the
 * language server sees it), a runner, and a lazily-started LSP client. Slots
 * stay independent — a broken gopls cannot stop Python from running.
 *
 *   run(lang, code)        → executes, returns stdout/stderr/exit code
 *   diagnose(lang, code)   → syncs the buffer, returns problems
 *   complete(lang, code,p) → completion items at a position
 *   hover(lang, code, p)   → hover text at a position
 *   preview(lang, code)    → renders Markdown to sanitized HTML (stage 8)
 *
 * Every operation flows through the kernel's spines, so the Performance and
 * Logs tabs show the work the editor just triggered, tagged with languageId.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LspClient,
  fallbackServerSpec,
  fileUri,
  type CompletionItem,
  type Hover,
  type LspLaunchSpec,
} from '../lsp/LspClient.js';
import { renderMarkdown, type MdFrontmatter, type MdHeading, type MdRenderResult, type MdStats } from '../markdown/MdRenderer.js';
import { defaultSample, type LanguageId, type RunMode } from './samples.js';
import { LanguageRegistry, type RegistryChange, type RegistryRoot } from '../langs/Registry.js';
import { RunnerFactory } from '../langs/RunnerFactory.js';
import { defaultRuntimeRegistry } from '../runtimes/index.js';
import type { HostContext, Runner } from '../runtimes/types.js';
import { discoverBinary, probeVersion, type BinaryResolution } from '../langs/discover.js';
import { ProfileManager, parseMemoryHint, runtimeMemoryBytes, type ResourceProfile } from '../langs/ProfileManager.js';
import {
  bufferName,
  primaryExtension,
  supportsRun as manifestSupportsRun,
  supportsTest as manifestSupportsTest,
  type LanguageManifest,
} from '../langs/manifest.js';
import type { Kernel } from '../kernel/Kernel.js';
import type { ExecService } from '../exec/ExecService.js';

export interface WorkspaceServiceOptions {
  /**
   * Per-language toolchain overrides, keyed by plugin id. The documented escape
   * hatch when a machine has several toolchains installed; the manifest's
   * `run.discovery` is the default.
   *
   * This is the *only* way to pin a binary. There used to be one option per
   * language (`pythonBin`, `goBin`, …), which meant this file had to know which
   * ids existed — exactly the coupling the plugin boundary removes.
   */
  toolchain?: Record<string, string>;
  /** Phase 4 · memory budget for language plugins (bytes). */
  memoryBudgetBytes?: number;
  /** Phase 4 · budget for language servers specifically (bytes). */
  lspMemoryBudgetBytes?: number;
  /** Phase 4 · idle time after which a language server is stopped (ms). */
  lspIdleMs?: number;
  /** Override language-server discovery, per language. */
  launch?: Partial<Record<string, LspLaunchSpec>>;
  /** Where the buffer files live (defaults to a temp dir). */
  workspaceDir?: string;
  /** Hard timeout for a single run. */
  runTimeoutMs?: number;
  /** Start every language server during init instead of on first use. */
  eagerLsp?: boolean;
  /** `NOLANGUAGE_HOME`; where `builtin/`, `languages/` and `data/` live. */
  home?: string;
  /** Extra plugin roots (the repo's `builtin/` during development). */
  pluginRoots?: RegistryRoot[];
  /**
   * Directory the `project` plugin tier resolves against
   * (`<dir>/.nolanguage/languages`). Defaults to the process cwd, which is the
   * launch directory — pass the workspace root when the panel was opened on a
   * folder.
   */
  projectDir?: string;
  /** Inject a prepared registry (tests, and hosts that own the scan). */
  registry?: LanguageRegistry;
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
  /** Set when a multi-step run failed part-way (compiled languages). */
  phase?: 'build' | 'run' | 'test';
  /** The compiler rejected the source. */
  compileError?: boolean;
  /** Wall time spent in the build step. */
  buildMs?: number;
}

/** One rendered Markdown preview. `html` is sanitized by MdRenderer. */
export interface PreviewResult {
  languageId: LanguageId;
  uri: string;
  html: string;
  title: string;
  headings: MdHeading[];
  frontmatter: MdFrontmatter;
  stats: MdStats;
  truncated: boolean;
  /** Wall time of the render, milliseconds — the spec's render-latency metric. */
  ms: number;
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

/**
 * The wire shape the UI consumes to build its language list, grammar and
 * extension map. Sending the *manifest* rather than a hardcoded table is what
 * lets a newly installed plugin highlight and run without a UI release.
 */
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
  /** Highlighting rules straight from `manifest.grammar`. */
  grammar: Array<{ re: string; cls: string; flags?: string }>;
  /** True when the plugin came with the binary (vs. user-installed). */
  builtin: boolean;
}

const SEVERITY_NAMES: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

/** One language's buffer + runner + (lazy) language server. */
interface Slot {
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

/**
 * Interpreter used to host the platform's own stub language server.
 *
 * The stub (`src/python/pyrightServer.py`) is substrate code written in Python,
 * so *it* needs an interpreter — this is a property of the bundled asset, not a
 * fact about the language being edited. It is consulted only when a manifest
 * declared `bundledFallback: "stub"` **and** its own toolchain was not found.
 */
function stubInterpreter(): string {
  return process.env.PYTHON_BIN ?? 'python';
}

export class WorkspaceService {
  private slots = new Map<string, Slot>();
  private rootDir = '';
  private ready = false;
  private readonly opts: WorkspaceServiceOptions;
  private readonly registry: LanguageRegistry;
  private readonly factory: RunnerFactory;
  /** Stage 9 · execution plane (warm-worker pool). Optional: set after boot. */
  exec?: ExecService;
  /** Phase 4 · memory budget for language servers. Binds itself in the constructor. */
  readonly resources: ProfileManager;
  /** Guards `applyRegistryChange` against overlapping applications. */
  private syncing = false;
  /** Serialises queued plugin syncs (see `queueSync`). */
  private syncChain: Promise<unknown> = Promise.resolve();

  constructor(private kernel: Kernel, opts: WorkspaceServiceOptions = {}) {
    this.opts = opts;
    this.registry =
      opts.registry ??
      new LanguageRegistry({
      home: opts.home,
      projectDir: opts.projectDir,
      extraRoots: opts.pluginRoots ?? defaultPluginRoots(),
    });
    this.factory = new RunnerFactory(defaultRuntimeRegistry());
    this.resources = new ProfileManager({
      budgetBytes: opts.memoryBudgetBytes,
      lspBudgetBytes: opts.lspMemoryBudgetBytes,
      idleMs: opts.lspIdleMs,
    });
    this.resources.bind({
      profiles: () => this.resourceProfiles(),
      stopLsp: (id) => this.releaseLsp(id),
    });
    // Phase 3: a plugin installed/enabled/disabled from the Plugins page must
    // take effect here, not after a restart. The registry tells us what happened;
    // `applyRegistryChange` does the work.
    this.registry.onDidChange((change) => {
      if (!this.ready) return;
      void this.queueSync(change);
    });
  }

  /** The language registry this workspace is built from. */
  get languages(): LanguageRegistry {
    return this.registry;
  }

  /** The runtime catalogue (for `/health` and the Plugins page). */
  get runtimes(): RunnerFactory['registry'] {
    return this.factory.registry;
  }

  /**
   * Attach the execution plane once it has been constructed by the host.
   *
   * Kept for hosts that own the plane; no language currently routes through it
   * from this service (the `inline-vm` runtime evaluates in-process).
   */
  setExec(exec: ExecService): void {
    this.exec = exec;
  }

  /**
   * Create buffer files and bring up the eager language server(s).
   *
   * The workspace directory defaults to a per-pid temp folder; `PANEL_WORKSPACE`
   * overrides it so a host (or a test harness) can pin it to a location it
   * already allows.
   */
  async init(initial?: Partial<Record<LanguageId, string>>): Promise<void> {
    if (this.ready) return;
    const dir =
      this.opts.workspaceDir ??
      process.env.PANEL_WORKSPACE ??
      join(tmpdir(), `nolanguage-ide-${process.pid}`);
    this.rootDir = dir;
    await mkdir(dir, { recursive: true });

    // The plugin scan is what defines the language set. No fallback list: an
    // empty registry is a real, reportable failure, not something to paper over.
    await this.registry.scan();
    const manifests = this.registry.all();
    if (!manifests.length) {
      throw new Error(
        `no language plugins found under ${this.registry.home} (looked for builtin/ and languages/)`,
      );
    }

    for (const manifest of manifests) {
      const code = initial?.[manifest.id] ?? defaultSample(manifest.id).code;
      await this.addSlot(manifest, code);
    }

    const eager: string[] = this.opts.eagerLsp === true
      ? manifests.map((m) => m.id)
      : manifests.filter((m) => m.lsp?.eager && !m.lsp.disabled).map((m) => m.id);
    for (const id of eager) await this.ensureLsp(id);
    for (const id of this.slots.keys()) this.resources.noteUse(id);
    // Phase 4: the budget only means something if it is re-checked.
    this.resources.start();

    this.kernel.logger.root().info('Workspace ready', {
      root: dir,
      languages: [...this.slots.keys()].join(','),
      runtimes: this.factory.registry.list().map((r) => `${r.id}@${r.version}`).join(','),
      buffers: [...this.slots.values()].map((s) => s.docPath).join(' | '),
    });
    this.ready = true;
  }

  /**
   * Create one language's slot: buffer file, scaffolded project files, runner.
   *
   * Split out of `init()` so the Plugins page can add a language after boot — an
   * installed plugin must be usable without restarting the IDE.
   */
  private async addSlot(manifest: LanguageManifest, code: string): Promise<Slot> {
    const id = manifest.id;
    const langDir = join(this.rootDir, id);
    await mkdir(langDir, { recursive: true });
    const docPath = join(langDir, bufferName(manifest));
    if (!existsSync(docPath)) await writeFile(docPath, code, 'utf8');

    // Project files a language server needs (a Go module, a Cargo manifest).
    for (const f of manifest.scaffold?.onFirstRun ?? []) {
      const target = join(langDir, f.file);
      if (!existsSync(target)) await writeFile(target, f.template, 'utf8');
    }

    const toolchain = this.resolveToolchain(manifest);
    let runner: Runner | undefined;
    let runnerError: string | undefined;
    if (manifestSupportsRun(manifest)) {
      try {
        await this.registry.ensureDataDir(id);
        runner = this.factory.create(manifest, await this.hostContext(manifest, toolchain)) ?? undefined;
      } catch (err) {
        // A plugin whose runtime is missing must not take the workspace down;
        // it shows up in `status()` as an unavailable language with a reason.
        runnerError = (err as Error).message;
        this.kernel.logger
          .forComponent(`ide.workspace.${id}`)
          .error('Runner unavailable', { language: id, runMode: manifest.run?.mode }, err as Error);
      }
    }

    const slot: Slot = {
      id,
      manifest,
      runner,
      runnerError,
      toolchain: toolchain.bin || undefined,
      toolchainSource: toolchain.source,
      lspPending: true,
      docPath,
      docUri: fileUri(docPath),
      queue: Promise.resolve(),
    };
    // Resolve the version now: it needs a process, and status() must stay
    // synchronous for the UI.
    const versionArgs = manifest.run?.versionArgs;
    if (versionArgs && toolchain.bin && toolchain.source !== 'missing') {
      slot.version = (await probeVersion(toolchain.bin, versionArgs)) ?? undefined;
    }
    this.slots.set(id, slot);
    this.resources.noteUse(id);
    return slot;
  }

  /** Tear down a language and forget it. Used when a plugin is removed. */
  private async removeSlot(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    await slot.lsp?.stop().catch(() => undefined);
    await slot.runner?.close().catch(() => undefined);
    this.slots.delete(id);
    this.resources.forget(id);
  }

  /** Resolves once every queued plugin sync has finished. */
  pluginsSynced(): Promise<void> {
    return this.syncChain.then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Queue a registry change for application. Serialised on `syncChain` so two
   * rapid installs do not interleave their slot creation.
   */
  private queueSync(change: RegistryChange): Promise<void> {
    this.syncChain = this.syncChain
      .then(() => this.applyRegistryChange(change))
      .catch((err: unknown) => {
        this.kernel.logger.root().warn('Plugin change could not be applied', {
          change: `${change.type}:${change.id}`,
          error: (err as Error).message,
        });
      });
    return this.pluginsSynced();
  }

  /**
   * React to a registry change: add, remove, enable or disable a language,
   * without restarting the workspace.
   *
   * An enabled/disabled plugin is the difference between "in the picker" and
   * "not in the picker" — which is a slot's presence, not a flag on it.
   *
   * Two things this deliberately does **not** do:
   *
   *   - it does not call `registry.scan()`. The registry emits *after* it has
   *     updated its own state, and `scan()` emits `rescan` — which would call
   *     this method again, forever. (This bug shipped once; the symptom was a
   *     package that never finished enabling anything.)
   *   - it does not react to `rescan`. A rescan means "the directory was read",
   *     not "the language set changed"; `applyRegistryChange` is idempotent,
   *     so there is nothing to do anyway.
   */
  async applyRegistryChange(change: RegistryChange): Promise<{ added: string[]; removed: string[] }> {
    if (change.type === 'rescan') return { added: [], removed: [] };
    if (this.syncing) return { added: [], removed: [] };
    this.syncing = true;
    try {      const wanted = new Set(this.registry.all().map((m) => m.id));
      const removed: string[] = [];
      for (const id of [...this.slots.keys()]) {
        if (wanted.has(id)) continue;
        await this.removeSlot(id);
        removed.push(id);
      }
      const added: string[] = [];
      for (const manifest of this.registry.all()) {
        const existing = this.slots.get(manifest.id);
        // Read the buffer *before* removing the slot that owns it.
        const preserved = existing ? await readText(existing.docPath) : '';
        if (existing) {
          // A version upgrade changes the manifest under the slot; recreate it so
          // the run config, discovery and grammar all match the new body.
          if (existing.manifest.version === manifest.version) continue;
          await this.removeSlot(manifest.id);
          removed.push(manifest.id);
        }
        await this.addSlot(manifest, preserved || defaultSample(manifest.id).code);
        added.push(manifest.id);
      }
      this.kernel.logger.root().info('Plugins applied', {
        change: `${change.type}:${change.id}`,
        added: added.join(',') || '-',
        removed: removed.join(',') || '-',
        languages: [...this.slots.keys()].join(','),
      });
      return { added, removed };
    } finally {
      this.syncing = false;
    }
  }

  /** The manifest for a language, for hosts that build their own capabilities. */
  manifestOf(id: string): LanguageManifest | undefined {
    return this.slots.get(id)?.manifest ?? this.registry.get(id);
  }

  /** Every manifest currently active in the workspace (host capability lists). */
  manifests(): LanguageManifest[] {
    return this.registry.isScanned() ? this.registry.all() : [];
  }

  // ---------------- plugin plumbing ----------------

  /** Resolve a toolchain: explicit override → manifest discovery → missing. */
  private resolveToolchain(manifest: LanguageManifest): BinaryResolution {
    const override = this.opts.toolchain?.[manifest.id];
    if (override) return { bin: override, source: 'override' };
    return discoverBinary(manifest.run?.discovery);
  }

  private async hostContext(manifest: LanguageManifest, toolchain: BinaryResolution): Promise<HostContext> {
    const source = this.registry.sourceOf(manifest.id);
    return {
      kernel: this.kernel,
      languageId: manifest.id,
      dataDir: await this.registry.ensureDataDir(manifest.id),
      pluginDir: source?.dir ?? this.registry.home,
      toolchain: toolchain.source === 'missing' ? undefined : toolchain.bin,
      exec: this.exec,
    };
  }

  // ---------------- language-server lifecycle ----------------

  /**
   * Start a language server on first use. Concurrent callers share one launch
   * via `lspStarting`, so a double Check does not spawn two gopls processes.
   *
   * Before starting anything, the budget gets a say (Phase 4): if this language
   * would push the language-server budget over, a quieter non-eager server is
   * stopped first. That is the one place the budget *acts* — the timer only
   * reports `overBudget`, it does not pre-empt a server the user is about to
   * need.
   */
  private ensureLsp(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot || !slot.lspPending) return Promise.resolve();
    if (slot.lspStarting) return slot.lspStarting;
    // Shed *before* the new server exists, so the language about to be used is
    // never the one that gets stopped to make room.
    slot.lspStarting = this.resources
      .enforce()
      .then(() => this.startLsp(slot))
      .finally(() => {
        slot.lspPending = false;
        slot.lspStarting = undefined;
      });
    return slot.lspStarting;
  }

  /**
   * Generic language-server launch.
   *
   * The four language branches this used to contain were *policy* — which
   * binary to look for, what to call it, and whether the platform ships a
   * fallback — so they now live in `manifest.lsp`. The only substrate-owned
   * capability left is `bundledFallback: "stub"`, which names a server the
   * binary carries rather than a language.
   */
  private async startLsp(slot: Slot): Promise<void> {
    const log = this.kernel.logger.forComponent(`ide.workspace.${slot.id}`);
    const spec = slot.manifest.lsp;

    let launch: LspLaunchSpec | undefined = this.opts.launch?.[slot.id];
    let note: string | undefined;

    if (!launch) {
      if (!spec || spec.disabled) {
        slot.lspError = spec?.degradedNote ?? `"${slot.id}" declares no language server`;
        log.warn('No language server declared', { language: slot.id });
        return;
      }

      const found = discoverBinary(spec.discovery);
      if (found.source !== 'missing' && found.bin) {
        launch = {
          languageId: spec.languageId ?? slot.id,
          serverName: spec.serverName ?? slot.id,
          command: found.bin,
          args: spec.args ?? [],
        };
        note = `${launch.serverName} (${found.source})`;
      } else if (spec.bundledFallback === 'stub') {
        launch = fallbackServerSpec(slot.toolchain ?? stubInterpreter());
        note = 'bundled stub server';
      } else {
        slot.lspError = spec.degradedNote ?? `${spec.serverName ?? 'language server'} not found`;
        log.warn('Language server unavailable — Check/completion disabled', {
          language: slot.id,
          searched: [
            ...(spec.discovery?.envVars ?? []),
            ...(spec.discovery?.knownPaths ?? []),
            ...(spec.discovery?.commands ?? []),
          ].join(', ') || '(none)',
        });
        return;
      }
    }
    if (!launch) return;

    const client = new LspClient({ launch });
    try {
      const caps = await client.start(this.kernel, fileUri(join(this.rootDir, slot.id)));
      await client.openDocument(slot.docUri, await readText(slot.docPath), slot.id);
      slot.lsp = client;
      slot.lspNote = note;
      this.resources.noteUse(slot.id);
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

  /** Is this language part of the workspace? */
  hasLanguage(id: string): boolean {
    return this.slots.has(id);
  }

  bufferUri(id: LanguageId): string {
    return this.slots.get(id)?.docUri ?? '';
  }

  bufferPath(id: LanguageId): string {
    return this.slots.get(id)?.docPath ?? '';
  }

  /**
   * The directory buffers live in. Set at the top of `init()`, so it is valid
   * even when `init()` later fails (a read-only or sandboxed workspace) — the
   * caller can still report *where* the workspace was meant to be.
   */
  get root(): string {
    return this.rootDir;
  }

  /**
   * The language list the UI builds itself from — id, display name,
   * extensions, grammar and capabilities, straight from the manifests.
   */
  /**
   * Slot ids in *manifest* order, not insertion order.
   *
   * A plugin installed later than Python still belongs after it: `order` is the
   * manifest's presentation decision, and the language picker and the status
   * bar must show the same sequence no matter when a plugin was added.
   */
  private orderedSlotIds(): string[] {
    return [...this.slots.values()]
      .sort(
        (a, b) =>
          (a.manifest.order ?? Number.MAX_SAFE_INTEGER) - (b.manifest.order ?? Number.MAX_SAFE_INTEGER) ||
          a.id.localeCompare(b.id),
      )
      .map((s) => s.id);
  }

  languageList(): LanguageDescriptorWire[] {
    const out: LanguageDescriptorWire[] = [];
    for (const id of this.orderedSlotIds()) {
      const slot = this.slots.get(id)!;
      const m = slot.manifest;
      const source = this.registry.sourceOf(m.id);
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
    /** Phase 4 · memory accounting for every language. */
    resource: ReturnType<ProfileManager['summary']>;
  } {
    const languages = this.orderedSlotIds().map((id) => this.languageStatus(id));
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
      resource: this.resources.summary(),
    };
  }

  languageStatus(id: LanguageId): LanguageStatus {
    const slot = this.slots.get(id);
    if (!slot) {
      const entry = this.registry.entry(id);
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
   * Execute code in the given (or default) session.
   *
   * One path: ask the slot's runner. There is no `instanceof` ladder here any
   * more — the runtime returned by `RunnerFactory` already speaks the uniform
   * `RunOutcome` shape.
   */
  async run(
    id: LanguageId,
    code: string,
    opts: {
      sessionId?: string;
      reset?: boolean;
      mode?: RunMode;
      timeoutMs?: number;
      onData?: (stream: 'stdout' | 'stderr', text: string) => void;
      onStdinReady?: (sink: (data: string) => void) => void;
    } = {},
  ): Promise<WorkspaceRunResult> {
    const slot = this.requireSlot(id);
    this.touch(id);
    if (!slot.runner) {
      // Render-only languages and broken plugins get the same clear answer
      // instead of a TypeError on a missing runner.
      if (!manifestSupportsRun(slot.manifest)) {
        throw new Error(`"${id}" documents render — there is nothing to run`);
      }
      throw new Error(`"${id}" cannot run: ${slot.runnerError ?? 'no runner available'}`);
    }

    const sessionId = opts.sessionId ?? 'ide';
    const mode: RunMode = opts.mode ?? 'run';
    if (opts.reset) await slot.runner.resetSession(sessionId);

    const outcome = await slot.runner.run({
      code,
      sessionId,
      mode,
      timeoutMs: opts.timeoutMs ?? this.opts.runTimeoutMs,
      onData: opts.onData,
      onStdinReady: opts.onStdinReady,
    });

    return {
      languageId: id,
      sessionId: outcome.sessionId,
      runId: outcome.runId,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      durationMs: outcome.durationMs,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      timedOut: outcome.timedOut,
      logLines: outcome.logLines,
      mode,
      binary: outcome.binary,
      phase: outcome.phase,
      compileError: outcome.compileError,
      buildMs: outcome.buildMs,
    };
  }

  async resetSession(id: LanguageId, sessionId = 'ide'): Promise<boolean> {
    const slot = this.requireSlot(id);
    this.touch(id);
    // Render-only languages have no session; "nothing to reset" is success.
    if (!slot.runner) return false;
    return slot.runner.resetSession(sessionId);
  }

  /** Sync the buffer and return the problems the language server reports. */
  async diagnose(id: LanguageId, code: string): Promise<DiagnoseResult> {
    const slot = this.requireSlot(id);
    this.touch(id);
    await this.ensureLsp(id);
    const spec = slot.manifest.lsp;
    return this.serialize(slot, async () => {
      await writeFile(slot.docPath, code, 'utf8').catch(() => undefined);
      if (!slot.lsp) {
        return { uri: slot.docUri, items: [], errors: 0, warnings: 0, fromLsp: false, note: slot.lspError };
      }
      slot.lsp.changeDocument(slot.docUri, code, id);
      // Type-checking servers need a longer first pass; the numbers are policy,
      // so they come from the manifest instead of a language branch.
      let wait = await slot.lsp.waitForDiagnostics(slot.docUri, spec?.diagnosticsTimeoutMs ?? 2500);
      // A cold server (fresh process, uncached module) can still be loading when
      // the first wait expires. `published: false` means it never answered, so
      // nudge the document and wait once more — without this, "no answer yet"
      // is reported to the user as "no problems", which is a lie that hides real
      // errors on the very first Check of a session.
      if (!wait.published) {
        slot.lsp.changeDocument(slot.docUri, code, id);
        wait = await slot.lsp.waitForDiagnostics(slot.docUri, spec?.coldDiagnosticsTimeoutMs ?? 2500);
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
    this.touch(id);
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

  /**
   * Render a Markdown document to sanitized HTML (stage 8).
   *
   * This is the spec's "render latency" column of the performance spine and
   * the "render logs" column of the log spine, so it flows through the same
   * machinery a run does: a `markdown.render` span, `markdown.render` /
   * `markdown.blocks` metrics, and a `markdown`-scoped log record per
   * render — visible in the Performance and Logs tabs without the UI doing
   * anything special.
   *
   * The renderer itself is pure; measurement wraps it here so tests stay
   * deterministic and the UI can still see a real duration.
   */
  async preview(id: LanguageId, code: string): Promise<PreviewResult> {
    const slot = this.requireSlot(id);
    this.touch(id);
    return this.serialize(slot, async () => {
      const t0 = performance.now();
      const span = this.kernel.tracer.startSpan('markdown.render', {
        attributes: { languageId: id, bytes: code.length },
      });
      const log = this.kernel.logger.forMarkdown().span(span);
      try {
        const r: MdRenderResult = renderMarkdown(code);
        const durationMs = performance.now() - t0;
        const m = this.kernel.perfMetrics();
        m.record('markdown.render', durationMs);
        m.record('markdown.blocks', r.stats.blocks);
        log.info('Rendered preview', {
          ms: Number(durationMs.toFixed(3)),
          headings: r.stats.headings,
          blocks: r.stats.blocks,
          words: r.stats.words,
          codeBlocks: r.stats.codeBlocks,
          links: r.stats.links,
          truncated: r.truncated,
        });
        span
          .setAttribute('headings', r.stats.headings)
          .setAttribute('blocks', r.stats.blocks)
          .setAttribute('truncated', r.truncated)
          .end();
        // Keep the buffer on disk so marksman (when installed) sees the same
        // document the preview just rendered.
        await writeFile(slot.docPath, code, 'utf8').catch(() => undefined);
        return {
          languageId: id,
          uri: slot.docUri,
          html: r.html,
          title: r.title,
          headings: r.headings,
          frontmatter: r.frontmatter,
          stats: r.stats,
          truncated: r.truncated,
          ms: Number(durationMs.toFixed(3)),
        };
      } catch (err) {
        span.setAttribute('error', (err as Error).message).end();
        log.error('Preview render failed', { bytes: code.length }, err as Error);
        throw err;
      }
    });
  }

  // ---------------- Phase 4 · resources ----------------

  /**
   * What every language currently costs, straight from its manifest.
   *
   * The manifest's `memoryHint` is the only number we have without shelling out
   * to the OS, and it is a *hint*: it keeps the accounting honest about the
   * difference between a pyright and a markdown server, which is what the
   * budget needs. Real RSS would be better where the platform allows it.
   */
  private resourceProfiles(): ResourceProfile[] {
    const now = Date.now();
    return [...this.slots.values()].map((slot) => {
      const m = slot.manifest;
      const lspBytes = parseMemoryHint(m.lsp?.memoryHint);
      return {
        languageId: slot.id,
        memoryBytes: lspBytes + parseMemoryHint(m.profiler?.memoryHint) + (slot.runner ? runtimeMemoryBytes(m.run?.mode) : 0),
        lspMemoryBytes: lspBytes,
        lspRunning: !!slot.lsp,
        eager: m.lsp?.eager === true,
        lastUsedAt: this.resources.lastUsedAt(slot.id, now),
      };
    });
  }

  /**
   * Stop a language server and leave a note to restart it on next use.
   *
   * Called by `ProfileManager` only — a user never sees a server disappear,
   * because `lspPending` brings it back on the next Check/Complete.
   */
  private async releaseLsp(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    await slot.lsp?.stop().catch(() => undefined);
    if (!slot.lsp) return; // Nothing to do (already stopped).
    slot.lsp = undefined;
    slot.lspStarting = undefined;
    slot.lspPending = true;
    this.kernel.logger
      .forComponent(`ide.workspace.${id}`)
      .info('Language server released by the resource manager — restarts on next use', { language: id });
  }

  /** Memory accounting for `/health`, the status bar and the Plugins page. */
  resourceSummary() {
    return this.resources.summary();
  }

  /** Run a budget pass now (used by tests and the Plugins page's "Reclaim" button). */
  async enforceResources() {
    return this.resources.enforce();
  }

  /** Touch a language, so LRU and idle reclamation see it as in use. */
  private touch(id: LanguageId): void {
    this.resources.noteUse(id);
  }

  async close(): Promise<void> {
    this.resources.stop();
    for (const slot of this.slots.values()) {
      await slot.lsp?.stop().catch(() => undefined);
      await slot.runner?.close().catch(() => undefined);
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

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}

/**
 * Default plugin roots when the host does not supply any.
 *
 * `<cwd>/builtin` is where the official plugins live in a source checkout —
 * and every harness runs from the repo root, so this is what makes `init()`
 * work out of the box. A packaged build has no such directory; the host
 * (`server.ts`) materialises the embedded copy and passes it explicitly.
 */
function defaultPluginRoots(): RegistryRoot[] {
  const dir = join(process.cwd(), 'builtin');
  return existsSync(dir) ? [{ dir, kind: 'builtin', removable: false }] : [];
}
