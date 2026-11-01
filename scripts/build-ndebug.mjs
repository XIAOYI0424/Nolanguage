/**
 * Build `dist/NDebug.exe` — the standalone observatory, as a Node SEA.
 *
 * Same technique as `build-exe.mjs` (bundle -> sea blob -> postject), with three
 * deliberate differences:
 *
 *   1. **Console subsystem is kept.** This is a command-line tool: it prints the
 *      page URL and streams the target's output. Hiding the console would hide
 *      the reason nothing happened.
 *   2. **No embedded asset tree.** The only assets are the two agent files,
 *      imported as text (`?raw`) and written to a temp dir at run time, so the
 *      binary is just node + our code.
 *   3. **The inherited certificate table is cleared**, exactly as the desktop
 *      build does — otherwise Authenticode refuses to sign the result and the
 *      file looks signed while being unsignable.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build', 'ndebug');
const DIST = join(ROOT, 'dist');
const EXE = join(DIST, 'NDebug.exe');
const NODE = process.execPath;
const TOOLS = join('C:', 'Users', '15936', '.workbuddy-ai', 'binaries', 'node', 'workspace');

const log = (...a) => console.log('[build-ndebug]', ...a);
const fail = (m) => {
  console.error(`[build-ndebug] ${m}`);
  process.exit(1);
};

// ------------------------------------------------------------------- tools

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

// ---------------------------------------------------------------- bundling

/** `?raw` text imports + `.js` -> `.ts`, mirroring resolve-loader.mjs. */
const rawPlugin = {
  name: 'ndebug-raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -4)),
      namespace: 'ndebug-raw',
    }));
    build.onLoad({ filter: /.*/, namespace: 'ndebug-raw' }, (args) => ({
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
  },
};

async function bundle() {
  mkdirSync(BUILD, { recursive: true });
  const outfile = join(BUILD, 'ndebug.cjs');
  await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'debugtool', 'cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs', // SEA's require() path is CJS; useCodeCache needs it too
    outfile,
    logLevel: 'warning',
    external: ['node:*'],
    plugins: [rawPlugin],
  });
  log(`bundled -> ${outfile} (${(statSync(outfile).size / 1024).toFixed(0)} KiB)`);
  return outfile;
}

function seaBlob(entry) {
  const configPath = join(BUILD, 'sea-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      { main: entry, output: join(BUILD, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: true },
      null,
      2,
    ),
  );
  log('generating SEA blob');
  execFileSync(NODE, ['--experimental-sea-config', configPath], { cwd: ROOT, stdio: 'inherit' });
  return join(BUILD, 'sea-prep.blob');
}

function inject(blob) {
  mkdirSync(DIST, { recursive: true });
  copyFileSync(NODE, EXE);
  log(`injecting NODE_SEA_BLOB into ${EXE}`);
  execFileSync(
    NODE,
    [postjectCli, EXE, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
    { cwd: ROOT, stdio: 'inherit' },
  );
}

/**
 * Clear the certificate table inherited from node.exe.
 *
 * The entry points into the middle of the new image, so Authenticode refuses to
 * sign it ("%1 is not a valid Win32 application"). Zeroing data directory 4 makes
 * the file honestly unsigned and signable again.
 */
function clearInheritedSignature(exe) {
  let fd;
  try {
    fd = openSync(exe, 'r+');
    const head = Buffer.alloc(4096);
    const read = readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, read);
    if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return false;
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff <= 0 || buf.readUInt32LE(peOff) !== 0x00004550) return false;
    const optOff = peOff + 24;
    const magic = buf.readUInt16LE(optOff);
    const is64 = magic === 0x20b;
    if (!is64 && magic !== 0x10b) return false;
    const dirOff = optOff + (is64 ? 112 : 96) + 4 * 8;
    if (dirOff + 8 > buf.length) return false;
    if (buf.readUInt32LE(dirOff + 4) === 0) return false;
    writeSync(fd, Buffer.alloc(8), 0, 8, dirOff);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// -------------------------------------------------------------------- main

rmSync(BUILD, { recursive: true, force: true });
const entry = await bundle();
const blob = seaBlob(entry);
inject(blob);
if (clearInheritedSignature(EXE)) log('cleared the inherited node.exe signature (stale certificate table)');

const mb = statSync(EXE).size / 1024 / 1024;
log(`done -> ${EXE} (${mb.toFixed(1)} MiB)`);
log(`run: ${EXE} path\\to\\app.py`);
