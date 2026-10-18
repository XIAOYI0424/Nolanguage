/**
 * `lang-install` — the command-line face of the language-plugin registry.
 *
 * Everything here goes through the same `LanguageRegistry` the IDE uses, so a
 * plugin installed from a terminal is byte-for-byte the same plugin the
 * `/plugins` page installs: validated at install time, migrations run before
 * the body is replaced, `data/<id>/` never touched by the copy.
 *
 * Usage:
 *   lang-install install <pluginDir>            validate, copy into <home>/languages, enable
 *   lang-install uninstall <id> [--drop-data]    remove the body; data is kept unless --drop-data
 *   lang-install enable <id> | disable <id>      flip the enabled flag
 *   lang-install list                            every plugin, where it lives, whether it is on
 *   lang-install dir <id>                         body dir + data dir of one plugin
 *
 * Flags:
 *   --home <dir>    plugin home (default: $NOLANGUAGE_HOME, else ~/.nolanguage)
 *
 * Exit codes: 0 ok · 1 operation failed · 2 bad usage.
 *
 * Deliberately not done here: talking to a *running* IDE. This process owns the
 * registry on disk; a panel that is already running keeps its own view until it
 * rescans, so a CLI install is for scripted/headless setups and for inspecting
 * a home directory. The `/plugins` page is the live path.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { LanguageRegistry, describeUnmet, type RegistryRoot } from '../src/langs/Registry.js';
import type { LanguageManifest } from '../src/langs/manifest.js';

const args = process.argv.slice(2);
const positional: string[] = [];
const dropData = args.includes('--drop-data');
const strictDeps = args.includes('--strict');
const wantsHelp = args.includes('--help') || args.includes('-h') || args.includes('help');
const homeIdx = args.indexOf('--home');
if (homeIdx >= 0 && !args[homeIdx + 1]) fail('--home needs a directory', 2);
const home = homeIdx >= 0 ? args[homeIdx + 1] : undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i] ?? '';
  if (a === '--home') {
    i++; // consume its value
    continue;
  }
  if (a === '--drop-data' || a === '--strict' || a === '--help' || a === '-h' || a === 'help') continue;
  if (a.startsWith('-')) fail(`unknown flag: ${a}`, 2);
  positional.push(a);
}

const command = positional[0];
const target = positional[1];

function usage(): never {
  const text = [
    'usage:',
    '  lang-install install <pluginDir>           validate, copy into <home>/languages, enable',
    '  lang-install uninstall <id> [--drop-data]  remove the body (data kept unless --drop-data)',
    '  lang-install enable <id>                   flip the enabled flag',
    '  lang-install disable <id>',
    '  lang-install list                          every plugin, where it lives, whether it is on',
    '  lang-install dir <id>                      body dir + data dir of one plugin',
    '',
    'flags: --home <dir>   plugin home (default: $NOLANGUAGE_HOME, else ~/.nolanguage)',
  ].join('\n');
  process.stdout.write(`${text}\n`);
  process.exit(wantsHelp || !command ? 0 : 2);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`lang-install: ${message}\n`);
  process.exit(code);
}

/**
 * Official plugins ship beside the source, user plugins under the home. The
 * same two rules the panel uses (`LANG_DIR` first, then the repo's `builtin/`
 * relative to this script and to the cwd), minus the packaged-exe assets —
 * a developer command has no executable to unpack.
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

async function readManifest(dir: string): Promise<LanguageManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as LanguageManifest;
  } catch {
    return undefined;
  }
}

/** Would copying `from` to `to` delete or swallow its own source? */
function overlapping(from: string, to: string): boolean {
  if (from === to) return true;
  return from.startsWith(to + sep) || to.startsWith(from + sep);
}

async function open(): Promise<LanguageRegistry> {
  const reg = new LanguageRegistry({ home, extraRoots: officialRoots() });
  await reg.scan();
  return reg;
}

async function main(): Promise<void> {
  if (!command || wantsHelp) usage();

  if (command === 'install') {
    if (!target) fail('install needs a plugin directory', 2);
    const src = resolve(target);
    if (!existsSync(join(src, 'manifest.json'))) fail(`no manifest.json in ${src}`);
    const manifest = await readManifest(src);
    if (!manifest?.id || !manifest.version) fail(`cannot read id/version from ${join(src, 'manifest.json')}`);

    const reg = await open();
    const destination = reg.installDir(manifest.id, manifest.version);
    if (overlapping(src, destination)) {
      // Installing a plugin onto itself would `rm` the source before copying it.
      console.log(`${manifest.id}@${manifest.version} is already installed at ${destination} — nothing to do`);
      return;
    }

    const out = await reg.install(src, { strictDeps });
    const wasEnabled = reg.isEnabled(out.id);
    if (!wasEnabled) await reg.enable(out.id); // a reinstall must not resurrect a banned plugin
    console.log(`installed ${out.id}@${out.version}`);
    console.log(`  body      ${out.dir}`);
    console.log(`  data      ${reg.dataDir(out.id)}`);
    console.log(`  enabled   ${wasEnabled ? 'yes' : 'yes (was disabled)'}`);
    if (out.migrated.length) console.log(`  migrated  ${out.migrated.join(', ')}`);
    if (out.requirements.requires.length) {
      // `run.requires` names host runtimes, so an unmet one is reported rather
      // than answered with "install something" — nothing can be installed.
      if (out.requirements.ok) {
        console.log(`  requires  ${out.requirements.requires.join(', ')} (met)`);
      } else {
        console.log(`  WARNING   unmet requirement: ${out.requirements.unmet.join(', ')}`);
        console.log(`            ${describeUnmet(out.id, out.requirements)}`);
      }
    }
    console.log('note: a running IDE applies this on its next start, or live from /plugins');
    return;
  }

  if (command === 'uninstall') {
    if (!target) fail('uninstall needs a plugin id', 2);
    const reg = await open();
    const entry = reg.entry(target);
    if (!entry) fail(`"${target}" is not installed`);
    if (!entry.source.removable) fail(`"${target}" is a builtin plugin — disable it instead of uninstalling`);
    await reg.uninstall(target, { keepData: !dropData });
    const data = reg.dataDir(target);
    console.log(`uninstalled ${target}@${entry.manifest.version}`);
    console.log(
      dropData
        ? `  dropped    ${data}${existsSync(data) ? '' : ' (there was none)'}`
        : `  kept data  ${data}${existsSync(data) ? '' : ' (there was none)'}`,
    );
    return;
  }

  if (command === 'enable' || command === 'disable') {
    if (!target) fail(`${command} needs a plugin id`, 2);
    const reg = await open();
    if (!reg.entry(target)) fail(`"${target}" is not installed`);
    if (command === 'enable') await reg.enable(target);
    else await reg.disable(target);
    console.log(`${command}d ${target}`);
    return;
  }

  if (command === 'list') {
    const reg = await open();
    const rows = reg
      .describe()
      .sort((a, b) => a.id.localeCompare(b.id));
    console.log(`home ${reg.home}`);
    if (!rows.length) {
      console.log('(no plugins found)');
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
    const line = (cells: string[]): string => cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
    console.log(line(head));
    console.log(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const row of body) console.log(line(row));
    return;
  }

  if (command === 'dir') {
    if (!target) fail('dir needs a plugin id', 2);
    const reg = await open();
    const entry = reg.entry(target);
    if (!entry) fail(`"${target}" is not installed`);
    console.log(entry.source.dir);
    console.log(reg.dataDir(target));
    return;
  }

  fail(`unknown command: ${command}`, 2);
}

main().catch((err: unknown) => fail((err as Error).message));
