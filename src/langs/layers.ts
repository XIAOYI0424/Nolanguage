/**
 * Explicit tiers for language plugins.
 *
 * Before this module a registry root was just a directory in an array, and the
 * order of that array was the only thing that said which copy of a plugin
 * "wins". That is fine for the two roots the registry owns and useless for
 * anyone looking at a machine where four of them exist.
 *
 * A layer names a tier, a directory, and whether its body is read-only. The
 * `order` field is the scan order, **first wins**: `LanguageRegistry.scan()`
 * keeps the highest version of an id and, when two roots ship the same version,
 * the one scanned first. That tie rule is deliberate — it is what stops a
 * user-installed copy of an official plugin from shadowing the shipped one just
 * by existing — so layers describe *where* a plugin came from rather than
 * pretending to override it by rank. Forcing a change is the override layer's
 * job (`overrides/<id>.json`), not a priority war.
 */
import { join, resolve } from 'node:path';
import { officialRoots, splitEnvList } from './pluginRoots.js';
import type { RegistryRoot } from './types.js';

export type { RegistryRoot } from './types.js';



export type LayerId = 'project' | 'builtin' | 'user' | 'cli' | 'system';

export interface PluginLayer extends RegistryRoot {
  /** Stable tier name, printed by `--dump-plugins`. */
  id: LayerId;
  /** Scan order, ascending. Ties on version go to the smaller number. */
  order: number;
  /** `true` for tiers whose bodies ship with the product (never uninstalled). */
  readOnly: boolean;
}

/** Human labels used by the dump; the CLI prints Chinese, logs stay ASCII. */
export const LAYER_LABELS: Record<LayerId, string> = {
  project: 'project（当前工作区 .nolanguage/languages）',
  builtin: 'builtin（随产品分发，只读）',
  user: 'user（<home>/languages）',
  cli: 'cli（LANG_DIR，只读）',
  system: 'system（%PROGRAMDATA%\\Nolanguage\\languages）',
};

export interface LayerOptions {
  /** Directory the IDE was started from; the project tier is relative to it. */
  cwd?: string;
  /** Machine-wide plugin root; `undefined` disables the tier. */
  systemDir?: string;
}

/**
 * The default tiers, in scan order.
 *
 * `project` is scanned first so a workspace copy of a plugin beats the shipped
 * one at the same version — that is the whole point of a per-project tier. The
 * remaining tiers keep the historical order exactly (`builtin` → `user` →
 * `LANG_DIR` → repo/embedded builtins), because changing it would silently
 * change which copy of an official plugin a machine runs today.
 */
export function defaultLayers(home: string, opts: LayerOptions = {}): PluginLayer[] {
  const cwd = opts.cwd ?? process.cwd();
  const programData = process.env.PROGRAMDATA;
  const systemDir =
    opts.systemDir ?? (programData ? join(programData, 'Nolanguage', 'languages') : undefined);

  const layers: PluginLayer[] = [
    {
      id: 'project',
      order: 0,
      dir: join(cwd, '.nolanguage', 'languages'),
      kind: 'user',
      removable: true,
      readOnly: false,
    },
    { id: 'builtin', order: 10, dir: join(home, 'builtin'), kind: 'builtin', removable: false, readOnly: true },
    { id: 'user', order: 20, dir: join(home, 'languages'), kind: 'user', removable: true, readOnly: false },
  ];

  // `LANG_DIR` entries are the "point me at another tree" tier; they are
  // read-only for the same reason a shipped plugin is: the host owns them.
  const envDirs = splitEnvList(process.env.LANG_DIR);
  let nextOrder = 30;
  for (const dir of envDirs) {
    const abs = resolve(dir);
    if (layers.some((l) => l.dir.toLowerCase() === abs.toLowerCase())) continue;
    layers.push({ id: 'cli', order: nextOrder++, dir: abs, kind: 'builtin', removable: false, readOnly: true });
  }
  for (const root of officialRoots()) {
    // `officialRoots()` already includes `LANG_DIR`; skip those (added above
    // with the `cli` label) so the same directory is not scanned twice.
    if (layers.some((l) => l.dir.toLowerCase() === root.dir.toLowerCase())) continue;
    layers.push({ ...root, id: 'builtin', order: nextOrder++, readOnly: true });
  }
  if (systemDir && !layers.some((l) => l.dir.toLowerCase() === systemDir.toLowerCase())) {
    layers.push({
      id: 'system',
      order: nextOrder++,
      dir: systemDir,
      kind: 'user',
      removable: true,
      readOnly: false,
    });
  }
  return layers;
}

/** Adapter for hosts that still pass bare roots (tests, older callers). */
export function layersFromRoots(roots: RegistryRoot[]): PluginLayer[] {
  return roots.map((root, index) => ({
    ...root,
    id: root.kind === 'builtin' ? 'builtin' : 'user',
    order: index,
    readOnly: !root.removable,
  }));
}
