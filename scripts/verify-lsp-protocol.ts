/**
 * Protocol behaviour, against a server that can be told to misbehave.
 *
 * Every case here is a failure mode the real world produces — a server that
 * never answers, one that dies mid-request, a burst of keystrokes — and none of
 * them can be produced reliably with jdtls or gopls. The fake server
 * (`scripts/fixtures/fake-lsp.mjs`) can hang, exit on a named method, and log
 * every method it received, so each assertion is about the manager's decision
 * rather than about a particular server's mood.
 *
 * One thing this suite deliberately documents instead of asserting as "good":
 * **there is no send-side debounce.** A completion request goes out on every
 * trigger; the client shows its local L1 list instantly and the manager cancels
 * the previous request. That is a design with a measurable cost (N sends for N
 * keystrokes), and the burst case below pins it so a future change is visible.
 *
 * Run: npm run verify:lsp-protocol
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Kernel } from '../src/kernel/Kernel.js';
import { buildManagerPlugin } from '../src/langs/managerPlugins.js';
import type { LanguageManifest } from '../src/langs/manifest.js';
import { LspManager } from '../src/lsp/manager/LspManager.js';
import type { ManagedLsp } from '../src/lsp/manager/ManagedLsp.js';
import type { LanguagePlugin } from '../src/lsp/manager/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Per-process: these suites build a jdtls workspace with thousands of files,
// and a shared directory makes the start-up `rmSync` hit the sandbox's
// bulk-delete guard — which surfaces as a suite that dies before its first
// check (0/0) when it runs after the others.
const SANDBOX = join(ROOT, '.tmp', 'lsp-protocol', String(process.pid));
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'fake-lsp.mjs');

const results: Array<{ name: string; ok: boolean; detail: string; skipped?: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
const frames = (log: string, method: string): number =>
  existsSync(log) ? (readFileSync(log, 'utf8').match(new RegExp(method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length : 0;

interface Setup {
  manager: LspManager;
  entry: ManagedLsp;
  uri: string;
  root: string;
}

interface Knobs {
  id: string;
  log: string;
  completionDelayMs?: number;
  budgetMs?: number;
  navBudgetMs?: number;
  /** Methods the server will never answer. */
  hang?: string[];
  dieOn?: string;
  logInit?: boolean;
  initOptions?: Record<string, unknown>;
}

function fakeManifest(k: Knobs): LanguageManifest {
  const args = [FIXTURE, '--log', k.log];
  if (k.completionDelayMs) args.push('--completion-delay', String(k.completionDelayMs));
  for (const m of k.hang ?? []) args.push('--hang', m);
  if (k.dieOn) args.push('--die-on', k.dieOn);
  if (k.logInit) args.push('--log-init');
  return {
    id: k.id,
    file: { extensions: [k.id] },
    lsp: {
      manager: true,
      discovery: { knownPaths: [process.execPath] },
      command: ['{resolved}', ...args],
      projectMarkers: ['marker.txt'],
      firstRequestBudgetMs: k.budgetMs ?? 5000,
      navBudgetMs: k.navBudgetMs ?? 5000,
      startTimeoutMs: 20_000,
      idleTtlMs: 120_000,
      ...(k.initOptions ? { initializationOptions: k.initOptions } : {}),
      fallback: { keywords: ['alpha', 'beta'], declarationPattern: 'class\\s+([A-Za-z_$][\\w$]*)' },
    },
  } as unknown as LanguageManifest;
}

async function newManager(home: string): Promise<LspManager> {
  const kernel = new Kernel({ appVersion: 'verify', logSilent: true });
  await kernel.start();
  return new LspManager({ kernel, home, reapIntervalMs: 0 });
}

async function setup(k: Knobs, dir: string): Promise<Setup> {
  const root = join(SANDBOX, dir);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'marker.txt'), 'x\n');
  const manager = await newManager(join(SANDBOX, `${dir}-home`));
  const plugin = (await buildManagerPlugin(fakeManifest(k), { home: join(SANDBOX, `${dir}-home`) })) as LanguagePlugin;
  manager.register(plugin);
  const entry = manager.acquire(k.id, root);
  if (!entry) throw new Error(`no entry for ${k.id}`);
  const file = join(root, `A.${k.id}`);
  writeFileSync(file, 'al\n');
  const uri = pathToFileURL(file).href;
  await entry.openDocument(uri, 'al\n', k.id);
  await entry.waitUntilReady(20_000);
  return { manager, entry, uri, root };
}

async function main(): Promise<void> {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });

  // ============================================================ burst / latest-only
  // Five keystrokes, one answer. The cost is pinned, not hidden: five requests
  // reach the server and four are cancelled, because nothing debounces the send.
  {
    const log = join(SANDBOX, 'burst.log');
    const { manager, entry, uri } = await setup({ id: 'burst', log, completionDelayMs: 250 }, 'burst');
    const calls = Array.from({ length: 5 }, () => entry.completion(uri, { line: 0, character: 2 }));
    await sleep(30);
    const answers = await Promise.all(calls);
    const withItems = answers.filter((a) => a.length > 0).length;

    check('burst: every caller gets a promise settled', answers.length === 5);
    check('burst: exactly one answer carries items', withItems === 1, `${withItems} of ${answers.length}`);
    check('burst: all five requests reached the server (no debounce)', frames(log, 'textDocument/completion') === 5, `${frames(log, 'textDocument/completion')} request(s)`);
    check('burst: the other four were cancelled', frames(log, '$/cancelRequest') === 4, `${frames(log, '$/cancelRequest')} cancel(s)`);
    const stats = manager.stats();
    check('burst: the drops are counted', stats.staleDropped === 4 && stats.cancelled === 4, JSON.stringify(stats));
    await manager.close();
  }

  // ==================================================================== dedupe
  // Explicit actions are not position-racing: three identical clicks are one
  // round trip, not three.
  {
    const log = join(SANDBOX, 'dedupe.log');
    const { manager, entry, uri } = await setup({ id: 'dedupe', log }, 'dedupe');
    await Promise.all([
      entry.definition(uri, { line: 0, character: 1 }),
      entry.definition(uri, { line: 0, character: 1 }),
      entry.definition(uri, { line: 0, character: 1 }),
    ]);
    check('dedupe: three identical definitions cost one round trip', frames(log, 'textDocument/definition') === 1, `${frames(log, 'textDocument/definition')} request(s)`);
    await manager.close();
  }

  // ==================================================================== timeout
  // A server that never answers must not become a hung keystroke.
  {
    const log = join(SANDBOX, 'hang.log');
    const { manager, entry, uri } = await setup(
      {
        id: 'hang',
        log,
        hang: ['textDocument/completion', 'textDocument/definition'],
        budgetMs: 400,
        navBudgetMs: 300,
      },
      'hang',
    );
    const t0 = Date.now();
    const items = await entry.completion(uri, { line: 0, character: 2 });
    const ms = Date.now() - t0;
    check('timeout: completion returns inside its budget', ms < 1500, `${ms} ms`);
    check('timeout: the fallback answered', items.some((i) => i.label === 'alpha'), items.map((i) => i.label).join(',') || 'nothing');

    const t1 = Date.now();
    const nav = await entry.definition(uri, { line: 0, character: 1 });
    const navMs = Date.now() - t1;
    check('timeout: an explicit action says it timed out', !nav.ok && /timed out/.test(nav.ok ? '' : nav.reason), nav.ok ? 'ok' : nav.reason);
    check('timeout: and does not wait forever', navMs < 2000, `${navMs} ms`);
    await manager.close();
  }

  // ==================================================================== crash
  // The server exits on the request itself. Nothing may hang, nothing may throw
  // out of the process, and the next request must degrade instead of retrying
  // per keystroke.
  {
    const log = join(SANDBOX, 'crash.log');
    const { manager, entry, uri } = await setup({ id: 'crash', log, dieOn: 'textDocument/completion' }, 'crash');

    const t0 = Date.now();
    let outcome = 'resolved';
    try {
      await entry.completion(uri, { line: 0, character: 2 });
    } catch (err) {
      outcome = `rejected: ${(err as Error).message.slice(0, 40)}`;
    }
    const ms = Date.now() - t0;
    check('crash: the request settles instead of hanging', ms < 5000, `${ms} ms · ${outcome}`);
    check('crash: the process is still here', true);

    await sleep(600);
    const info = entry.describe();
    check('crash: the entry reports itself down', info.started === false, JSON.stringify({ started: info.started, error: info.error }));

    // Degradation, and no respawn storm: the backoff must hold for the next
    // requests, or a broken server is spawned once per keystroke.
    const before = frames(log, 'initialize');
    const items = await entry.completion(uri, { line: 0, character: 2 });
    const items2 = await entry.completion(uri, { line: 0, character: 2 });
    const after = frames(log, 'initialize');
    check('crash: later requests fall back instead of failing', items.some((i) => i.label === 'alpha') && items2.length > 0, `${items.length} + ${items2.length} item(s)`);
    check('crash: the failed server is not respawned per request', after === before, `${before} → ${after} initialize(s)`);
    check('crash: the exit is reported as a reason', /exited/.test(String(info.error ?? '')), String(info.error ?? 'no reason'));
    await manager.close();
  }

  // ========================================================== capabilities contract
  // Declared capability -> the request is accepted. Absent capability -> a reason,
  // never an empty result. The fake server advertises formatting as false, which
  // is the only way to test the negative half deterministically.
  {
    const log = join(SANDBOX, 'caps.log');
    const { manager, entry, uri } = await setup({ id: 'caps', log }, 'caps');
    const caps = entry.capabilities as Record<string, unknown>;
    check('caps: the server advertised what it implements', !!caps.completionProvider && caps.hoverProvider === true);
    check('caps: an advertised capability answers', (await entry.completion(uri, { line: 0, character: 2 })).length > 0);

    const fmt = await entry.formatting(uri);
    check(
      'caps: an absent capability says why instead of returning nothing',
      !fmt.ok && /does not advertise|does not format/.test(fmt.ok ? '' : fmt.reason),
      fmt.ok ? `ok with ${fmt.value.length} edit(s)` : fmt.reason,
    );
    await manager.close();
  }

  // ================================================================ navigation
  // The plumbing the live UI needs: request out, result normalised, frame
  // carrying what the overlay and the caret jump use. This runs in CI because it
  // needs no real server — and it is where the URI shape is pinned.
  {
    const log = join(SANDBOX, 'nav.log');
    const { manager, entry, uri } = await setup({ id: 'nav', log }, 'nav');

    const refs = await entry.references(uri, { line: 0, character: 1 }, true);
    check(
      'nav: references come back as locations',
      refs.ok && refs.value.length === 3,
      refs.ok ? `${refs.value.length} location(s)` : refs.reason,
    );
    check('nav: the request reached the server', frames(log, 'textDocument/references') === 1);

    // pyright sends `file:///c%3A/…`; a client that uses that as a path opens
    // nothing at all. The engine hands over a decoded form.
    const firstUri = refs.ok && refs.value[0] ? refs.value[0].uri : '';
    check('nav: file URIs are decoded before they reach the UI', !!firstUri && !/%3A/i.test(firstUri), firstUri);

    const actions = await entry.codeActions(uri, { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, []);
    check(
      'nav: a code action keeps its edit',
      actions.ok && actions.value.length === 1 && !!actions.value[0]?.edits,
      actions.ok ? `${actions.value.length} action(s)` : actions.reason,
    );
    await manager.close();
  }

  // ====================================================== initializationOptions
  // The manifest field was silently dropped before; a plugin could declare it and
  // have nothing reach the server.
  {
    const log = join(SANDBOX, 'init.log');
    const { manager } = await setup(
      {
        id: 'init',
        log,
        logInit: true,
        initOptions: { settings: { 'demo.tuning': 'off' }, extendedClientCapabilities: { x: 1 } },
      },
      'init',
    );
    const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
    check(
      'init: initializationOptions reach the server',
      text.includes('"demo.tuning":"off"') && text.includes('"extendedClientCapabilities"'),
      (text.split('\n').find((l) => l.startsWith('initialize-options:')) ?? 'not logged').slice(0, 120),
    );
    await manager.close();
  }

  // ==================================================================== summary
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
  if (failed.length) console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* a just-killed child may hold a handle */
  }
  process.exitCode = failed.length ? 1 : 0;
}

await main();
