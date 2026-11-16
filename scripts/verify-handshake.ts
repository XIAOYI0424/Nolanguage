/**
 * Launch-time version handshake (`src/desktop/handshake.ts`).
 *
 * The bug this suite exists for: the freshly installed exe probes `/health`,
 * gets `ok` from a server that is still the **previous** build, and exits —
 * the user is left looking at the old UI with nothing on screen saying so.
 * Liveness is not identity, and the decision table is pure, so it is pinned
 * here; `main.ts` only carries out the verdict.
 *
 * The second half checks the wiring that makes the verdict visible: the
 * `?updated=` hand-off and the one-shot toast in the client.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decideLaunch, launchUrl, sameBuild, type BuildIdentity } from '../src/desktop/handshake.js';
import { APP_VERSION } from '../src/version.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (rel: string): string => readFileSync(join(here, '..', rel), 'utf8');
const mainSource = read('src/desktop/main.ts');
const serverSource = read('src/panel/server.ts');
// The shell's client code lives in text fragments now (0.7.5 split); read the
// assembled source, not the thin assembler.
const clientSource = readdirSync(join(here, '..', 'src', 'ui', 'client'))
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'src', 'ui', 'client', f), 'utf8'))
  .join('\n');

const OWN: BuildIdentity = { appVersion: '0.7.2-workspace', exeSize: 96_000_000 };

// ---------- sameBuild ----------
check('sameBuild: identical version and size', sameBuild(OWN, { ...OWN }));
check('sameBuild: version differs', !sameBuild({ appVersion: '0.7.1-workspace', exeSize: 96_000_000 }, OWN));
check(
  'sameBuild: same version, different binary size (rebuild)',
  !sameBuild({ appVersion: '0.7.2-workspace', exeSize: 95_000_000 }, OWN),
);
check(
  'sameBuild: unknown size on either side cannot disagree',
  sameBuild({ appVersion: '0.7.2-workspace' }, OWN) && sameBuild(OWN, { appVersion: '0.7.2-workspace', exeSize: 0 }),
);
check('sameBuild: missing version never matches', !sameBuild({ exeSize: 96_000_000 }, OWN));
check('sameBuild: missing identity never matches', !sameBuild(undefined, OWN) && !sameBuild(null, null));

// ---------- decideLaunch ----------
check('decide: no server -> start', decideLaunch({ ownBuild: OWN, windowAlive: false }).action === 'start');
check(
  'decide: same build + window -> reuse (do not open a second window)',
  decideLaunch({ runningBuild: OWN, ownBuild: OWN, windowAlive: true }).action === 'reuse',
);
const update = decideLaunch({
  runningBuild: { appVersion: '0.7.1-workspace', exeSize: 95_500_000 },
  ownBuild: OWN,
  windowAlive: true,
});
check('decide: older build + window -> takeover-update', update.action === 'takeover-update', update.action);
check('decide: update names the replaced version', update.replacedVersion === '0.7.1-workspace', String(update.replacedVersion));
check('decide: update reason is version-mismatch', update.reason === 'version-mismatch', update.reason);
check(
  'decide: same version but rebuilt exe -> takeover-update',
  decideLaunch({
    runningBuild: { appVersion: '0.7.2-workspace', exeSize: 90_000_000 },
    ownBuild: OWN,
    windowAlive: true,
  }).action === 'takeover-update',
);
const orphan = decideLaunch({ runningBuild: OWN, ownBuild: OWN, windowAlive: false });
check('decide: same build + no window -> takeover-orphan', orphan.action === 'takeover-orphan', orphan.action);
check(
  'decide: older build + no window -> takeover-orphan (port first, build later)',
  decideLaunch({ runningBuild: { appVersion: '0.7.0-workspace' }, ownBuild: OWN, windowAlive: false }).action ===
    'takeover-orphan',
);
const legacy = decideLaunch({ runningBuild: {}, ownBuild: OWN, windowAlive: true });
check('decide: pre-0.7.1 server without build block -> takeover-update', legacy.action === 'takeover-update', legacy.action);
check('decide: legacy server reported as unknown', legacy.replacedVersion === 'unknown', String(legacy.replacedVersion));

// ---------- launchUrl ----------
check('url: plain start has no query', launchUrl('http://127.0.0.1:7310', undefined) === 'http://127.0.0.1:7310/');
check(
  'url: update carries the replaced version',
  launchUrl('http://127.0.0.1:7310/', '0.7.1-workspace') === 'http://127.0.0.1:7310/?updated=0.7.1-workspace',
);
check(
  'url: version is percent-encoded',
  launchUrl('http://127.0.0.1:7310', '0.7.1 build') === 'http://127.0.0.1:7310/?updated=0.7.1%20build',
);

// ---------- wiring ----------
check('main: decides through decideLaunch', /decideLaunch\(\{/.test(mainSource));
check('main: logs the verdict', /logDesktop\('handshake'/.test(mainSource));
check(
  'main: "already running" only after a reuse verdict',
  /decision\.action === 'reuse'/.test(mainSource) && !/if \(running\) \{\s*process\.stdout\.write\(`\\n {2}Nolanguage is already running/.test(mainSource),
);
check('main: update takeover records the replaced version', /updatedFrom = decision\.replacedVersion/.test(mainSource));
check('main: window URL comes from launchUrl', /launchUrl\(base, updatedFrom\)/.test(mainSource));
check('main: no bare base URL left in the window spawn', !/openWebView\(\{\s*url: `\$\{base\}\/`/.test(mainSource));

check('server: version comes from the shared constant', /appVersion: APP_VERSION/.test(serverSource));
// The receipt must describe the installed app. A node process (`nlg desktop`,
// or any suite) writing it makes doctor report the interpreter as the build —
// 0.7.5 found exactly that leftover.
check(
  'server: the install receipt is never written by a node process',
  /packagedImage/.test(serverSource) && /NOLANGUAGE_DESKTOP === '1' && packagedImage/.test(serverSource),
);
check(
  'server: no hardcoded -workspace literal',
  !/'[0-9]+\.[0-9]+\.[0-9]+-workspace'/.test(serverSource),
);

const pkg = JSON.parse(read('package.json')) as { version: string };
check(
  'version: APP_VERSION matches package.json',
  APP_VERSION === `${pkg.version}-workspace`,
  `${APP_VERSION} vs ${pkg.version}`,
);
check('version: APP_VERSION is the 0.7 line', /^0\.7\.\d+-workspace$/.test(APP_VERSION), APP_VERSION);

// The installer writes this number into Add/Remove Programs and into the file
// version of the setup, so it has to be the same build. `build-setup.mjs`
// passes it from package.json; the fallback in the .nsi is what a hand-run
// `makensis` uses, and it drifted once (registered 0.7.23 for a 0.7.24 build).
const nsiVersion = /!define\s+APP_VERSION\s+"([^"]+)"/.exec(read('installer/Nolanguage.nsi'))?.[1];
check(
  'version: the installer fallback version matches package.json',
  nsiVersion === pkg.version,
  `${nsiVersion ?? 'not found'} vs ${pkg.version}`,
);

check('client: reads the updated param', /\[\?&\]updated=\(\[\^&\]\*\)/.test(clientSource));
check('client: announces the update', /function announceUpdate\(\)/.test(clientSource));
check('client: strips the param so a reload stays quiet', /history\.replaceState\(\{\}, '', location\.pathname\)/.test(clientSource));
check(
  'client: the update notice lives in a fragment, not a template literal',
  clientSource.indexOf('function announceUpdate') !== -1 && clientSource.indexOf('`') === -1,
);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
