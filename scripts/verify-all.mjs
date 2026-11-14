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
  { name: 'Stage 2 · panel UI self-containment', script: 'scripts/check-panel-html.ts', pure: true },
  { name: 'Stage 2 · LSP log collector parsing', script: 'scripts/test-logcollector.ts', pure: true },
  { name: 'Stage 3 · Python + pyright closed loop', script: 'scripts/verify-stage3.ts' },
  { name: 'Stage 4 · Python workspace (backend)', script: 'scripts/verify-ide.ts' },
  { name: 'Workspace · PyCharm shell (mount + self-containment)', script: 'scripts/verify-pycharm.ts' },
  { name: 'MCP · client (config + stdio lifecycle)', script: 'scripts/verify-mcp.ts' },
  { name: 'Doctor · diagnostics (pure)', script: 'scripts/verify-doctor.ts', pure: true },
  // Launch-time build handshake: liveness is not identity. A freshly installed
  // exe that finds the *previous* build on 7310 must replace it, not exit.
  { name: 'Desktop · version handshake', script: 'scripts/verify-handshake.ts', pure: true },
  // P1 migration thresholds: interpreter discovery + `.idea` run configurations.
  { name: 'Migration · interpreter + .idea import', script: 'scripts/verify-migration.ts', pure: true },
  // Stage 11: CUSUM + Welch t + Cohen's d + bisect.
  { name: 'Stage 11 · attribution engine', script: 'scripts/verify-attribution.ts', pure: true },
  // Code signing: PE header read, script wiring, doctor report.
  { name: 'Release · code signing', script: 'scripts/verify-sign.ts', pure: true },
  // Debug observatory (M0): protocol/serializer/sampler + a real Python probe.
  { name: 'Debug · observatory (protocol + channel)', script: 'scripts/verify-debugtool.ts' },
  // The standalone app: session, page, and a real attach through the CLI path.
  { name: 'Debug · observatory app (ndebug)', script: 'scripts/verify-ndebug.ts' },
  // Snapshot diff: pure logic, so it belongs in the fast gate.
  { name: 'Debug · snapshot diff', script: 'scripts/verify-diff.ts', pure: true },
  // Bounds: big values, big trees, runaway lines, and the agent's own cost.
  { name: 'Debug · stress (bounds)', script: 'scripts/verify-stress.ts' },
  // Go: pprof parsing + a real attach against a compiled sample.
  { name: 'Debug · go attach (pprof)', script: 'scripts/verify-ndebug-go.ts' },
  // Redaction rules: pure, so it belongs in the fast gate.
  { name: 'Debug · redaction rules', script: 'scripts/verify-redact.ts', pure: true },
  // Recording export: token removal, re-redaction, scrub patterns.
  { name: 'Debug · sanitize a recording', script: 'scripts/verify-sanitize.ts' },
  // The architecture contract: layers, cycles, product boundary, budgets.
  { name: 'Arch · contract', script: 'scripts/verify-architecture.ts', pure: true },
  // scripts/ was never in tsconfig's include; this ratchets the remainder down.
  { name: 'Arch · types in scripts', script: 'scripts/verify-types.ts' },
  // Documents are claims about the code. Runs after `Arch · contract` because it
  // reads the summary that suite writes; if the order ever changes, this suite
  // fails loudly rather than passing on a missing file.
  { name: 'Docs · claims match the code', script: 'scripts/verify-docs.ts', pure: true },
  // The workflow is a claim too: every command it names must exist, and it must
  // install from the lockfile.
  { name: 'CI · the workflow is honest', script: 'scripts/verify-ci.ts', pure: true },
  { name: 'Perf · kernel analysis UI self-containment', script: 'scripts/check-perf-html.ts', pure: true },
  // Phase 3: the Plugins page — self-containment, theming, emoji rules, and the
  // promise that every message it sends is one the server answers.
  { name: 'Plugins · page self-containment', script: 'scripts/check-plugins-html.ts', pure: true },
  { name: 'Profile · flamegraph page self-containment', script: 'scripts/check-profile-html.ts', pure: true },
  // script-host OS-level memory cap: human-string parsing, env-wins-over-
  // manifest precedence, the 256MB default, and the [64MB, 4GB] clamp.
  { name: 'Runtimes · script-host memory cap', script: 'scripts/verify-script-host.ts' },
  { name: 'Dev Panel pages mount in a DOM (jsdom)', script: 'scripts/verify-ui-dom.ts' },
  // Stage 8: Markdown — zero-dependency renderer (blocks/inlines/safety),
  // marksman discovery SKIP semantics, and the live mdRender/mdPreview round trip.
  { name: 'Stage 8 · Markdown (renderer + discovery + preview)', script: 'scripts/verify-markdown.ts' },
  { name: 'Stage 5 · Go toolchain + gopls loop', script: 'scripts/verify-go.ts' },
  // JavaScript runs on the Stage 9 warm pool: node discovery, the pool's
  // per-session worker semantics, and the missing-LSP degrade path.
  { name: 'Stage 9 · JavaScript (node + warm pool)', script: 'scripts/verify-javascript.ts' },
  // The pool itself: warm reuse, namespace carry-over, session isolation,
  // timeouts, reset, the log spine, and the frame protocol both workers speak.
  // Its absence is how two Python-worker defects lived here unnoticed: a missing
  // `contextlib` import and a frame writer that never sent the body.
  { name: 'Stage 9 · execution plane (warm pool)', script: 'scripts/verify-exec.ts' },
  // Stage 10: user-code profiling — Python cProfile hotspots, Go pprof (SKIP
  // when the toolchain is absent), the profiler.* commands and the WS round trip.
  { name: 'Stage 10 · Profiler (Python cProfile + Go pprof)', script: 'scripts/verify-profiler.ts' },
  // Language plugins: manifest contract + version ranges, the registry
  // (scan/order/enable/install/uninstall + data separation), all five runtime
  // extensions against real processes, and RunnerFactory's single path.
  { name: 'Plugins · language substrate (registry + 5 runtimes)', script: 'scripts/verify-langplugins.ts' },
  // `nlg lang add` accepts five source shapes; this is the resolver underneath:
  // zip/tar parsing by hand, the wrapper-folder descent, and — most importantly —
  // that no archive entry can escape the destination.
  { name: 'Plugins · source resolution (dir/zip/tar/git/url)', script: 'scripts/verify-langsource.ts' },
  // `run.requires` is checked at install time, not only at Run: an unmet
  // requirement is reported (and refuses the install under --strict, before the
  // body is copied). Those are host runtimes, so the message must not promise
  // an installable fix.
  { name: 'Plugins · dependency resolution (requires + strict)', script: 'scripts/verify-langdeps.ts' },
  // `nlg lang search` / `add <id>`: a static JSON index (file or https), multiple
  // sources merged by highest version, query filtering, and graceful offline.
  { name: 'Plugins · catalog / online index (search + resolve)', script: 'scripts/verify-langcatalog.ts' },
  // Phase 3 + 4: install/uninstall/enable/disable applied live, the memory
  // budget (LRU + idle + the eager exemption), and upgrade migration scripts.
  { name: 'Plugins · lifecycle, budget + migrations', script: 'scripts/verify-plugins.ts' },
  // Phase 6: the DAP runtime — a real framed-JSON-RPC session against a mock
  // adapter, degradation when no adapter is installed, and the debug contract.
  { name: 'Phase 6 · DAP runtime (mock adapter + degradation)', script: 'scripts/verify-dap.ts' },
  // The Tauri seam: WebSocket and stdio must be interchangeable, and the real
  // engine must speak the protocol on a pipe (what the Rust relay does).
  { name: 'Transport · ws ⇄ stdio equivalence', script: 'scripts/verify-transport.ts' },
  { name: 'Stage 6 · baseline system (git + SQLite + baselines)', script: 'scripts/verify-baseline.ts' },
  { name: 'Stage 5 · extension host (child process + RPC)', script: 'scripts/verify-extensions.ts' },
  // Project explorer: FsService containment/CRUD + the `fs*` wire protocol,
  // including the upgrade-origin check.
  { name: 'Stage 4 · project explorer (FsService + fs protocol)', script: 'scripts/verify-explorer.ts' },
  // Desktop window launcher: engine resolution + profile + launch contract.
  { name: 'Desktop · WebView host (engine + window)', script: 'scripts/verify-webview.ts' },
  // Needs `npm run build:exe` (or build-to-exe.bat) first; skipped when the
  // packaged binary is absent, so a fresh clone still verifies.
  { name: 'Package · packaged exe smoke test', script: 'scripts/smoke-exe.ts', requiresExe: true },
  // The MCP panel as a user meets it: mcp.json -> the shipped exe -> the
  // sidebar. `verify-mcp` covers the manager; this covers the wiring, including
  // a per-server `timeoutMs` and the failure cards (dead server, disabled,
  // unknown id).
  { name: 'Package · MCP client in the packaged exe', script: 'scripts/verify-mcp-exe.ts', requiresExe: true },
  // `nlg web` / `nlg desktop` entry points boot the workspace server.
  { name: 'CLI · nlg web / nlg desktop launch', script: 'scripts/verify-cli-launch.ts' },
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
      // A suite that dies before its first check reports 0/0, which on its own
      // explains nothing. Echo what it actually said whenever it failed.
      if (code !== 0) {
        console.log(out.trim() ? out : '(the suite produced no output)');
        console.log(`  exit code ${code}`);
      }
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

// Filters, so CI can run the fast gate before the expensive one.
//   --pure        suites that need no server, toolchain, browser or exe
//   --skip-exe    everything that does not require dist/Nolanguage.exe
//   --only <s>    substring match on the suite name
const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;
const pureOnly = argv.includes('--pure');
const skipExe = argv.includes('--skip-exe');
const selected = stages.filter((stage) => {
  if (only && !stage.name.toLowerCase().includes(String(only).toLowerCase())) return false;
  if (pureOnly && !stage.pure) return false;
  if (skipExe && stage.requiresExe) return false;
  return true;
});
if (pureOnly || skipExe || only) {
  console.log(`  filter: ${selected.length}/${stages.length} suites` +
    (pureOnly ? ' (pure)' : '') + (skipExe ? ' (no exe)' : '') + (only ? ` (matching "${only}")` : ''));
}

// A filter that selects nothing must fail. Otherwise `--pure` in CI goes green
// having run zero suites — the same lie as a suite that crashes before its first
// assertion, one level up. It is reachable: drop the `pure: true` markers, or
// mistype `--only`, and the summary would read "0/0 checks passed".
if (selected.length === 0) {
  console.error('\n  FAIL  the filter selected no suites — nothing was verified');
  console.error(`        flags: ${argv.join(' ') || '(none)'}  ·  ${stages.length} suites available`);
  process.exit(1);
}

for (const [i, stage] of selected.entries()) {
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
// A suite that ran but produced no checks did not pass — it crashed before its
// first assertion. Marking that "0/0 PASS" is how a broken suite hides inside a
// green total (this happened: a moved module broke one suite's import, and the
// summary still read "1978/1978 passed").
let empty = 0;
for (const s of summary) {
  const isCrashed = !s.skipped && s.code !== 0;
  const isEmpty = !s.skipped && s.code === 0 && s.total === 0;
  if (isEmpty) empty++;
  const mark = s.skipped ? 'SKIP' : isCrashed ? 'FAIL' : isEmpty ? 'EMPTY' : 'PASS';
  console.log(`  ${mark}  ${s.name.padEnd(46)} ${s.passed}/${s.total} checks`);
}
const totalPassed = summary.reduce((a, s) => a + s.passed, 0);
const totalChecks = summary.reduce((a, s) => a + s.total, 0);
const ran = summary.filter((s) => !s.skipped).length;
const bad = failed + empty;
console.log(
  `\n  ${totalPassed}/${totalChecks} checks passed across ${ran} suites` +
    (bad ? `  ·  ${bad} SUITE(S) DID NOT PASS` : ''),
);
process.exit(bad ? 1 : 0);
