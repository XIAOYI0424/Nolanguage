/**
 * Fast unit tests for the pure modules.
 *
 * The script suites (`scripts/verify-*.ts`) are the release gate: they boot
 * servers, spawn toolchains and take minutes. That is the right shape for
 * integration, and the wrong shape for "did I break the maths". This file
 * covers the modules that have no I/O — attribution, interpreter selection,
 * XML, the launch handshake — so `npm test` answers in a couple of seconds.
 *
 * The script suites still cover these (more thoroughly); this is the fast loop,
 * not a replacement.
 */
// Test functions are supplied by the active Vitest collector (see globals in vitest.config.ts).
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attribute,
  bisectSuspects,
  cohensD,
  cusumChangePoint,
  tTestPValue,
  welchT,
} from '../src/perf/Attribution';
import { discoverInterpreters, pickInterpreter, shortVersion } from '../src/langs/interpreters';
import { buildExtensionIndex, languageForName } from '../src/langs/extensionIndex';
import { decodeEntities, findAll, options, parseXml } from '../src/util/xml';
import { decideLaunch, launchUrl, sameBuild } from '../src/desktop/handshake';
import { expandMacros, importIdeaProject } from '../src/langs/ideaImport';
import { boundedRunTimeout, RUN_TIMEOUT_MAX_MS, RUN_TIMEOUT_MIN_MS } from '../src/panel/run-timeout';
import { isCmdScript, planMcpSpawn, quoteCmdArg } from '../src/mcp/spawn-command';
import { boundedMcpTimeout, MCP_TIMEOUT_MAX_MS, MCP_TIMEOUT_MIN_MS } from '../src/mcp/McpManager';
import { FileTransport } from '../src/log/transports/FileTransport';
import { bootLog, bootLogError, bootLogPath } from '../src/util/bootLog';
import { resolveBundledFallback } from '../src/lsp/bundledFallback';
import { sliceDigest } from '../src/panel/log-digest';
import { LogLevel } from '../src/log/LogLevel';
import type { LogRecord } from '../src/log/types';

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

describe('attribution · t distribution', () => {
  it('matches textbook p-values', () => {
    expect(near(tTestPValue(0, 10), 1, 1e-9)).toBe(true);
    expect(near(tTestPValue(2, 10), 0.0734, 0.002)).toBe(true);
    expect(near(tTestPValue(3.169, 10), 0.01, 0.001)).toBe(true);
    expect(near(tTestPValue(1.96, 1_000_000), 0.05, 0.001)).toBe(true);
  });

  it('is symmetric and safe at degenerate df', () => {
    expect(near(tTestPValue(-2, 10), tTestPValue(2, 10), 1e-12)).toBe(true);
    expect(tTestPValue(2, 0)).toBe(1);
  });
});

describe('attribution · welch + cohen', () => {
  const flat = [100, 100, 100, 100, 100];
  const shifted = [150, 152, 148, 151, 149];

  it('flags a real shift', () => {
    const r = welchT(flat, shifted);
    expect(r).not.toBeNull();
    expect(r!.p).toBeLessThan(0.01);
    expect(r!.t).toBeGreaterThan(0);
  });

  it('treats identical samples as a tie', () => {
    const r = welchT(flat, flat);
    expect(r!.t).toBe(0);
    expect(r!.p).toBe(1);
  });

  it('refuses to test one sample', () => {
    expect(welchT([1], [2, 3])).toBeNull();
    expect(cohensD([1], [2])).toBeNull();
  });

  it('grades effect size', () => {
    expect(cohensD(flat, flat)!.magnitude).toBe('negligible');
    expect(cohensD([100, 101, 99, 100, 101], [200, 201, 199, 200, 201])!.magnitude).toBe('large');
    expect(cohensD([1, 1, 1], [2, 2, 2])!.d).toBe(3);
  });
});

describe('attribution · cusum', () => {
  it('locates a step', () => {
    const step = [...Array(10).fill(100), ...Array(10).fill(200)];
    const hit = cusumChangePoint(step);
    expect(hit?.direction).toBe('up');
    expect(hit!.index).toBeGreaterThanOrEqual(10);
    expect(hit!.index).toBeLessThanOrEqual(11);
  });

  it('detects a downward step', () => {
    const hit = cusumChangePoint([...Array(10).fill(200), ...Array(10).fill(100)]);
    expect(hit?.direction).toBe('down');
  });

  it('stays silent on flat and stationary series', () => {
    expect(cusumChangePoint(Array(40).fill(42))).toBeNull();
    const noise = Array.from({ length: 60 }, (_, i) => 100 + 6 * Math.sin(i * 1.7) + 3 * Math.cos(i * 0.9));
    expect(cusumChangePoint(noise)).toBeNull();
    expect(cusumChangePoint([1, 2, 3])).toBeNull();
  });
});

describe('attribution · verdicts', () => {
  const before = Array.from({ length: 24 }, (_, i) => 100 + 4 * Math.sin(i));
  const after = Array.from({ length: 24 }, (_, i) => 160 + 4 * Math.sin(i));

  it('calls a significant, material slowdown a regression', () => {
    const r = attribute({ before, after, series: [...before, ...after] });
    expect(r.verdict).toBe('regression');
    expect(r.magnitude).toBe('large');
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.confidence).toBeLessThan(1);
    expect(r.changePoint?.direction).toBe('up');
  });

  it('calls the reverse an improvement', () => {
    expect(attribute({ before: after, after: before }).verdict).toBe('improvement');
  });

  it('does not call noise a change', () => {
    const same = attribute({ before, after: before.map((v, i) => v + (i % 2 ? 1 : -1)) });
    expect(same.verdict).toBe('no-change');
  });

  it('asks for more samples instead of guessing', () => {
    expect(attribute({ before: [1, 2, 3, 4], after: [9, 9, 9, 9] }).verdict).toBe('insufficient-data');
  });
});

describe('attribution · bisect', () => {
  const commits = Array.from({ length: 16 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);

  it('finds the first bad commit in log steps', async () => {
    let probes = 0;
    const r = await bisectSuspects(commits, async (c) => {
      probes++;
      return Number(c.slice(1)) >= 11 ? 'bad' : 'good';
    });
    expect(r.suspect).toBe('c11');
    expect(r.lastGood).toBe('c10');
    expect(probes).toBeLessThanOrEqual(6);
  });

  it('reports nothing when everything is good', async () => {
    const r = await bisectSuspects(commits, async () => 'good' as const);
    expect(r.suspect).toBeUndefined();
  });

  it('survives an unbuildable commit without guessing', async () => {
    const r = await bisectSuspects(commits, async (c) => {
      if (c === 'c10') return 'unknown';
      return Number(c.slice(1)) >= 11 ? 'bad' : 'good';
    });
    expect(r.degraded).toBe(true);
    expect(r.suspect).toBe('c11');
  });
});

describe('handshake', () => {
  const own = { appVersion: '0.7.4-workspace', exeSize: 96_000_000 };

  it('compares build identity, not liveness', () => {
    expect(sameBuild(own, { ...own })).toBe(true);
    expect(sameBuild({ appVersion: '0.7.3-workspace' }, own)).toBe(false);
    expect(sameBuild({ appVersion: '0.7.4-workspace', exeSize: 1 }, own)).toBe(false);
    expect(sameBuild({}, own)).toBe(false);
  });

  it('decides reuse / orphan / update', () => {
    expect(decideLaunch({ ownBuild: own, windowAlive: false }).action).toBe('start');
    expect(decideLaunch({ runningBuild: own, ownBuild: own, windowAlive: true }).action).toBe('reuse');
    expect(decideLaunch({ runningBuild: own, ownBuild: own, windowAlive: false }).action).toBe('takeover-orphan');
    const update = decideLaunch({ runningBuild: { appVersion: '0.7.3-workspace' }, ownBuild: own, windowAlive: true });
    expect(update.action).toBe('takeover-update');
    expect(update.replacedVersion).toBe('0.7.3-workspace');
  });

  it('treats a pre-0.7.1 server as unknown, not as a match', () => {
    const r = decideLaunch({ runningBuild: {}, ownBuild: own, windowAlive: true });
    expect(r.action).toBe('takeover-update');
    expect(r.replacedVersion).toBe('unknown');
  });

  it('only adds the update parameter when something was replaced', () => {
    expect(launchUrl('http://127.0.0.1:7310')).toBe('http://127.0.0.1:7310/');
    expect(launchUrl('http://127.0.0.1:7310', '0.7.3-workspace')).toBe(
      'http://127.0.0.1:7310/?updated=0.7.3-workspace',
    );
  });
});

describe('xml', () => {
  it('handles entities, CDATA, comments and quoted angle brackets', () => {
    const doc = parseXml(
      '<?xml version="1.0"?><!-- <x> --><root a="x &gt; y"><option name="n" value="v" /><![CDATA[raw <t>]]></root>',
    );
    const root = findAll(doc, 'root')[0];
    expect(root.attrs.a).toBe('x > y');
    expect(options(root).n).toBe('v');
    expect(root.text).toContain('raw <t>');
    expect(decodeEntities('&#65;&#x42;&nope;')).toBe('AB&nope;');
  });

  it('tolerates unclosed tags', () => {
    expect(findAll(parseXml('<a><b><c></a>'), 'b').length).toBe(1);
  });
});

describe('interpreters', () => {
  it('formats versions', () => {
    expect(shortVersion('Python 3.13.14')).toBe('3.13.14');
    expect(shortVersion('go version go1.27.2 windows/amd64')).toBe('1.27.2');
    expect(shortVersion(null)).toBeUndefined();
  });

  it('prefers a project venv, then a pin, then the SDK match', () => {
    const list = [
      { path: 'C:/p/.venv/python.exe', label: '', kind: 'venv' as const, source: '.venv' },
      { path: 'C:/sys/python.exe', label: '', kind: 'path' as const, source: 'PATH' },
      { path: 'C:/sdk/python.exe', label: '', kind: 'version-manager' as const, source: 'pyenv', sdkMatch: true },
    ];
    expect(pickInterpreter(list)!.source).toBe('.venv');
    expect(pickInterpreter(list, { pinned: 'C:/sys/python.exe' })!.source).toBe('PATH');
    expect(pickInterpreter([list[1], list[2]])!.path).toBe('C:/sdk/python.exe');
    expect(pickInterpreter([])).toBeUndefined();
  });

  it('discovers a project environment from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nlg-vitest-'));
    try {
      mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
      writeFileSync(join(dir, '.venv', 'pyvenv.cfg'), 'home = C:/Python313\n');
      writeFileSync(join(dir, '.venv', 'Scripts', 'python.exe'), 'MZ');
      const found = await discoverInterpreters(dir, 'python', { pathEnv: '', probe: null, home: dir });
      expect(found.length).toBe(1);
      expect(found[0].kind).toBe('venv');
      expect(found[0].source).toBe('.venv');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns nothing for a language it has no spec for', async () => {
    expect(await discoverInterpreters('.', 'cobol')).toEqual([]);
  });
});

describe('.idea import', () => {
  it('expands the JetBrains macros', () => {
    const out = expandMacros('$PROJECT_DIR$/src', 'C:/proj');
    expect(out.startsWith('C:/proj') || out.startsWith('C:\\proj')).toBe(true);
    expect(out).not.toContain('$PROJECT_DIR$');
  });

  it('reads run configurations and reports what it skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nlg-idea-'));
    try {
      mkdirSync(join(dir, '.idea', 'runConfigurations'), { recursive: true });
      writeFileSync(
        join(dir, '.idea', 'misc.xml'),
        '<project><component name="ProjectRootManager" project-jdk-name="Python 3.13 (proj)" /></project>',
      );
      writeFileSync(
        join(dir, '.idea', 'runConfigurations', 'main.xml'),
        `<component><configuration default="false" name="main" type="PythonConfigurationType" factoryName="Python">
           <option name="SCRIPT_NAME" value="$PROJECT_DIR$/main.py" />
           <option name="PARAMETERS" value="--fast 1" />
           <envs><env name="MODE" value="dev" /></envs>
         </configuration>
         <configuration default="false" name="broken" type="PythonConfigurationType" /></component>`,
      );
      const out = await importIdeaProject(dir);
      expect(out.missing).toBe(false);
      expect(out.projectSdk).toBe('Python 3.13 (proj)');
      expect(out.configurations).toHaveLength(1);
      const cfg = out.configurations[0];
      expect(cfg.name).toBe('main');
      expect(cfg.script).toBe('main.py');
      expect(cfg.parameters).toBe('--fast 1');
      expect(cfg.env.MODE).toBe('dev');
      expect(cfg.language).toBe('python');
      expect(out.warnings.join(' ')).toContain('broken');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a project without .idea instead of throwing', async () => {
    const out = await importIdeaProject(join(tmpdir(), 'nlg-no-such-project-xyz'));
    expect(out.missing).toBe(true);
    expect(out.configurations).toEqual([]);
  });
});

describe('run timeout · a client budget that means something', () => {
  it('treats absent values as "use the manifest default"', () => {
    expect(boundedRunTimeout(undefined)).toBeUndefined();
    expect(boundedRunTimeout(null)).toBeUndefined();
    expect(boundedRunTimeout('')).toBeUndefined();
  });

  it('rejects values that are not a number at all', () => {
    // `Number('abc')` is NaN and `setTimeout(NaN)` fires immediately: a typo
    // would abort every run at birth, which reads as a crash.
    expect(boundedRunTimeout('abc')).toBeUndefined();
    expect(boundedRunTimeout(Number.NaN)).toBeUndefined();
    expect(boundedRunTimeout(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(boundedRunTimeout({})).toBeUndefined();
    expect(boundedRunTimeout(true)).toBeUndefined();
    expect(boundedRunTimeout([5000])).toBeUndefined();
  });

  it('clamps a zero or negative budget up to the minimum', () => {
    expect(boundedRunTimeout(0)).toBe(RUN_TIMEOUT_MIN_MS);
    expect(boundedRunTimeout(-1)).toBe(RUN_TIMEOUT_MIN_MS);
    expect(boundedRunTimeout(-99999)).toBe(RUN_TIMEOUT_MIN_MS);
  });

  it('clamps an absurd budget down to the maximum', () => {
    expect(boundedRunTimeout(1e9)).toBe(RUN_TIMEOUT_MAX_MS);
    expect(boundedRunTimeout(RUN_TIMEOUT_MAX_MS + 1)).toBe(RUN_TIMEOUT_MAX_MS);
  });

  it('keeps a sane budget exactly as asked', () => {
    expect(boundedRunTimeout(4000)).toBe(4000);
    expect(boundedRunTimeout(RUN_TIMEOUT_MIN_MS)).toBe(RUN_TIMEOUT_MIN_MS);
    expect(boundedRunTimeout(RUN_TIMEOUT_MAX_MS)).toBe(RUN_TIMEOUT_MAX_MS);
  });

  it('accepts a numeric string from the wire and rounds fractions', () => {
    expect(boundedRunTimeout('4000')).toBe(4000);
    expect(boundedRunTimeout(4000.7)).toBe(4001);
    expect(boundedRunTimeout(4000.2)).toBe(4000);
  });
});

describe('mcp · turning an mcp.json command into a spawn()', () => {
  // A fixture PATH holding one shim of each kind, so the resolution rules can be
  // checked without a real npm install.
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nlg-mcp-path-'));
    writeFileSync(join(dir, 'npx.cmd'), '@echo off\r\n');
    writeFileSync(join(dir, 'tool.exe'), 'MZ');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A function, not a const: `beforeAll` assigns `dir` after the describe body
  // runs, so a captured object would hold the empty string forever.
  const win = (): { platform: NodeJS.Platform; PATH: string; PATHEXT: string } => ({
    platform: 'win32',
    PATH: dir,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  });

  it('leaves the command alone off Windows', () => {
    const plan = planMcpSpawn('npx', ['-y', 'pkg'], { ...win(), platform: 'linux' });
    expect(plan).toEqual({ command: 'npx', args: ['-y', 'pkg'], shell: false });
  });

  it('resolves a bare name to its .cmd shim and asks for a shell', () => {
    // This is the bug a local run found: `spawn('npx')` is ENOENT on Windows,
    // and `spawn('npx.cmd')` is EINVAL. Both are only launchable via cmd.exe.
    const plan = planMcpSpawn('npx', ['-y', '@modelcontextprotocol/server-filesystem', 'C:/my dir'], win());
    // Same file: Windows paths are case-insensitive, and the resolver echoes the
    // extension as PATHEXT spells it.
    expect(plan.command.toLowerCase()).toBe(join(dir, 'npx.cmd').toLowerCase());
    expect(plan.shell).toBe(true);
    // Quoted, or the space in the path would split the argument.
    expect(plan.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '"C:/my dir"']);
  });

  it('resolves a bare name to an .exe without a shell', () => {
    const plan = planMcpSpawn('tool', ['--flag'], win());
    expect(plan.command.toLowerCase()).toBe(join(dir, 'tool.exe').toLowerCase());
    expect(plan.shell).toBe(false);
    expect(plan.args).toEqual(['--flag']);
  });

  it('passes an explicit path through untouched', () => {
    const cmd = join(dir, 'tool.exe');
    const plan = planMcpSpawn(cmd, ['a'], win());
    expect(plan).toEqual({ command: cmd, args: ['a'], shell: false });
  });

  it('routes an explicit .cmd path through the shell too', () => {
    const cmd = join(dir, 'npx.cmd');
    const plan = planMcpSpawn(cmd, ['-y', 'pkg'], win());
    expect(plan.shell).toBe(true);
    expect(plan.command).toBe(cmd);
  });

  it('leaves an unresolvable name alone so spawn reports ENOENT', () => {
    const plan = planMcpSpawn('definitely-not-here', ['x'], win());
    expect(plan).toEqual({ command: 'definitely-not-here', args: ['x'], shell: false });
  });

  it('recognises both script extensions', () => {
    expect(isCmdScript('a.cmd')).toBe(true);
    expect(isCmdScript('a.BAT')).toBe(true);
    expect(isCmdScript('a.exe')).toBe(false);
    expect(isCmdScript('a')).toBe(false);
  });

  it('quotes only the arguments that need it', () => {
    expect(quoteCmdArg('plain')).toBe('plain');
    expect(quoteCmdArg('two words')).toBe('"two words"');
    expect(quoteCmdArg('C:/my dir')).toBe('"C:/my dir"');
    expect(quoteCmdArg('')).toBe('""');
    // A quote inside an argument is doubled, which is what the C runtime undoes.
    expect(quoteCmdArg('say "hi"')).toBe('"say ""hi"""');
    // Shell metacharacters must not escape the quoting.
    expect(quoteCmdArg('a&b|c>d')).toBe('"a&b|c>d"');
    expect(quoteCmdArg('50%')).toBe('50%');
  });
});

describe('mcp · a per-server handshake budget', () => {
  it('treats absent values as "use the manager default"', () => {
    expect(boundedMcpTimeout(undefined)).toBeUndefined();
    expect(boundedMcpTimeout(null)).toBeUndefined();
    expect(boundedMcpTimeout('')).toBeUndefined();
  });

  it('rejects values that are not a number at all', () => {
    // `setTimeout(NaN)` fires immediately, so a typo in mcp.json would make
    // every connect fail at once — the opposite of what the field is for.
    expect(boundedMcpTimeout('soon')).toBeUndefined();
    expect(boundedMcpTimeout(Number.NaN)).toBeUndefined();
    expect(boundedMcpTimeout(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(boundedMcpTimeout({})).toBeUndefined();
    expect(boundedMcpTimeout(true)).toBeUndefined();
  });

  it('clamps a too-small budget up to the floor', () => {
    // A server that answers in 2s and a config of 50ms is a mistake, not a
    // request to abandon the handshake before the process can even boot.
    expect(boundedMcpTimeout(50)).toBe(MCP_TIMEOUT_MIN_MS);
    expect(boundedMcpTimeout(0)).toBe(MCP_TIMEOUT_MIN_MS);
    expect(boundedMcpTimeout(-5)).toBe(MCP_TIMEOUT_MIN_MS);
  });

  it('clamps an absurd budget down to the ceiling', () => {
    expect(boundedMcpTimeout(1e9)).toBe(MCP_TIMEOUT_MAX_MS);
  });

  it('keeps a sane budget exactly as asked', () => {
    expect(boundedMcpTimeout(60_000)).toBe(60_000);
    expect(boundedMcpTimeout('45000')).toBe(45_000);
    expect(boundedMcpTimeout(MCP_TIMEOUT_MIN_MS)).toBe(MCP_TIMEOUT_MIN_MS);
  });
});

describe('log · the digest never hides a gap', () => {
  it('passes a small burst through untouched', () => {
    const out = sliceDigest(['a', 'b', 'c'], 300);
    expect(out.records).toEqual(['a', 'b', 'c']);
    expect(out.dropped).toBe(0);
  });

  it('keeps the newest records and counts the rest', () => {
    // A log panel is read backwards: the tail is what explains the failure.
    const burst = Array.from({ length: 1000 }, (_, i) => i);
    const out = sliceDigest(burst, 300);
    expect(out.records).toHaveLength(300);
    expect(out.records[0]).toBe(700);
    expect(out.records[299]).toBe(999);
    // The count is the whole point: silently dropping 700 records makes the
    // timeline look continuous when it is not.
    expect(out.dropped).toBe(700);
  });

  it('treats a non-positive cap as "drop everything, say so"', () => {
    expect(sliceDigest([1, 2, 3], 0)).toEqual({ records: [], dropped: 3 });
  });

  it('does not mutate the input', () => {
    const burst = [1, 2, 3, 4];
    sliceDigest(burst, 2);
    expect(burst).toEqual([1, 2, 3, 4]);
  });
});

describe('log · the NDJSON file transport', () => {
  const record = (over: Partial<LogRecord> = {}): LogRecord =>
    ({
      id: 'r1',
      timestamp: 1_700_000_000_000_000_000,
      level: LogLevel.INFO,
      message: 'hello',
      resource: { scope: 'kernel', component: 'test' },
      scope: {},
      correlation: { sessionId: 's1' } as LogRecord['correlation'],
      environment: {} as LogRecord['environment'],
      fields: {},
      ...over,
    }) as LogRecord;

  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nlg-logfile-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a header line and one JSON object per record', () => {
    const path = join(dir, 'app.log');
    const t = new FileTransport({ path, header: { version: 1, app: 'test' } });
    t.write(record({ message: 'first' }));
    t.write(record({ message: 'second', level: LogLevel.WARN }));
    t.close();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(header['#']).toBe('header');
    expect(header.app).toBe('test');
    const first = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(first.msg).toBe('first');
    expect(first.lvl).toBe('INFO');
    expect(first.comp).toBe('test');
    const second = JSON.parse(lines[2]) as Record<string, unknown>;
    expect(second.lvl).toBe('WARN');
  });

  it('drops records below the configured level', () => {
    const path = join(dir, 'app.log');
    const t = new FileTransport({ path, minLevel: LogLevel.WARN });
    t.write(record({ message: 'trace', level: LogLevel.TRACE }));
    t.write(record({ message: 'error', level: LogLevel.ERROR }));
    t.close();
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain('trace');
    expect(text).toContain('error');
  });

  it('rotates by size and keeps the requested generations', () => {
    const path = join(dir, 'app.log');
    // Tiny cap so a handful of records forces several rotations. Flushed in
    // batches on purpose: the transport coalesces a burst into one write, so a
    // single burst rotates once no matter how many records it holds.
    const t = new FileTransport({ path, maxBytes: 400, keep: 2 });
    for (let batch = 0; batch < 6; batch++) {
      for (let i = 0; i < 4; i++) t.write(record({ message: `b${batch}-${i}-${'x'.repeat(40)}` }));
      t.flush();
    }
    t.close();

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    // `keep: 2` means .1 and .2 survive; .3 is removed.
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
    // Nothing was lost silently along the way.
    expect(t.stats().rotations).toBeGreaterThan(0);
    expect(t.stats().errors).toBe(0);
  });

  it('truncates a huge record without producing invalid JSON', () => {
    const path = join(dir, 'app.log');
    const t = new FileTransport({ path, maxLineBytes: 300 });
    t.write(record({ message: 'y'.repeat(5000) }));
    t.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(String(last.msg)).toContain('truncated');
    expect(String(last.msg).length).toBeLessThan(1000);
  });

  it('never throws when the path cannot be written, and counts it', () => {
    // A directory used as a file: appendFileSync fails, the transport must not.
    const path = join(dir, 'nested');
    mkdirSync(path, { recursive: true });
    const t = new FileTransport({ path });
    expect(() => {
      t.write(record({ message: 'into a directory' }));
      t.close();
    }).not.toThrow();
    const stats = t.stats();
    expect(stats.errors).toBeGreaterThan(0);
    expect(stats.lastError).toBeTruthy();
    expect(stats.written).toBe(0);
  });

  it('caps the queue instead of growing without bound', () => {
    const path = join(dir, 'app.log');
    const t = new FileTransport({ path, maxQueue: 2 });
    for (let i = 0; i < 10; i++) t.write(record({ message: `m${i}` }));
    t.close();
    const stats = t.stats();
    // Two made it through the queue, the rest are counted, not forgotten.
    expect(stats.written + stats.dropped).toBe(10);
    expect(stats.dropped).toBeGreaterThan(0);
  });
});

describe('log · the boot sink that exists before the kernel', () => {
  let dir = '';
  const withLogFile = (value: string | undefined): void => {
    if (value === undefined) delete process.env.NOLANGUAGE_LOG_FILE;
    else process.env.NOLANGUAGE_LOG_FILE = value;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nlg-boot-'));
  });
  afterEach(() => {
    withLogFile(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('stays silent when no log file is configured', () => {
    withLogFile(undefined);
    expect(bootLogPath()).toBeUndefined();
    bootLog('nothing-happens');
    expect(existsSync(join(dir, 'boot.log'))).toBe(false);
  });

  it('honours an explicit opt-out', () => {
    withLogFile('0');
    expect(bootLogPath()).toBeUndefined();
    withLogFile('off');
    expect(bootLogPath()).toBeUndefined();
  });

  it('writes a header first, then one line per event', () => {
    const appLog = join(dir, 'logs', 'app.log');
    withLogFile(appLog);
    expect(bootLogPath()).toBe(join(dir, 'logs', 'boot.log'));
    bootLog('boot');
    bootLog('server-starting', { port: 7310 });

    const lines = readFileSync(join(dir, 'logs', 'boot.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(header['#']).toBe('boot');
    expect(header.pid).toBe(process.pid);
    const event = JSON.parse(lines[2]) as Record<string, unknown>;
    expect(event.ev).toBe('server-starting');
    expect((event as { port?: number }).port).toBe(7310);
  });

  it('keeps the fields that identify a denied write', () => {
    // The failure this exists for said only "operation not permitted"; the
    // path and errno are what make it actionable.
    withLogFile(join(dir, 'logs', 'app.log'));
    const err = Object.assign(new Error('EPERM: operation not permitted, open X'), {
      code: 'EPERM',
      errno: -4048,
      syscall: 'open',
      path: 'C:/temp/nolanguage-embedded/extensions/examples/faulty/extension.json',
    });
    bootLogError('embedded-asset', err, { asset: 'extensions/examples/faulty/extension.json' });

    const lines = readFileSync(join(dir, 'logs', 'boot.log'), 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]) as {
      ev: string;
      asset: string;
      error: { code: string; errno: number; syscall: string; path: string };
    };
    expect(entry.ev).toBe('embedded-asset');
    expect(entry.asset).toContain('faulty/extension.json');
    expect(entry.error.code).toBe('EPERM');
    expect(entry.error.errno).toBe(-4048);
    expect(entry.error.syscall).toBe('open');
    expect(entry.error.path).toContain('nolanguage-embedded');
  });

  it('never throws when the target cannot be written', () => {
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked, { recursive: true });
    // Point the log at a directory: every append fails.
    withLogFile(join(blocked, 'nested'));
    expect(() => {
      bootLog('first');
      bootLog('second');
    }).not.toThrow();
  });
});

describe('lsp · the bundled fallback is declared, not guessed', () => {
  it('expands the toolchain and the embedded asset', () => {
    // The real Python declaration: `{toolchain} -u {embedded:pyrightServer.py}`.
    const spec = resolveBundledFallback(
      {
        languageId: 'python',
        serverName: 'nolanguage-py',
        command: ['{toolchain}', '-u', '{embedded:pyrightServer.py}'],
        sourceDir: 'python',
      },
      { languageId: 'python', toolchain: 'C:/Python313/python.exe' },
    );
    expect(spec).toBeDefined();
    expect(spec!.command).toBe('C:/Python313/python.exe');
    expect(spec!.args[0]).toBe('-u');
    // Source run: the asset resolves under src/python, not from the exe.
    expect(spec!.args[1]).toMatch(/pyrightServer\.py$/);
    expect(spec!.languageId).toBe('python');
    expect(spec!.serverName).toBe('nolanguage-py');
  });

  it('refuses to launch without a toolchain', () => {
    // A literal `{toolchain}` left in the command would surface as a confusing
    // ENOENT much later; undefined here becomes the manifest's degradedNote.
    const spec = resolveBundledFallback(
      { command: ['{toolchain}', '-u', '{embedded:pyrightServer.py}'], sourceDir: 'python' },
      { languageId: 'python' },
    );
    expect(spec).toBeUndefined();
  });

  it('refuses an asset that does not exist', () => {
    const spec = resolveBundledFallback(
      { command: ['{toolchain}', '{embedded:no_such_asset.py}'], sourceDir: 'python' },
      { languageId: 'python', toolchain: 'python' },
    );
    expect(spec).toBeUndefined();
  });

  it('defaults the ids to the asking language', () => {
    const spec = resolveBundledFallback({ command: ['my-server', '--stdio'] }, { languageId: 'cobol' });
    expect(spec!.languageId).toBe('cobol');
    expect(spec!.serverName).toBe('cobol');
    expect(spec!.args).toEqual(['--stdio']);
  });

  it('passes a plain command through untouched', () => {
    const spec = resolveBundledFallback({ command: ['/opt/x/server'] }, { languageId: 'go', toolchain: '/usr/bin/go' });
    expect(spec!.command).toBe('/opt/x/server');
    expect(spec!.args).toEqual([]);
  });

  it('returns undefined for a malformed declaration instead of throwing', () => {
    expect(resolveBundledFallback(undefined, { languageId: 'go' })).toBeUndefined();
    expect(resolveBundledFallback({ command: [] }, { languageId: 'go' })).toBeUndefined();
    // A broken manifest must degrade to "no server", never crash the slot.
    expect(resolveBundledFallback({ command: [''] }, { languageId: 'go' })).toBeUndefined();
  });
});

describe('interpreters · declared by the plugin, table only as fallback', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nlg-interp-'));
    // A Kotlin-flavoured environment: the engine has no row for this language.
    mkdirSync(join(dir, '.kvenv', 'bin'), { recursive: true });
    writeFileSync(join(dir, '.kvenv', 'kvenv.cfg'), 'x\n');
    writeFileSync(join(dir, '.kvenv', 'bin', 'kotlinc'), 'bin');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lets a language the engine has never heard of discover its SDK', async () => {
    const found = await discoverInterpreters(dir, 'kotlin', {
      pathEnv: '',
      probe: null,
      home: dir,
      spec: { envDirs: ['.kvenv'], marker: 'kvenv.cfg', envBins: ['bin/kotlinc'] },
    });
    expect(found.map((f) => f.source)).toEqual(['.kvenv']);
    expect(found[0].kind).toBe('venv');
  });

  it('replaces the fallback table instead of merging with it', async () => {
    // python has a table row that would find `.venv`; an explicit spec that
    // declares nothing must win, otherwise "declared" is not authoritative.
    mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
    writeFileSync(join(dir, '.venv', 'pyvenv.cfg'), 'x\n');
    writeFileSync(join(dir, '.venv', 'Scripts', 'python.exe'), 'MZ');
    const found = await discoverInterpreters(dir, 'python', {
      pathEnv: '',
      probe: null,
      home: dir,
      spec: { envDirs: [], exeNames: [] },
    });
    expect(found).toEqual([]);
  });

  it('matches a recorded SDK name through the declared prefix', async () => {
    const found = await discoverInterpreters(dir, 'kotlin', {
      pathEnv: '',
      home: dir,
      probe: async () => '1.9.0',
      sdkName: 'Kotlin 1.9.0',
      spec: {
        envDirs: ['.kvenv'],
        marker: 'kvenv.cfg',
        envBins: ['bin/kotlinc'],
        sdkPrefix: 'Kotlin',
      },
    });
    expect(found).toHaveLength(1);
    // Only the prefix rule can match here: the directory is `.kvenv` and the
    // binary is `kotlinc`, neither of which appears in "Kotlin 1.9.0".
    expect(found[0].sdkMatch).toBe(true);
  });

  it('will not treat a directory as an environment without a marker', async () => {
    // An empty marker would make `join(envDir, '')` the directory itself, which
    // always exists — every listed dir would look like an environment.
    const found = await discoverInterpreters(dir, 'kotlin', {
      pathEnv: '',
      probe: null,
      home: dir,
      spec: { envDirs: ['.kvenv'], envBins: ['bin/kotlinc'] },
    });
    expect(found).toEqual([]);
  });

  it('keeps the table working for plugins that declare nothing', async () => {
    mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
    writeFileSync(join(dir, '.venv', 'pyvenv.cfg'), 'x\n');
    writeFileSync(join(dir, '.venv', 'Scripts', 'python.exe'), 'MZ');
    const found = await discoverInterpreters(dir, 'python', { pathEnv: '', probe: null, home: dir });
    expect(found.map((f) => f.source)).toEqual(['.venv']);
  });
});

describe('extensions · one table answers "what language is this file"', () => {
  it('resolves the built-in defaults', () => {
    expect(languageForName('main.py')).toBe('python');
    expect(languageForName('main.go')).toBe('go');
    expect(languageForName('README.md')).toBe('markdown');
    expect(languageForName('app.jsx')).toBe('javascript');
  });

  it('calls a .ts file javascript, because no TypeScript plugin exists', () => {
    // This used to be `typescript` in the explorer and `javascript` in a run
    // configuration — the same file, two answers, and `typescript` was an id
    // nothing could act on (no manifest, no server, no runtime).
    expect(languageForName('a.ts')).toBe('javascript');
    expect(languageForName('a.tsx')).toBe('javascript');
  });

  it('still names languages that have no plugin', () => {
    // Highlighted, never run — the editor needs an id for these too.
    expect(languageForName('data.json')).toBe('json');
    expect(languageForName('ci.yml')).toBe('yaml');
    expect(languageForName('run.sh')).toBe('shell');
  });

  it('handles dotfiles, which have no dot-suffix to strip', () => {
    expect(languageForName('.gitignore')).toBe('text');
  });

  it('returns undefined for an extension nobody claims', () => {
    expect(languageForName('a.zzz')).toBeUndefined();
  });

  it('lets a manifest override a default without losing the rest', () => {
    // The shape of the future: a typescript plugin would claim .ts and win,
    // while every other default keeps working.
    const index = buildExtensionIndex([{ id: 'typescript', file: { extensions: ['ts', 'tsx'] } }]);
    expect(index.get('ts')).toBe('typescript');
    expect(index.get('tsx')).toBe('typescript');
    expect(index.get('py')).toBe('python');
    expect(index.get('json')).toBe('json');
  });
});
