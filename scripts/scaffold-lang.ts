/**
 * `npm run scaffold:lang -- --id=lua --ext=lua --run=repl-session --lsp=lua-language-server`
 *
 * Writes a plugin directory whose manifest already passes `validateManifest`, so
 * the first run of a new language is not a debugging session about `requires`
 * strings. The generator is `src/langs/scaffoldPlugin.ts`; this file is the CLI:
 * argument parsing, overwrite policy, and the after-care checklist.
 *
 * Refuses to write into a non-empty directory without `--force`, because the
 * common accident is re-running with the same id and clobbering hand edits.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { buildLanguagePlugin, RUN_MODES, type RunMode } from '../src/langs/scaffoldPlugin.js';
import { validateManifest } from '../src/langs/manifest.js';

const ROOT = process.cwd();

interface Args {
  id?: string;
  name?: string;
  ext?: string;
  version?: string;
  run?: string;
  lsp?: string;
  keywords?: string;
  comment?: string;
  out?: string;
  builtin: boolean;
  force: boolean;
  print: boolean;
  help: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = { builtin: false, force: false, print: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = (eq >= 0 ? raw.slice(2, eq) : raw.slice(2)).toLowerCase();
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return '';
      i++;
      return next;
    };
    switch (key) {
      case 'id':
        args.id = value();
        break;
      case 'name':
      case 'display-name':
        args.name = value();
        break;
      case 'ext':
      case 'extensions':
        args.ext = value();
        break;
      case 'version':
        args.version = value();
        break;
      case 'run':
      case 'mode':
        args.run = value();
        break;
      case 'lsp':
      case 'lsp-command':
        args.lsp = value();
        break;
      case 'keywords':
        args.keywords = value();
        break;
      case 'comment':
      case 'comment-prefix':
        args.comment = value();
        break;
      case 'out':
      case 'dir':
        args.out = value();
        break;
      case 'builtin':
        args.builtin = true;
        break;
      case 'force':
        args.force = true;
        break;
      case 'print':
        args.print = true;
        break;
      case 'help':
        args.help = true;
        break;
      default:
        throw new Error(`unknown option --${key} (try --help)`);
    }
  }
  return args;
}

const USAGE = `Usage: npm run scaffold:lang -- --id=<id> --ext=<ext> [options]

  --id <id>            plugin id and folder name (required, lowercase)
  --ext <a,b>          file extensions without the dot (required)
  --name <name>        display name (default: the id, capitalised)
  --version <v>        plugin version (default: 1.0.0)
  --run <mode>         ${RUN_MODES.join(' | ')}   (default: none)
  --lsp <command>      language server command, e.g. rust-analyzer
  --keywords <a,b>     words highlighted as keywords
  --comment <prefix>   line-comment prefix (default: //)
  --builtin            write to builtin/ instead of examples/
  --force              overwrite a non-empty target directory
  --print              print the files instead of writing them
  --help               this text`;

function fail(message: string): never {
  console.error(`scaffold:lang: ${message}`);
  process.exit(1);
}

function main(): void {
  const args = parse(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!args.id) fail('--id is required');
  if (!args.ext) fail('--ext is required (for example --ext=rs,rlib)');
  const run = (args.run ?? 'none').toLowerCase();
  if (!RUN_MODES.includes(run as RunMode)) fail(`--run must be one of ${RUN_MODES.join(', ')}`);

  const built = buildLanguagePlugin({
    id: args.id,
    displayName: args.name,
    extensions: [args.ext],
    version: args.version,
    run: run as RunMode,
    lspCommand: args.lsp,
    keywords: args.keywords ? args.keywords.split(',') : undefined,
    commentPrefix: args.comment,
  });

  // The manifest must pass the same validation the loader applies. A generator
  // that emits an invalid plugin is worse than no generator: it looks official.
  const verdict = validateManifest(built.manifest);
  if (!verdict.ok) {
    const detail = verdict.issues.map((i) => `${i.field}: ${i.message}`).join('; ');
    fail(`the generated manifest would not load — this is a generator bug: ${detail}`);
  }

  if (args.print) {
    for (const file of built.files) console.log(`--- ${file.path}\n${file.content}`);
    if (built.todos.length > 0) for (const todo of built.todos) console.error(`TODO  ${todo}`);
    return;
  }

  const root = args.builtin ? 'builtin' : 'examples';
  const dir = resolve(ROOT, args.out ?? join(root, `${built.manifest.id}@${built.manifest.version}`));
  if (!dir.startsWith(ROOT)) fail(`refusing to write outside the repository: ${dir}`);
  if (existsSync(dir) && readdirSync(dir).length > 0 && !args.force) {
    fail(`${relative(ROOT, dir)} is not empty; pass --force to overwrite it`);
  }
  for (const file of built.files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }

  console.log(`wrote ${relative(ROOT, dir)}`);
  for (const file of built.files) console.log(`  ${file.path}`);
  console.log('');
  console.log(`plugin id      ${built.manifest.id}`);
  console.log(`extensions     ${built.manifest.file.extensions.join(' ')}`);
  console.log(`run            ${built.manifest.run?.mode ?? 'none (Run is disabled)'}`);
  console.log(`lsp            ${built.manifest.lsp?.serverName ?? 'none (Check and hover are unavailable)'}`);
  for (const todo of built.todos) console.log(`TODO           ${todo}`);
  console.log('');
  console.log('next:');
  console.log('  npm run lang -- ls                      # the plugin is picked up without a restart');
  console.log('  npm run verify:langparity               # shape and literal-budget checks');
  console.log('  npm run verify:lsp-protocol             # only if you declared an lsp block');
  console.log('  docs/添加新语言指南.md §6.3              # the full self-check list');
}

main();
