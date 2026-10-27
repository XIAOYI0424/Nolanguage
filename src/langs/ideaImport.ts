/**
 * Import a PyCharm/IntelliJ project's run configurations.
 *
 * The migration threshold is not "the editor looks similar" — it is "I do not
 * have to retype my run setups". PyCharm writes them as plain XML in
 * `.idea/runConfigurations/*.xml` and (newer versions) `.run/*.xml`, so the
 * whole import is a directory read plus a small mapping table.
 *
 * What is read:
 *
 *   .idea/runConfigurations/*.xml   <configuration name type> + <option>/<env>
 *   .run/*.xml                      same schema, newer location
 *   .idea/misc.xml                  ProjectRootManager@project-jdk-name
 *   .idea/modules.xml               <module fileurl=…>
 *
 * What is deliberately ignored: `.idea/workspace.xml` (per-user UI state, huge
 * and volatile), inspections profiles, and anything under `_temp`. Importing
 * editor state would make the first launch look like someone else's desktop.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { child, children, findAll, options, parseXml, type XmlNode } from '../util/xml.js';

export interface ImportedRunConfiguration {
  /** Configuration name shown in the run dropdown. */
  name: string;
  /** IntelliJ configuration type, e.g. `PythonConfigurationType`. */
  type: string;
  factory: string;
  /** Entry script, project-relative when it lives inside the project. */
  script: string;
  /** Absolute script path (what the runner actually needs). */
  scriptPath: string;
  /** Command-line arguments, verbatim. */
  parameters: string;
  /** Working directory, project-relative when inside the project. */
  workdir: string;
  env: Record<string, string>;
  /** Project-relative XML file this came from. */
  source: string;
  /** Language id guessed from the script extension. */
  language?: string;
}

export interface IdeaImport {
  root: string;
  /** `project-jdk-name` from `.idea/misc.xml`, e.g. `Python 3.13 (proj)`. */
  projectSdk?: string;
  /** Module names from `.idea/modules.xml`. */
  modules: string[];
  configurations: ImportedRunConfiguration[];
  warnings: string[];
  /** True when the directory has no `.idea` at all. */
  missing: boolean;
}

/** Script-bearing options, in the order JetBrains writes them per type. */
const SCRIPT_KEYS = ['SCRIPT_NAME', 'PATH_TO_JS_FILE', 'FILE_PATH', 'INPUT_FILE', 'SCRIPT'];

const EXT_LANGUAGE: Record<string, string> = {
  py: 'python',
  pyw: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  go: 'go',
  md: 'markdown',
};

const MAX_FILES = 200;

/** Replace JetBrains path macros with real paths. */
export function expandMacros(value: string, root: string): string {
  return value
    .replace(/\$PROJECT_DIR\$/g, root)
    .replace(/\$MODULE_DIR\$/g, root)
    .replace(/\$CONTENT_ROOT\$/g, root)
    .replace(/\$USER_HOME\$/g, process.env.USERPROFILE ?? process.env.HOME ?? '')
    .replace(/\\/g, sep === '\\' ? '\\' : '/');
}

/** Project-relative form when the path is inside the root, else absolute. */
function relativeTo(root: string, target: string): string {
  const abs = isAbsolute(target) ? target : resolve(root, target);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return abs.replace(/\\/g, '/');
  return rel.replace(/\\/g, '/');
}

/** Read one `<configuration>` element. */
function readConfiguration(node: XmlNode, root: string, source: string): ImportedRunConfiguration | undefined {
  const name = node.attrs.name || '';
  if (!name) return undefined;
  const opts = options(node);

  let scriptRaw = '';
  for (const key of SCRIPT_KEYS) {
    const v = opts[key];
    if (v && v.trim()) {
      scriptRaw = v.trim();
      break;
    }
  }
  if (!scriptRaw) return undefined;

  const scriptPath = resolve(root, expandMacros(scriptRaw, root));
  const envsNode = child(node, 'envs');
  const env: Record<string, string> = {};
  for (const e of envsNode ? children(envsNode, 'env') : []) {
    if (e.attrs.name) env[e.attrs.name] = e.attrs.value ?? '';
  }

  const workRaw = (opts.WORKING_DIRECTORY ?? '').trim();
  const workdir = workRaw ? relativeTo(root, expandMacros(workRaw, root)) : '.';
  const ext = basename(scriptPath).split('.').pop()?.toLowerCase() ?? '';

  return {
    name,
    type: node.attrs.type || '',
    factory: node.attrs.factoryName || '',
    script: relativeTo(root, scriptPath),
    scriptPath,
    parameters: (opts.PARAMETERS ?? '').trim(),
    workdir,
    env,
    source,
    ...(EXT_LANGUAGE[ext] ? { language: EXT_LANGUAGE[ext] } : {}),
  };
}

async function listXml(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.xml') && !e.name.startsWith('.'))
      .map((e) => join(dir, e.name))
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
}

/**
 * Read a project's `.idea` folder.
 *
 * Missing folders are normal (not every project was opened in PyCharm), so they
 * produce `missing: true` rather than an error: the caller decides whether that
 * is worth telling the user about.
 */
export async function importIdeaProject(rootDir: string): Promise<IdeaImport> {
  const root = resolve(rootDir);
  const ideaDir = join(root, '.idea');
  const result: IdeaImport = { root, modules: [], configurations: [], warnings: [], missing: false };
  if (!existsSync(ideaDir)) {
    result.missing = true;
    return result;
  }

  // ---- project SDK ----
  const miscPath = join(ideaDir, 'misc.xml');
  if (existsSync(miscPath)) {
    try {
      const doc = parseXml(await readFile(miscPath, 'utf8'));
      const rootManager = findAll(doc, 'component').find((c) => c.attrs.name === 'ProjectRootManager');
      if (rootManager?.attrs['project-jdk-name']) result.projectSdk = rootManager.attrs['project-jdk-name'];
    } catch (err) {
      result.warnings.push(`misc.xml: ${(err as Error).message}`);
    }
  }

  // ---- modules ----
  const modulesPath = join(ideaDir, 'modules.xml');
  if (existsSync(modulesPath)) {
    try {
      const doc = parseXml(await readFile(modulesPath, 'utf8'));
      for (const m of findAll(doc, 'module')) {
        const file = m.attrs.filepath || m.attrs.fileurl || '';
        if (file) result.modules.push(basename(file.replace(/^file:\/\//, ''), '.iml'));
      }
    } catch (err) {
      result.warnings.push(`modules.xml: ${(err as Error).message}`);
    }
  }

  // ---- run configurations ----
  const dirs = [join(ideaDir, 'runConfigurations'), join(root, '.run')];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const file of await listXml(dir)) {
      let doc: XmlNode;
      try {
        doc = parseXml(await readFile(file, 'utf8'));
      } catch (err) {
        result.warnings.push(`${basename(file)}: ${(err as Error).message}`);
        continue;
      }
      const source = relative(root, file).replace(/\\/g, '/');
      for (const node of findAll(doc, 'configuration')) {
        // `default="true"` entries are JetBrains templates, not user setups.
        if (node.attrs.default === 'true') continue;
        const cfg = readConfiguration(node, root, source);
        if (!cfg) {
          if (node.attrs.name) result.warnings.push(`${source}: "${node.attrs.name}" has no script`);
          continue;
        }
        if (seen.has(cfg.name)) {
          result.warnings.push(`${source}: duplicate name "${cfg.name}" ignored`);
          continue;
        }
        seen.add(cfg.name);
        result.configurations.push(cfg);
      }
    }
  }

  result.configurations.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Directory size guard used by tests: cheap existence check. */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
