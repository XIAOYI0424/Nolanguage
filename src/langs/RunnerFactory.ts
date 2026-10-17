/**
 * RunnerFactory — one path, no built-in branch.
 *
 * The previous design kept a `BUILTIN_RUNNERS` map for the four languages the
 * engine shipped with and fell back to a manifest path for everyone else. That
 * branch is exactly what made "official" and "third-party" different things, so
 * it is gone: every runner is created by looking up `manifest.run.mode` in the
 * runtime registry.
 *
 * Failure modes are all *loud and specific*, because a plugin author needs to
 * know which of the three things went wrong:
 *
 *   1. the runtime is not installed          → "Runtime 'x' not available"
 *   2. the runtime version is too old        → "Runtime requirement not met"
 *   3. the plugin's config does not fit it   → "Invalid run config: …"
 */
import { RuntimeRegistry } from '../runtimes/RuntimeRegistry.js';
import type { HostContext, Runner } from '../runtimes/types.js';
import type { LanguageManifest } from './manifest.js';

export interface FactoryDiagnostics {
  languageId: string;
  mode: string;
  ok: boolean;
  reason?: string;
}

export class RunnerFactory {
  constructor(private runtimes: RuntimeRegistry) {}

  /** The runtimes this factory can build from (for `/health` and the UI). */
  get registry(): RuntimeRegistry {
    return this.runtimes;
  }

  /**
   * Build a runner for a language, or `null` when the language only renders
   * (Markdown). Throws when the language *should* run but cannot — silently
   * returning null would make Run a no-op button.
   */
  create(manifest: LanguageManifest, ctx: HostContext): Runner | null {
    const config = manifest.run;
    if (!config) return null;

    const runtime = this.runtimes.get(config.mode);
    if (!runtime) {
      throw new Error(
        `Runtime '${config.mode}' not available (installed: ${this.runtimes
          .list()
          .map((r) => `${r.id}@${r.version}`)
          .join(', ')})`,
      );
    }

    const req = this.runtimes.satisfiesAll(config.requires);
    if (!req.ok) {
      throw new Error(
        `Runtime requirement not met: ${req.unmet.join(', ')} (installed ${runtime.id}@${runtime.version})`,
      );
    }

    const validation = runtime.validate(config, manifest.id);
    if (!validation.ok) {
      throw new Error(`Invalid run config for "${manifest.id}": ${validation.errors.join('; ')}`);
    }

    // `scaffold` sits at the manifest top level (it is also used by the
    // workspace to pre-create project files) but runtimes need it in the config
    // they receive. Merged here so there is exactly one place that knows this.
    const effective = manifest.scaffold ? { ...config, scaffold: config.scaffold ?? manifest.scaffold } : config;
    return runtime.createRunner(effective, ctx);
  }

  /** Check without side effects — used to grey out Run in the UI. */
  diagnose(manifest: LanguageManifest): FactoryDiagnostics {
    const config = manifest.run;
    if (!config) {
      return { languageId: manifest.id, mode: '', ok: false, reason: 'this language renders — nothing to run' };
    }
    const runtime = this.runtimes.get(config.mode);
    if (!runtime) {
      return { languageId: manifest.id, mode: config.mode, ok: false, reason: `runtime '${config.mode}' not installed` };
    }
    const req = this.runtimes.satisfiesAll(config.requires);
    if (!req.ok) {
      return {
        languageId: manifest.id,
        mode: config.mode,
        ok: false,
        reason: `requires ${req.unmet.join(', ')}`,
      };
    }
    const validation = runtime.validate(config, manifest.id);
    return {
      languageId: manifest.id,
      mode: config.mode,
      ok: validation.ok,
      reason: validation.ok ? undefined : validation.errors.join('; '),
    };
  }
}
