/**
 * Startup, gated on the number that means "the server is done loading".
 *
 * Three contracts, three instruments:
 *
 * 1. **The baseline is real** — `perf-baseline.json` must cover every language
 *    that declares a server, and every entry must carry all three thresholds.
 *    This part runs on a machine with nothing installed, so the file cannot rot
 *    into a list of languages the product no longer has.
 * 2. **The first Python keystroke** — with `eager: false` nothing starts at
 *    boot, so the first key pays for a server. The stub must answer inside
 *    500 ms and the real server must take over afterwards. This is the cost of
 *    moving the wait off the launch path, and it is the reason the flag is safe
 *    to turn off.
 * 3. **`stable` per language** — handshake and first-answer are recorded but not
 *    gated. A JVM that starts in 2 s instead of 1.9 s is not a regression; a
 *    server that takes twice as long to *finish loading* is.
 *
 * # Why attempts instead of one number
 *
 * A single measurement on a shared Windows box is not a measurement: one build
 * running in the background moved every server's handshake by 1.5 s here, and a
 * gate that fails for that reason gets ignored and then deleted. So a latency
 * contract is checked the way an SLO is: several *independent* cold attempts,
 * best one wins. Best-of-three still fails a real regression — a server that
 * genuinely takes 900 ms cannot produce a 400 ms attempt — and it stops
 * reporting the machine's mood as the product's fault.
 *
 * Run: npm run verify:startup
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Kernel } from '../src/kernel/Kernel.js';
import type { LanguageManifest } from '../src/langs/manifest.js';
import { resolveServer } from '../src/langs/serverInstall.js';
import { LspClient } from '../src/lsp/LspClient.js';
import { WorkspaceService } from '../src/panel/WorkspaceService.js';
import { languageRoots } from '../src/panel/handlers/plugins.js';
import { hoverText, launchFor, measureStartup, targets } from './lib/lspProbe.js';

const ROOT = process.cwd();
// Per-process: a shared directory grows past the sandbox's bulk-delete guard
// after a few runs, and `rmSync` then refuses to clear it.
const SANDBOX = join(ROOT, '.tmp', 'verify-startup', String(process.pid));
/** The product's own home: a `nlg lang server install` must be visible here. */
const HOME = process.env.NOLANGUAGE_HOME ?? join(homedir(), '.nolanguage');
const KEYSTROKE_ATTEMPTS = Number(process.env.STARTUP_ATTEMPTS ?? 3);
const STABLE_ATTEMPTS = 2;

process.env.JDTLS = process.env.JDTLS ?? join(ROOT, '.tmp', 'langdeps', 'jdtls', 'bin', 'jdtls.bat');
process.env.LOCALAPPDATA = join(SANDBOX, 'appdata');
process.env.GOCACHE = join(SANDBOX, 'gocache');
process.env.TMP = join(SANDBOX, 'tmp');
process.env.TEMP = process.env.TMP;
process.env.TMPDIR = process.env.TMP;

const results: Array<{ name: string; ok: boolean; detail: string; skipped?: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function skip(name: string, why: string): void {
  results.push({ name, ok: true, detail: why, skipped: true });
  console.log(`SKIP  ${name}  — ${why}`);
}
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

interface BaselineEntry {
  server: string;
  handshakeMs: [number, number];
  firstMs: [number, number];
  stableMs: [number, number];
  items: number;
  note?: string;
  /** Explicit regression limit, when the cold cost is known to be host-dependent. */
  gateMs?: number;
}

interface Baseline {
  schema: number;
  measuredAt: string;
  policy: string;
  tolerance: string;
  app: { coldMs: number; warmMs: [number, number]; panelMs: number; note: string };
  firstKeystroke: {
    python: { targetMs: number; gateMs: number; answeredBy: string; measuredMs: [number, number] };
  };
  languages: Record<string, BaselineEntry>;
}

const baseline = JSON.parse(readFileSync(join(ROOT, 'perf-baseline.json'), 'utf8')) as Baseline;

const manifests = (): LanguageManifest[] => {
  const out: LanguageManifest[] = [];
  for (const dir of ['builtin', 'examples']) {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const path = join(ROOT, dir, entry, 'manifest.json');
      if (!existsSync(path)) continue;
      out.push(JSON.parse(readFileSync(path, 'utf8')) as LanguageManifest);
    }
  }
  return out;
};

const all = manifests();
const withLsp = all.filter((m) => m.lsp && !m.lsp.disabled);

const kernel = new Kernel({ appVersion: 'verify-startup', logSilent: true });
await kernel.start();
for (const d of [SANDBOX, process.env.LOCALAPPDATA!, process.env.GOCACHE!, process.env.TMP!]) mkdirSync(d, { recursive: true });

// ============================================================ 1. the baseline
check('baseline: schema is 1', baseline.schema === 1, `schema=${baseline.schema}`);
check('baseline: it says what it gates and why', baseline.policy.length > 40 && /stable/i.test(baseline.policy));
check(
  'baseline: the app numbers are present',
  typeof baseline.app.coldMs === 'number' && Array.isArray(baseline.app.warmMs) && baseline.app.warmMs[1] >= baseline.app.warmMs[0],
  `cold ${baseline.app.coldMs} ms · warm ${baseline.app.warmMs?.join('–')} ms`,
);

const shape = (e: BaselineEntry | undefined): string[] => {
  if (!e) return ['missing'];
  const problems: string[] = [];
  for (const key of ['handshakeMs', 'firstMs', 'stableMs'] as const) {
    const v = e[key];
    if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== 'number' || n < 0)) problems.push(`${key} is not [low, high]`);
  }
  if (problems.length) return problems;
  if (e.stableMs[0] > e.stableMs[1]) problems.push('stableMs is inverted');
  if (e.firstMs[0] > e.stableMs[1]) problems.push('firstMs is after stableMs');
  if (e.handshakeMs[0] > e.firstMs[1]) problems.push('handshakeMs is after firstMs');
  if (!(e.items > 0)) problems.push('items must be positive');
  return problems;
};

// Coverage is the rot guard: adding a language without a baseline fails here,
// on any machine, before anyone wonders why the new language has no numbers.
const uncovered = withLsp.filter((m) => !baseline.languages[m.id]).map((m) => m.id);
check(
  'baseline: every language with a server has an entry',
  uncovered.length === 0,
  uncovered.length ? `missing: ${uncovered.join(', ')}` : `${withLsp.length} language(s)`,
);

const badShape = Object.entries(baseline.languages)
  .map(([id, e]) => ({ id, problems: shape(e) }))
  .filter((x) => x.problems.length);
check(
  'baseline: every entry carries all three thresholds',
  badShape.length === 0,
  badShape.length ? badShape.map((b) => `${b.id}: ${b.problems.join(', ')}`).join(' | ') : 'ok',
);

// ==================================================== 2. the python contract
const pythonManifest = all.find((m) => m.id === 'python');
const target = baseline.firstKeystroke.python.targetMs;
const keystrokeGate = baseline.firstKeystroke.python.gateMs;
check(
  'python: it is not eager any more',
  !!pythonManifest && pythonManifest.lsp?.eager !== true,
  pythonManifest ? `eager=${String(pythonManifest.lsp?.eager)}` : 'no python manifest',
);
check(
  'python: the target and the gate are the ones in the file',
  target === 500 && keystrokeGate >= target,
  `target ${target} ms · gate ${keystrokeGate} ms · answered by ${baseline.firstKeystroke.python.answeredBy}`,
);

interface PythonProbe {
  label: string;
  home: string;
  expectUpgrade: boolean;
}

const pythonProbes: PythonProbe[] = [
  // No servers at all: what a machine without pyright has, and it must be
  // answered by the bundled stub — the manifest's own fallback.
  { label: 'stub-only', home: join(SANDBOX, 'home-stub'), expectUpgrade: false },
  // The product's own home: pyright if it is installed. The first keystroke must
  // still be answered by the stub, and pyright must take over afterwards.
  { label: 'installed', home: HOME, expectUpgrade: true },
];

const stubFirstMs: Record<string, number> = {};
for (const probe of pythonProbes) {
  mkdirSync(probe.home, { recursive: true });

  // One fresh workspace per attempt: a warm one would answer from an already
  // running server and prove nothing about the first keystroke.
  const attempts: Array<{ ms: number; items: number; labels: string[]; server: string; init: number; running: boolean }> = [];
  let lastWs: WorkspaceService | undefined;
  for (let i = 0; i < KEYSTROKE_ATTEMPTS; i++) {
    const dir = join(SANDBOX, `ws-${probe.label}-${i}`);
    const ws = new WorkspaceService(kernel, {
      home: probe.home,
      pluginRoots: languageRoots(),
      projectDir: dir,
      workspaceDir: dir,
    });
    const tInit = Date.now();
    await ws.init();
    const init = Date.now() - tInit;
    const runningBefore = (ws.languageStatus('python') as unknown as { lsp?: { running?: boolean } }).lsp?.running === true;
    const t0 = Date.now();
    const out = await ws.complete('python', 'pri\n', 0, 3);
    const ms = Date.now() - t0;
    const server = (ws.languageStatus('python') as unknown as { lsp?: { serverName?: string } }).lsp?.serverName ?? '?';
    attempts.push({ ms, items: out.items.length, labels: out.items.map((i) => i.label), server, init, running: runningBefore });
    lastWs = ws;
    if (i < KEYSTROKE_ATTEMPTS - 1) await ws.close();
  }

  const best = attempts.reduce((a, b) => (b.ms < a.ms ? b : a));
  stubFirstMs[probe.label] = best.ms;
  check(
    `python (${probe.label}): boot does not start a server`,
    attempts.every((a) => !a.running),
    `init ${attempts[0]?.init} ms · running=${String(attempts[0]?.running)}`,
  );
  // `target` is what the product does on an idle machine; `keystrokeGate` is
  // what the gate enforces, because the stub's process start alone is 400-450 ms
  // and a 500 ms hard limit would fail the same code on a busy host.
  check(
    `python (${probe.label}): first keystroke answers within ${keystrokeGate} ms (target ${target})`,
    best.ms <= keystrokeGate,
    `${attempts.map((a) => a.ms).join(' / ')} ms (best ${best.ms})`,
  );
  check(
    `python (${probe.label}): the answer comes from the bundled stub`,
    best.items > 0 && best.server === 'nolanguage-py',
    `${best.server} · ${best.items} item(s)`,
  );

  // What the stub says, recorded before anything takes over. Same request, same
  // position: if these do not change afterwards, nothing took over — a status
  // field saying "pyright" while the stub keeps answering is exactly the bug
  // this pair of checks exists for.
  const stubLabels = attempts[attempts.length - 1]?.labels ?? [];
  const stubHover = hoverText(await lastWs?.hover('python', 'print("x")\n', 0, 2) ?? null);
  check(
    `python (${probe.label}): the stub's hover is the stub's`,
    /builtin/i.test(stubHover) && !/\(function\) def print/.test(stubHover),
    stubHover.replace(/\s+/g, ' ').slice(0, 60) || 'empty',
  );

  // The real server, if this machine has one, must take over by itself.
  const installed = pythonManifest ? resolveServer(pythonManifest, probe.home, { root: SANDBOX }) : { source: 'missing' as const };
  if (!probe.expectUpgrade || installed.source === 'missing' || !lastWs) {
    skip(
      `python (${probe.label}): the real server takes over`,
      installed.source === 'missing' ? 'no real server installed in this home' : 'stub-only home',
    );
  } else {
    const t0 = Date.now();
    let server = best.server;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      server = (lastWs.languageStatus('python') as unknown as { lsp?: { serverName?: string } }).lsp?.serverName ?? '';
      if (server && server !== 'nolanguage-py') break;
      await sleep(200);
    }
    const after = await lastWs.complete('python', 'pri\n', 0, 3);
    check(
      `python (${probe.label}): the real server takes over`,
      server === (pythonManifest?.lsp?.serverName ?? 'pyright') && after.items.length > 0,
      `${server} after ${Date.now() - t0} ms · ${after.items.length} item(s)`,
    );

    // Content, not the status field. The stub answers `pri` with 30 builtins;
    // pyright answers with its own list. A takeover that only renamed the server
    // would leave these identical.
    const afterLabels = after.items.map((i) => i.label);
    const gained = afterLabels.filter((l) => !stubLabels.includes(l));
    const lost = stubLabels.filter((l) => !afterLabels.includes(l));
    check(
      `python (${probe.label}): the takeover changes the answers, not just the name`,
      gained.length > 0 && lost.length > 0,
      `+${gained.slice(0, 3).join('/')} −${lost.slice(0, 3).join('/')} (stub ${stubLabels.length} → real ${afterLabels.length})`,
    );

    // Hover is the sharper witness: the stub says `builtin`, pyright returns the
    // signature. A stub left running in the background cannot fake this.
    const realHover = hoverText(await lastWs.hover('python', 'print("x")\n', 0, 2));
    check(
      `python (${probe.label}): hover after takeover is the real server's`,
      /\(function\) def print/.test(realHover),
      realHover.replace(/\s+/g, ' ').slice(0, 70) || 'empty',
    );
  }
  await lastWs?.close();
}

// =========================================================== 3. the stable gate
const firstByLang: Record<string, number> = {};
for (const t of targets) {
  const manifest = all.find((m) => m.id === t.id);
  if (!manifest) {
    skip(`${t.id}: stable`, 'no manifest');
    continue;
  }
  const root = join(SANDBOX, 'stable', t.id);
  for (const [rel, text] of Object.entries(t.files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  const { launch } = await launchFor(manifest, root, HOME);
  if (!launch) {
    skip(`${t.id}: stable`, `${manifest.lsp?.serverName ?? t.id} is not installed`);
    continue;
  }

  const uri = pathToFileURL(join(root, t.complete.file)).href;
  const runs: Array<{ handshake: number; first: number; stable: number; items: number }> = [];
  for (let i = 0; i < STABLE_ATTEMPTS; i++) {
    const client = new LspClient({ launch, timeoutMs: 240_000 });
    try {
      runs.push(
        await measureStartup(client, kernel, root, uri, t.files[t.complete.file], {
          line: t.complete.line,
          character: t.complete.character,
        }, { expectItems: baseline.languages[t.id].items }),
      );
    } catch (err) {
      if (!runs.length) check(`${t.id}: stable`, false, (err as Error).message.slice(0, 120));
    } finally {
      await client.stop().catch(() => undefined);
    }
    await sleep(400);
  }

  if (!runs.length) continue;
  const best = runs.reduce((a, b) => (b.stable > 0 && (a.stable <= 0 || b.stable < a.stable) ? b : a));
  const entry = baseline.languages[t.id];
  const limit = entry.gateMs ?? Math.round(entry.stableMs[1] * 2 + 1000);
  firstByLang[t.id] = best.first;
  check(
    `${t.id}: stable within ${limit} ms (baseline ${entry.stableMs.join('–')})`,
    best.stable > 0 && best.stable <= limit,
    `handshake ${best.handshake} · first ${best.first} · stable ${best.stable} ms · ${best.items} item(s)` +
      (runs.length > 1 ? ` · attempts ${runs.map((r) => r.stable).join('/')}` : ''),
  );
}

// The relative contract, which holds on any host: the stub must answer well
// before the real server could have. 500 ms is a target that a busy machine can
// miss; "faster than waiting for pyright" is the reason the stub exists.
if (stubFirstMs.installed && firstByLang.python) {
  check(
    'python: the stub answers before pyright could have',
    stubFirstMs.installed < firstByLang.python,
    `stub ${stubFirstMs.installed} ms vs pyright ${firstByLang.python} ms`,
  );
} else {
  skip('python: the stub answers before pyright could have', 'pyright is not installed here');
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
if (failed.length) console.log('FAILED:\n' + failed.map((f) => `  - ${f.name}  ${f.detail}`).join('\n'));
try {
  rmSync(SANDBOX, { recursive: true, force: true });
} catch (err) {
  console.log(`  (cleanup left ${SANDBOX}: ${(err as Error).message})`);
}
// The kernel owns timers and a SQLite handle; without this the suite prints its
// summary and then sits there, which a harness reads as a hang.
// The kernel owns timers and a SQLite handle; without this the suite prints its
// summary and then sits there, which a harness reads as a hang.
await Promise.race([kernel.stop().catch(() => undefined), sleep(5000)]);
// Explicit exit: this suite spawns eight language servers, and a request timer
// or a `.cmd` wrapper that outlives its server must not turn a green run into a
// hang. Everything above is printed and awaited before this line.
process.exit(failed.length ? 1 : 0);
