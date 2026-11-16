/**
 * Bringing one slot's language server up.
 *
 * Split out of `WorkspaceService` because it is *policy*, not workspace state:
 * which binary to use, whether the platform ships a fallback, and whether the
 * plugin asked for the pooled manager. The service keeps the slots; this keeps
 * the rules for turning a manifest into a running server.
 *
 * Two paths, one function:
 *
 * - **pooled** (`lsp.manager: true`) — hand the slot a `ManagedLsp` from
 *   `LspManager`. Nothing is spawned here; the first request starts it. This is
 *   what makes opening a Maven reactor free until something is asked of it.
 * - **legacy** — one `LspClient` per language, started eagerly, exactly as
 *   before. Kept so the migration is one manifest line at a time.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kernel } from '../kernel/Kernel.js';
import { resolveBundledFallback } from '../lsp/bundledFallback.js';
import { LspClient, fileUri, type LspLaunchSpec } from '../lsp/LspClient.js';
import type { LspManager } from '../lsp/manager/LspManager.js';
import type { LanguageRegistry } from '../langs/Registry.js';
import { resolveServer } from './serverInstall.js';
import { toolchainEnv } from './toolchainEnv.js';
import type { LanguageManifest } from './manifest.js';
import type { LspLike } from '../lsp/lspLike.js';

/**
 * What launching needs from a slot, structurally.
 *
 * Declared here rather than imported from the panel: `langs` is below `panel` in
 * the layer order, and reaching up for a type would be a cycle waiting to happen.
 * Every field is one the caller already owns.
 */
export interface LaunchSlot {
  id: string;
  docPath: string;
  docUri: string;
  manifest: LanguageManifest;
  toolchain?: string;
  lsp?: LspLike;
  lspError?: string;
  lspNote?: string;
}

export interface LaunchDeps {
  kernel: Kernel;
  registry: LanguageRegistry;
  manager: LspManager;
  /** Where the buffers live; the legacy root URI is derived from it. */
  rootDir: string;
  /** Per-language override, used by tests and by hosts with their own servers. */
  launchOverride?: Partial<Record<string, LspLaunchSpec>>;
  /** Memory accounting, called when a server comes up. */
  noteUse: (id: string) => void;
}

const readText = (path: string): Promise<string> => readFile(path, 'utf8').catch(() => '');

export async function startSlotLsp(deps: LaunchDeps, slot: LaunchSlot): Promise<void> {
  const log = deps.kernel.logger.forComponent(`ide.workspace.${slot.id}`);
  const spec = slot.manifest.lsp;

  let launch: LspLaunchSpec | undefined = deps.launchOverride?.[slot.id];
  let note: string | undefined;

  if (!launch) {
    if (spec?.manager) {
      const plugin = deps.manager.registry.get(slot.id);
      if (!plugin) {
        slot.lspError = spec.degradedNote ?? `"${slot.id}" is not registered with the language-server manager`;
        return;
      }
      const root = plugin.projectRoot(slot.docPath) ?? deps.rootDir;
      const entry = deps.manager.acquire(slot.id, root);
      if (!entry) {
        slot.lspError = plugin.degradedNote ?? `no pooled server for "${slot.id}"`;
        return;
      }
      // No server configured is not an error state for the slot: the entry is
      // still useful, because its fallback answers. The note is what the
      // Problems panel shows instead of pretending a server replied.
      if (!plugin.lspConfig(root)) slot.lspError = plugin.degradedNote;
      await entry.openDocument(slot.docUri, await readText(slot.docPath), slot.id);
      slot.lsp = entry;
      slot.lspNote = `pooled ${entry.serverName} @ ${root}`;
      deps.noteUse(slot.id);
      log.info('Pooled language server attached', { language: slot.id, root, server: entry.serverName });
      return;
    }

    if (!spec || spec.disabled) {
      slot.lspError = spec?.degradedNote ?? `"${slot.id}" declares no language server`;
      log.warn('No language server declared', { language: slot.id });
      return;
    }

    // `resolveServer` is discovery plus one extra place: the managed root a
    // `nlg lang server install` writes into. An env var or a known path still
    // wins — a user who pointed us at their own server means it.
    const found = resolveServer(slot.manifest, deps.registry.home, { root: deps.rootDir || process.cwd() });
    if (found.source !== 'missing' && found.bin) {
      const env = toolchainEnv(slot.toolchain);
      launch = {
        languageId: spec.languageId ?? slot.id,
        serverName: spec.serverName ?? slot.id,
        command: found.bin,
        args: spec.args ?? [],
        ...(env ? { env } : {}),
      };
      note = `${launch.serverName} (${found.source})`;
    } else if (spec.bundledFallback) {
      // The plugin declares the command; this layer only expands placeholders.
      // It used to call a Python-only `fallbackServerSpec()` here, so any
      // language that declared a fallback silently got Python's server.
      const toolchain = slot.toolchain ?? slot.manifest.run?.discovery?.commands?.[0];
      const fallback = resolveBundledFallback(spec.bundledFallback, { languageId: slot.id, toolchain });
      if (fallback) {
        launch = fallback;
        note = `bundled ${fallback.serverName}`;
      } else {
        slot.lspError = spec.degradedNote ?? `bundled fallback for "${slot.id}" could not be resolved`;
        log.warn('Bundled language server unavailable', { language: slot.id });
        return;
      }
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
    const caps = await client.start(deps.kernel, fileUri(join(deps.rootDir, slot.id)));
    await client.openDocument(slot.docUri, await readText(slot.docPath), slot.id);
    slot.lsp = client;
    slot.lspNote = note;
    deps.noteUse(slot.id);
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
