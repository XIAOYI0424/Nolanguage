/**
 * `--dump-plugins` — print where every language plugin was found and which copy
 * won.
 *
 * The panel can show the plugin list, but not *why* that list looks the way it
 * does: two layers may contain the same id, a plugin may be disabled in
 * `config.json`, an override file may have rewritten its LSP command, and an
 * official plugin may be shadowed by a newer copy elsewhere. This dump answers
 * those questions without starting the server.
 *
 * Every fact printed here comes from `LanguageRegistry` itself (layers,
 * conflicts, overrides) — a second opinion would eventually disagree with the
 * one that actually loads plugins.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LanguageRegistry } from '../langs/Registry.js';
import { validateManifest, type LanguageManifest } from '../langs/manifest.js';
import { LAYER_LABELS, type PluginLayer } from '../langs/layers.js';

export interface DumpIo {
  out(line?: string): void;
}

export interface DumpOptions {
  /** Plugin home; defaults to `NOLANGUAGE_HOME` / `~/.nolanguage`. */
  home?: string;
  io?: DumpIo;
}

/** One plugin directory found in one layer, before the registry picks a winner. */
interface Candidate {
  layer: PluginLayer;
  dir: string;
  id: string;
  version: string;
  manifest: LanguageManifest;
  issues: string[];
}

/** Print the plugin landscape and return a process exit code. */
export async function dumpPlugins(opts: DumpOptions = {}): Promise<number> {
  const io = opts.io ?? { out: (line = '') => process.stdout.write(`${line}\n`) };
  const registry = new LanguageRegistry({ home: opts.home });
  await registry.scan();

  const layers = registry.pluginLayers();
  const candidates: Candidate[] = [];
  for (const layer of layers) {
    if (!existsSync(layer.dir)) continue;
    let entries: string[];
    try {
      entries = (await readdir(layer.dir)).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(layer.dir, entry);
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      let manifest: LanguageManifest;
      let issues: string[] = [];
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as LanguageManifest;
        const validation = validateManifest(manifest);
        issues = validation.ok ? [] : validation.issues.map((i) => `${i.field}: ${i.message}`);
      } catch (err) {
        // Unreadable JSON is worth printing: it is the usual reason a plugin
        // "exists" on disk yet never shows up in the panel.
        io.out(`  ! ${manifestPath}  (${(err as Error).message})`);
        continue;
      }
      if (!manifest.id) continue;
      candidates.push({
        layer,
        dir,
        id: manifest.id,
        version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        manifest,
        issues,
      });
    }
  }

  const winners = new Map(registry.describe().map((row) => [row.id, row.dir]));
  const disabled = registry.describe().filter((row) => !row.enabled).map((row) => row.id);
  const overrides = registry.overrides();
  const problems = registry.overrideIssues();

  io.out('Nolanguage 插件清单');
  io.out('====================');
  io.out(`home    ${registry.home}`);
  io.out(`config  ${join(registry.home, 'config.json')}${disabled.length ? `  (disabled: ${disabled.length})` : ''}`);
  io.out();

  const seenLayerIds = new Set<string>();
  layers.forEach((layer, index) => {
    // Two `builtin` tiers are normal (the home copy and the shipped/embedded
    // one); say so rather than printing the same heading twice.
    const repeated = seenLayerIds.has(layer.id);
    seenLayerIds.add(layer.id);
    io.out(`Layer ${index} · ${LAYER_LABELS[layer.id]}${repeated ? ' · 附加根' : ''}`);
    io.out(`  ${layer.dir}${existsSync(layer.dir) ? '' : '  （不存在）'}`);
    const inLayer = candidates.filter((c) => c.layer.dir === layer.dir);
    if (!inLayer.length) {
      io.out('  （无插件）');
    } else {
      for (const c of inLayer) {
        io.out(`  ${formatCandidate(c, winners.get(c.id) === c.dir)}`);
        for (const issue of c.issues) io.out(`    ! ${issue}`);
      }
    }
    io.out();
  });

  io.out('选中规则  版本高者胜；同版本先扫描的层胜（project → builtin → user → cli → system）');
  const conflicts = registry.conflicts();
  io.out(`遮蔽      ${conflicts.length ? '' : '（无）'}`);
  for (const conflict of conflicts) {
    for (const loser of conflict.losers) {
      io.out(`  ${conflict.id}@${loser.version}  ${loser.layer.padEnd(7)} ${loser.dir}`);
    }
    io.out(`    ← ${conflict.winner.layer.padEnd(7)} ${conflict.winner.dir} 胜出`);
  }
  io.out();

  io.out(`覆盖层    ${overrides.length || problems.length ? '' : '（无）'}`);
  for (const item of overrides) {
    io.out(`  ${item.id}  ${item.file}`);
    for (const field of item.changed) io.out(`    ${field}  已覆盖`);
    for (const field of item.stale) io.out(`    ! ${field}  在 manifest 中不存在（过期键）`);
  }
  for (const problem of problems) io.out(`  ! ${problem}`);
  if (overrides.length || problems.length) io.out();

  io.out('状态');
  const enabled = registry.describe().filter((row) => row.enabled).map((row) => row.id);
  io.out(`  enabled   ${enabled.length ? enabled.join(', ') : '（无）'}`);
  io.out(`  disabled  ${disabled.length ? disabled.join(', ') : '（无）'}`);
  return 0;
}

/** `python@1.0.0   run repl-session   lsp pyright   <dir>` */
function formatCandidate(c: Candidate, won: boolean): string {
  const fields = [
    `${c.id}@${c.version}`.padEnd(20),
    `run ${c.manifest.run?.mode ?? '-'}`.padEnd(24),
    `lsp ${c.manifest.lsp?.serverName ?? '-'}`.padEnd(20),
    c.dir,
  ];
  return `${fields.join(' ')}${won ? '' : '  (未选中)'}`;
}
