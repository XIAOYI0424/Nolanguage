/**
 * Dependency declarations that live in a project file, not behind a CLI.
 *
 * npm has `npm install x`, cargo has `cargo add x`, and both edit their own
 * manifest. Gradle and Maven have no equivalent "`add dependency`" command:
 * their dependency list *is* `build.gradle` / `pom.xml`. Inventing a
 * `gradle add` here would be a lie, so this module does the one honest thing —
 * validate a Maven coordinate and write the declaration into the file the
 * build tool already reads.
 *
 * Nothing here resolves versions or downloads anything. Fetching is a separate,
 * explicit action (`planSync`), because a build can take minutes and touch the
 * network; the user decides when that happens.
 */
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';

export type DeclaredEcosystem = 'gradle' | 'maven';

export interface DeclaredFile {
  ecosystem: DeclaredEcosystem;
  /** Manifest-relative file name, for display. */
  file: string;
  abs: string;
  /** What the dependency dialog shows before a spec is typed. */
  label: string;
}

export interface DeclaredAddPlan extends DeclaredFile {
  /** Normalised `group:artifact[:version]`, also used as the duplicate check. */
  spec: string;
  /** Exact line/block that will be written. */
  declaration: string;
}

export class DeclaredDependencyError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'DeclaredDependencyError';
  }
}

/** Maven coordinates: no whitespace, no quotes, no shell metacharacters. */
const COORDINATE = /^([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*):([A-Za-z0-9][A-Za-z0-9_.-]*)(?::([A-Za-z0-9_.+,\[\]\(\)-]+))?$/;

function projectFile(dir: string, file: string): string | undefined {
  const candidate = join(dir, file);
  if (!existsSync(candidate)) return undefined;
  const root = realpathSync(dir);
  const abs = realpathSync(candidate);
  const rel = relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DeclaredDependencyError(`拒绝编辑项目目录之外的构建文件：${file}`, 'file');
  }
  return abs;
}

/**
 * Which build file owns this directory.
 *
 * A Gradle project may ship only `settings.gradle`; that is not enough to edit,
 * because there is no `dependencies` block to edit. Multi-project roots route
 * to the first included module which has its own build file; module names come
 * from settings.gradle(.kts), never from a hardcoded framework/language list.
 */
export function findDeclared(dir: string): DeclaredFile | undefined {
  const gradle = (file: string, abs: string): DeclaredFile => ({
    ecosystem: 'gradle',
    file,
    abs,
    label: `gradle · ${file}（编辑依赖声明）`,
  });
  const settingsRel = ['settings.gradle.kts', 'settings.gradle'].find((f) => existsSync(join(dir, f)));
  if (settingsRel) {
    const settings = projectFile(dir, settingsRel)!;
    const settingsText = readFileSync(settings, 'utf8');
    const modules = new Set<string>();
    for (const raw of settingsText.split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      const include = /^include\b(.*)$/i.exec(line);
      if (!include) continue;
      for (const match of include[1].matchAll(/['"]([^'"]+)['"]/g)) {
        const module = match[1].replace(/^:+/, '').replace(/:/g, '/');
        const parts = module.split('/');
        if (!module || parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) continue;
        modules.add(parts.join('/'));
      }
    }
    for (const module of modules) {
      for (const file of [`${module}/build.gradle.kts`, `${module}/build.gradle`]) {
        const abs = projectFile(dir, file);
        if (abs) return gradle(file, abs);
      }
    }
  }
  for (const file of ['build.gradle.kts', 'build.gradle']) {
    const abs = projectFile(dir, file);
    if (abs) return gradle(file, abs);
  }
  const pom = projectFile(dir, 'pom.xml');
  if (pom) return { ecosystem: 'maven', file: 'pom.xml', abs: pom, label: 'maven · pom.xml（编辑依赖声明）' };
  return undefined;
}

export interface Coordinate {
  group: string;
  artifact: string;
  version?: string;
}

/** Validate and split `group:artifact[:version]`. */
export function parseCoordinate(raw: string): Coordinate {
  const spec = raw.trim();
  if (!spec) throw new DeclaredDependencyError('请填写要添加的依赖', 'spec');
  const m = COORDINATE.exec(spec);
  if (!m) {
    throw new DeclaredDependencyError('Java 依赖坐标应写成 group:artifact 或 group:artifact:version', 'spec');
  }
  return { group: m[1], artifact: m[2], ...(m[3] ? { version: m[3] } : {}) };
}

/** The text written into the build file. Kotlin DSL needs parentheses and double quotes. */
export function declarationFor(ecosystem: DeclaredEcosystem, spec: string, file = ''): string {
  const c = parseCoordinate(spec);
  const coordinate = `${c.group}:${c.artifact}${c.version ? `:${c.version}` : ''}`;
  if (ecosystem === 'gradle') {
    return file.endsWith('.kts') ? `implementation("${coordinate}")` : `implementation '${coordinate}'`;
  }
  const lines = ['    <dependency>', `      <groupId>${c.group}</groupId>`, `      <artifactId>${c.artifact}</artifactId>`];
  if (c.version) lines.push(`      <version>${c.version}</version>`);
  lines.push('    </dependency>');
  return lines.join('\n');
}

/** Escape a literal for use inside a RegExp. */
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build the edit plan; `probe=true` only identifies the build file. */
export function planDeclaredAdd(dir: string, spec: string, probe = false): DeclaredAddPlan | undefined {
  const found = findDeclared(dir);
  if (!found) return undefined;
  if (probe) return { ...found, spec: '', declaration: '' };
  const c = parseCoordinate(spec);
  const normalised = `${c.group}:${c.artifact}${c.version ? `:${c.version}` : ''}`;
  return { ...found, spec: normalised, declaration: declarationFor(found.ecosystem, normalised, found.file) };
}

function alreadyDeclared(text: string, ecosystem: DeclaredEcosystem, c: Coordinate): boolean {
  if (ecosystem === 'gradle') {
    const coord = `${c.group}:${c.artifact}`;
    return new RegExp(`['"]${escapeRe(coord)}(?::[^'"]+)?['"]`).test(text);
  }
  return new RegExp(
    `<groupId>${escapeRe(c.group)}</groupId>\\s*<artifactId>${escapeRe(c.artifact)}</artifactId>`,
  ).test(text);
}

function insertGradle(text: string, declaration: string, nl: string): string {
  const lines = text.split(/\r?\n/);
  const oneLine = lines.findIndex((line) => /^\s*dependencies\s*\{[^{}]*\}\s*$/.test(line));
  if (oneLine >= 0) {
    const line = lines[oneLine];
    const m = /^(\s*)dependencies\s*\{([^{}]*)\}\s*$/.exec(line)!;
    const indent = m[1];
    const existing = m[2].trim();
    lines.splice(oneLine, 1, `${indent}dependencies {`, ...(existing ? [`${indent}    ${existing}`] : []), `${indent}    ${declaration}`, `${indent}}`);
    return lines.join(nl);
  }
  const at = lines.findIndex((line) => /^\s*dependencies\s*\{/.test(line));
  if (at < 0) {
    const body = `dependencies {${nl}    ${declaration}${nl}}${nl}`;
    return `${text.replace(/\s*$/, '')}${nl}${nl}${body}`;
  }
  const indent = /^(\s*)/.exec(lines[at])?.[1] ?? '';
  lines.splice(at + 1, 0, `${indent}    ${declaration}`);
  return lines.join(nl);
}

function projectDependencyClose(text: string): number | undefined {
  // Match only direct `<project><dependencies>` so nested dependencyManagement
  // and profile declarations are never mistaken for runtime dependencies.
  const safe = text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, ' '));
  const tagName = (raw: string): string => raw.match(/^<\/?((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)/)?.[1] ?? '';
  const projectOpen = /<(?:[A-Za-z_][\w.-]*:)?project\b[^>]*>/g.exec(safe);
  if (!projectOpen) return undefined;
  const rootName = tagName(projectOpen[0]);
  const rootPrefix = rootName.includes(':') ? `${rootName.split(':')[0]}:` : '';
  const stack = [rootName];
  const re = /<\/?(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*\b[^>]*>/g;
  re.lastIndex = projectOpen.index + projectOpen[0].length;
  for (let m = re.exec(safe); m; m = re.exec(safe)) {
    const raw = m[0];
    const closing = /^<\//.test(raw);
    const selfClosing = /\/\s*>$/.test(raw);
    const fullTag = tagName(raw);
    const local = fullTag.split(':').pop() ?? fullTag;
    if (closing) {
      if (local === 'dependencies' && stack.length === 2 && stack[0] === rootName) return m.index;
      const at = stack.lastIndexOf(fullTag);
      if (at >= 0) stack.length = at;
    } else if (!selfClosing) {
      stack.push(fullTag);
    }
  }
  void rootPrefix;
  return undefined;
}

function insertMaven(text: string, declaration: string, nl: string): string {
  const projectClose = /<\/project\s*>/g;
  let closeAt = -1;
  for (const m of text.matchAll(projectClose)) closeAt = m.index ?? closeAt;
  if (closeAt < 0) {
    throw new DeclaredDependencyError('pom.xml 里没有 </project>，拒绝在未知结构上写入', 'file');
  }
  const depClose = projectDependencyClose(text);
  if (depClose !== undefined) {
    return `${text.slice(0, depClose)}${declaration}${nl}  ${text.slice(depClose)}`;
  }
  const block = `  <dependencies>${nl}${declaration}${nl}  </dependencies>${nl}`;
  return `${text.slice(0, closeAt)}${block}${text.slice(closeAt)}`;
}

/**
 * Write the declaration. A temp file is written first so a half-written build
 * file is never left behind; on Windows rename normally replaces the target,
 * with a plain write as the fallback for filesystems that refuse it.
 */
export function applyDeclaredAdd(plan: DeclaredAddPlan): string {
  const lock = `${plan.abs}.nolanguage-lock`;
  let lockFd: number;
  try {
    lockFd = openSync(lock, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DeclaredDependencyError('另一个依赖写入正在进行，请稍后重试', 'spec');
    }
    throw err;
  }

  const tmp = `${plan.abs}.nolanguage-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  try {
    // Re-read only after taking the lock, so two simultaneous clicks cannot
    // both pass the duplicate check and overwrite one another's declarations.
    const before = readFileSync(plan.abs, 'utf8');
    const c = parseCoordinate(plan.spec);
    if (alreadyDeclared(before, plan.ecosystem, c)) {
      throw new DeclaredDependencyError(`${plan.spec} 已经声明过了`, 'spec');
    }
    const nl = before.includes('\r\n') ? '\r\n' : '\n';
    const after = plan.ecosystem === 'gradle' ? insertGradle(before, plan.declaration, nl) : insertMaven(before, plan.declaration, nl);
    writeFileSync(tmp, after, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, plan.abs);
    return `已在 ${plan.file} 中声明 ${plan.spec}。\n${plan.declaration}`;
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or never created */ }
    closeSync(lockFd);
    try { unlinkSync(lock); } catch { /* best-effort release; close already released the OS handle */ }
  }
}
