/**
 * The one place that knows what templates exist and how to write one out.
 *
 * Aggregation, not generation strategy: a language manifest contributes its own
 * templates, and a provider that shells out to another tool (Initializr,
 * cookiecutter) contributes the same `ProjectTemplateSpec` shape. The registry
 * never learns which is which — it validates, expands, and writes.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  type GenerateResult,
  type ProjectTemplateSpec,
  type TemplateError,
  type TemplateSummary,
  expand,
  resolveParams,
  safeRelativePath,
} from './types.js';

export interface TemplateSource {
  /** Language id (`python`, `rust`, …) — the left column's filter. */
  language: string;
  /** Human label for the badge (`Initializr`, `内置`). */
  label?: string;
  /** Whether this source can run right now, and why not when it cannot. */
  availability?: () => { ok: boolean; reason?: string };
  templates: ProjectTemplateSpec[];
}

interface Entry {
  language: string;
  spec: ProjectTemplateSpec;
  sourceLabel: string;
  availability?: () => { ok: boolean; reason?: string };
}

export class TemplateRegistry {
  private entries = new Map<string, Entry>();

  /** Replace every template for one language (the manifest is the source of truth). */
  setLanguage(source: TemplateSource): void {
    for (const [key, entry] of this.entries) if (entry.language === source.language) this.entries.delete(key);
    for (const spec of source.templates) {
      const key = `${source.language}:${spec.id}`;
      this.entries.set(key, {
        language: source.language,
        spec,
        sourceLabel: source.label ?? spec.source ?? 'builtin',
        availability: source.availability,
      });
    }
  }

  removeLanguage(language: string): void {
    for (const [key, entry] of this.entries) if (entry.language === language) this.entries.delete(key);
  }

  /**
   * Everything the wizard shows.
   *
   * Unavailable templates are included, with the reason: "there is such a thing
   * and it is not usable right now" is information the user needs, and hiding it
   * is how a missing toolchain becomes a mystery.
   */
  list(): TemplateSummary[] {
    const out: TemplateSummary[] = [];
    for (const entry of this.entries.values()) {
      const probe = entry.availability?.();
      out.push({
        id: entry.spec.id,
        name: entry.spec.name,
        description: entry.spec.description,
        language: entry.language,
        source: entry.sourceLabel,
        kind: entry.spec.kind ?? 'project',
        available: probe ? probe.ok : true,
        reason: probe && !probe.ok ? (probe.reason ?? '不可用') : undefined,
        params: entry.spec.params ?? [],
        suggestedDir: entry.spec.suggestedDir,
      });
    }
    return out.sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
  }

  get(language: string, id: string): Entry | undefined {
    return this.entries.get(`${language}:${id}`);
  }

  /**
   * Write a template into `targetDir`.
   *
   * The directory rules are enforced here rather than in the UI: the wizard can
   * warn early, but a second client (CLI, script) must not be able to skip them.
   */
  generate(
    language: string,
    id: string,
    submitted: Record<string, unknown>,
    targetDir: string,
    opts: { allowNonEmpty?: boolean } = {},
  ): GenerateResult {
    const entry = this.get(language, id);
    if (!entry) throw new Error(`unknown template ${language}:${id}`);
    const probe = entry.availability?.();
    if (probe && !probe.ok) throw new Error(probe.reason ?? `${entry.sourceLabel} 不可用`);

    const values = resolveParams(entry.spec.params ?? [], submitted);
    const dir = resolve(targetDir);
    if (!isAbsolute(targetDir)) throw new Error('目标目录必须是绝对路径');
    if (dir === resolve('/') || /^[a-zA-Z]:\\?$/.test(dir)) throw new Error('不能直接写到磁盘根目录');

    if (existsSync(dir) && !opts.allowNonEmpty) {
      const left = readdirSync(dir).filter((name) => name !== '.git');
      if (left.length) throw new Error(`目录不是空的（${left.length} 项），请换一个位置或勾选「允许写入非空目录」`);
    }

    const files = entry.spec.files
      .filter((file) => !file.when || values[file.when] === 'true')
      .map((file) => ({
        path: safeRelativePath(expand(file.path, values)),
        content: expand(file.template, values),
      }));

    mkdirSync(dir, { recursive: true });
    const written = files.map((file) => {
      const full = join(dir, file.path);
      // `safeRelativePath` already rejected `..`; this is the belt to its braces,
      // because a symlinked parent would otherwise still escape.
      const rel = relative(dir, full);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`模板路径越界: ${file.path}`);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, file.content, 'utf8');
      return { path: file.path, bytes: Buffer.byteLength(file.content, 'utf8') };
    });

    return { dir, files: written };
  }
}

/** Suggested subdirectory for a template, expanded from the submitted params. */
export function suggestDir(spec: ProjectTemplateSpec, submitted: Record<string, unknown>): string {
  const pattern = spec.suggestedDir;
  if (!pattern) return '';
  try {
    return expand(pattern, resolveParams(spec.params ?? [], submitted));
  } catch {
    return '';
  }
}

export type { TemplateError };
