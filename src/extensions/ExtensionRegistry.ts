/**
 * Extension registry: manifests parsed at startup, no code loaded.
 *
 * The registry is the kernel's *view* of what is installed. It answers three
 * questions and nothing else:
 *
 *   - which extensions exist (and are they compatible with this kernel)?
 *   - which one activates for a given event (`onCommand:…`, `onLanguage:…`)?
 *   - what does an extension contribute (commands / languages / views)?
 *
 * Activation itself lives in `ExtensionManager` — the registry never spawns a
 * process or imports a module.
 */
import {
  type ExtensionManifest,
  type CommandContribution,
  ManifestError,
  parseManifest,
  satisfies,
} from './Manifest.js';

export interface RegisteredExtension {
  manifest: ExtensionManifest;
  /** Directory the manifest was read from (entry paths resolve against it). */
  dir: string;
  /** Absolute path of the entry module. */
  entryPath: string;
  /** False when `engines.kernel` does not match the running kernel. */
  compatible: boolean;
  /** Why it was rejected (unreadable manifest, bad id, wrong engine…). */
  note?: string;
}

export class ExtensionRegistry {
  private byId = new Map<string, RegisteredExtension>();

  constructor(private kernelVersion: string) {}

  /** Register a parsed manifest. Throws when the id is already taken. */
  add(entry: RegisteredExtension): void {
    if (this.byId.has(entry.manifest.id)) {
      throw new ManifestError(`extension already registered: ${entry.manifest.id}`);
    }
    this.byId.set(entry.manifest.id, entry);
  }

  remove(id: string): boolean {
    return this.byId.delete(id);
  }

  get(id: string): RegisteredExtension | undefined {
    return this.byId.get(id);
  }

  all(): RegisteredExtension[] {
    return [...this.byId.values()];
  }

  /** Only extensions that may be activated on this kernel. */
  compatible(): RegisteredExtension[] {
    return this.all().filter((e) => e.compatible);
  }

  /** Every extension that declares `onCommand:<commandId>`. */
  forCommand(commandId: string): RegisteredExtension[] {
    return this.compatible().filter((e) => e.manifest.activationEvents.includes(`onCommand:${commandId}`));
  }

  /** Every extension that declares `onLanguage:<languageId>`. */
  forLanguage(languageId: string): RegisteredExtension[] {
    return this.compatible().filter((e) => e.manifest.activationEvents.includes(`onLanguage:${languageId}`));
  }

  /** Every extension that declares `onStartup`. */
  forStartup(): RegisteredExtension[] {
    return this.compatible().filter((e) => e.manifest.activationEvents.includes('onStartup'));
  }

  /** Union of all contributed commands, in registration order. */
  commands(): Array<{ command: CommandContribution; extensionId: string }> {
    const out: Array<{ command: CommandContribution; extensionId: string }> = [];
    for (const e of this.compatible()) {
      for (const command of e.manifest.contributes?.commands ?? []) {
        out.push({ command, extensionId: e.manifest.id });
      }
    }
    return out;
  }

  /** True when this kernel version satisfies the manifest's engine range. */
  static isCompatible(manifest: ExtensionManifest, kernelVersion: string): boolean {
    return satisfies(kernelVersion, manifest.engines.kernel);
  }
}

export { parseManifest, satisfies, ManifestError };
