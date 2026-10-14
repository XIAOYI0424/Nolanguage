/**
 * Runs every stage verification in sequence and reports a summary.
 * Plain JS (no TS) so it works with a bare `node` invocation.
 *
 *   node scripts/verify-all.mjs
 *
 * Each stage runs as a child process with the same TypeScript loader flags the
 * project uses everywhere else.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const NODE_FLAGS = [
  '--experimental-transform-types',
  '--no-warnings',
  '--experimental-loader',
  './resolve-loader.mjs',
];

const stages = [
  { name: 'Stage 1 · minimal kernel', script: 'scripts/verify-stage1.ts' },
  { name: 'Stage 2 · dev panel (WebSocket + UI)', script: 'scripts/verify-panel.ts' },
  { name: 'Stage 2 · panel UI self-containment', script: 'scripts/check-panel-html.ts' },
  { name: 'Stage 2 · LSP log collector parsing', script: 'scripts/test-logcollector.ts' },
  { name: 'Stage 3 · Python + pyright closed loop', script: 'scripts/verify-stage3.ts' },
  { name: 'Stage 4 · Python workspace (IDE)', script: 'scripts/verify-ide.ts' },
  { name: 'Stage 4 · IDE UI self-containment', script: 'scripts/check-ide-html.ts' },
  { name: 'UI · Vue pages mount in a DOM (jsdom)', script: 'scripts/verify-ui-dom.ts' },
  { name: 'Stage 5 · Go toolchain + gopls loop', script: 'scripts/verify-go.ts' },
  { name: 'Stage 6 · baseline system (git + SQLite + baselines)', script: 'scripts/verify-baseline.ts' },
  // Needs `npm run build:exe` (or build-to-exe.bat) first; skipped when the
  // packaged binary is absent, so a fresh clone still verifies.
  { name: 'Package · packaged exe smoke test', script: 'scripts/smoke-exe.ts', requiresExe: true },
];

function run(script, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
      process.stderr.write(d);
    });
    child.on('close', (code) => {
      const m = /(\d+)\/(\d+) (?:parsing )?checks passed/.exec(out);
      resolve({
        code,
        passed: m ? Number(m[1]) : 0,
        total: m ? Number(m[2]) : 0,
      });
    });
  });
}

const summary = [];
let failed = 0;

for (const [i, stage] of stages.entries()) {
  console.log(`\n${'='.repeat(72)}\n  ${stage.name}\n${'='.repeat(72)}`);
  if (stage.requiresExe && !existsSync(join(root, 'dist', 'Nolanguage.exe'))) {
    console.log('  SKIP  dist/Nolanguage.exe not built (run build-to-exe.bat)');
    summary.push({ ...stage, code: 0, passed: 0, total: 0, skipped: true });
    continue;
  }
  // Use a distinct port per run so parallel/leftover servers never collide.
  const res = await run(stage.script, { VERIFY_PORT: String(7500 + i), PANEL_PORT: String(7600 + i) });
  summary.push({ ...stage, ...res });
  if (res.code !== 0) failed++;
}

console.log(`\n${'='.repeat(72)}\n  SUMMARY\n${'='.repeat(72)}`);
for (const s of summary) {
  const mark = s.code === 0 ? (s.skipped ? 'SKIP' : 'PASS') : 'FAIL';
  console.log(`  ${mark}  ${s.name.padEnd(46)} ${s.passed}/${s.total} checks`);
}
const totalPassed = summary.reduce((a, s) => a + s.passed, 0);
const totalChecks = summary.reduce((a, s) => a + s.total, 0);
const ran = summary.filter((s) => !s.skipped).length;
console.log(`\n  ${totalPassed}/${totalChecks} checks passed across ${ran} suites`);
process.exit(failed ? 1 : 0);
