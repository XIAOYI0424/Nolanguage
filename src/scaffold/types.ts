/**
 * Project templates: what a generator needs to declare, and nothing more.
 *
 * The wizard's right-hand form is rendered *from* this schema, so a new template
 * is a manifest entry, not a UI change. That is the whole point of keeping these
 * types here rather than in the panel: a provider in another language (Spring
 * Initializr, cookiecutter, cargo-generate) describes the same shape, and the UI
 * never learns which one it is talking to.
 */

/** Controls the form can render. A provider may only use these. */
export type ParamKind = 'text' | 'select' | 'boolean' | 'multiselect';

export interface ParamOption {
  value: string;
  label: string;
  /** Optional grouping (e.g. Spring's "Web" / "SQL" dependency categories). */
  group?: string;
}

export interface TemplateParam {
  key: string;
  label: string;
  kind: ParamKind;
  /** Value used when the user has not touched the field. */
  default?: string | boolean | string[];
  /** Choices for `select` / `multiselect`. */
  options?: ParamOption[];
  /**
   * Validation, as a JS regex source. Declared per parameter so the UI runs one
   * generic check instead of every provider writing its own.
   */
  pattern?: string;
  /** Shown under the field when `pattern` rejects a value. */
  hint?: string;
  required?: boolean;
  /** Form section heading; fields with the same group sit together. */
  group?: string;
}

export interface TemplateFile {
  /** Target path, may contain `{{param}}` placeholders. */
  path: string;
  /** File contents, may contain `{{param}}` placeholders. */
  template: string;
  /**
   * Write this file only when the named boolean parameter is true.
   *
   * A form that offers "generate tests" and then writes them anyway is worse than
   * no option at all, so conditionals belong in the schema rather than in a
   * per-language generator script.
   */
  when?: string;
}

export interface ProjectTemplateSpec {
  /** Unique within a language (`spring-boot`, `cargo-bin`). */
  id: string;
  name: string;
  description?: string;
  /**
   * Where the template comes from. `builtin` writes files directly; the others
   * name a tool that has to be installed, which is what the card's badge and its
   * availability state are about.
   */
  source?: 'builtin' | 'initializr' | 'cookiecutter' | 'cargo-generate' | 'local';
  /** `project` scaffolds a directory; `file` adds one file to an open project. */
  kind?: 'project' | 'file';
  /** Suggested subdirectory, expanded from params (`{{name}}`). */
  suggestedDir?: string;
  params?: TemplateParam[];
  files: TemplateFile[];
}

/** What the left/middle columns need; never the file bodies. */
export interface TemplateSummary {
  id: string;
  name: string;
  description?: string;
  language: string;
  source: string;
  kind: 'project' | 'file';
  available: boolean;
  /** Why it is unavailable — shown on the card, never hidden. */
  reason?: string;
  params: TemplateParam[];
  suggestedDir?: string;
}

export interface GeneratedFile {
  path: string;
  bytes: number;
}

export interface GenerateResult {
  dir: string;
  files: GeneratedFile[];
}

export class TemplateError extends Error {
  constructor(
    message: string,
    /** Machine-readable so the UI can point at the offending field. */
    readonly field?: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** Expand `{{key}}` placeholders; an unknown key is an error, not an empty string. */
export function expand(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new TemplateError(`模板引用了未声明的参数 {{${key}}}`, key);
    return values[key];
  });
}

/**
 * Coerce and validate the submitted form against the schema.
 *
 * Returns only the declared keys: a provider must not receive fields it did not
 * ask for, because that is how a typo in the UI turns into a silently ignored
 * setting.
 */
export function resolveParams(
  params: TemplateParam[],
  submitted: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    const raw = submitted[p.key];
    if (p.kind === 'boolean') {
      out[p.key] = raw === undefined ? String(p.default === true) : String(raw === true || raw === 'true');
      continue;
    }
    if (p.kind === 'multiselect') {
      const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' && raw ? raw.split(',') : [];
      out[p.key] = list.join(',');
      continue;
    }
    const value = raw === undefined || raw === null || raw === '' ? (typeof p.default === 'string' ? p.default : '') : String(raw);
    if (p.required && !value) throw new TemplateError(`${p.label} 不能为空`, p.key);
    if (p.pattern && value && !new RegExp(p.pattern).test(value)) {
      throw new TemplateError(p.hint ?? `${p.label} 格式不正确`, p.key);
    }
    if (p.kind === 'select' && value && p.options && !p.options.some((o) => o.value === value)) {
      throw new TemplateError(`${p.label} 的取值不在可选范围内`, p.key);
    }
    out[p.key] = value;
  }
  return out;
}

/**
 * Reject a path that would escape the directory we are about to write into.
 *
 * The templates are declared in manifests, which are data — a `../` in a path is
 * not a hypothetical, it is one bad manifest away from writing outside the
 * workspace.
 */
export function safeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new TemplateError(`模板路径不安全: ${path}`);
  }
  if (/^[a-zA-Z]:/.test(normalized)) throw new TemplateError(`模板路径不能是绝对路径: ${path}`);
  return normalized;
}
