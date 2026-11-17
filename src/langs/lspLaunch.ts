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
  /** Set when the fast tier answered and a real server is still coming up. */
  upgrade?: LspUpgrade;
  /**
   * The upgrade in flight, so an explicit action can wait for it.
   *
   * A keystroke must not wait — that is the whole point of the stub — but
   * "go to definition" is a question, and the stub has no references and only a
   * heuristic goto. Answering "nothing found" there is worse than waiting.
   */
  upgrading?: Promise<void>;
  /**
   * Start the upgrade now instead of after the delay.
   *
   * The delay exists so the first keystroke does not compete with a 400 MB
   * server starting. An explicit action is already waiting, so that trade does
   * not apply — and skipping the wait is what keeps "go to definition" from
   * costing stub + delay + handshake.
   */
  startUpgradeNow?: () => void;
}

/**
 * A real server that is still starting behind a stub that already answered.
 *
 * `stub` is kept so the caller can tell "the slot still holds the fast tier"
 * from "someone restarted it while I was starting" — swapping in that case would
 * clobber a newer client and leak a process.
 */
export interface LspUpgrade {
  launch: LspLaunchSpec;
  stub: LspLike;
  /** Buffer text at start time; the next request re-syncs the real content. */
  text: string;
  note: string;
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
  /** True when `launch` is the bundled stub, not a real server. */
  let fromStub = false;

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
        // The manifest field existed but nothing read it, so a plugin could
        // declare `initializationOptions` and have them silently dropped. That
        // is how a server's tuning (rust-analyzer's `cachePriming`, a formatter
        // profile) becomes unreachable from a manifest.
        ...(spec.initializationOptions ? { initializationOptions: spec.initializationOptions } : {}),
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
        // The stub *is* the server here. Two tiers would mean starting it twice:
        // once as the fast answer, once as the "real" server it is upgrading to.
        fromStub = true;
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

  const text = await readText(slot.docPath);

  // ---- two tiers, when the manifest ships a stub -------------------------
  //
  // Python is the case: pyright takes ~1.1 s to answer its first completion, and
  // the manifest already carries a stub (`bundledFallback`) that answers in
  // ~0.4 s. Starting the stub first and letting pyright take over in the
  // background is what keeps the first keystroke inside 500 ms *with pyright
  // installed* — otherwise removing `eager` would just move the wait from boot
  // to the first key, which is the worse place for it.
  //
  // `eager: true` keeps the old behaviour: a language that asked to be ready at
  // boot is not going to be answered by a stub while it warms up.
  if (spec?.bundledFallback && spec.eager !== true && !fromStub) {
    const toolchain = slot.toolchain ?? slot.manifest.run?.discovery?.commands?.[0];
    const fast = resolveBundledFallback(spec.bundledFallback, { languageId: slot.id, toolchain });
    if (fast) {
      const stub = new LspClient({ launch: fast });
      try {
        await stub.start(deps.kernel, fileUri(join(deps.rootDir, slot.id)));
        await stub.openDocument(slot.docUri, text, slot.id);
        slot.lsp = stub;
        slot.lspNote = `${fast.serverName} (bundled) — ${launch.serverName} starting`;
        slot.upgrade = { launch, stub, text, note: note ?? `${launch.serverName}` };
        deps.noteUse(slot.id);
        log.info('Bundled server answered first', {
          language: slot.id,
          stub: fast.serverName,
          starting: launch.serverName,
        });
        return;
      } catch (err) {
        // The stub failing is not a reason to fail the slot: fall through and
        // start the real server the old way.
        await stub.stop().catch(() => undefined);
        log.warn('Bundled server did not start — starting the real one directly', {
          language: slot.id,
          error: (err as Error).message,
        });
      }
    }
  }

  const client = new LspClient({ launch });
  try {
    const caps = await client.start(deps.kernel, fileUri(join(deps.rootDir, slot.id)));
    await client.openDocument(slot.docUri, text, slot.id);
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

/**
 * Swap the stub for the real server, once it is up.
 *
 * Everything here is about not clobbering someone else's work: the slot may have
 * been released or restarted while this server was starting, so `isCurrent` gets
 * the last word. Without that check a "restart language server" during startup
 * would leave an orphan holding hundreds of megabytes and nothing pointing at it.
 */
export async function finishLspUpgrade(
  deps: { kernel: Kernel; rootDir: string },
  slot: LaunchSlot,
  upgrade: LspUpgrade,
  isCurrent: () => boolean,
): Promise<void> {
  const log = deps.kernel.logger.forComponent(`ide.workspace.${slot.id}`);
  const client = new LspClient({ launch: upgrade.launch });
  try {
    await client.start(deps.kernel, fileUri(join(deps.rootDir, slot.id)));
    await client.openDocument(slot.docUri, upgrade.text, slot.id);
  } catch (err) {
    await client.stop().catch(() => undefined);
    log.warn('Real language server did not start — the bundled one keeps answering', {
      language: slot.id,
      error: (err as Error).message,
    });
    return;
  }
  if (!isCurrent()) {
    await client.stop().catch(() => undefined);
    return;
  }
  slot.lsp = client;
  slot.lspNote = upgrade.note;
  await upgrade.stub.stop().catch(() => undefined);
  log.info('Real language server took over from the bundled one', {
    language: slot.id,
    server: client.serverName,
  });
}

/**
 * Start the real server just after the first answer, not in the same tick.
 *
 * `stillOwner` answers "is this slot still mine?" — the workspace passes a check
 * against its slot map, so a release or restart during startup wins.
 */
export function scheduleLspUpgrade(
  deps: { kernel: Kernel; rootDir: string },
  slot: LaunchSlot,
  stillOwner: () => boolean,
  delayMs = 300,
): Promise<void> {
  const upgrade = slot.upgrade;
  if (!upgrade) return Promise.resolve();
  slot.upgrade = undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The delay is deliberate: starting a 400 MB server in the same millisecond as
  // the first keystroke makes that keystroke compete with the thing that exists
  // to stay out of its way. An explicit action calls `startUpgradeNow` and opens
  // the gate early — it is waiting anyway.
  const timer = setTimeout(release, delayMs);
  timer.unref?.();
  slot.startUpgradeNow = () => {
    clearTimeout(timer);
    release();
  };
  const run = (async () => {
    await gate;
    slot.startUpgradeNow = undefined;
    await finishLspUpgrade(deps, slot, upgrade, () => slot.lsp === upgrade.stub && stillOwner());
  })();
  slot.upgrading = run;
  void run.then(
    () => {
      if (slot.upgrading === run) slot.upgrading = undefined;
    },
    () => {
      if (slot.upgrading === run) slot.upgrading = undefined;
    },
  );
  return run;
}

/**
 * Wait for a pending upgrade, bounded.
 *
 * A keystroke must never wait for the real server — that is what the stub is
 * for. But goto/references/quick fix are questions the stub cannot answer (it
 * has no references at all), so during the first second of a session they would
 * report "nothing found" for a symbol defined two lines above. Ten seconds is
 * the ceiling: a server that never comes up must not hang the editor.
 */
export async function waitForUpgrade(slot: LaunchSlot, timeoutMs = 10_000): Promise<void> {
  const pending = slot.upgrading;
  if (!pending) return;
  // An action that waits is an action that can afford the server to start now.
  slot.startUpgradeNow?.();
  await Promise.race([
    pending.catch(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
}
