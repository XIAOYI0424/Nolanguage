/**
 * Build a standalone Windows installer (Nolanguage-Setup.exe) as a Node Single
 * Executable Application, using the same isolated toolchain as build-exe.mjs.
 *
 *   node installer/build-setup.mjs
 *
 * Produces installer/Nolanguage-Setup.exe. The installer reads the application
 * executable from a sibling payload/Nolanguage.exe at runtime, so no third-party
 * packager (NSIS / WiX / makensis) is required.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = join(ROOT, 'installer');
const DIST = join(INSTALLER, 'Nolanguage-Setup.exe');
const BUILD = join(INSTALLER, '.build');
const NODE = process.execPath;
const TOOLS = join('C:', 'Users', '15936', '.workbuddy-ai', 'binaries', 'node', 'workspace');

const log = (...a) => console.log('[build-setup]', ...a);

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
  log('esbuild not found — run: npm i --no-save esbuild');
  process.exit(1);
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
  log('postject not found — run: npm i --no-save postject');
  process.exit(1);
}

const resolveExtPlugin = {
  name: 'nolanguage-resolve',
  setup(build) {
    build.onResolve({ filter: /^\.[^?]*$/ }, (args) => {
      const abs = resolve(args.resolveDir, args.path);
      if (abs.endsWith('.js') && !existsSync(abs) && existsSync(`${abs.slice(0, -3)}.ts`)) {
        return { path: `${abs.slice(0, -3)}.ts` };
      }
      return null;
    });
  },
};

async function bundle() {
  mkdirSync(BUILD, { recursive: true });
  const target = join(BUILD, 'setup.embedded.cjs');
  await esbuild.build({
    entryPoints: [join(INSTALLER, 'setup-entry.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: target,
    logLevel: 'warning',
    sourcemap: 'inline',
    external: ['node:*'],
    plugins: [resolveExtPlugin],
  });
  log(`bundled -> ${target} (${statSync(target).size / 1024} KiB)`);
  return target;
}

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

function inject(blob) {
  mkdirSync(INSTALLER, { recursive: true });
  copyFileSync(NODE, DIST);
  log(`injecting NODE_SEA_BLOB into ${DIST}`);
  execFileSync(
    NODE,
    [postjectCli, DIST, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
    { cwd: ROOT, stdio: 'inherit' },
  );
}

rmSync(BUILD, { recursive: true, force: true });
const entry = await bundle();
const blob = seaBlob(entry);
inject(blob);
log(`done -> ${DIST} (${(statSync(DIST).size / 1024 / 1024).toFixed(1)} MiB)`);
log('to ship: place Nolanguage.exe in installer/payload/ next to this setup.');
