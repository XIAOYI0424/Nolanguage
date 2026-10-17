/**
 * Build a standalone Windows executable for Nolanguage.
 *
 *   node scripts/build-exe.mjs
 *
 * Produces `dist/Nolanguage.exe` — a Node Single Executable Application (SEA)
 * that boots the workspace server on double-click. No Node installation is
 * required to run it; `node:sqlite` and the other built-ins come from the Node
 * runtime embedded in the exe itself.
 *
 * Steps:
 *   1. bundle   esbuild inlines src/** into one ESM file. A plugin mirrors
 *                `resolve-loader.mjs` (`.js` -> `.ts`) and loads `.py` as text.
 *   2. embed    a prelude defines `globalThis.__NOLANGUAGE_EMBEDDED__`, carrying
 *                the Python language server so the exe is self-contained.
 *   3. sea       `node --experimental-sea-config` turns the bundle into a blob.
 *   4. inject   postject writes the blob into a `NODE_SEA_BLOB` PE section.
 *
 * Tooling (esbuild, postject) is installed into the isolated node workspace at
 * `C:/Users/15936/.workbuddy-ai/binaries/node/workspace` rather than the project
 * `node_modules`, so building adds no project dependencies.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BUILD = join(ROOT, 'build');
const NODE = process.execPath;
const TOOLS = join('C:', 'Users', '15936', '.workbuddy-ai', 'binaries', 'node', 'workspace');
const EXE = join(DIST, process.env.NOLANGUAGE_EXE_NAME ?? 'Nolanguage.exe');
const NAME = process.env.NOLANGUAGE_EXE_NAME ?? 'Nolanguage.exe';

const log = (...a) => console.log('[build-exe]', ...a);
const fail = (m) => {
  console.error(`[build-exe] ${m}`);
  process.exit(1);
};

// ------------------------------------------------------------------- tools

// Tooling (esbuild/postject) is installed into the isolated node workspace on
// this machine; on CI it is installed into the project's own node_modules.
// Resolve from the isolated workspace first, then fall back to the project, so
// the exact same build runs in both places without adding a project dependency.
const projectRequire = createRequire(join(ROOT, 'package.json'));
function toolRequire(name) {
  try {
    return createRequire(join(TOOLS, 'package.json'))(name);
  } catch {
    return projectRequire(name);
  }
}
let esbuild;
try {
  esbuild = toolRequire('esbuild');
} catch {
  fail(`esbuild not found — run: npm i --no-save esbuild (or place it in ${TOOLS})`);
}
let postjectCli = '';
try {
  postjectCli = createRequire(join(TOOLS, 'package.json')).resolve('postject/dist/cli.js');
} catch {
  try {
    postjectCli = projectRequire.resolve('postject/dist/cli.js');
  } catch {
    postjectCli = '';
  }
}
if (!postjectCli || !existsSync(postjectCli)) {
  fail(`postject not found — run: npm i --no-save postject (or place it in ${TOOLS})`);
}

// -------------------------------------------------------- 1 & 2. bundling

/** Mirrors `resolve-loader.mjs`: `.js` specifiers resolve to sibling `.ts`. */
const resolveExtPlugin = {
  name: 'nolanguage-resolve',
  setup(build) {
    // Vite-style `?raw` text imports: the file's text becomes the module's
    // default export. Used to inline the vendored Vue runtime and the
    // browser-side app sources into the single-file HTML the panel serves.
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -4)),
      namespace: 'nolanguage-raw',
    }));
    build.onLoad({ filter: /.*/, namespace: 'nolanguage-raw' }, (args) => ({
      contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))};`,
      loader: 'js',
    }));
    build.onResolve({ filter: /^\.[^?]*$/ }, (args) => {
      const abs = resolve(args.resolveDir, args.path);
      if (abs.endsWith('.js') && !existsSync(abs) && existsSync(`${abs.slice(0, -3)}.ts`)) {
        return { path: `${abs.slice(0, -3)}.ts` };
      }
      return null;
    });
    // `pyrightServer.py` is imported as a string module by the embedded prelude.
    build.onResolve({ filter: /\.py$/ }, (args) => ({ path: resolve(args.resolveDir, args.path) }));
    build.onLoad({ filter: /\.py$/ }, (args) => ({
      contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))};`,
      loader: 'js',
    }));
  },
};

const PYRIGHT = join(ROOT, 'src', 'python', 'pyrightServer.py');

/**
 * Ship a source tree as embedded assets, keyed by its path under the repo root.
 *
 * Used for the built-in demo extensions (the extension host child process
 * imports them by *path*) and for the official language plugins (`builtin/`,
 * whose manifests and bootstrap scripts are read off disk by the registry). A
 * packaged build has no source tree to read them from.
 */
function embeddedTree(relRoot, prefix) {
  const root = join(ROOT, relRoot);
  const out = {};
  if (!existsSync(root)) return out;
  const walk = (dir, keyPrefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const key = `${keyPrefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, key);
      else out[`${prefix}${key}`] = readFileSync(full, 'utf8');
    }
  };
  walk(root, '');
  return out;
}

/** Back-compat name for the demo extensions. */
function embeddedExtensions() {
  return embeddedTree(join('src', 'extensions', 'examples'), 'extensions/examples');
}

/** Official language plugins: manifests, grammar and bootstrap scripts. */
function embeddedBuiltinLanguages() {
  return embeddedTree('builtin', 'builtin');
}

/**
 * Node SEA requires the entry to be CommonJS (the blob is executed through the
 * CJS loader, so an ESM entry fails with "Cannot use import statement outside a
 * module"), and `useCodeCache` is only supported for CJS too.
 */
async function bundle() {
  mkdirSync(BUILD, { recursive: true });
  const target = join(BUILD, 'app.embedded.cjs');
  await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'desktop', 'main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: target,
    logLevel: 'warning',
    sourcemap: 'inline',
    external: ['node:*'],
    plugins: [resolveExtPlugin],
    banner: {
      js:
        `globalThis.__NOLANGUAGE_EMBEDDED__ = ${JSON.stringify({
          'pyrightServer.py': readFileSync(PYRIGHT, 'utf8'),
          ...embeddedExtensions(),
          ...embeddedBuiltinLanguages(),
        })};\n`,
    },
  });
  const kb = statSync(target).size / 1024;
  log(`bundled + embedded assets -> ${target} (${kb.toFixed(0)} KiB)`);
  return target;
}

// ------------------------------------------------------------------- 3. sea

function seaBlob(entry) {
  const configPath = join(BUILD, 'sea-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        main: entry,
        output: join(BUILD, 'sea-prep.blob'),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: true,
      },
      null,
      2,
    ),
  );
  log('generating SEA blob');
  execFileSync(NODE, ['--experimental-sea-config', configPath], { cwd: ROOT, stdio: 'inherit' });
  return join(BUILD, 'sea-prep.blob');
}

// --------------------------------------------------------------- 4. inject

function inject(blob) {
  mkdirSync(DIST, { recursive: true });
  copyFileSync(NODE, EXE); // start from a pristine Node runtime
  log(`injecting NODE_SEA_BLOB into ${EXE}`);
  // The default fuse sentinel is baked into Node exactly for this purpose.
  execFileSync(
    NODE,
    [postjectCli, EXE, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
    { cwd: ROOT, stdio: 'inherit' },
  );
}

// -------------------------------------------------------------------- main

rmSync(BUILD, { recursive: true, force: true });
const entry = await bundle();
const blob = seaBlob(entry);
inject(blob);

// Files that must live next to the exe rather than inside the blob.
const readme = join(ROOT, 'README.md');
if (existsSync(readme)) copyFileSync(readme, join(DIST, 'README.md'));

const mb = statSync(EXE).size / 1024 / 1024;
log(`done -> ${EXE} (${mb.toFixed(1)} MiB)`);
log(`double-click ${NAME}, or run it from a terminal to see the log output`);
