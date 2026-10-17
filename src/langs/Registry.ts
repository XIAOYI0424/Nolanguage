/**
 * The language registry — where languages come from.
 *
 * Three directories, one format:
 *
 *   <home>/builtin/    official plugins shipped with the binary (not removable)
 *   <home>/languages/  user-installed plugins (removable)
 *   <extra roots>      host-supplied, e.g. the repo's `builtin/` during dev
 *
 * The registry is the *only* source of truth for "which languages exist".
 * Nothing downstream may hardcode a language id, a display name, an extension
 * mapping or a grammar table — those all live in a manifest now.
 *
 * Plugin body vs. user data are separate on purpose: `<plugin>/` is read-only
 * and replaced wholesale on upgrade, `<home>/data/<id>/` is writable and
 * survives uninstall unless the user asks otherwise.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  normaliseExtensions,
  validateManifest,
  type LanguageManifest,
  type ManifestValidation,
  type PluginSource,
} from './manifest.js';

export interface RegistryRoot {
  dir: string;
  kind: 'builtin' | 'user';
  removable: boolean;
}

export interface InstalledPlugin {
  manifest: LanguageManifest;
  source: PluginSource;
  /** Validation outcome; a plugin with issues is listed but never enabled. */
  validation: ManifestValidation;
  enabled: boolean;
}

export interface RegistryChange {
  type: 'added' | 'removed' | 'enabled' | 'disabled' | 'rescan';
  id: string;
}

export interface RegistryOptions {
  /** Where `builtin/`, `languages/`, `data/` and `config.json` live. */
  home?: string;
  /** Explicit roots (tests use this); defaults to `builtin/` + `languages/` under `home`. */
  roots?: RegistryRoot[];
  /** Extra roots appended after the defaults. */
  extraRoots?: RegistryRoot[];
}

interface ConfigFile {
  disabled?: string[];
}

/** Compare two semver strings; higher wins. */
function versionKey(v: string): number {
  const [a = '0', b = '0', c = '0'] = String(v).split('.');
  return Number(a) * 1_000_000 + Number(b) * 1_000 + Number(c);
}

export class LanguageRegistry {
  readonly home: string;
  private roots: RegistryRoot[] = [];
  private plugins = new Map<string, InstalledPlugin>();
  private disabled = new Set<string>();
  private listeners = new Set<(e: RegistryChange) => void>();
  private scanned = false;

  constructor(private opts: RegistryOptions = {}) {
    this.home = resolve(opts.home ?? process.env.NOLANGUAGE_HOME ?? join(homedir(), '.nolanguage'));
    const base: RegistryRoot[] = opts.roots ?? [
      { dir: join(this.home, 'builtin'), kind: 'builtin', removable: false },
      { dir: join(this.home, 'languages'), kind: 'user', removable: true },
    ];
    this.roots = [...base, ...(opts.extraRoots ?? [])];
  }

  // ---------------- paths ----------------

  /** Where a language's writable data lives (sessions, run configs, breakpoints). */
  dataDir(id: string): string {
    return join(this.home, 'data', id);
  }

  /** Where a user-installed plugin would be unpacked. */
  installDir(id: string, version: string): string {
    return join(this.home, 'languages', `${id}@${version}`);
  }

  private configPath(): string {
    return join(this.home, 'config.json');
  }

  // ---------------- lifecycle ----------------

  onDidChange(cb: (e: RegistryChange) => void): { dispose(): void } {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  private emit(e: RegistryChange): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch {
        // A listener must never break a scan.
      }
    }
  }

  private async loadConfig(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.configPath(), 'utf8')) as ConfigFile;
      this.disabled = new Set(Array.isArray(raw.disabled) ? raw.disabled : []);
    } catch {
      this.disabled = new Set();
    }
  }

  private async saveConfig(): Promise<void> {
    await mkdir(this.home, { recursive: true });
    await writeFile(this.configPath(), JSON.stringify({ disabled: [...this.disabled] }, null, 2), 'utf8');
  }

  /**
   * Scan every root. A root that does not exist is not an error — a fresh
   * install has no `languages/` yet.
   *
   * A plugin directory is either `languages/<id>@<version>/` (the canonical
   * layout) or a flat `<name>/` containing `manifest.json`; both are accepted
   * so a hand-unzipped plugin works.
   */
  async scan(): Promise<void> {
    await this.loadConfig();
    const found = new Map<string, InstalledPlugin>();

    for (const root of this.roots) {
      if (!existsSync(root.dir)) continue;
      let entries: string[];
      try {
        entries = await readdir(root.dir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        const dir = join(root.dir, entry);
        const manifestPath = join(dir, 'manifest.json');
        if (!existsSync(manifestPath)) continue;
        try {
          const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
          const validation = validateManifest(raw);
          const manifest = raw as LanguageManifest;
          if (!validation.ok || !manifest.id) continue;
          const id = manifest.id;
          const candidate: InstalledPlugin = {
            manifest,
            source: { kind: root.kind, dir, removable: root.removable },
            validation,
            enabled: !this.disabled.has(id),
          };
          const prev = found.get(id);
          // Higher version wins; on a tie the earlier root wins (builtin before
          // user), which keeps an official plugin from being shadowed by a
          // stale copy of itself.
          if (!prev || versionKey(candidate.manifest.version) > versionKey(prev.manifest.version)) {
            found.set(id, candidate);
          }
        } catch {
          // A malformed manifest is skipped, not fatal: one bad plugin must not
          // take the language list down with it.
        }
      }
    }

    this.plugins = found;
    this.scanned = true;
    this.emit({ type: 'rescan', id: '*' });
  }

  private ensureScanned(): void {
    if (!this.scanned) {
      // Callers may use the registry synchronously after `scan()`; using it
      // before that is a programming error worth surfacing loudly.
      throw new Error('LanguageRegistry.scan() must be awaited before use');
    }
  }

  // ---------------- queries ----------------

  all(): LanguageManifest[] {
    this.ensureScanned();
    return [...this.plugins.values()]
      .filter((p) => p.enabled)
      .map((p) => p.manifest)
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  }

  /** Every known plugin, enabled or not. */
  installed(): InstalledPlugin[] {
    this.ensureScanned();
    return [...this.plugins.values()];
  }

  get(id: string): LanguageManifest | undefined {
    this.ensureScanned();
    const p = this.plugins.get(id);
    return p && p.enabled ? p.manifest : undefined;
  }

  /** The plugin record, including a disabled one. */
  entry(id: string): InstalledPlugin | undefined {
    this.ensureScanned();
    return this.plugins.get(id);
  }

  sourceOf(id: string): PluginSource | undefined {
    this.ensureScanned();
    return this.plugins.get(id)?.source;
  }

  /** Look up by file extension, with or without the leading dot. */
  byExtension(ext: string): LanguageManifest | undefined {
    this.ensureScanned();
    const needle = String(ext).replace(/^\./, '').toLowerCase();
    if (!needle) return undefined;
    for (const m of this.all()) {
      if (normaliseExtensions(m.file).includes(needle)) return m;
    }
    return undefined;
  }

  /** Look up by file name (`main.rs` → rust). */
  byFileName(name: string): LanguageManifest | undefined {
    const dot = String(name).lastIndexOf('.');
    if (dot < 0) return undefined;
    return this.byExtension(String(name).slice(dot + 1));
  }

  /** Ids that declare a language server. */
  withLsp(): LanguageManifest[] {
    return this.all().filter((m) => m.lsp && !m.lsp.disabled);
  }

  /** Ids that can execute code. */
  runnable(): LanguageManifest[] {
    return this.all().filter((m) => !!m.run);
  }

  // ---------------- enable / disable ----------------

  async disable(id: string): Promise<void> {
    this.ensureScanned();
    if (!this.plugins.has(id)) throw new Error(`unknown language: ${id}`);
    this.disabled.add(id);
    const p = this.plugins.get(id);
    if (p) p.enabled = false;
    await this.saveConfig();
    this.emit({ type: 'disabled', id });
  }

  async enable(id: string): Promise<void> {
    this.ensureScanned();
    if (!this.plugins.has(id)) throw new Error(`unknown language: ${id}`);
    this.disabled.delete(id);
    const p = this.plugins.get(id);
    if (p) p.enabled = true;
    await this.saveConfig();
    this.emit({ type: 'enabled', id });
  }

  isEnabled(id: string): boolean {
    this.ensureScanned();
    return !!this.plugins.get(id)?.enabled;
  }

  // ---------------- install / uninstall ----------------

  /**
   * Copy a plugin directory into `languages/<id>@<version>/`.
   *
   * Only the *body* is copied — user data under `data/<id>/` is never touched
   * by an install, so reinstalling cannot destroy run configs.
   */
  async install(srcDir: string): Promise<{ id: string; version: string; dir: string }> {
    const manifestPath = join(srcDir, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`no manifest.json in ${srcDir}`);
    const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    const validation = validateManifest(raw);
    if (!validation.ok) {
      const detail = validation.issues.map((i) => `${i.field}: ${i.message}`).join('; ');
      throw new Error(`invalid manifest: ${detail}`);
    }
    const manifest = raw as LanguageManifest;
    const target = this.installDir(manifest.id, manifest.version);
    await mkdir(join(this.home, 'languages'), { recursive: true });
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    await cp(srcDir, target, { recursive: true });
    await this.scan();
    this.emit({ type: 'added', id: manifest.id });
    return { id: manifest.id, version: manifest.version, dir: target };
  }

  /**
   * Remove every installed version of a plugin. Builtin plugins are not
   * removable — they can only be disabled, because they ship with the binary.
   * `keepData` defaults to true: uninstalling a language must not silently
   * throw away the user's breakpoints and run configurations.
   */
  async uninstall(id: string, opts: { keepData?: boolean } = {}): Promise<boolean> {
    this.ensureScanned();
    const p = this.plugins.get(id);
    if (!p) return false;
    if (!p.source.removable) throw new Error(`"${id}" is a builtin plugin — disable it instead of uninstalling`);
    await rm(p.source.dir, { recursive: true, force: true }).catch(() => undefined);
    if (opts.keepData === false) {
      await rm(this.dataDir(id), { recursive: true, force: true }).catch(() => undefined);
    }
    this.plugins.delete(id);
    this.emit({ type: 'removed', id });
    return true;
  }

  /** Create the writable data directory for a language, on demand. */
  async ensureDataDir(id: string): Promise<string> {
    const dir = this.dataDir(id);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Human-readable summary, used by `/health` and the verification suite. */
  describe(): Array<{
    id: string;
    version: string;
    kind: 'builtin' | 'user';
    enabled: boolean;
    removable: boolean;
    extensions: string[];
    runMode?: string;
    dir: string;
  }> {
    this.ensureScanned();
    return this.installed().map((p) => ({
      id: p.manifest.id,
      version: p.manifest.version,
      kind: p.source.kind,
      enabled: p.enabled,
      removable: p.source.removable,
      extensions: normaliseExtensions(p.manifest.file),
      runMode: p.manifest.run?.mode,
      dir: p.source.dir,
    }));
  }
}

/** Directory name of a plugin folder (`rust@1.0.0`), for diagnostics. */
export function pluginFolderName(id: string, version: string): string {
  return `${id}@${version}`;
}

/** Is `dir` a plugin directory (has a manifest)? */
export async function isPluginDir(dir: string): Promise<boolean> {
  try {
    const s = await stat(join(dir, 'manifest.json'));
    return s.isFile();
  } catch {
    return false;
  }
}

/** The last path segment, handy in log lines. */
export function pluginDirName(dir: string): string {
  return basename(dir);
}
