/**
 * The one place that answers "what language is this file?".
 *
 * # Why it is one place now
 *
 * There were five answers, and they disagreed:
 *
 *   `FsService.EXT_LANGUAGE`   `ts -> 'typescript'`   (explorer, LSP open)
 *   `ideaImport.EXT_LANGUAGE`  `ts -> 'javascript'`   (run configurations)
 *   `debugtool.languageOf`     three branches, no markdown, no ts at all
 *   client `EXT_LANG`          a pre-connect bootstrap, replaced by the catalog
 *   `manifest.file.extensions` the truth
 *
 * The `.ts` disagreement was the visible symptom: `typescript` is not a
 * language this product has — no plugin, no manifest, no server, no runtime —
 * so a `.ts` file got a language id nothing could act on, while the same file
 * in a run configuration was called `javascript`. Both now resolve to
 * `javascript`, which is the plugin that actually exists (and whose language
 * server, tsserver, handles TypeScript).
 *
 * # Three layers, in priority order
 *
 *   1. a manifest's `file.extensions` — whatever the registry says wins;
 *   2. `BUILTIN_EXTENSION_DEFAULTS` — for processes with no registry at all
 *      (the standalone debugger) and as the value before the first scan;
 *   3. `NO_PLUGIN` — languages that are highlighted and never run.
 *
 * The gate asserts layer 2 never contradicts layer 1, so the defaults cannot
 * silently drift from the manifests they stand in for.
 */

/** Languages with no plugin: the editor colours them, nothing else. */
const NO_PLUGIN: Record<string, string> = {
  json: 'json',
  jsonc: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  bash: 'shell',
  bat: 'shell',
  cmd: 'shell',
  ps1: 'shell',
  html: 'html',
  htm: 'html',
  css: 'css',
  sql: 'sql',
  txt: 'text',
  log: 'text',
  cfg: 'text',
  ini: 'text',
  env: 'text',
  gitignore: 'text',
};

/**
 * Defaults for the built-in plugins.
 *
 * Used by processes that never scan a registry (`NDebug.exe`) and as the value
 * before the panel's first scan. `verify:langparity` fails if any of these
 * contradicts the manifest that claims the same extension.
 */
export const BUILTIN_EXTENSION_DEFAULTS: Record<string, string> = {
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  // No manifest claims these: there is no TypeScript plugin, and the JavaScript
  // one is what can actually run and check them.
  ts: 'javascript',
  tsx: 'javascript',
  go: 'go',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
};

export interface ExtensionOwner {
  id: string;
  file?: { extensions?: string[] };
}

const normalize = (ext: string): string => ext.trim().toLowerCase().replace(/^\./, '');

/**
 * Build the lookup. Later layers overwrite earlier ones, so a manifest always
 * beats a default and a default always beats the no-plugin table.
 */
export function buildExtensionIndex(manifests: readonly ExtensionOwner[]): Map<string, string> {
  const index = new Map<string, string>(Object.entries(NO_PLUGIN));
  for (const [ext, id] of Object.entries(BUILTIN_EXTENSION_DEFAULTS)) index.set(ext, id);
  for (const m of manifests) {
    for (const ext of m.file?.extensions ?? []) {
      const key = normalize(ext);
      if (key) index.set(key, m.id);
    }
  }
  return index;
}

/** The live index. Starts as defaults so a pre-scan lookup still answers. */
let current = buildExtensionIndex([]);

/** Called once after the registry scans; replaces the defaults with the truth. */
export function setExtensionManifests(manifests: readonly ExtensionOwner[]): void {
  current = buildExtensionIndex(manifests);
}

/** Extension (with or without a dot) to language id. */
export function languageForExtension(ext: string): string | undefined {
  return current.get(normalize(ext));
}

/**
 * File name to language id.
 *
 * Dotfiles count: `.gitignore` has no dot-suffix to strip, but the name itself
 * is a meaningful key.
 */
export function languageForName(name: string): string | undefined {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return current.get(lower.replace(/^\./, ''));
  return current.get(lower.slice(dot + 1));
}
