/**
 * Run vitest — with the temp directory pinned, and with a check that nothing
 * was dropped.
 *
 * Two things went wrong here, and both were invisible:
 *
 *  1. Vite writes a transform cache under the OS temp folder. When that write is
 *     denied (sandbox, policy, another process holding the directory), vitest
 *     does not fail — it **drops the affected file** and reports the rest as a
 *     clean pass. `vitest.config.ts` already moved `cacheDir` into the repo for
 *     exactly this reason, but a second path (`<temp>/<random>/ssr/<hash>`) still
 *     went to the OS temp folder, so the same failure came back through another
 *     door. Pinning TMP/TEMP/TMPDIR closes both.
 *
 *  2. Even with the pin, "1 test file passed" while two exist on disk is not a
 *     result anybody would notice. So this wrapper counts the `*.test.ts` files
 *     on disk, reads vitest's JSON report, and fails when the report covers
 *     fewer files than the tree contains. A green run that skipped a file is the
 *     same class of lie as a suite that crashes before its first assertion.
 *
 * Run: node scripts/run-tests.mjs [extra vitest args]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const TMP = join(ROOT, '.tmp', 'vitest-tmp');
const REPORT = join(ROOT, '.tmp', 'vitest-report.json');

mkdirSync(TMP, { recursive: true });
mkdirSync(dirname(REPORT), { recursive: true });

// Every spelling of "the temp directory" that Node, Vite or a native addon
// might consult. Setting one and not the others is how the second door stayed
// open.
process.env.TMPDIR = TMP;
process.env.TMP = TMP;
process.env.TEMP = TMP;

/** Every test file the config's `include` should pick up. */
function testFilesOnDisk(dir = join(ROOT, 'tests')) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testFilesOnDisk(full));
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

// A positional argument is a file filter: the caller asked for a subset, so the
// on-disk count is not the expectation. Only a full run is checked for drops.
const extra = process.argv.slice(2);
const filtered = extra.some((a) => !a.startsWith('-'));
const onDisk = filtered ? [] : testFilesOnDisk();
const vitestBin = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const args = [
  vitestBin,
  'run',
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${REPORT}`,
  ...extra,
];

const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
child.on('close', (code) => {
  let reported = -1;
  try {
    const report = JSON.parse(readFileSync(REPORT, 'utf8'));
    reported = report.testResults?.length ?? -1;
  } catch {
    /* no report — the collection itself failed, which vitest already reported */
  }

  if (reported >= 0 && reported < onDisk.length) {
    console.error(
      `\n  FAIL  vitest collected ${reported} of ${onDisk.length} test files — ${onDisk.length - reported} were dropped.`,
    );
    console.error('        A dropped file is not a passing file. Check the temp-directory warnings above.');
    process.exit(1);
  }

  process.exit(code ?? 1);
});
