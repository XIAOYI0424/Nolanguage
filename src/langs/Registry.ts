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
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  normaliseExtensions,
  validateManifest,
  type LanguageManifest,
  type ManifestValidation,
  type MigrationSpec,
  type PluginSource,
} from './manifest.js';
import type { RuntimeRegistry } from '../runtimes/RuntimeRegistry.js';

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
  /**
   * The host's runtime catalogue, used to check `run.requires`. When absent the
   * default set is imported lazily on first use.
   */
  runtimes?: RuntimeRegistry;
}

export interface InstallOptions {
  /**
   * Refuse to install when `run.requires` cannot be met, instead of installing
   * and reporting. The check happens before anything is copied, so a refusal
   * leaves the previous body untouched.
   */
  strictDeps?: boolean;
}

/** The outcome of checking one plugin's `run.requires`. */
export interface RequirementReport {
  ok: boolean;
  /** The requirement strings that were not met, e.g. `["quantum@^2.0.0"]`. */
  unmet: string[];
  /** What this build provides — named so an unmet requirement has context. */
  available: Array<{ id: string; version: string }>;
  requires: string[];
}

/**
 * Explain an unmet requirement. A runtime is a capability of this build, not an
 * installable plugin, so "install X" would be a lie — say what is missing, what
 * exists, and what kind of thing it is.
 */
export function describeUnmet(id: string, report: RequirementReport): string {
  const available = report.available.length
    ? report.available.map((r) => `${r.id} ${r.version}`).join(', ')
    : 'none';
  return (
    `"${id}" requires ${report.unmet.join(', ')}, which this build does not provide ` +
    `(available runtimes: ${available}). ` +
    'A runtime is a host capability rather than an installable language plugin, ' +
    'so it cannot be added by installing something else.'
  );
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
  /** Injected runtime catalogue (host-provided) or lazily imported default. */
  private runtimes?: RuntimeRegistry;
  private lazyRuntimes?: RuntimeRegistry;
  private roots: RegistryRoot[] = [];
  private plugins = new Map<string, InstalledPlugin>();
  private disabled = new Set<string>();
  private listeners = new Set<(e: RegistryChange) => void>();
  private scanned = false;

  constructor(private opts: RegistryOptions = {}) {
    this.home = resolve(opts.home ?? process.env.NOLANGUAGE_HOME ?? join(homedir(), '.nolanguage'));
    this.runtimes = opts.runtimes;
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

  /**
   * True once `scan()` has completed. Hosts that bind closures (the profiler,
   * the Plugins page) can poll this instead of guessing.
   */
  isScanned(): boolean {
    return this.scanned;
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
   * Copy a plugin directory into `languages/<id>@<version>/` and migrate data.
   *
   * Two things happen before the body is replaced:
   *
   *   1. **Migrations run.** A plugin whose data layout changed between versions
   *      ships `migrations/1.0.0-to-1.1.0.js` and declares it in its manifest;
   *      each step is a subprocess invoked with the data directory, and steps
   *      that already ran are skipped (recorded in `data/<id>/migrations.json`).
   *   2. **A failed migration aborts the install.** The old plugin directory is
   *      left untouched, so a broken upgrade downgrades the plugin to "unchanged"
   *      rather than "unusable".
   *
   * Only the *body* is copied — user data under `data/<id>/` is never touched by
   * the copy itself, so reinstalling cannot destroy run configs. The migrations
   * are the one thing allowed to change it, on purpose.
   *
   * `manifest.run.requires` is checked *before* anything is copied. Those are
   * requirements on **host runtimes** (`template`, `repl-session`, …), which are
   * capabilities compiled into this build rather than installable plugins, so an
   * unmet one cannot be fixed by installing something else — it is reported, and
   * `strictDeps` turns it into a refusal that leaves the old body intact. The
   * runner performs the same check at run time; doing it here means a plugin
   * that can never run is announced at install time instead of at first Run.
   */
  async install(
    srcDir: string,
    opts: InstallOptions = {},
  ): Promise<{ id: string; version: string; dir: string; migrated: string[]; requirements: RequirementReport }> {
    const manifestPath = join(srcDir, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`no manifest.json in ${srcDir}`);
    const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    const validation = validateManifest(raw);
    if (!validation.ok) {
      const detail = validation.issues.map((i) => `${i.field}: ${i.message}`).join('; ');
      throw new Error(`invalid manifest: ${detail}`);
    }
    const manifest = raw as LanguageManifest;

    // Dependencies first: a refusal must happen before the body is replaced.
    const requirements = await this.checkRequirements(manifest);
    if (!requirements.ok && opts.strictDeps) {
      throw new Error(`${manifest.id} cannot be installed: ${describeUnmet(manifest.id, requirements)}`);
    }

    const previous = this.plugins.get(manifest.id);
    const migrated = await this.runMigrations(manifest, previous?.manifest, srcDir);
    const target = this.installDir(manifest.id, manifest.version);
    await mkdir(join(this.home, 'languages'), { recursive: true });
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    await cp(srcDir, target, { recursive: true });
    // An older copy of the same plugin must not linger: `scan()` keeps the
    // highest version anyway, but leaving 1.0.0 on disk after installing 1.1.0
    // just confuses anyone looking at the directory.
    if (previous?.source.removable && previous.source.dir !== target && resolve(previous.source.dir) !== resolve(srcDir)) {
      await rm(previous.source.dir, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.scan();
    this.emit({ type: 'added', id: manifest.id });
    return { id: manifest.id, version: manifest.version, dir: target, migrated, requirements };
  }

  /**
   * Check one manifest's `run.requires` against the host's runtimes.
   *
   * The runtime registry is injected when a host has one; otherwise the default
   * set is imported lazily, so a registry that never sees a `requires` line
   * never pays for it.
   */
  async checkRequirements(manifest: LanguageManifest): Promise<RequirementReport> {
    const requires = manifest.run?.requires ?? [];
    if (!requires.length) return { ok: true, unmet: [], available: [], requires: [] };
    const runtimes = this.runtimes ?? (await this.defaultRuntimes());
    const result = runtimes.satisfiesAll(requires);
    return {
      ok: result.ok,
      unmet: result.unmet,
      available: runtimes.list(),
      requires: [...requires],
    };
  }

  private async defaultRuntimes(): Promise<RuntimeRegistry> {
    if (!this.lazyRuntimes) {
      // Dynamic on purpose: this keeps `src/langs` free of a static dependency
      // on the runtime implementations.
      const mod = (await import('../runtimes/index.js')) as { defaultRuntimeRegistry: () => RuntimeRegistry };
      this.lazyRuntimes = mod.defaultRuntimeRegistry();
    }
    return this.lazyRuntimes;
  }

  /**
   * Every installed plugin's runtime requirements and whether they are met —
   * what `nlg lang deps` and the Plugins page show. Plugins without a `run`
   * section are omitted: they declare nothing to check.
   */
  async dependencyAudit(): Promise<Array<{ id: string; version: string; requires: string[]; ok: boolean; unmet: string[] }>> {
    this.ensureScanned();
    const out: Array<{ id: string; version: string; requires: string[]; ok: boolean; unmet: string[] }> = [];
    for (const plugin of this.plugins.values()) {
      const requires = plugin.manifest.run?.requires ?? [];
      if (!requires.length) continue;
      const report = await this.checkRequirements(plugin.manifest);
      out.push({ id: plugin.manifest.id, version: plugin.manifest.version, requires, ok: report.ok, unmet: report.unmet });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Run the migration steps between `previous` and `manifest`.
   *
   * Each step is a subprocess (`node migrations/1.0.0-to-1.1.0.js <dataDir>
   * <from> <to>`), never `import()`d: a migration is plugin code, and plugin
   * code does not run inside the host process. A script must exit 0; anything
   * else — including an ENOENT for the script itself — aborts the install.
   */
  private async runMigrations(
    manifest: LanguageManifest,
    previous: LanguageManifest | undefined,
    srcDir: string,
  ): Promise<string[]> {
    const steps = manifest.migrations ?? [];
    if (!steps.length || !previous) return [];
    if (versionKey(manifest.version) <= versionKey(previous.version)) {
      // Same or lower version: nothing to migrate. Reinstalling the same build
      // must be a no-op for data, so a user can repair a broken plugin.
      return [];
    }
    const done = await this.appliedMigrations(manifest.id);
    const applied: string[] = [];
    for (const step of steps) {
      if (step.from !== previous.version) continue; // Not on the path from where we are.
      const key = `${step.from}->${step.to}`;
      if (done.has(key)) continue;
      await this.runMigrationScript(manifest.id, join(srcDir, step.file), step);
      applied.push(key);
      done.add(key);
      await this.recordMigrations(manifest.id, done);
    }
    return applied;
  }

  private async runMigrationScript(id: string, script: string, step: MigrationSpec): Promise<void> {
    if (!existsSync(script)) {
      throw new Error(`migration script ${step.file} for "${id}" is missing (${script})`);
    }
    const dataDir = await this.ensureDataDir(id);
    const scriptArgs = [dataDir, step.from, step.to];
    const child = spawn(process.execPath, [script, ...scriptArgs], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NL_PLUGIN_ID: id, NL_DATA_DIR: dataDir },
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let err = '';
      child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('error', rejectPromise);
      // 0 is the only acceptable exit: a half-migrated data directory is worse
      // than a failed upgrade, so the install aborts with the old body intact.
      child.on('close', (code) =>
        code === 0 ? resolvePromise() : rejectPromise(new Error(`migration ${step.file} for "${id}" exited ${code}: ${err.trim()}`)),
      );
    });
  }

  /** `data/<id>/migrations.json`, the record of what already ran. */
  private async appliedMigrations(id: string): Promise<Set<string>> {
    try {
      const raw = JSON.parse(await readFile(join(this.dataDir(id), 'migrations.json'), 'utf8')) as { applied?: string[] };
      return new Set(Array.isArray(raw.applied) ? raw.applied : []);
    } catch {
      return new Set();
    }
  }

  private async recordMigrations(id: string, applied: Set<string>): Promise<void> {
    const dir = await this.ensureDataDir(id);
    await writeFile(join(dir, 'migrations.json'), JSON.stringify({ applied: [...applied] }, null, 2), 'utf8');
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
