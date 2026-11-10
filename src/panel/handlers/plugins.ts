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
