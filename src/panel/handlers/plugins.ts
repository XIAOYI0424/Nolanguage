/**
 * The payload the Plugins page renders, and the roots the registry scans.
 *
 * Both are derived from manifests plus the Phase 4 budget — the page never has
 * a language id of its own, which is the same rule the IDE follows.
 */
import type { WorkspaceService } from '../WorkspaceService.js';
import { bufferName, normaliseExtensions } from '../../langs/manifest.js';
import type { RegistryRoot } from '../../langs/Registry.js';
import { officialRoots } from '../../langs/pluginRoots.js';
import {
  fetchIndex,
  mergeEntries,
  resolveEntry,
  resolveSources,
  searchEntries,
  type PluginIndexEntry,
} from '../../langs/Catalog.js';
import { disposeSource, resolveSource } from '../../langs/SourceResolver.js';
import { parseSha256 } from '../../util/hash.js';
import { resolve } from 'node:path';

/**
 * The payload the Plugins page renders.
 *
 * Everything here is derived from manifests plus the Phase 4 budget — the page
 * never has a language id of its own, which is the same rule the IDE follows.
 */
export function pluginPayload(workspace: WorkspaceService): Record<string, unknown> {
  const registry = workspace.languages;
  const budget = workspace.resourceSummary();
  const budgetOf = new Map(budget.profiles.map((p) => [p.languageId, p]));
  const slots = new Map(workspace.status().languages.map((l) => [l.id, l]));
  // Layer, override and shadow data only exist after a scan; asking the
  // registry before that throws, and the page must still render.
  const scanned = registry.isScanned();
  const overrideOf = new Map((scanned ? registry.overrides() : []).map((o) => [o.id, o]));
  const plugins = (scanned ? registry.installed() : []).map((p) => {
    const m = p.manifest;
    const res = budgetOf.get(m.id);
    const slot = slots.get(m.id);
    const override = overrideOf.get(m.id);
    return {
      id: m.id,
      displayName: m.displayName,
      version: m.version,
      publisher: m.publisher ?? '',
      description: m.description ?? '',
      kind: p.source.kind,
      removable: p.source.removable,
      enabled: p.enabled,
      extensions: normaliseExtensions(m.file),
      fileName: bufferName(m),
      runMode: m.run?.mode,
      needsRunner: !!m.run,
      runnerError: slot?.runnerError ?? '',
      lspServerName: m.lsp?.serverName,
      debugAdapter: m.debug?.adapter,
      profilerAdapter: m.profiler?.adapter,
      memoryBytes: res?.memoryBytes ?? 0,
      memoryRunning: res?.lspRunning ?? false,
      migrations: (m.migrations ?? []).length,
      validation: p.validation.issues,
      validationOk: p.validation.ok,
      dir: p.source.dir,
      // Which tier supplied this body, and what `overrides/<id>.json` changed.
      // The page's job is to make "why is this plugin here / why is its LSP
      // command different" answerable without a terminal.
      layer: (scanned ? registry.layerOf(m.id)?.id : undefined) ?? p.source.kind,
      readOnly: (scanned ? registry.layerOf(m.id)?.readOnly : undefined) ?? !p.source.removable,
      overrides: override
        ? { file: override.file, changed: override.changed, stale: override.stale }
        : undefined,
    };
  });
  return {
    kind: 'plugins',
    plugins,
    resource: budget,
    runtimes: workspace.runtimes.list(),
    // Same id in several tiers: the losers are not installed, but seeing them is
    // the only way to understand a plugin that "should" be a different version.
    conflicts: scanned ? registry.conflicts() : [],
    overrideProblems: scanned ? registry.overrideIssues() : [],
    home: registry.home,
  };
}


/**
 * Extra roots scanned for language plugins (`<id>@<version>/manifest.json`).
 *
 * The registry itself owns `~/.nolanguage/builtin` and `~/.nolanguage/languages`;
 * these are the *development* and *packaged* sources of the official plugins,
 * which must not have to be copied into the home directory before first run.
 *
 * `LANG_DIR` (`:`/`;` separated) lets a host or a test point at its own tree.
 */
export function languageRoots(): RegistryRoot[] {
  // Shared with the CLI and `--dump-plugins` so the three cannot drift apart.
  return officialRoots();
}

/**
 * Every reachable index, merged by id (highest version wins).
 *
 * A source that is offline or malformed is reported rather than fatal: the
 * page still has to render, and one broken mirror must not hide the others.
 */
async function loadIndex(home: string): Promise<{ entries: PluginIndexEntry[]; errors: string[] }> {
  const sources = resolveSources(home, []);
  const loaded: Array<{ source: { id: string; url: string; priority?: number }; index: { plugins: PluginIndexEntry[] } }> = [];
  const errors: string[] = [];
  for (const s of sources) {
    try {
      loaded.push(await fetchIndex(s));
    } catch (err) {
      errors.push(`${s.id} (${s.url}): ${(err as Error).message}`);
    }
  }
  return { entries: mergeEntries(loaded), errors };
}

/**
 * What the Plugins page's "install from the index" list renders.
 *
 * `unavailable` is explicit instead of an empty list: "the index answered and
 * has nothing" and "nothing answered" are different facts, and the page must
 * not show the first when it means the second.
 */
export async function handleCatalogSearch(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (payload: unknown) => void,
): Promise<void> {
  const query = typeof msg.query === 'string' ? msg.query.slice(0, 120) : '';
  const { entries, errors } = await loadIndex(workspace.languages.home);
  if (!entries.length) {
    reply({
      kind: 'catalog',
      query,
      entries: [],
      unavailable: errors.join('; ') || 'no plugin index is configured',
    });
    return;
  }
  const installed = new Set(
    (workspace.languages.isScanned() ? workspace.languages.installed() : []).map((p) => p.manifest.id),
  );
  const rows = searchEntries(entries, query)
    .slice(0, 200)
    .map((e) => ({
      id: e.id,
      version: e.version,
      displayName: e.displayName ?? e.id,
      description: e.description ?? '',
      // Whether the entry carries a hash the installer will check — the page
      // says so, because "verified" and "unverified" installs differ.
      sha256: parseSha256(e.sha256) !== undefined,
      installed: installed.has(e.id),
    }));
  reply({ kind: 'catalog', query, entries: rows, ...(errors.length ? { unavailable: errors.join('; ') } : {}) });
}

/**
 * Install a plugin from a directory the client chose, or by id from the index.
 *
 * The id path is the only one that can be hash-verified, and it refuses an
 * entry without a hash: a remote index is the exact threat model for integrity
 * checking, so silently installing unverified code would defeat the feature.
 */
export async function installPlugin(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
): Promise<{ id: string; version: string; dir: string; unverified?: boolean }> {
  const id = String(msg.id ?? '').trim();
  if (!id) {
    const dir = String(msg.dir ?? '').trim();
    if (!dir) throw new Error('dir or id is required');
    const installed = await workspace.languages.install(resolve(dir));
    return { id: installed.id, version: installed.version, dir: installed.dir };
  }
  const { entries, errors } = await loadIndex(workspace.languages.home);
  const hit = resolveEntry(entries, id);
  if (!hit) {
    const why = errors.length ? ` (${errors.join('; ')})` : '';
    throw new Error(`"${id}" is not in any plugin index${why}`);
  }
  const wantVersion = typeof msg.version === 'string' ? msg.version.trim() : '';
  if (wantVersion && hit.version !== wantVersion) {
    throw new Error(`the index now serves ${hit.id}@${hit.version}, not ${wantVersion} — search again`);
  }
  const sha = parseSha256(hit.sha256);
  const allowUnverified = msg.allowUnverified === true;
  if (!sha && !allowUnverified) {
    throw new Error(
      `"${hit.id}" has no sha256 in the index — refusing to install code that cannot be verified (set allowUnverified to accept the risk)`,
    );
  }
  const source = await resolveSource(hit.downloadUrl, {
    ...(sha ? { expectSha256: sha } : {}),
    allowUnverifiedRemote: allowUnverified,
  });
  try {
    const installed = await workspace.languages.install(source.dir);
    return {
      id: installed.id,
      version: installed.version,
      dir: installed.dir,
      ...(sha ? {} : { unverified: true }),
    };
  } finally {
    await disposeSource(source);
  }
}

export interface PluginOpDeps {
  workspace: WorkspaceService;
  /** Answer the requesting client only. */
  reply: (payload: unknown) => void;
  /** Repaint every attached client after a successful operation. */
  broadcast: () => void;
  /** The server owns the logger; this module only describes what happened. */
  log: (level: 'info' | 'warn', message: string, fields: Record<string, unknown>) => void;
}

/**
 * One plugin operation from the Plugins page.
 *
 * Every op answers on the requesting client with `pluginOp { ok }`, and a
 * success re-broadcasts the whole list so a second tab (or the IDE) sees the
 * change too. Failures are answers, not exceptions: a user who points the
 * installer at a directory that is not a plugin must be told *why*, not dropped.
 */
export async function handlePluginOp(deps: PluginOpDeps, msg: Record<string, unknown>): Promise<void> {
  const { workspace, reply, broadcast, log } = deps;
  const op = String(msg.kind ?? '');
  const id = String(msg.id ?? '');
  const answer = (ok: boolean, extra: Record<string, unknown> = {}): void => {
    reply({ kind: 'pluginOp', ok, op, id, ...extra });
    if (ok) broadcast();
  };
  try {
    if (op === 'langInstall') {
      const installed = await installPlugin(workspace, msg);
      await workspace.pluginsSynced();
      log('info', 'Plugin installed', {
        id: installed.id,
        version: installed.version,
        ...(installed.unverified ? { unverified: true } : {}),
      });
      answer(true, { installed });
      return;
    }
    if (op === 'langEnable') {
      await workspace.languages.enable(id);
      await workspace.pluginsSynced();
      answer(true);
      return;
    }
    if (op === 'langDisable') {
      await workspace.languages.disable(id);
      await workspace.pluginsSynced();
      answer(true);
      return;
    }
    if (op === 'langUninstall') {
      const keepData = msg.keepData !== false;
      const gone = await workspace.languages.uninstall(id, { keepData });
      await workspace.pluginsSynced();
      if (!gone) throw new Error(`"${id}" is not installed`);
      answer(true);
      return;
    }
    answer(false, { error: `unknown plugin op: ${op}` });
  } catch (err) {
    log('warn', 'Plugin operation failed', { op, id, error: (err as Error).message });
    answer(false, { error: (err as Error).message });
  }
}
