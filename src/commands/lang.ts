/**
 * `lang` — the command-line face of the language-plugin registry.
 *
 * Two front doors, one implementation:
 *
 *   Nolanguage.exe lang <verb> …     packaged build (the exe is a Node SEA)
 *   nlg lang <verb> …                source checkout (`scripts/lang.ts` wraps this)
 *
 * Everything here goes through the same `LanguageRegistry` the IDE uses, so a
 * plugin installed from a terminal is byte-for-byte the same plugin the
 * `/plugins` page installs: validated at install time, migrations run before
 * the body is replaced, `data/<id>/` never touched by the copy.
 *
 * Usage:
 *   lang add <dir|zip|tar.gz|url|git|id>   install from any of those, then enable
 *   lang rm <id> [--drop-data]             remove the body; data is kept by default
 *   lang on <id> | off <id>                flip the enabled flag
 *   lang ls                                every plugin, where it lives, whether it is on
 *   lang info <id>                         one plugin in full
 *   lang deps [id]                         runtime requirements and whether they are met
 *   lang server [id]                       language-server status: found, size, how to get it
 *   lang server install <id>               install that server (npm/go; github is manual)
 *   lang up <id> [source]                  reinstall from the recorded origin
 *   lang search [query]                    browse plugin indexes
 *
 * Flags:
 *   --home <dir>    plugin home (default: $NOLANGUAGE_HOME, else ~/.nolanguage)
 *   --drop-data     with rm: also delete `data/<id>/`
 *   --strict        with add: refuse to install when `run.requires` is unmet
 *   --source <url>  with search/add: an extra index (file or https); repeatable
 *
 * Exit codes: 0 ok · 1 operation failed · 2 bad usage.
 *
 * Deliberately not done here: talking to a *running* IDE. This process owns the
 * registry on disk; a panel that is already running keeps its own view until it
 * rescans, so a CLI install is for scripted/headless setups and for inspecting
 * a home directory. The `/plugins` page is the live path.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LanguageRegistry,
  describeUnmet,
  type RegistryRoot,
  type RequirementReport,
} from '../langs/Registry.js';
import type { LanguageManifest } from '../langs/manifest.js';
import { installServer, statusFor } from '../langs/serverInstall.js';
import { disposeSource, resolveSource, SourceError, classifySource } from '../langs/SourceResolver.js';
import {
  resolveSources,
  fetchIndex,
  mergeEntries,
  searchEntries,
  resolveEntry,
  DEFAULT_INDEX_URL,
  type PluginIndexEntry,
} from '../langs/Catalog.js';
import { officialRoots } from '../langs/pluginRoots.js';

/** Where a CLI writes. Injected so the command is testable without a tty. */
export interface LangIo {
  out(line?: string): void;
  err(line: string): void;
}

const consoleIo: LangIo = {
  out: (line = '') => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** A failed operation; `code` becomes the process exit code. */
class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

/** Print usage and return 0 — used for `lang`, `lang --help`, `lang help`. */
function printUsage(io: LangIo): void {
  const text = [
    'lang — install and manage languages',
    '',
    '  lang add <dir|zip|tar.gz|url|git|id>   install from any of those',
    '  lang rm <id> [--drop-data]             uninstall (keeps data unless --drop-data)',
    '  lang ls                                list what is installed',
    '  lang on <id>                           enable',
    '  lang off <id>                          disable',
    '  lang info <id>                         show one plugin in full',
    '  lang deps [id]                         runtime requirements and whether they are met',
    '  lang up <id> [source]                  reinstall from the recorded origin',
    '  lang search [query]                    browse plugin indexes (add <id> installs from there)',
    '',
    'flags:',
    '  --home <dir>    plugin home (default: $NOLANGUAGE_HOME, else ~/.nolanguage)',
    '  --drop-data     with rm: also delete the plugin data directory',
    '  --strict        with add: refuse to install when a requirement is unmet',
    '  --source <url>  with search/add: an extra index (file or https); repeatable',
    '',
    'examples:',
    '  Nolanguage.exe lang add ./examples/cpp@1.0.0',
    '  Nolanguage.exe lang add https://example.org/cpp.zip',
    '  Nolanguage.exe lang search lsp',
    '  Nolanguage.exe lang off cpp',
    '  nlg lang ls                            (same commands, from a source checkout)',
  ].join('\n');
  io.out(text);
}

/** Run one `lang` invocation; returns the process exit code. */
export async function runLang(argv: string[], io: LangIo = consoleIo): Promise<number> {
  const positional: string[] = [];
  let homeArg: string | undefined;
  let dropData = false;
  let strictDeps = false;
  let wantsHelp = false;
  const extraSources: string[] = [];

  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i] ?? '';
      if (a === '--home') {
        const value = argv[i + 1];
        if (!value) throw new CliError('--home needs a directory', 2);
        homeArg = value;
        i++;
        continue;
      }
      if (a === '--source') {
        const value = argv[i + 1];
        if (!value) throw new CliError('--source needs a URL or file path', 2);
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
      if (a.startsWith('-')) throw new CliError(`unknown flag: ${a}`, 2);
      positional.push(a);
    }

    const verb = positional[0];
    const target = positional[1];
    const extra = positional[2];
    if (!verb || wantsHelp) {
      printUsage(io);
      return 0;
    }

    const ctx: Ctx = { io, homeArg, dropData, strictDeps, extraSources };
    switch (verb) {
      case 'add':
      case 'install':
        if (!target) throw new CliError('add needs a source (directory, .zip, .tar.gz, URL or git URL)', 2);
        await doAdd(ctx, target);
        return 0;
      case 'rm':
      case 'remove':
      case 'uninstall':
        if (!target) throw new CliError(`${verb} needs a plugin id`, 2);
        await doRemove(ctx, target);
        return 0;
      case 'on':
      case 'enable':
        if (!target) throw new CliError('on needs a plugin id', 2);
        await doSetEnabled(ctx, target, true);
        return 0;
      case 'off':
      case 'disable':
        if (!target) throw new CliError('off needs a plugin id', 2);
        await doSetEnabled(ctx, target, false);
        return 0;
      case 'ls':
      case 'list':
        await doList(ctx);
        return 0;
      case 'info':
        if (!target) throw new CliError('info needs a plugin id', 2);
        await doInfo(ctx, target);
        return 0;
      case 'deps':
        await doDeps(ctx, target);
        return 0;
      case 'server':
        // `server` = status for every language; `server install <id>` = do it.
        if (target === 'install' || target === 'add') {
          if (!extra) throw new CliError('server install needs a language id', 2);
          await doServerInstall(ctx, extra);
          return 0;
        }
        await doServerStatus(ctx, target);
        return 0;
      case 'search':
        await doSearch(ctx, target);
        return 0;
      case 'up':
      case 'update':
        if (!target) throw new CliError('up needs a plugin id', 2);
        await doUp(ctx, target, extra);
        return 0;
      default:
        throw new CliError(`unknown command: ${verb}`, 2);
    }
  } catch (err) {
    const message = err instanceof SourceError || err instanceof Error ? err.message : String(err);
    io.err(`lang: ${message}`);
    return err instanceof CliError ? err.code : 1;
  }
}

interface Ctx {
  io: LangIo;
  homeArg?: string;
  dropData: boolean;
  strictDeps: boolean;
  extraSources: string[];
}

// ---- registry access --------------------------------------------------------

/**
 * Official plugins ship beside the source (the repo's `builtin/`) and inside a
 * packaged executable; user plugins live under the home. One shared resolver,
 * so `lang ls` and `--dump-plugins` cannot disagree.
 */
function official(): RegistryRoot[] {
  return officialRoots();
}

async function open(ctx: Ctx): Promise<LanguageRegistry> {
  const reg = new LanguageRegistry({ home: ctx.homeArg, extraRoots: official() });
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
async function loadCatalog(
  ctx: Ctx,
  home: string,
): Promise<{ entries: PluginIndexEntry[]; errors: string[] }> {
  const sources = resolveSources(home, ctx.extraSources);
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

async function doAdd(ctx: Ctx, source: string): Promise<void> {
  const reg = await open(ctx);
  let resolvedSource = source;
  if (!looksLikeInstallSource(source)) {
    // Not a path/URL/git — treat it as a plugin id and resolve from the catalog.
    const { entries } = await loadCatalog(ctx, reg.home);
    const hit = resolveEntry(entries, source);
    if (!hit) {
      throw new CliError(`"${source}" is not a local path and was not found in any plugin index`, 1);
    }
    ctx.io.out(`resolving "${source}" from plugin index → ${hit.downloadUrl}`);
    resolvedSource = hit.downloadUrl;
  }
  const resolved = await resolveSource(resolvedSource);
  try {
    const installed = await reg.install(resolved.dir, { strictDeps: ctx.strictDeps });
    if (!reg.isEnabled(installed.id)) await reg.enable(installed.id);
    await rememberOrigin(reg.home, installed.id, source);
    ctx.io.out(`added ${installed.id}@${installed.version}`);
    ctx.io.out(`  from     ${source} (${resolved.kind})`);
    ctx.io.out(`  body     ${installed.dir}`);
    ctx.io.out(`  data     ${reg.dataDir(installed.id)}`);
    if (installed.migrated.length) ctx.io.out(`  migrated ${installed.migrated.join(', ')}`);
    reportRequirements(ctx, installed.requirements, installed.id);
    ctx.io.out('note: a running IDE applies this on its next start, or live from /plugins');
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
function reportRequirements(ctx: Ctx, report: RequirementReport, id: string): void {
  if (!report.requires.length) return;
  if (report.ok) {
    ctx.io.out(`  requires ${report.requires.join(', ')} (met)`);
    return;
  }
  ctx.io.out(`  WARNING  unmet requirement: ${report.unmet.join(', ')}`);
  ctx.io.out(`           ${describeUnmet(id, report)}`);
  ctx.io.out('           The plugin is installed but will fail at Run until a build provides it.');
}

async function doDeps(ctx: Ctx, id?: string): Promise<void> {
  const reg = await open(ctx);
  const rows = await reg.dependencyAudit();
  const wanted = id ? rows.filter((r) => r.id === id) : rows;
  if (id && !rows.some((r) => r.id === id)) {
    const entry = reg.entry(id);
    if (!entry) throw new CliError(`"${id}" is not installed`);
    ctx.io.out(`${id}@${entry.manifest.version} declares no runtime requirements`);
    return;
  }
  if (!wanted.length) {
    ctx.io.out('no installed plugin declares runtime requirements');
    return;
  }
  ctx.io.out(`home ${reg.home}`);
  printTable(
    ctx.io,
    ['ID', 'VERSION', 'OK', 'REQUIRES', 'UNMET'],
    wanted.map((r) => [r.id, r.version, r.ok ? 'yes' : 'NO', r.requires.join(' '), r.unmet.length ? r.unmet.join(' ') : '-']),
  );
}

async function doRemove(ctx: Ctx, id: string): Promise<void> {
  const reg = await open(ctx);
  const entry = reg.entry(id);
  if (!entry) throw new CliError(`"${id}" is not installed`);
  if (!entry.source.removable) {
    throw new CliError(`"${id}" is a builtin plugin — use "lang off ${id}" instead`);
  }
  await reg.uninstall(id, { keepData: !ctx.dropData });
  const data = reg.dataDir(id);
  ctx.io.out(`removed ${id}@${entry.manifest.version}`);
  ctx.io.out(ctx.dropData ? `  dropped   ${data}` : `  kept data ${data}`);
}

async function doSetEnabled(ctx: Ctx, id: string, on: boolean): Promise<void> {
  const reg = await open(ctx);
  if (!reg.entry(id)) throw new CliError(`"${id}" is not installed`);
  if (on) await reg.enable(id);
  else await reg.disable(id);
  ctx.io.out(`${on ? 'enabled' : 'disabled'} ${id}`);
}

async function doList(ctx: Ctx): Promise<void> {
  const reg = await open(ctx);
  const rows = reg.describe().sort((a, b) => a.id.localeCompare(b.id));
  ctx.io.out(`home ${reg.home}`);
  if (!rows.length) {
    ctx.io.out('(no languages installed)');
    return;
  }
  printTable(
    ctx.io,
    ['ID', 'VERSION', 'LAYER', 'KIND', 'ON', 'RUN', 'EXTENSIONS'],
    rows.map((r) => [
      r.id,
      r.version,
      reg.layerOf(r.id)?.id ?? '-',
      r.kind,
      r.enabled ? 'yes' : 'off',
      r.runMode ?? '-',
      r.extensions.join(' '),
    ]),
  );
}

/**
 * `lang server` — one row per language: which server it wants, whether it is
 * here, how big it is, and what to type if it is not.
 *
 * This is the answer to "why is this language dumb?" without reading a manifest
 * or guessing a package name. Everything shown comes from the plugin itself
 * (`lsp.serverName`, `lsp.memoryHint`, `lsp.provider`), so a plugin installed
 * from a directory gets the same treatment as a built-in one.
 */
async function doServerStatus(ctx: Ctx, only?: string): Promise<void> {
  const reg = await open(ctx);
  const rows = reg
    .describe()
    .filter((r) => (only ? r.id === only : true))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!rows.length) {
    ctx.io.out(only ? `"${only}" is not installed` : '(no languages installed)');
    return;
  }
  ctx.io.out(`home ${reg.home}`);
  const statuses = rows.map((r) => {
    const entry = reg.entry(r.id);
    return entry ? statusFor(entry.manifest, reg.home) : undefined;
  });
  printTable(
    ctx.io,
    ['ID', 'SERVER', 'FOUND', 'WHERE', 'MEMORY', 'HOW'],
    statuses.filter((x): x is NonNullable<typeof x> => !!x).map((st) => [
      st.id,
      st.serverName,
      st.found ? 'yes' : 'MISSING',
      st.source,
      st.memoryHint ?? '-',
      st.found ? '' : st.plan.command ? st.plan.command.join(' ') : 'see `lang server install ' + st.id + '`',
    ]),
  );
  const missing = statuses.filter((x): x is NonNullable<typeof x> => !!x && !x.found);
  if (missing.length) {
    ctx.io.out('');
    ctx.io.out(`${missing.length} of ${statuses.length} language server(s) missing.`);
    for (const st of missing) {
      if (!st.plan.command) {
        ctx.io.out(`  ${st.id}: ${st.plan.manual ?? 'no provider declared'}`);
      }
    }
    ctx.io.out('  install with: nlg lang server install <id>');
  }
}

/** `lang server install <id>` — run the plugin's provider, or explain why not. */
async function doServerInstall(ctx: Ctx, id: string): Promise<void> {
  const reg = await open(ctx);
  const entry = reg.entry(id);
  if (!entry) throw new CliError(`"${id}" is not installed`);
  const st = statusFor(entry.manifest, reg.home);
  if (st.found) {
    ctx.io.out(`${id}: already available (${st.source}) at ${st.bin}`);
    return;
  }
  if (!st.plan.command) {
    // Manual by design: a GitHub release asset has no checksum we can verify, so
    // the product does not fetch one and pretend it is trustworthy.
    ctx.io.out(`${id}: no automatic install for this server.`);
    ctx.io.out(`  ${st.plan.manual ?? 'this plugin declares no provider (lsp.provider)'}`);
    return;
  }
  ctx.io.out(`${id}: ${st.plan.command.join(' ')}`);
  const result = await installServer(entry.manifest, reg.home, { onData: (d) => ctx.io.out(d.trimEnd()) });
  if (!result.ok) throw new CliError(result.error ?? 'install failed');
  ctx.io.out(`installed ${id}: ${result.bin}`);
  ctx.io.out('a running IDE picks this up on its next language-server restart');
}

async function doInfo(ctx: Ctx, id: string): Promise<void> {
  const reg = await open(ctx);
  const entry = reg.entry(id);
  if (!entry) throw new CliError(`"${id}" is not installed`);
  const m = entry.manifest;
  const out: string[] = [];
  out.push(`${m.id}@${m.version}${m.displayName ? `  ${m.displayName}` : ''}`);
  if (m.publisher) out.push(`  publisher   ${m.publisher}`);
  if (m.apiVersion) out.push(`  apiVersion  ${m.apiVersion}`);
  if (m.description) out.push(`  description ${m.description}`);
  out.push(`  kind        ${entry.source.kind}${entry.source.removable ? '' : ' (builtin)'}`);
  const layer = reg.layerOf(id);
  if (layer) out.push(`  layer       ${layer.id} (order ${layer.order}${layer.readOnly ? ', read-only' : ''})`);
  out.push(`  enabled     ${entry.enabled ? 'yes' : 'no'}`);
  out.push(`  body        ${entry.source.dir}`);
  out.push(`  data        ${reg.dataDir(id)}`);
  out.push(`  extensions  ${m.file?.extensions?.join(' ') ?? '-'}`);
  if (m.file?.defaultExt) out.push(`  default ext ${m.file.defaultExt}`);
  if (m.run?.mode) out.push(`  run         ${m.run.mode}`);
  if (m.lsp?.serverName) out.push(`  lsp         ${m.lsp.serverName}`);
  // Print the effective command: it is the field users override most often, and
  // seeing it here is how you confirm an override file actually took effect.
  if (m.lsp?.command?.length) out.push(`  lsp cmd     ${m.lsp.command.join(' ')}`);
  if (m.debug?.serverName) out.push(`  debug       ${m.debug.serverName} (${m.debug.type ?? '?'})`);
  // `requires` lives under `run` in the manifest (e.g. cpp needs template@^1.0.0).
  if (m.run?.requires?.length) out.push(`  requires    ${m.run.requires.join(', ')}`);
  const origins = await readOrigins(reg.home);
  if (origins[id]) out.push(`  origin      ${origins[id]}`);
  const override = reg.overrides().find((o) => o.id === id);
  if (override) {
    out.push(`  override    ${override.file}`);
    for (const field of override.changed) out.push(`                ${field}`);
    for (const field of override.stale) out.push(`                ! ${field}  在 manifest 中不存在`);
  }
  for (const problem of reg.overrideIssues()) {
    if (problem.includes(`${id}.json`)) out.push(`  ! override  ${problem}`);
  }
  ctx.io.out(out.join('\n'));
}

async function doUp(ctx: Ctx, id: string, explicit?: string): Promise<void> {
  const reg = await open(ctx);
  const entry = reg.entry(id);
  if (!entry) throw new CliError(`"${id}" is not installed`);
  const origins = await readOrigins(reg.home);
  const source = explicit ?? origins[id];
  if (!source) {
    throw new CliError(
      `"${id}" has no recorded origin — pass one: lang up ${id} <dir|zip|url|git>`,
      2,
    );
  }
  const kind = classifySource(source);
  ctx.io.out(`updating ${id} from ${source} (${kind})`);
  await doAdd(ctx, source);
}

async function doSearch(ctx: Ctx, query?: string): Promise<void> {
  const reg = await open(ctx);
  const { entries, errors } = await loadCatalog(ctx, reg.home);
  const installed = new Set(reg.describe().map((r) => r.id));

  if (errors.length) {
    ctx.io.out(`note: ${errors.length} source(s) skipped (offline or unreachable):`);
    for (const e of errors) ctx.io.out(`  ! ${e}`);
  }
  if (!entries.length) {
    ctx.io.out('search: no plugin index is reachable right now.');
    ctx.io.out('  configure sources with --source <url>, a <home>/sources.json,');
    ctx.io.out(`  or set a default index (current default: ${DEFAULT_INDEX_URL}).`);
    return;
  }

  const hits = searchEntries(entries, query);
  if (!hits.length) {
    ctx.io.out(query ? `no plugin matches "${query}"` : 'no plugins listed in the reachable index(es)');
    return;
  }
  ctx.io.out(`found ${hits.length} plugin(s)${query ? ` matching "${query}"` : ''}:`);
  printTable(
    ctx.io,
    ['NAME', 'VERSION', 'PUBLISHER', 'DESCRIPTION'],
    hits.map((e) => {
      const name = e.displayName ? `${e.displayName} (${e.id})` : e.id;
      const mark = installed.has(e.id) ? '  ✓ installed' : '';
      return [name + mark, e.version, e.publisher ?? '-', truncate(e.description ?? '-', 52)];
    }),
  );
  ctx.io.out('install with:  lang add <id>   (the id in parentheses above)');
}

/** Left-aligned columns sized to their content, as every other listing here. */
function printTable(io: LangIo, head: string[], body: string[][]): void {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  io.out(line(head));
  io.out(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) io.out(line(row));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
