/**
 * Manifests in, template registry out.
 *
 * The registry itself is language-blind (`src/scaffold`); this is the one place
 * that knows a manifest can carry templates, which keeps `WorkspaceService` from
 * growing a second responsibility and keeps the wiring testable without a panel.
 */
import { TemplateRegistry } from '../scaffold/registry.js';
import type { LanguageManifest } from './manifest.js';

export function templatesFor(manifests: LanguageManifest[]): TemplateRegistry {
  const registry = new TemplateRegistry();
  for (const manifest of manifests) {
    const specs = manifest.scaffold?.templates ?? [];
    if (specs.length) registry.setLanguage({ language: manifest.id, label: '内置', templates: specs });
  }
  return registry;
}
