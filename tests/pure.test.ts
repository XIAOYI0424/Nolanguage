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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { decodeEntities, findAll, options, parseXml } from '../src/util/xml';
import { decideLaunch, launchUrl, sameBuild } from '../src/desktop/handshake';
import { expandMacros, importIdeaProject } from '../src/langs/ideaImport';
import { boundedRunTimeout, RUN_TIMEOUT_MAX_MS, RUN_TIMEOUT_MIN_MS } from '../src/panel/run-timeout';
import { isCmdScript, planMcpSpawn, quoteCmdArg } from '../src/mcp/spawn-command';
import { boundedMcpTimeout, MCP_TIMEOUT_MAX_MS, MCP_TIMEOUT_MIN_MS } from '../src/mcp/McpManager';

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
