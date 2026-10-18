/**
 * `nlg lang ...` — the short face of the language-plugin registry.
 *
 *   nlg lang add <dir|zip|tar.gz|url|git>   install a language (any of the five sources)
 *   nlg lang rm <id> [--drop-data]          uninstall it (data kept unless --drop-data)
 *   nlg lang ls                             what is installed
 *   nlg lang on <id> | off <id>             enable / disable
 *   nlg lang info <id>                      one plugin in full
 *   nlg lang up <id> [source]               reinstall from the recorded origin
 *
 * This is a *thin* face over the same `LanguageRegistry` the IDE uses, so an
 * install from here is byte-for-byte the same install the `/plugins` page
 * performs: validated at install time, migrations run before the body is
 * replaced, `data/<id>/` never touched by the copy. The only thing added here
 * is `resolveSource` — everything else deliberately stays in the registry.
 *
 * The older `lang-install` script is untouched and still works; both commands
 * share the registry and therefore share every guarantee.
 *
 * Flags:  --home <dir>   plugin home (default: $NOLANGUAGE_HOME, else ~/.nolanguage)
 * Exit codes: 0 ok · 1 operation failed · 2 bad usage.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LanguageRegistry,
  describeUnmet,
  type RegistryRoot,
  type RequirementReport,
} from '../src/langs/Registry.js';
import { disposeSource, resolveSource, SourceError, classifySource } from '../src/langs/SourceResolver.js';
import {
  resolveSources,
  fetchIndex,
  mergeEntries,
  searchEntries,
  resolveEntry,
  DEFAULT_INDEX_URL,
  type PluginIndexEntry,
} from '../src/langs/Catalog.js';

const args = process.argv.slice(2);

// ---- argument parsing -------------------------------------------------------
const positional: string[] = [];
let homeArg: string | undefined;
let dropData = false;
let strictDeps = false;
let wantsHelp = false;
const extraSources: string[] = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i] ?? '';
  if (a === '--home') {
    const value = args[i + 1];
    if (!value) fail('--home needs a directory', 2);
    homeArg = value;
    i++;
    continue;
  }
  if (a === '--source') {
    const value = args[i + 1];
    if (!value) fail('--source needs a URL or file path', 2);
    extraSources.push(value);
    i++;
    continue;
  }
  if (a === '--drop-data') {
    dropData = true;
    continue;
  }
  if (a === '--strict') {
    strictDeps = true;
    continue;
  }
  if (a === '--help' || a === '-h' || a === 'help') {
    wantsHelp = true;
    continue;
  }
  if (a.startsWith('-')) fail(`unknown flag: ${a}`, 2);
  positional.push(a);
}

const verb = positional[0];
const target = positional[1];
const extra = positional[2];

function usage(): never {
  const text = [
    'nlg lang — install and manage languages',
    '',
    '  nlg lang add <dir|zip|tar.gz|url|git>   install from any of those',
    '  nlg lang rm <id> [--drop-data]          uninstall (keeps data unless --drop-data)',
    '  nlg lang ls                             list what is installed',
    '  nlg lang on <id>                        enable',
    '  nlg lang off <id>                       disable',
    '  nlg lang info <id>                      show one plugin in full',
    '  nlg lang deps [id]                      runtime requirements and whether they are met',
    '  nlg lang up <id> [source]               reinstall from the recorded origin',
    '  nlg lang search [query]                 browse plugin indexes (add <id> installs from there)',
    '',
    'flags:',
    '  --home <dir>    plugin home (default: $NOLANGUAGE_HOME, else ~/.nolanguage)',
    '  --drop-data     with rm: also delete the plugin data directory',
    '  --strict        with add: refuse to install when a requirement is unmet',
    '  --source <url>  with search/add: an extra index (file or https); repeatable',
    '',
    'examples:',
    '  nlg lang add ./examples/cpp@1.0.0',
    '  nlg lang add https://example.org/cpp.zip',
    '  nlg lang add https://github.com/someone/nolang-rust.git',
    '  nlg lang add rust                # resolve "rust" from a plugin index',
    '  nlg lang search lsp',
    '  nlg lang search --source ./my-index.json',
    '  nlg lang off cpp',
  ].join('\n');
  process.stdout.write(`${text}\n`);
  process.exit(wantsHelp || !verb ? 0 : 2);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`nlg lang: ${message}\n`);
  process.exit(code);
}

// ---- registry access --------------------------------------------------------

/**
 * Official plugins ship beside the source (the repo's `builtin/`) and user
 * plugins under the home. Mirrors `lang-install`; the two must stay in step.
 */
function officialRoots(): RegistryRoot[] {
  const fromEnv = (process.env.LANG_DIR ?? '')
    .split(/[:;]/)
    .filter(Boolean)
    .map((p) => ({ dir: resolve(p), kind: 'builtin' as const, removable: false }));
  const here = dirname(fileURLToPath(import.meta.url)); // .../scripts
  const repo = [join(here, '..', 'builtin'), join(process.cwd(), 'builtin')]
    .filter((d) => existsSync(d))
    .map((d) => ({ dir: resolve(d), kind: 'builtin' as const, removable: false }));
  return [...fromEnv, ...repo];
}

async function open(): Promise<LanguageRegistry> {
  const reg = new LanguageRegistry({ home: homeArg, extraRoots: officialRoots() });
  await reg.scan();
  return reg;
}

/**
 * Where `add` recorded the source, so `up` can repeat it without asking again.
 * Kept as a sidecar next to the home rather than inside `languages/` — the
 * registry owns that directory, and this file is the CLI's business only.
 */
function originsPath(home: string): string {
  return join(home, 'lang-origins.json');
}

async function readOrigins(home: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(originsPath(home), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function rememberOrigin(home: string, id: string, source: string): Promise<void> {
  const all = await readOrigins(home);
  all[id] = source;
  try {
    await writeFile(originsPath(home), JSON.stringify(all, null, 2), 'utf8');
  } catch {
    // Recording the origin is a convenience; failing must not fail the install.
  }
}

// ---- verbs ------------------------------------------------------------------

/**
 * A bare argument to `add` is a path/URL/git URL *or* a plugin id. This tells
 * the two apart so a plain name like `rust` is looked up in the catalog instead
 * of being mistaken for a (missing) local file.
 */
function looksLikeInstallSource(s: string): boolean {
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s)) return true;
  if (/^git@/i.test(s) || /\.git(?:[#@]|$)/i.test(s)) return true;
  if (/[\\/]/.test(s)) return true;
  if (/\.(zip|tar|tgz|gz)$/i.test(s)) return true;
  if (existsSync(s)) return true;
  return false;
}

/**
 * Pull every reachable index, merged by id (highest version wins). A source
 * that is offline or malformed is reported, not fatal — search still works
 * against whatever answered.
 */
async function loadCatalog(home: string): Promise<{
  entries: PluginIndexEntry[];
  errors: string[];
}> {
  const sources = resolveSources(home, extraSources);
  const loaded: Array<{ source: { id: string; url: string; priority?: number }; index: { plugins: PluginIndexEntry[] } }> = [];
  const errors: string[] = [];
  for (const s of sources) {
    try {
      loaded.push(await fetchIndex(s));
    } catch (err) {
      errors.push(`${s.id} (${s.url}): ${(err as Error).message}`);
    }
  }
  return { entries: mergeEntries(loaded), errors };
}

async function doAdd(source: string): Promise<void> {
  const reg = await open();
  let resolvedSource = source;
  if (!looksLikeInstallSource(source)) {
    // Not a path/URL/git — treat it as a plugin id and resolve from the catalog.
    const { entries } = await loadCatalog(reg.home);
    const hit = resolveEntry(entries, source);
    if (!hit) {
      fail(`"${source}" is not a local path and was not found in any plugin index`, 1);
    }
    console.log(`resolving "${source}" from plugin index → ${hit.downloadUrl}`);
    resolvedSource = hit.downloadUrl;
  }
  const resolved = await resolveSource(resolvedSource);
  try {
    const installed = await reg.install(resolved.dir, { strictDeps });
    if (!reg.isEnabled(installed.id)) await reg.enable(installed.id);
    await rememberOrigin(reg.home, installed.id, source);
    console.log(`added ${installed.id}@${installed.version}`);
    console.log(`  from     ${source} (${resolved.kind})`);
    console.log(`  body     ${installed.dir}`);
    console.log(`  data     ${reg.dataDir(installed.id)}`);
    if (installed.migrated.length) console.log(`  migrated ${installed.migrated.join(', ')}`);
    reportRequirements(installed.requirements, installed.id);
    console.log('note: a running IDE applies this on its next start, or live from /plugins');
  } finally {
    await disposeSource(resolved);
  }
}

/**
 * Say what a plugin needs and whether this build has it.
 *
 * `run.requires` names *host runtimes*, not installable plugins, so when one is
 * missing the honest answer is "this build cannot run it" — not "install X".
 * With --strict the install was already refused, so this is only reached when
 * the plugin was installed anyway.
 */
function reportRequirements(report: RequirementReport, id: string): void {
  if (!report.requires.length) return;
  if (report.ok) {
    console.log(`  requires ${report.requires.join(', ')} (met)`);
    return;
  }
  console.log(`  WARNING  unmet requirement: ${report.unmet.join(', ')}`);
  console.log(`           ${describeUnmet(id, report)}`);
  console.log('           The plugin is installed but will fail at Run until a build provides it.');
}

async function doDeps(id?: string): Promise<void> {
  const reg = await open();
  const rows = await reg.dependencyAudit();
  const wanted = id ? rows.filter((r) => r.id === id) : rows;
  if (id && !rows.some((r) => r.id === id)) {
    const entry = reg.entry(id);
    if (!entry) fail(`"${id}" is not installed`);
    console.log(`${id}@${entry.manifest.version} declares no runtime requirements`);
    return;
  }
  if (!wanted.length) {
    console.log('no installed plugin declares runtime requirements');
    return;
  }
  console.log(`home ${reg.home}`);
  const head = ['ID', 'VERSION', 'OK', 'REQUIRES', 'UNMET'];
  const body = wanted.map((r) => [
    r.id,
    r.version,
    r.ok ? 'yes' : 'NO',
    r.requires.join(' '),
    r.unmet.length ? r.unmet.join(' ') : '-',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) console.log(line(row));
}

async function doRemove(id: string): Promise<void> {
  const reg = await open();
  const entry = reg.entry(id);
  if (!entry) fail(`"${id}" is not installed`);
  if (!entry.source.removable) fail(`"${id}" is a builtin plugin — use "nlg lang off ${id}" instead`);
  await reg.uninstall(id, { keepData: !dropData });
  const data = reg.dataDir(id);
  console.log(`removed ${id}@${entry.manifest.version}`);
  console.log(dropData ? `  dropped   ${data}` : `  kept data ${data}`);
}

async function doSetEnabled(id: string, on: boolean): Promise<void> {
  const reg = await open();
  if (!reg.entry(id)) fail(`"${id}" is not installed`);
  if (on) await reg.enable(id);
  else await reg.disable(id);
  console.log(`${on ? 'enabled' : 'disabled'} ${id}`);
}

async function doList(): Promise<void> {
  const reg = await open();
  const rows = reg.describe().sort((a, b) => a.id.localeCompare(b.id));
  console.log(`home ${reg.home}`);
  if (!rows.length) {
    console.log('(no languages installed)');
    return;
  }
  const head = ['ID', 'VERSION', 'KIND', 'ON', 'RUN', 'EXTENSIONS'];
  const body = rows.map((r) => [
    r.id,
    r.version,
    r.kind,
    r.enabled ? 'yes' : 'off',
    r.runMode ?? '-',
    r.extensions.join(' '),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) console.log(line(row));
}

async function doInfo(id: string): Promise<void> {
  const reg = await open();
  const entry = reg.entry(id);
  if (!entry) fail(`"${id}" is not installed`);
  const m = entry.manifest;
  const out: string[] = [];
  out.push(`${m.id}@${m.version}${m.displayName ? `  ${m.displayName}` : ''}`);
  if (m.publisher) out.push(`  publisher   ${m.publisher}`);
  if (m.apiVersion) out.push(`  apiVersion  ${m.apiVersion}`);
  if (m.description) out.push(`  description ${m.description}`);
  out.push(`  kind        ${entry.source.kind}${entry.source.removable ? '' : ' (builtin)'}`);
  out.push(`  enabled     ${entry.enabled ? 'yes' : 'no'}`);
  out.push(`  body        ${entry.source.dir}`);
  out.push(`  data        ${reg.dataDir(id)}`);
  out.push(`  extensions  ${m.file?.extensions?.join(' ') ?? '-'}`);
  if (m.file?.defaultExt) out.push(`  default ext ${m.file.defaultExt}`);
  if (m.run?.mode) out.push(`  run         ${m.run.mode}`);
  if (m.lsp?.serverName) out.push(`  lsp         ${m.lsp.serverName}`);
  if (m.debug?.serverName) out.push(`  debug       ${m.debug.serverName} (${m.debug.type ?? '?'})`);
  // `requires` lives under `run` in the manifest (e.g. cpp needs template@^1.0.0).
  if (m.run?.requires?.length) out.push(`  requires    ${m.run.requires.join(', ')}`);
  const origins = await readOrigins(reg.home);
  if (origins[id]) out.push(`  origin      ${origins[id]}`);
  console.log(out.join('\n'));
}

async function doUp(id: string, explicit?: string): Promise<void> {
  const reg = await open();
  const entry = reg.entry(id);
  if (!entry) fail(`"${id}" is not installed`);
  const origins = await readOrigins(reg.home);
  const source = explicit ?? origins[id];
  if (!source) {
    fail(
      `"${id}" has no recorded origin — pass one: nlg lang up ${id} <dir|zip|url|git>`,
      2,
    );
  }
  const kind = classifySource(source);
  console.log(`updating ${id} from ${source} (${kind})`);
  await doAdd(source);
}

async function doSearch(query?: string): Promise<void> {
  const reg = await open();
  const { entries, errors } = await loadCatalog(reg.home);
  const installed = new Set(reg.describe().map((r) => r.id));

  if (errors.length) {
    console.log(`note: ${errors.length} source(s) skipped (offline or unreachable):`);
    for (const e of errors) console.log(`  ! ${e}`);
  }
  if (!entries.length) {
    console.log('search: no plugin index is reachable right now.');
    console.log('  configure sources with --source <url>, a <home>/sources.json,');
    console.log(`  or set a default index (current default: ${DEFAULT_INDEX_URL}).`);
    return;
  }

  const hits = searchEntries(entries, query);
  if (!hits.length) {
    console.log(query ? `no plugin matches "${query}"` : 'no plugins listed in the reachable index(es)');
    return;
  }
  console.log(`found ${hits.length} plugin(s)${query ? ` matching "${query}"` : ''}:`);
  const head = ['NAME', 'VERSION', 'PUBLISHER', 'DESCRIPTION'];
  const body = hits.map((e) => {
    const name = e.displayName ? `${e.displayName} (${e.id})` : e.id;
    const mark = installed.has(e.id) ? '  ✓ installed' : '';
    return [name + mark, e.version, e.publisher ?? '-', truncate(e.description ?? '-', 52)];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) console.log(line(row));
  console.log('install with:  nlg lang add <id>   (the id in parentheses above)');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function main(): Promise<void> {
  if (!verb || wantsHelp) usage();

  switch (verb) {
    case 'add':
    case 'install':
      if (!target) fail('add needs a source (directory, .zip, .tar.gz, URL or git URL)', 2);
      await doAdd(target);
      return;
    case 'rm':
    case 'remove':
    case 'uninstall':
      if (!target) fail(`${verb} needs a plugin id`, 2);
      await doRemove(target);
      return;
    case 'on':
    case 'enable':
      if (!target) fail('on needs a plugin id', 2);
      await doSetEnabled(target, true);
      return;
    case 'off':
    case 'disable':
      if (!target) fail('off needs a plugin id', 2);
      await doSetEnabled(target, false);
      return;
    case 'ls':
    case 'list':
      await doList();
      return;
    case 'info':
      if (!target) fail('info needs a plugin id', 2);
      await doInfo(target);
      return;
    case 'deps':
      await doDeps(target);
      return;
    case 'search':
      await doSearch(target);
      return;
    case 'up':
    case 'update':
      if (!target) fail('up needs a plugin id', 2);
      await doUp(target, extra);
      return;
    default:
      fail(`unknown command: ${verb}`, 2);
  }
}

main().catch((err: unknown) => {
  if (err instanceof SourceError) fail(err.message);
  fail((err as Error).message);
});
