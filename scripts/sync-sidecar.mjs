#!/usr/bin/env node
/**
 * Mirror the packaged app image into the Tauri sidecar slot.
 *
 *   node scripts/sync-sidecar.mjs           # copy when the bytes differ
 *   node scripts/sync-sidecar.mjs --check   # exit 1 when out of sync (CI gate)
 *
 * Why this exists: the Tauri shell spawns `NolanguageEngine.exe`, which must be
 * byte-identical to `dist/Nolanguage.exe` (same engine, renamed for the
 * bundle). Copying it by hand has already shipped one installer whose shell was
 * new while its engine was two builds old. `tauri.conf.json` runs this before
 * every `tauri build`, so the two can no longer drift.
 *
 * The triple comes from `TAURI_ENV_TARGET_TRIPLE` (set by the Tauri CLI) and
 * falls back to the host default; Tauri appends the triple to `externalBin`
 * names at bundle time, so the file on disk must carry it too.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRIPLE =
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  process.env.CARGO_BUILD_TARGET ??
  'x86_64-pc-windows-msvc';
const WINDOWS = TRIPLE.includes('windows');

const SOURCE = join(ROOT, 'dist', WINDOWS ? 'Nolanguage.exe' : 'Nolanguage');
const DEST = join(
  ROOT,
  'src-tauri',
  'binaries',
  `NolanguageEngine-${TRIPLE}${WINDOWS ? '.exe' : ''}`,
);

const checkOnly = process.argv.includes('--check');
const log = (...a) => console.log('[sync-sidecar]', ...a);

/** Short content digest — enough to detect drift without dumping 64 chars. */
function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

if (!existsSync(SOURCE)) {
  console.error(`[sync-sidecar] missing ${SOURCE}`);
  console.error('[sync-sidecar] run `npm run build:exe` first.');
  process.exit(1);
}

if (!existsSync(DEST)) {
  if (checkOnly) {
    console.error(`[sync-sidecar] out of sync: ${DEST} does not exist`);
    process.exit(1);
  }
  mkdirSync(dirname(DEST), { recursive: true });
  copyFileSync(SOURCE, DEST);
  log(`created ${DEST} (${digest(DEST)})`);
  process.exit(0);
}

const sourceHash = digest(SOURCE);
const destHash = digest(DEST);

if (sourceHash === destHash) {
  log(`up to date (${sourceHash}) · ${DEST}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`[sync-sidecar] out of sync: dist=${sourceHash} sidecar=${destHash}`);
  console.error(`[sync-sidecar] run \`node scripts/sync-sidecar.mjs\` to fix.`);
  process.exit(1);
}

copyFileSync(SOURCE, DEST);
log(`updated sidecar ${destHash} -> ${sourceHash}`);
log(
  `  ${(statSync(SOURCE).size / 1024 / 1024).toFixed(1)} MiB · ` +
    `dist/Nolanguage.exe -> src-tauri/binaries/NolanguageEngine-${TRIPLE}${WINDOWS ? '.exe' : ''}`,
);
