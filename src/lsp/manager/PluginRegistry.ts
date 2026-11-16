/**
 * Which plugin owns a file.
 *
 * Registration is compile-time in spirit: `BUILTIN_PLUGINS` is a static list and
 * the manifest-driven plugins are added during workspace init. There is no
 * dynamic loading, so a plugin cannot appear at runtime that the type system has
 * never seen.
 */
import type { LanguagePlugin } from './types.js';

export class PluginRegistry {
  private byId = new Map<string, LanguagePlugin>();

  register(plugin: LanguagePlugin): void {
    const existing = this.byId.get(plugin.id);
    if (existing && existing !== plugin) {
      throw new Error(`a language plugin with id "${plugin.id}" is already registered`);
    }
    this.byId.set(plugin.id, plugin);
  }

  unregister(id: string): boolean {
    return this.byId.delete(id);
  }

  get(id: string): LanguagePlugin | undefined {
    return this.byId.get(id);
  }

  all(): LanguagePlugin[] {
    return [...this.byId.values()];
  }

  /**
   * The plugin that owns `file`, or undefined.
   *
   * Ties are broken by `serverPriority()` and then by id, so routing is
   * deterministic: two plugins that both claim `.h` would otherwise resolve by
   * whichever happened to be registered first, which is the kind of bug that
   * only shows up on someone else's machine.
   */
  route(file: string): LanguagePlugin | undefined {
    let best: LanguagePlugin | undefined;
    for (const plugin of this.byId.values()) {
      if (!plugin.matches(file)) continue;
      if (!best) {
        best = plugin;
        continue;
      }
      const dp = plugin.serverPriority() - best.serverPriority();
      if (dp > 0 || (dp === 0 && plugin.id < best.id)) best = plugin;
    }
    return best;
  }
}
