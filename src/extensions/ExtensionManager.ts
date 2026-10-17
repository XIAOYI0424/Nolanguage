/**
 * ExtensionManager — the kernel-side orchestrator for the extension host model
 * (spec 4.3 / 16.2 / 18.2).
 *
 * It owns the *view* (an {@link ExtensionRegistry}, parsed from manifests) and
 * the *runtime* (a lazily-spawned {@link ExtensionHost} per extension). The
 * registry never imports extension code; the manager only spawns a host, and
 * only once one of the manifest's `activationEvents` fires (`onStartup`,
 * `onCommand:<id>`, `onLanguage:<id>`).
 *
 * Integration points:
 *  - `installCommands()` mirrors every contributed command onto the kernel
 *    command bus, so `kernel.commands.execute('ext.cmd')` transparently routes
 *    into the host process.
 *  - `runCommand(id, ...args)` finds the owning extension and dispatches it.
 *  - `panelInfo()` returns a serialisable snapshot for the dev panel (status,
 *    pid, crashes, contributed commands…).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Kernel } from '../kernel/Kernel.js';
import { ExtensionRegistry, type RegisteredExtension } from './ExtensionRegistry.js';
import { ExtensionHost, type ExtensionHostStatus } from './ExtensionHost.js';
import {
  parseManifest,
  type CommandContribution,
  type ExtensionManifest,
} from './Manifest.js';

export interface ExtensionManagerOptions {
  /** Directories to scan for `<dir>/<ext>/extension.json` manifests. */
  scanDirs?: string[];
  /** Auto-activate extensions that declare `onStartup`. */
  activateOnStartup?: boolean;
  /** Forwarded to each {@link ExtensionHost}. */
  maxCrashes?: number;
  crashWindowMs?: number;
  readyTimeoutMs?: number;
}

/** Serializable extension status for the dev panel. */
export interface ExtensionPanelInfo {
  id: string;
  name: string;
  version: string;
  engine: string;
  host: 'child-process' | 'in-process';
  activationEvents: string[];
  commands: CommandContribution[];
  compatible: boolean;
  note?: string;
  state: string;
  pid?: number;
  restarts: number;
  crashes: number;
  rssBytes?: number;
}

export class ExtensionManager {
  readonly registry: ExtensionRegistry;
  private hosts = new Map<string, ExtensionHost>();
  private kernel: Kernel;
  private opts: Required<Pick<ExtensionManagerOptions, 'activateOnStartup'>> & ExtensionManagerOptions;

  constructor(kernel: Kernel, opts: ExtensionManagerOptions = {}) {
    this.kernel = kernel;
    this.registry = new ExtensionRegistry(kernel.appVersion);
    this.opts = {
      scanDirs: opts.scanDirs ?? [],
      activateOnStartup: opts.activateOnStartup ?? true,
      maxCrashes: opts.maxCrashes,
      crashWindowMs: opts.crashWindowMs,
      readyTimeoutMs: opts.readyTimeoutMs,
    };
  }

  /** Register a manifest programmatically (no scanning). */
  register(
    manifest: ExtensionManifest,
    entryPath: string,
    manifestPath: string = entryPath,
    dir: string = dirname(entryPath),
  ): void {
    this.registry.add({
      manifest,
      dir,
      manifestPath,
      entryPath,
      compatible: ExtensionRegistry.isCompatible(manifest, this.kernel.appVersion),
    });
  }

  /** Scan a directory tree for `extension.json` manifests and register them. */
  discover(dir: string): RegisteredExtension[] {
    const found: RegisteredExtension[] = [];
    if (!existsSync(dir)) return found;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const manifestPath = join(full, 'extension.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const manifest = parseManifest(raw, manifestPath);
        let entryPath = resolve(full, manifest.entry);
        // Source runs reference `.ts`; a built package references `.js`.
        if (!existsSync(entryPath) && manifest.entry.endsWith('.js')) {
          const ts = entryPath.slice(0, -3) + '.ts';
          if (existsSync(ts)) entryPath = ts;
        }
        const compatible = ExtensionRegistry.isCompatible(manifest, this.kernel.appVersion);
        const reg: RegisteredExtension = { manifest, dir: full, manifestPath, entryPath, compatible };
        this.registry.add(reg);
        found.push(reg);
      } catch (err) {
        // A single bad manifest must not prevent the others from loading.
        this.kernel.logger
          .forComponent('extensions.manager')
          .warn('Rejected extension manifest', { dir: full, error: (err as Error).message });
      }
    }
    return found;
  }

  /** Discover every configured scan directory. */
  discoverAll(): RegisteredExtension[] {
    const out: RegisteredExtension[] = [];
    for (const d of this.opts.scanDirs ?? []) out.push(...this.discover(d));
    return out;
  }

  get(id: string): RegisteredExtension | undefined {
    return this.registry.get(id);
  }

  list(): RegisteredExtension[] {
    return this.registry.all();
  }

  private ensureHost(id: string): ExtensionHost {
    let host = this.hosts.get(id);
    if (!host) {
      const ext = this.registry.get(id);
      if (!ext) throw new Error(`unknown extension: ${id}`);
      host = new ExtensionHost(this.kernel, ext, {
        maxCrashes: this.opts.maxCrashes,
        crashWindowMs: this.opts.crashWindowMs,
        readyTimeoutMs: this.opts.readyTimeoutMs,
      });
      this.hosts.set(id, host);
    }
    return host;
  }

  /** Activate all extensions that declare `onStartup`. */
  async activateStartup(): Promise<void> {
    const targets = this.registry.forStartup().filter((e) => e.compatible);
    await Promise.all(
      targets.map((e) => this.ensureHost(e.manifest.id).activate().catch(() => undefined)),
    );
  }

  /** Activate every extension that wants to handle a command. */
  async activateForCommand(commandId: string): Promise<void> {
    const targets = this.registry.forCommand(commandId).filter((e) => e.compatible);
    await Promise.all(
      targets.map((e) => this.ensureHost(e.manifest.id).activate().catch(() => undefined)),
    );
  }

  /** Activate every extension that wants a language. */
  async activateForLanguage(languageId: string): Promise<void> {
    const targets = this.registry.forLanguage(languageId).filter((e) => e.compatible);
    await Promise.all(
      targets.map((e) => this.ensureHost(e.manifest.id).activate().catch(() => undefined)),
    );
  }

  /**
   * Register every contributed command onto the kernel command bus as a proxy
   * that lazily activates + dispatches into the host process. After this,
   * `kernel.commands.execute('ext.cmd', ...)` works like any built-in command.
   */
  installCommands(): void {
    for (const { command, extensionId } of this.registry.commands()) {
      this.kernel.commands.register(
        command.id,
        (...args: unknown[]) => this.runCommand(command.id, ...args),
        { title: command.title ?? command.id, category: command.category ?? 'extension' },
      );
      void extensionId;
    }
  }

  /** Find the owning extension and run a contributed command in its host. */
  async runCommand(commandId: string, ...args: unknown[]): Promise<unknown> {
    const ext = this.registry
      .all()
      .find(
        (e) =>
          e.compatible &&
          (e.manifest.contributes?.commands ?? []).some((c) => c.id === commandId),
      );
    if (!ext) throw new Error(`no extension contributes command: ${commandId}`);
    const host = this.ensureHost(ext.manifest.id);
    return host.runCommand(commandId, args);
  }

  /** Live status of every spawned host. */
  statuses(): ExtensionHostStatus[] {
    return [...this.hosts.values()].map((h) => h.status());
  }

  /** Serialisable snapshot for the dev panel. */
  panelInfo(): ExtensionPanelInfo[] {
    return this.registry.all().map((e) => {
      const st = this.hosts.get(e.manifest.id)?.status();
      return {
        id: e.manifest.id,
        name: e.manifest.name,
        version: e.manifest.version,
        engine: e.manifest.engines.kernel,
        host: e.manifest.host,
        activationEvents: e.manifest.activationEvents,
        commands: e.manifest.contributes?.commands ?? [],
        compatible: e.compatible,
        note: e.note,
        state: st?.state ?? (e.compatible ? 'idle' : 'incompatible'),
        pid: st?.pid,
        restarts: st?.restarts ?? 0,
        crashes: st?.crashes ?? 0,
        rssBytes: st?.rssBytes,
      };
    });
  }

  /** Tear down every host (deactivate + kill the child processes). */
  async dispose(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => h.deactivate().catch(() => undefined)));
    this.hosts.clear();
  }
}
