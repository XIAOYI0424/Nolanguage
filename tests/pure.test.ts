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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import {
  installPackage,
  packageNameProblem,
  parseDependencies,
  readDependencies,
  undeclaredImports,
} from '../src/langs/dependencies';
import { materializeAssets } from '../src/assets/embeddedAssets';
import { environmentExecutable, planEnvironment } from '../src/langs/interpreters';
import { validateManifest } from '../src/langs/manifest';
import { normalizeFoldingRanges, normalizeInlayHints } from '../src/lsp/navigation';
import { applyTextEdits, editPath } from '../src/lsp/workspaceEdits';
import { createGoTestParser, parseGoTest } from '../src/langs/testParser';
import {
  boundedRunTimeout,
  RUN_TIMEOUT_MAX_MS,
  RUN_TIMEOUT_MIN_MS,
} from '../src/panel/handlers/run';
import { sanitizeTestFilter } from '../src/panel/handlers/tests';
import { HistoryStore } from '../src/util/history';
import { planPreLaunch, resolveLaunchProgram } from '../src/panel/handlers/debug';
import { buildLanguagePlugin, RUN_MODES } from '../src/langs/scaffoldPlugin';
import { parseSha256 } from '../src/util/hash';
import { SseDecoder, buildChatRequest, normalizeBaseUrl, normalizeModel } from '../src/net/ai';
import { FsService } from '../src/panel/FsService';
import { handleApplyWorkspaceEdits, handleDraft } from '../src/panel/handlers/fs';
import { describeFailure } from '../src/desktop/fatalDialog';
import {
  declaresFeature,
  normalizeCodeActions,
  normalizeLocations,
  normalizeSymbols,
  normalizeWorkspaceEdit,
} from '../src/lsp/navigation';
import { decodeEntities, findAll, options, parseXml } from '../src/util/xml';
import { decideLaunch, launchUrl, sameBuild } from '../src/desktop/handshake';
import { expandMacros, importIdeaProject } from '../src/langs/ideaImport';

import { isCmdScript, planSpawn, quoteCmdArg } from '../src/util/spawnPlan';
import { boundedMcpTimeout, MCP_TIMEOUT_MAX_MS, MCP_TIMEOUT_MIN_MS } from '../src/mcp/McpManager';
import { FileTransport } from '../src/log/transports/FileTransport';
import { bootLog, bootLogError, bootLogPath } from '../src/util/bootLog';
import { decodeOutput, OutputDecoder } from '../src/util/encoding';
import { writeHandshake } from '../src/net/websocket';
import { resolveBundledFallback } from '../src/lsp/bundledFallback';
import { managedBinary, planFor, resolveServer, statusFor } from '../src/langs/serverInstall';
import { buildManagerPlugin } from '../src/langs/managerPlugins';
import { toolchainEnv } from '../src/langs/toolchainEnv';
import { cachedVersion, toolchainSignature, versionCachePath } from '../src/langs/versionCache';
import { windowUsable } from '../src/desktop/handshake';
import { detectProjects } from '../src/scaffold/detect';
import { applyAdd, planAdd, planSync } from '../src/scaffold/dependencies';
import {
  classpathProblem,
  mainClassProblem,
  parseEnv,
  RunConfigStore,
  splitArgs,
} from '../src/scaffold/runConfigs';
import { runtimeSupportsArgs } from '../src/runtimes/index';
import { TemplateRegistry } from '../src/scaffold/registry';
import { safeRelativePath } from '../src/scaffold/types';
import { judgeTtl, summarizeIdle } from '../src/lsp/ttlStats';
import { UsageLog } from '../src/perf/usageLog';
import { JsonRpcConnection } from '../src/lsp/jsonrpc';
import { PassThrough } from 'node:stream';
import { CacheValidator } from '../src/lsp/manager/CacheValidator';
import { DiagnosticsBuffer } from '../src/lsp/manager/DiagnosticsBuffer';
import { LexicalFallback, scanText } from '../src/lsp/manager/fallback';
import { LspManager } from '../src/lsp/manager/LspManager';
import { PluginRegistry } from '../src/lsp/manager/PluginRegistry';
import { Scheduler } from '../src/lsp/manager/Scheduler';
import { versionSignature } from '../src/lsp/manager/signature';
import { ContentHashStrategy, GitDiffStrategy } from '../src/lsp/manager/strategies';
import type { DirtyReport, IndexMetadata, LanguagePlugin } from '../src/lsp/manager/types';
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
      const found = await discoverInterpreters(dir, 'python', {
        pathEnv: '', probe: null, home: dir, envSearchUp: 0, envSearchDown: 0,
      });
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

  it('finds a virtual environment inside a subfolder project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nlg-vitest-child-'));
    try {
      const env = join(dir, 'services', 'api', '.venv');
      mkdirSync(join(env, 'Scripts'), { recursive: true });
      writeFileSync(join(env, 'pyvenv.cfg'), 'home = C:/Python313\n');
      writeFileSync(join(env, 'Scripts', 'python.exe'), 'MZ');
      const found = await discoverInterpreters(dir, 'python', {
        pathEnv: '', probe: null, home: dir, envSearchUp: 0, envSearchDown: 3,
      });
      expect(found.map((f) => f.source)).toEqual(['services/api/.venv']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the workspace environment from an opened subfolder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nlg-vitest-parent-'));
    try {
      const env = join(dir, '.venv');
      mkdirSync(join(env, 'Scripts'), { recursive: true });
      writeFileSync(join(env, 'pyvenv.cfg'), 'home = C:/Python313\n');
      writeFileSync(join(env, 'Scripts', 'python.exe'), 'MZ');
      const sub = join(dir, 'services', 'api');
      mkdirSync(sub, { recursive: true });
      const found = await discoverInterpreters(sub, 'python', {
        pathEnv: '', probe: null, home: dir, envSearchUp: 2, envSearchDown: 0,
      });
      expect(found.map((f) => f.source)).toEqual(['../../.venv']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ranks local, parent and child environments in that order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nlg-vitest-rank-'));
    try {
      for (const rel of ['.venv', 'services/api/.venv', 'services/api/tools/.venv']) {
        const env = join(dir, rel);
        mkdirSync(join(env, 'Scripts'), { recursive: true });
        writeFileSync(join(env, 'pyvenv.cfg'), 'home = C:/Python313\n');
        writeFileSync(join(env, 'Scripts', 'python.exe'), 'MZ');
      }
      const found = await discoverInterpreters(join(dir, 'services', 'api'), 'python', {
        pathEnv: '', probe: null, home: dir, envSearchUp: 2, envSearchDown: 2,
      });
      expect(found.map((f) => f.source)).toEqual(['.venv', '../../.venv', 'tools/.venv']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not crawl dependency directories looking for environments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nlg-vitest-skip-'));
    try {
      const env = join(dir, 'node_modules', 'pkg', '.venv');
      mkdirSync(join(env, 'Scripts'), { recursive: true });
      writeFileSync(join(env, 'pyvenv.cfg'), 'home = C:/Python313\n');
      writeFileSync(join(env, 'Scripts', 'python.exe'), 'MZ');
      const found = await discoverInterpreters(dir, 'python', {
        pathEnv: '', probe: null, home: dir, envSearchUp: 0, envSearchDown: 4,
      });
      expect(found).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    const plan = planSpawn('npx', ['-y', 'pkg'], { ...win(), platform: 'linux' });
    expect(plan).toEqual({ command: 'npx', args: ['-y', 'pkg'], shell: false });
  });

  it('resolves a bare name to its .cmd shim and asks for a shell', () => {
    // This is the bug a local run found: `spawn('npx')` is ENOENT on Windows,
    // and `spawn('npx.cmd')` is EINVAL. Both are only launchable via cmd.exe.
    const plan = planSpawn('npx', ['-y', '@modelcontextprotocol/server-filesystem', 'C:/my dir'], win());
    // Same file: Windows paths are case-insensitive, and the resolver echoes the
    // extension as PATHEXT spells it.
    expect(plan.command.toLowerCase()).toBe(join(dir, 'npx.cmd').toLowerCase());
    expect(plan.shell).toBe(true);
    // Quoted, or the space in the path would split the argument.
    expect(plan.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '"C:/my dir"']);
  });

  it('resolves a bare name to an .exe without a shell', () => {
    const plan = planSpawn('tool', ['--flag'], win());
    expect(plan.command.toLowerCase()).toBe(join(dir, 'tool.exe').toLowerCase());
    expect(plan.shell).toBe(false);
    expect(plan.args).toEqual(['--flag']);
  });

  it('passes an explicit path through untouched', () => {
    const cmd = join(dir, 'tool.exe');
    const plan = planSpawn(cmd, ['a'], win());
    expect(plan).toEqual({ command: cmd, args: ['a'], shell: false });
  });

  it('routes an explicit .cmd path through the shell too', () => {
    const cmd = join(dir, 'npx.cmd');
    const plan = planSpawn(cmd, ['-y', 'pkg'], win());
    expect(plan.shell).toBe(true);
    expect(plan.command).toBe(cmd);
  });

  it('leaves an unresolvable name alone so spawn reports ENOENT', () => {
    const plan = planSpawn('definitely-not-here', ['x'], win());
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

describe('language server providers', () => {
  const home = join(tmpdir(), 'nl-servers-test');
  const manifest = (lsp: Record<string, unknown>) => ({ id: 'demo', lsp } as never);

  it('turns an npm provider into one reproducible install command', () => {
    const plan = planFor(manifest({ provider: { kind: 'npm', package: 'pyright', version: '1.1.414', bin: 'pyright-langserver' } }), home);
    expect(plan.command).toEqual([
      'npm', 'install', '--prefix', join(home, 'servers', 'demo'), '--no-audit', '--no-fund', 'pyright@1.1.414',
    ]);
    // Both shims are probed: Windows gets a .cmd, POSIX a bare script.
    expect(plan.probe).toEqual(['node_modules/.bin/pyright-langserver.cmd', 'node_modules/.bin/pyright-langserver']);
  });

  it('pulls in a peer dependency in the same install', () => {
    const plan = planFor(manifest({
      provider: { kind: 'npm', package: 'typescript-language-server', version: '6.1.0', also: ['typescript@5.6.3'] },
    }), home);
    // Without `typescript` the server starts and then fails on the first request.
    expect(plan.command?.slice(-1)).toEqual(['typescript@5.6.3']);
  });

  it('points a Go install at the managed bin directory', () => {
    const plan = planFor(manifest({ provider: { kind: 'go-install', package: 'golang.org/x/tools/gopls', version: 'v0.24.0' } }), home);
    expect(plan.command).toEqual(['go', 'install', 'golang.org/x/tools/gopls@v0.24.0']);
    expect(plan.probe).toEqual([join('bin', process.platform === 'win32' ? 'gopls.exe' : 'gopls')]);
  });

  it('uses the discovered toolchain for go install, not a bare name', () => {
    // `go` is not always on PATH — that is what `run.discovery` is for, and the
    // installer must use the same answer the runner does. With a bare `go` the
    // install failed with "'go' is not recognized" on exactly those machines.
    // Discovery checks that the path exists, so the fixture has to exist too.
    const goDir = mkdtempSync(join(tmpdir(), 'nl-go-'));
    const goPath = join(goDir, 'go.exe');
    writeFileSync(goPath, '');
    const plan = planFor(
      {
        id: 'demo',
        lsp: { provider: { kind: 'go-install', package: 'golang.org/x/tools/gopls', version: 'v0.24.0' } },
        run: { mode: 'template', discovery: { knownPaths: [goPath] } },
      } as never,
      home,
    );
    expect(plan.command?.[0]).toBe(goPath);
    expect(plan.command?.slice(1)).toEqual(['install', 'golang.org/x/tools/gopls@v0.24.0']);
    rmSync(goDir, { recursive: true, force: true });
  });

  it('refuses to auto-download a GitHub release, and says where to put it', () => {
    const plan = planFor(manifest({ provider: { kind: 'github', package: 'artempyanykh/marksman', asset: 'marksman.exe' } }), home);
    expect(plan.command).toBeUndefined();
    expect(plan.manual).toMatch(/github\.com\/artempyanykh\/marksman/);
    expect(plan.manual).toContain(join(home, 'servers', 'demo', 'marksman.exe'));
  });

  it('says so when a plugin declares no provider', () => {
    expect(planFor(manifest({}), home).manual).toMatch(/lsp\.provider/);
  });

  it('finds a managed install only when normal discovery finds nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-managed-'));
    const m = manifest({
      discovery: { envVars: ['NL_TEST_SERVER'], knownPaths: [], commands: ['definitely-not-a-real-server'] },
      provider: { kind: 'npm', package: 'x', version: '1.0.0', bin: 'x' },
      serverName: 'x',
    });
    try {
      expect(managedBinary(m, dir)).toBeUndefined();
      const bin = join(dir, 'servers', 'demo', 'node_modules', '.bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'x.cmd'), '@echo off\n');
      expect(managedBinary(m, dir)).toBe(join(bin, 'x.cmd'));
      expect(resolveServer(m, dir)).toEqual({ bin: join(bin, 'x.cmd'), source: 'managed' });

      // An env var is the user telling us where their server is: it wins.
      const own = join(dir, 'own-server.exe');
      writeFileSync(own, '');
      process.env.NL_TEST_SERVER = own;
      expect(resolveServer(m, dir).source).toBe('env:NL_TEST_SERVER');
      delete process.env.NL_TEST_SERVER;
    } finally {
      delete process.env.NL_TEST_SERVER;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the memory hint and the degraded note from the manifest', () => {
    const st = statusFor(manifest({
      serverName: 'gopls', memoryHint: '80MB', degradedNote: 'gopls not installed',
      provider: { kind: 'go-install', package: 'golang.org/x/tools/gopls', version: 'v0.24.0' },
      discovery: { commands: ['definitely-not-a-real-server'] },
    }), join(tmpdir(), 'nl-servers-test'));
    expect(st.serverName).toBe('gopls');
    expect(st.memoryHint).toBe('80MB');
    expect(st.found).toBe(false);
  });
});

describe('lsp transport · a dead pipe is a close, not a crash', () => {
  it('closes the connection when the input stream errors', async () => {
    // A server that exits mid-request makes `input.write()` emit EPIPE. An
    // unhandled 'error' event on a stream kills the process, so the editor would
    // disappear because a language server crashed.
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = new JsonRpcConnection(input, output);
    const pending = rpc.request('textDocument/completion', {});
    input.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await expect(pending).rejects.toThrow(/closed/);
    expect(rpc.isClosed).toBe(true);
  });

  it('cancels by id only while the request is pending', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = new JsonRpcConnection(input, output);
    let sent = '';
    input.on('data', (chunk: Buffer) => {
      sent += chunk.toString('utf8');
    });
    let id = -1;
    const pending = rpc.request('textDocument/hover', {}, (assigned) => {
      id = assigned;
    });
    expect(rpc.cancel(id)).toBe(true);
    expect(sent).toContain('$/cancelRequest');
    // The answer arrives, so a second cancel has nothing to aim at.
    const body = JSON.stringify({ jsonrpc: '2.0', id, result: null });
    output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await pending;
    expect(rpc.cancel(id)).toBe(false);
  });
});

describe('lsp manager · the toolchain goes on the server PATH', () => {
  const base = { PATH: ['C:\\Windows', 'C:\\other'].join(';') };

  it('prepends the toolchain directory when it is missing', () => {
    const env = toolchainEnv('D:\\Go lang\\bin\\go.exe', base as NodeJS.ProcessEnv);
    expect(env?.PATH.split(';')[0]).toBe('D:\\Go lang\\bin');
  });

  it('adds nothing when the directory is already on PATH', () => {
    // Case-insensitively: Windows has one directory however it is spelled, and
    // prepending a duplicate would grow PATH on every launch.
    expect(toolchainEnv('C:\\Windows\\python.exe', base as NodeJS.ProcessEnv)).toBeUndefined();
    expect(toolchainEnv('c:\\windows\\python.exe', base as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('adds nothing when there is no toolchain', () => {
    expect(toolchainEnv(undefined, base as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('adds nothing for a bare command name', () => {
    // `java` was resolved through PATH, so `dirname` is `.` — prepending that
    // would put the workspace first on the child's search path.
    expect(toolchainEnv('java', base as NodeJS.ProcessEnv)).toBeUndefined();
    expect(toolchainEnv('go', base as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('adds nothing for a bare command name', () => {
    // `java` was resolved through PATH, so `dirname` is `.` — prepending that
    // would put the workspace first on the child's search path.
    expect(toolchainEnv('java', base as NodeJS.ProcessEnv)).toBeUndefined();
    expect(toolchainEnv('go', base as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('scaffold · templates', () => {
  const spec = {
    id: 'pkg',
    name: 'Package',
    suggestedDir: '{{name}}',
    params: [
      { key: 'name', label: 'Name', kind: 'text' as const, default: 'demo', required: true, pattern: '^[a-z]+$', hint: 'lowercase only' },
      { key: 'tests', label: 'Tests', kind: 'boolean' as const, default: true },
    ],
    files: [
      { path: '{{name}}/README.md', template: '# {{name}}' },
      { path: '{{name}}/test.py', when: 'tests', template: 'assert "{{name}}"' },
    ],
  };

  it('expands placeholders and skips files whose condition is false', () => {
    const reg = new TemplateRegistry();
    reg.setLanguage({ language: 'python', templates: [spec] });
    const dir = mkdtempSync(join(tmpdir(), 'nl-tpl-'));
    const out = reg.generate('python', 'pkg', { name: 'demo' }, dir);
    expect(out.files.map((f) => f.path).sort()).toEqual(['demo/README.md', 'demo/test.py']);
    expect(readFileSync(join(dir, 'demo/README.md'), 'utf8')).toBe('# demo');

    const off = join(mkdtempSync(join(tmpdir(), 'nl-tpl2-')), 'x');
    const out2 = reg.generate('python', 'pkg', { name: 'demo', tests: false }, off);
    expect(out2.files.map((f) => f.path)).toEqual(['demo/README.md']);
    rmSync(dir, { recursive: true, force: true });
    rmSync(off, { recursive: true, force: true });
  });

  it('writes a single file for a file template, under the given directory', () => {
    const reg = new TemplateRegistry();
    reg.setLanguage({
      language: 'python',
      templates: [
        {
          id: 'test-file',
          name: 'test',
          kind: 'file' as const,
          params: [{ key: 'name', label: 'Name', kind: 'text' as const, default: 'demo', required: true }],
          files: [{ path: 'tests/test_{{name}}.py', template: 'import {{name}}\n' }],
        },
      ],
    });
    const dir = mkdtempSync(join(tmpdir(), 'nl-tpl-file-'));
    const out = reg.generate('python', 'test-file', { name: 'demo' }, dir);
    expect(out.files.map((f) => f.path)).toEqual(['tests/test_demo.py']);
    expect(readFileSync(join(dir, 'tests/test_demo.py'), 'utf8')).toBe('import demo\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a value that does not match the declared pattern', () => {
    const reg = new TemplateRegistry();
    reg.setLanguage({ language: 'python', templates: [spec] });
    expect(() => reg.generate('python', 'pkg', { name: 'NotValid' }, mkdtempSync(join(tmpdir(), 'nl-tpl3-')))).toThrow(/lowercase/);
  });

  it('refuses a non-empty target unless told otherwise', () => {
    const reg = new TemplateRegistry();
    reg.setLanguage({ language: 'python', templates: [spec] });
    const dir = mkdtempSync(join(tmpdir(), 'nl-tpl4-'));
    writeFileSync(join(dir, 'busy.txt'), 'x');
    expect(() => reg.generate('python', 'pkg', { name: 'demo' }, dir)).toThrow(/不是空/);
    expect(() => reg.generate('python', 'pkg', { name: 'demo' }, dir, { allowNonEmpty: true })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a path that would escape the target directory', () => {
    expect(() => safeRelativePath('../etc/passwd')).toThrow();
    expect(() => safeRelativePath('C:/Windows/system32')).toThrow();
    expect(safeRelativePath('src/main.py')).toBe('src/main.py');
  });

  it('lists unavailable templates with their reason instead of hiding them', () => {
    const reg = new TemplateRegistry();
    reg.setLanguage({
      language: 'java',
      label: 'Initializr',
      availability: () => ({ ok: false, reason: 'network unreachable' }),
      templates: [{ ...spec, id: 'spring', name: 'Spring Boot' }],
    });
    const [item] = reg.list();
    expect(item.available).toBe(false);
    expect(item.reason).toBe('network unreachable');
  });
});

describe('runtimes · which ones take program arguments', () => {
  it('says yes only for the two that spawn a real process', () => {
    // `args` is only meaningful when something puts it on argv. Saying so here is
    // what lets the run-configuration dialog disable the field instead of
    // accepting a value that would be dropped.
    expect(runtimeSupportsArgs('template')).toBe(true);
    expect(runtimeSupportsArgs('repl-session')).toBe(true);
    expect(runtimeSupportsArgs('directory-session')).toBe(false);
    expect(runtimeSupportsArgs('inline-vm')).toBe(false);
    expect(runtimeSupportsArgs('script-host')).toBe(false);
  });

  it('answers no for a mode it has never heard of', () => {
    expect(runtimeSupportsArgs(undefined)).toBe(false);
    expect(runtimeSupportsArgs('')).toBe(false);
    expect(runtimeSupportsArgs('telepathy')).toBe(false);
  });
});

describe('scaffold · run configurations', () => {
  it('saves, updates and deletes a configuration on disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'nl-rc-'));
    const store = new RunConfigStore(home);
    const saved = store.save({ name: 'dev', language: 'python', args: '--port 8080' });
    expect(saved.id).toMatch(/^rc-/);
    expect(store.list()).toHaveLength(1);

    store.save({ id: saved.id, name: 'dev2', language: 'python', args: '' });
    expect(store.list()[0].name).toBe('dev2');
    expect(store.list()).toHaveLength(1);

    expect(store.remove(saved.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses a configuration without a name or language', () => {
    const home = mkdtempSync(join(tmpdir(), 'nl-rc2-'));
    const store = new RunConfigStore(home);
    expect(() => store.save({ language: 'python' })).toThrow(/名字/);
    expect(() => store.save({ name: 'x' })).toThrow(/语言/);
    rmSync(home, { recursive: true, force: true });
  });

  it('splits arguments on whitespace but respects quotes', () => {
    expect(splitArgs('--port 8080')).toEqual(['--port', '8080']);
    expect(splitArgs('--msg "two words" --x')).toEqual(['--msg', 'two words', '--x']);
    expect(splitArgs("  a   b  ")).toEqual(['a', 'b']);
    expect(splitArgs('')).toEqual([]);
  });

  it('parses KEY=VALUE lines and ignores comments and junk', () => {
    const env = parseEnv('# comment\nA=1\nBAD KEY=2\nB = two words \n\n');
    expect(env).toEqual({ A: '1', B: 'two words' });
  });

  it('saves a project-mode configuration with a classpath and entry class', () => {
    const home = mkdtempSync(join(tmpdir(), 'nl-rc-project-'));
    const store = new RunConfigStore(home);
    const saved = store.save({
      name: 'NeroSama app', language: 'java', mode: 'project', args: '',
      classpath: 'D:\\repo\\app\\build\\classes;D:\\repo\\lib\\*',
      mainClass: 'com.nero.vtuber.app.Application',
    });
    expect(saved.mode).toBe('project');
    expect(saved.classpath).toContain('lib\\*');
    expect(store.list()[0].mainClass).toBe('com.nero.vtuber.app.Application');
    expect(() => store.save({ ...saved, mode: 'project', classpath: 'a"b' })).toThrow(/forbidden/);
    expect(() => store.save({ ...saved, mode: 'project', mainClass: 'x; calc.exe' })).toThrow(/dotted/);
    rmSync(home, { recursive: true, force: true });
  });

  it('validates classpath and main class as data, not shell text', () => {
    expect(classpathProblem('C:\\repo\\classes;C:\\repo\\lib\\*')).toBeUndefined();
    expect(classpathProblem('a"b')).toMatch(/forbidden/);
    expect(classpathProblem('a{b}')).toMatch(/forbidden/);
    expect(classpathProblem('')).toMatch(/required/);
    expect(mainClassProblem('com.nero.vtuber.app.Application')).toBeUndefined();
    expect(mainClassProblem('x; calc.exe')).toMatch(/dotted/);
  });

  it('decodes GBK child output, UTF-8, and a split multi-byte character', () => {
    const gbk = Buffer.from([0xb4, 0xed, 0xce, 0xf3, 0x3a]); // 错误:
    expect(decodeOutput(gbk)).toBe('错误:');
    expect(decodeOutput(Buffer.from('你好', 'utf8'))).toBe('你好');

    const utf8 = Buffer.from('你', 'utf8');
    const decoder = new OutputDecoder();
    expect(decoder.push(utf8.subarray(0, 2))).toBe('');
    expect(decoder.push(utf8.subarray(2))).toBe('你');
    expect(decoder.flush()).toBe('');
  });

  it('does not let a failed handshake write escape to process level', () => {
    const writes: string[] = [];
    let destroyed = false;
    const socket = {
      destroyed: false,
      write(data: string) { writes.push(data); throw new Error('EPIPE: broken pipe, write'); },
      destroy() { destroyed = true; },
    } as unknown as import('node:stream').Duplex;
    expect(writeHandshake(socket, 'HTTP/1.1 101\r\n\r\n')).toBe(false);
    expect(writes).toHaveLength(1);
    expect(destroyed).toBe(true);
  });

  it('treats a corrupt file as empty instead of failing to start', () => {
    const home = mkdtempSync(join(tmpdir(), 'nl-rc3-'));
    writeFileSync(join(home, 'run-configs.json'), '{not json');
    expect(new RunConfigStore(home).list()).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('scaffold · adding a dependency', () => {
  const dirs: Array<[string, string, string[]]> = [
    ['Cargo.toml', 'cargo', ['add', 'serde@1']],
    ['go.mod', 'go', ['get', 'github.com/x/y@v1']],
    ['pyproject.toml', 'uv', ['add', 'httpx']],
    ['package.json', 'npm', ['install', 'lodash']],
  ];

  for (const [marker, ecosystem, args] of dirs) {
    it(`plans ${ecosystem} for a directory with ${marker}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'nl-dep-'));
      writeFileSync(join(dir, marker), 'x');
      const plan = planAdd(dir, args[args.length - 1]);
      expect(plan.ecosystem).toBe(ecosystem);
      expect(plan.args).toEqual(args);
      expect(plan.cwd).toBe(dir);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it('probes the ecosystem without a package name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-dep-probe-'));
    writeFileSync(join(dir, 'Cargo.toml'), 'x');
    expect(planAdd(dir, '', { probe: true }).label).toBe('cargo add');
    expect(() => planAdd(dir, '')).toThrow(/请填写/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a spec that could look like a second argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-dep-bad-'));
    writeFileSync(join(dir, 'package.json'), '{}');
    expect(() => planAdd(dir, 'lodash && rm -rf /')).toThrow(/字符/);
    expect(() => planAdd(dir, '--save-dev')).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a directory with no project marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-dep-none-'));
    expect(() => planAdd(dir, 'lodash')).toThrow(/没有识别到项目/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('edits a Gradle dependencies block instead of inventing a gradle add command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-dep-gradle-'));
    writeFileSync(join(dir, 'build.gradle'), "plugins { id 'java' }\n\ndependencies {\n    implementation 'org.example:base:1.0'\n}\n");
    const plan = planAdd(dir, 'com.fasterxml.jackson.core:jackson-databind:2.17.2');
    expect(plan.ecosystem).toBe('gradle');
    expect(plan.command).toBe('');
    expect(plan.declared?.declaration).toBe("implementation 'com.fasterxml.jackson.core:jackson-databind:2.17.2'");
    expect(applyAdd(plan).ok).toBe(true);
    const after = readFileSync(join(dir, 'build.gradle'), 'utf8');
    expect(after).toContain("implementation 'com.fasterxml.jackson.core:jackson-databind:2.17.2'");
    expect(after).toContain("implementation 'org.example:base:1.0'");
    // A second add is a no-op error, never a duplicate declaration.
    expect(applyAdd(plan).ok).toBe(false);
    expect(readFileSync(join(dir, 'build.gradle'), 'utf8')).toBe(after);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a Gradle dependencies block when the build file has none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-dep-gradle2-'));
    writeFileSync(join(dir, 'build.gradle.kts'), 'plugins { java }\n');
    const plan = planAdd(dir, 'org.slf4j:slf4j-api:2.0.13');
    expect(plan.declared?.file).toBe('build.gradle.kts');
    expect(plan.declared?.declaration).toBe('implementation("org.slf4j:slf4j-api:2.0.13")');
    expect(applyAdd(plan).ok).toBe(true);
    const after = readFileSync(join(dir, 'build.gradle.kts'), 'utf8');
    expect(after).toContain('dependencies {');
    expect(after).toContain('implementation("org.slf4j:slf4j-api:2.0.13")');
    rmSync(dir, { recursive: true, force: true });
  });

  it('edits the included module of a Gradle multi-project, not the aggregator root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-dep-gradle3-'));
    mkdirSync(join(dir, 'service/api'), { recursive: true });
    writeFileSync(join(dir, 'settings.gradle'), "rootProject.name = 'demo'\ninclude 'service:api'\n");
    writeFileSync(join(dir, 'build.gradle'), "plugins { id 'java' apply false }\n");
    writeFileSync(join(dir, 'service/api/build.gradle'), "plugins { id 'java' }\n\ndependencies {\n}\n");
    const plan = planAdd(dir, 'org.example:core:1.0');
    expect(plan.declared?.file).toBe('service/api/build.gradle');
    expect(applyAdd(plan).ok).toBe(true);
    expect(readFileSync(join(dir, 'service/api/build.gradle'), 'utf8')).toContain("implementation 'org.example:core:1.0'");
    expect(readFileSync(join(dir, 'build.gradle'), 'utf8')).not.toContain('dependencies');
    rmSync(dir, { recursive: true, force: true });
  });

  it('edits pom.xml and rejects a coordinate that is not Maven-shaped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-dep-maven-'));
    writeFileSync(join(dir, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>\n');
    expect(() => planAdd(dir, 'lodash && rm -rf /')).toThrow(/坐标/);
    const plan = planAdd(dir, 'org.example:core:1.2.3');
    expect(plan.ecosystem).toBe('maven');
    expect(applyAdd(plan).ok).toBe(true);
    const after = readFileSync(join(dir, 'pom.xml'), 'utf8');
    expect(after).toContain('<groupId>org.example</groupId>');
    expect(after).toContain('<version>1.2.3</version>');
    expect(after.indexOf('<dependencies>')).toBeLessThan(after.indexOf('</project>'));
    expect(applyAdd(plan).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('scaffold · fetching declared packages', () => {
  const cases: Array<[string, string, string[]]> = [
    ['build.gradle', 'gradle', ['--no-daemon', 'classes']],
    ['pom.xml', 'maven', ['-B', '-q', 'dependency:resolve']],
    ['Cargo.toml', 'cargo', ['fetch']],
    ['go.mod', 'go', ['mod', 'download']],
    ['pyproject.toml', 'uv', ['sync']],
    ['package.json', 'npm', ['install']],
  ];
  for (const [marker, ecosystem, args] of cases) {
    it(`plans a sync for ${marker}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'nl-sync-'));
      writeFileSync(join(dir, marker), 'x');
      const plan = planSync(dir);
      expect(plan.ecosystem).toBe(ecosystem);
      expect(plan.args).toEqual(args);
      expect(plan.cwd).toBe(dir);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it('uses the Gradle wrapper when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-sync-gradle-wrapper-'));
    writeFileSync(join(dir, 'build.gradle'), '');
    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    writeFileSync(join(dir, wrapper), '');
    const plan = planSync(dir);
    expect(plan.command).toBe(join(dir, wrapper));
    expect(plan.args).toEqual(['--no-daemon', 'classes']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers pnpm or Yarn lockfiles to npm', () => {
    const pnpm = mkdtempSync(join(tmpdir(), 'nl-sync-pnpm-'));
    writeFileSync(join(pnpm, 'package.json'), '{}');
    writeFileSync(join(pnpm, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    expect(planSync(pnpm)).toMatchObject({ ecosystem: 'pnpm', args: ['install', '--frozen-lockfile'] });
    rmSync(pnpm, { recursive: true, force: true });

    const yarn = mkdtempSync(join(tmpdir(), 'nl-sync-yarn-'));
    writeFileSync(join(yarn, 'package.json'), '{}');
    writeFileSync(join(yarn, 'yarn.lock'), '');
    expect(planSync(yarn)).toMatchObject({ ecosystem: 'yarn', args: ['install', '--frozen-lockfile'] });
    rmSync(yarn, { recursive: true, force: true });
  });

  it('uses npm ci when a lockfile is committed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-sync-lock-'));
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    expect(planSync(dir).args).toEqual(['ci']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('scaffold · detecting existing projects', () => {
  it('finds the root and one level of children, and skips build dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'nl-detect-'));
    writeFileSync(join(root, 'package.json'), '{"name":"root-app"}');
    mkdirSync(join(root, 'svc'), { recursive: true });
    writeFileSync(join(root, 'svc/Cargo.toml'), '[package]\nname = "svc"\n');
    mkdirSync(join(root, 'java-service/app'), { recursive: true });
    writeFileSync(join(root, 'java-service/settings.gradle'), "rootProject.name = 'java-service'\ninclude 'app'\n");
    writeFileSync(join(root, 'java-service/app/build.gradle'), "plugins { id 'java' }\n");
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, 'node_modules/x'), { recursive: true });
    writeFileSync(join(root, 'node_modules/x/package.json'), '{"name":"dep"}');

    const found = detectProjects(root);
    expect(found.map((c) => `${c.language}:${c.name}`)).toEqual(['javascript:root-app', 'java:java-service', 'rust:svc']);
    expect(found[2].marker).toBe('Cargo.toml');
    expect(found[1].marker).toBe('settings.gradle');
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to the directory name when the marker has no name', () => {
    const root = mkdtempSync(join(tmpdir(), 'nl-detect2-'));
    writeFileSync(join(root, 'go.mod'), 'module example.com/x\n');
    const [first] = detectProjects(root);
    expect(first.language).toBe('go');
    expect(first.name).toBe('example.com/x');
    rmSync(root, { recursive: true, force: true });
  });

  it('reports nothing for a directory without markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'nl-detect3-'));
    expect(detectProjects(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('desktop · is the running window usable', () => {
  it('a handle with no connected page is not usable', () => {
    // The bug this exists for: an Edge tree whose page never loaded shows a blank
    // frame, every later launch says "already running", and the installer cannot
    // replace the exe — the user has no way out except Task Manager.
    expect(windowUsable(true, 0)).toBe(false);
  });

  it('a handle with a connected page is usable', () => {
    expect(windowUsable(true, 1)).toBe(true);
    expect(windowUsable(true, 3)).toBe(true);
  });

  it('no handle is never usable, whatever the server says', () => {
    expect(windowUsable(false, 2)).toBe(false);
  });

  it('an old server that does not report clients is trusted', () => {
    // Otherwise every launch against a pre-clients build would take the port over.
    expect(windowUsable(true, undefined)).toBe(true);
  });
});

describe('perf · usage log', () => {
  const home = mkdtempSync(join(tmpdir(), 'nl-usage-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('writes one JSON line per event, with a session and a schema version', () => {
    const log = new UsageLog({ home, appVersion: '9.9.9', sessionId: 'sid-1' });
    log.record('request', { language: 'python', method: 'completion', ms: 3 });
    log.close();
    const rows = readFileSync(log.path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; sid: string; v: string; appVersion?: string });
    expect(rows.map((r) => r.event)).toEqual(['session.start', 'request', 'session.end']);
    expect(rows.every((r) => r.sid === 'sid-1' && r.v === '1')).toBe(true);
    expect(rows[0].appVersion).toBe('9.9.9');
  });

  it('rotates instead of growing without bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-usage-rot-'));
    const log = new UsageLog({ home: dir, appVersion: '1', sessionId: 's', maxBytes: 400, keep: 2 });
    // Flush explicitly: rotation is checked when a batch is written, and the
    // buffer only spills on its own at 64 KiB.
    for (let i = 0; i < 40; i++) {
      log.record('request', { language: 'go', method: 'completion', ms: i, pad: 'x'.repeat(40) });
      log.flush();
    }
    log.close();
    expect(existsSync(join(dir, 'logs', 'usage.1.jsonl'))).toBe(true);
    // The current file is still readable, and every line in every file parses.
    const files = readdirSync(join(dir, 'logs')).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      for (const line of readFileSync(join(dir, 'logs', f), 'utf8').trim().split('\n')) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('never takes the app down when the log cannot be written', () => {
    // A home that is a file, not a directory: mkdir fails, recording must not.
    const file = join(home, 'not-a-dir');
    writeFileSync(file, 'x');
    const log = new UsageLog({ home: file, appVersion: '1', sessionId: 's' });
    expect(() => log.record('request', { ms: 1 })).not.toThrow();
    expect(() => log.close()).not.toThrow();
  });
});

describe('lsp · idle TTL statistics', () => {
  it('says nothing rather than guessing when there is no data', () => {
    const s = summarizeIdle([]);
    expect(s.count).toBe(0);
    expect(s.medianMs).toBe(0);
    expect(judgeTtl(s, 60_000)).toBe('no-data');
  });

  it('reports nearest-rank percentiles, so every answer is a real sample', () => {
    const s = summarizeIdle([300, 100, 200]);
    expect(s.count).toBe(3);
    expect(s.medianMs).toBe(200);
    expect(s.p90Ms).toBe(300);
    expect(s.maxMs).toBe(300);
  });

  it('counts the share that came back inside a window', () => {
    const s = summarizeIdle([10, 20, 30, 1000]);
    expect(s.shareWithin(30)).toBeCloseTo(0.75);
    expect(s.shareWithin(5)).toBe(0);
  });

  it('ignores values that are not measurements', () => {
    const s = summarizeIdle([Number.NaN, -1, 50, Number.POSITIVE_INFINITY]);
    expect(s.count).toBe(1);
    expect(s.medianMs).toBe(50);
  });

  it('calls a TTL generous only when most reuses land well inside it', () => {
    const ttl = 60_000;
    expect(judgeTtl(summarizeIdle([1_000, 2_000, 3_000, 4_000, 5_000]), ttl)).toBe('ttl-is-generous');
    // Every reuse arrives at 55 s: the server was still there, but barely.
    expect(judgeTtl(summarizeIdle([55_000, 56_000, 57_000]), ttl)).toBe('ttl-is-tight');
  });
});

describe('langs · toolchain version cache', () => {
  const home = mkdtempSync(join(tmpdir(), 'nl-ver-'));
  const bin = join(home, 'python.exe');
  writeFileSync(bin, 'x');

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('probes once and answers from the cache afterwards', async () => {
    let probes = 0;
    const probe = async (): Promise<string> => {
      probes++;
      return 'Python 3.13.14';
    };
    const first = await cachedVersion({ home, id: 'python', bin, args: ['--version'], probe });
    const second = await cachedVersion({ home, id: 'python', bin, args: ['--version'], probe });
    expect(first).toBe('Python 3.13.14');
    expect(second).toBe('Python 3.13.14');
    expect(probes).toBe(1);
    // Written where a later launch will find it.
    expect(existsSync(versionCachePath(home))).toBe(true);
    expect(JSON.parse(readFileSync(versionCachePath(home), 'utf8')).entries.python.version).toBe('Python 3.13.14');
  });

  it('re-probes when the binary changed, and only then', async () => {
    let probes = 0;
    const probe = async (): Promise<string> => {
      probes++;
      return `build ${probes}`;
    };
    await cachedVersion({ home, id: 'go', bin, args: ['version'], probe });
    expect(probes).toBe(1);
    // Same file, different content: an upgrade. The signature has to notice.
    writeFileSync(bin, 'xx');
    const after = await cachedVersion({ home, id: 'go', bin, args: ['version'], probe });
    expect(probes).toBe(2);
    expect(after).toBe('build 2');
  });

  it('treats a different argument list as a different question', async () => {
    let probes = 0;
    const probe = async (_bin: string, args: string[]): Promise<string> => {
      probes++;
      return args.join(' ');
    };
    await cachedVersion({ home, id: 'rust', bin, args: ['--version'], probe });
    await cachedVersion({ home, id: 'rust', bin, args: ['-V'], probe });
    expect(probes).toBe(2);
  });

  it('does not cache a failed probe', async () => {
    // A binary that cannot answer today might answer after the user fixes their
    // PATH; remembering "broken" would hide the fix they just made.
    let probes = 0;
    const probe = async (): Promise<string | null> => {
      probes++;
      return probes === 1 ? null : 'fixed';
    };
    expect(await cachedVersion({ home, id: 'broken', bin, args: [], probe })).toBeNull();
    expect(await cachedVersion({ home, id: 'broken', bin, args: [], probe })).toBe('fixed');
    expect(probes).toBe(2);
  });

  it('marks a missing binary as missing, which never matches', () => {
    expect(toolchainSignature(join(home, 'nope.exe'))).toBe('missing');
    expect(toolchainSignature(bin)).not.toBe('missing');
  });

  it('ignores a corrupt cache file instead of failing the launch', async () => {
    const other = mkdtempSync(join(tmpdir(), 'nl-ver-bad-'));
    const otherBin = join(other, 'node.exe');
    writeFileSync(otherBin, 'x');
    mkdirSync(join(other, 'cache'), { recursive: true });
    writeFileSync(versionCachePath(other), '{ not json');
    const version = await cachedVersion({ home: other, id: 'node', bin: otherBin, args: ['-v'], probe: async () => 'v22' });
    expect(version).toBe('v22');
    rmSync(other, { recursive: true, force: true });
  });
});

describe('lsp manager · launch templates', () => {
  const manifest = (command: string[]) =>
    ({
      id: 'demo',
      file: { extensions: ['demo'] },
      lsp: { manager: true, discovery: { knownPaths: [process.execPath] }, command },
    }) as never;

  it('gives each project root its own data dir', async () => {
    // jdtls keeps an Eclipse workspace under `-data`. Sharing one across roots
    // means the second instance handshakes and then never imports anything, so
    // every request comes back empty - a silent failure, not an error.
    const plugin = await buildManagerPlugin(manifest(['{resolved}', '-data', '{dataDir}/{rootHash}']), {
      home: join(tmpdir(), 'nl-tpl'),
    });
    const rootA = join(tmpdir(), 'root-a');
    const rootB = join(tmpdir(), 'root-b');
    const a = plugin!.lspConfig(rootA)!.args[1];
    const b = plugin!.lspConfig(rootB)!.args[1];
    expect(a).not.toBe(b);
    // Same root twice must reuse its state, or every reopen re-imports.
    expect(plugin!.lspConfig(rootA)!.args[1]).toBe(a);
    expect(a.startsWith(join(tmpdir(), 'nl-tpl', 'lsp-data', 'demo'))).toBe(true);
  });

  it('refuses to launch when a template placeholder cannot be resolved', async () => {
    const plugin = await buildManagerPlugin(manifest(['{glob:' + join(tmpdir(), 'nope', '*.jar') + '}']), {
      home: join(tmpdir(), 'nl-tpl'),
    });
    expect(plugin!.lspConfig(join(tmpdir(), 'root-a'))).toBeUndefined();
  });
});

describe('lsp manager · routing, signature, invalidation, scheduling', () => {
  const plugin = (id: string, priority = 0): LanguagePlugin => ({
    id,
    matches: (file: string) => file.endsWith(`.${id}`),
    projectRoot: () => undefined,
    lspConfig: () => undefined,
    versionSignature: () => `sig-${id}`,
    fallback: () => undefined,
    incremental: () => undefined,
    serverPriority: () => priority,
    idleTtlMs: () => 0,
  });

  it('routes a file to the plugin that claims it, and nothing otherwise', () => {
    const registry = new PluginRegistry();
    registry.register(plugin('aaa'));
    registry.register(plugin('bbb'));
    expect(registry.route('/p/x.aaa')?.id).toBe('aaa');
    expect(registry.route('/p/x.bbb')?.id).toBe('bbb');
    expect(registry.route('/p/x.ccc')).toBeUndefined();
  });

  it('breaks a tie by priority, then by id, so routing is deterministic', () => {
    const registry = new PluginRegistry();
    registry.register(plugin('zzz'));
    registry.register(plugin('yyy', 5));
    // Both match `.zzz`/`.yyy`? No: `matches` is per-extension, so give both
    // the same extension through a shared matcher.
    const shared = (id: string, priority: number): LanguagePlugin => ({ ...plugin(id, priority), matches: () => true });
    const tie = new PluginRegistry();
    tie.register(shared('zzz', 0));
    tie.register(shared('aaa', 0));
    expect(tie.route('/p/x.h')?.id).toBe('aaa');
    const ranked = new PluginRegistry();
    ranked.register(shared('zzz', 1));
    ranked.register(shared('aaa', 0));
    expect(ranked.route('/p/x.h')?.id).toBe('zzz');
  });

  it('refuses a duplicate plugin id instead of silently replacing it', () => {
    const registry = new PluginRegistry();
    registry.register(plugin('dup'));
    expect(() => registry.register(plugin('dup'))).toThrow(/already registered/);
  });

  it('treats a root as inside itself, and not the other way round', () => {
    const parent = join(tmpdir(), 'nl-root', 'reactor');
    const child = join(parent, 'module-a');
    expect(LspManager.containsRoot(parent, child)).toBe(true);
    expect(LspManager.containsRoot(parent, parent)).toBe(true);
    expect(LspManager.containsRoot(child, parent)).toBe(false);
    // A sibling whose name merely starts with the same characters is not inside.
    expect(LspManager.containsRoot(parent, `${parent}-other`)).toBe(false);
  });

  it('derives a signature that changes with the server version', () => {
    const a = versionSignature({ pluginId: 'p', serverName: 's', serverVersion: '1.0.0' });
    const b = versionSignature({ pluginId: 'p', serverName: 's', serverVersion: '1.0.1' });
    expect(a).toBe(versionSignature({ pluginId: 'p', serverName: 's', serverVersion: '1.0.0' }));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('invalidates a cached index whose signature does not match', () => {
    const validator = new CacheValidator(join(tmpdir(), 'nl-cache-test'));
    const meta: IndexMetadata = { signature: 'old', indexedCommit: null, indexedAt: new Date().toISOString() };
    const verdict = validator.validate(plugin('p'), meta);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/signature changed/);
    expect(validator.validate(plugin('p'), { ...meta, signature: 'sig-p' }).valid).toBe(true);
    expect(validator.validate(plugin('p'), undefined).valid).toBe(false);
  });

  it('calls a change large only when it exceeds the threshold', () => {
    const git = new GitDiffStrategy();
    const dirty: DirtyReport = { files: ['a', 'b', 'c'], source: 'git' };
    expect(git.isLargeChange(dirty, 2)).toBe(true);
    expect(git.isLargeChange(dirty, 3)).toBe(false);
    expect(new ContentHashStrategy().isLargeChange({ files: [], source: 'none' }, 0)).toBe(false);
  });

  it('dedupes diagnostics and caps them per file and overall', () => {
    const buffer = new DiagnosticsBuffer(3, 2);
    const d = (line: number): Diagnostic => ({
      range: { start: { line, character: 0 }, end: { line, character: 1 } },
      message: `m${line}`,
    });
    buffer.set('file:///a', [d(0), d(0), d(1)]);
    expect(buffer.get('file:///a')).toHaveLength(2);
    buffer.set('file:///b', [d(0), d(1)]);
    buffer.set('file:///c', [d(0)]);
    // 2 + 2 + 1 exceeds the global cap of 3, so the last file is dropped whole.
    expect(buffer.all()).toHaveLength(1);
    expect(buffer.stats().files).toBe(3);
  });

  it('finds an unterminated literal and an unbalanced brace, ignoring strings', () => {
    expect(scanText('class A { String s = "}"; }\n').depth).toBe(0);
    expect(scanText('class A {\n').depth).toBe(1);
    expect(scanText('class A { String s = "oops;\n').unterminated?.what).toBe('string');
    // A line comment must not open a string.
    expect(scanText('// "unclosed\nclass A {}\n').unterminated).toBeUndefined();
  });

  it('offers the declarations in the buffer, filtered by prefix', () => {
    const fallback = new LexicalFallback({
      keywords: ['class', 'void'],
      declarationPattern: 'class\\s+([A-Za-z_$][\\w$]*)',
    });
    const text = 'public class Demo {\n    void run() {}\n}\n';
    const all = fallback.completions({ file: 'Demo.java', text, line: 0, character: 0 });
    expect(all.map((c) => c.label)).toContain('Demo');
    // The whole buffer, with the caret on the half-typed line: the declaration
    // only exists in the document, so a one-line snippet could not offer it.
    const filtered = fallback.completions({
      file: 'Demo.java',
      text: 'public class Demo {\n}\n        Dem\n',
      line: 2,
      character: 11,
    });
    // Both the declaration and the half-typed identifier match the prefix; what
    // matters is that nothing else leaks through.
    expect(filtered.map((c) => c.label)).toContain('Demo');
    expect(filtered.every((c) => c.label.toLowerCase().startsWith('dem'))).toBe(true);
  });

  it('marks a superseded result stale and never returns it as fresh', async () => {
    const scheduler = new Scheduler();
    const first = scheduler.latest('k', async () => {
      await new Promise((ok) => setTimeout(ok, 60));
      return 'old';
    });
    await new Promise((ok) => setTimeout(ok, 5));
    const second = scheduler.latest('k', async () => 'new');
    const [a, b] = await Promise.all([first, second]);
    expect(a.stale).toBe(true);
    expect(b.stale).toBe(false);
    expect(b.value).toBe('new');
    expect(scheduler.stats().staleDropped).toBe(1);
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
      envSearchUp: 0,
      envSearchDown: 0,
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
      envSearchUp: 0,
      envSearchDown: 0,
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
      envSearchUp: 0,
      envSearchDown: 0,
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
      envSearchUp: 0,
      envSearchDown: 0,
      spec: { envDirs: ['.kvenv'], envBins: ['bin/kotlinc'] },
    });
    expect(found).toEqual([]);
  });

  it('keeps the table working for plugins that declare nothing', async () => {
    mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
    writeFileSync(join(dir, '.venv', 'pyvenv.cfg'), 'x\n');
    writeFileSync(join(dir, '.venv', 'Scripts', 'python.exe'), 'MZ');
    const found = await discoverInterpreters(dir, 'python', {
      pathEnv: '', probe: null, home: dir, envSearchUp: 0, envSearchDown: 0,
    });
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

describe('lsp · navigation results are normalised in one place', () => {
  it('accepts every shape textDocument/definition may return', () => {
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
    // A server may answer with one Location, an array, a LocationLink, or null.
    expect(normalizeLocations({ uri: 'a.py', range })).toHaveLength(1);
    expect(normalizeLocations([{ uri: 'a.py', range }, { uri: 'b.py', range }])).toHaveLength(2);
    expect(normalizeLocations([{ targetUri: 'c.py', targetSelectionRange: range }])[0].uri).toBe('c.py');
    expect(normalizeLocations(null)).toEqual([]);
    // Garbage in must not throw: a malformed location is dropped, not fatal.
    expect(normalizeLocations([{ nope: true }])).toEqual([]);
  });

  it('flattens both workspace-edit dialects', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
    const changes = normalizeWorkspaceEdit({ changes: { 'a.py': [{ range, newText: 'x' }] } });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ uri: 'a.py', newText: 'x' });
    // documentChanges is what servers send when they support versioned edits.
    const docChanges = normalizeWorkspaceEdit({
      documentChanges: [{ textDocument: { uri: 'b.py' }, edits: [{ range, newText: 'y' }] }],
    });
    expect(docChanges).toHaveLength(1);
    expect(docChanges[0].uri).toBe('b.py');
    // A create/rename/delete operation has no edits and must be skipped.
    expect(normalizeWorkspaceEdit({ documentChanges: [{ kind: 'create', uri: 'c.py' }] })).toEqual([]);
  });

  it('keeps a command-only code action visible but inert', () => {
    const actions = normalizeCodeActions([
      { title: 'Organise imports', kind: 'source.organizeImports', edit: { changes: { 'a.py': [] } } },
      { title: 'Run a command', command: 'x.y' },
    ]);
    expect(actions.map((a) => a.title)).toEqual(['Organise imports', 'Run a command']);
    expect(actions[1].edits).toBeUndefined();
  });

  it('flattens workspace symbols to uri + line', () => {
    const symbols = normalizeSymbols([
      {
        name: 'add',
        kind: 12,
        location: { uri: 'a.py', range: { start: { line: 3, character: 4 }, end: { line: 3, character: 7 } } },
      },
    ]);
    expect(symbols).toEqual([{ name: 'add', kind: 12, uri: 'a.py', line: 3 }]);
  });

  it('treats an unadvertised capability as unsupported, not as empty', () => {
    // This is the whole point of the distinction: `false` and "absent" both mean
    // the server cannot answer, and the UI must say so instead of showing [].
    expect(declaresFeature({}, 'definition')).toBe(false);
    expect(declaresFeature({ definitionProvider: false }, 'definition')).toBe(false);
    expect(declaresFeature({ definitionProvider: true }, 'definition')).toBe(true);
    expect(declaresFeature({ definitionProvider: {} }, 'definition')).toBe(true);
    // workspace/symbol and codeAction use different keys than the rest.
    expect(declaresFeature({ workspaceSymbolProvider: true }, 'workspaceSymbol')).toBe(true);
    expect(declaresFeature({ codeActionProvider: true }, 'codeAction')).toBe(true);
  });
});

describe('assets · materialising the embedded tree survives a hostile %TEMP%', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nlg-embed-'));
    // The store is a global the packaged build installs; a test can supply one.
    (globalThis as { __NOLANGUAGE_EMBEDDED__?: Record<string, string> }).__NOLANGUAGE_EMBEDDED__ = {
      'extensions/examples/hello/extension.json': '{"id":"demo.hello"}',
      'extensions/examples/hello/extension.ts': 'export const x = 1;\n',
    };
  });
  afterEach(() => {
    delete (globalThis as { __NOLANGUAGE_EMBEDDED__?: Record<string, string> }).__NOLANGUAGE_EMBEDDED__;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the tree and returns the prefix directory', () => {
    const root = join(dir, 'primary');
    const out = materializeAssets('extensions/examples', { root });
    expect(out).toBe(join(root, 'extensions', 'examples'));
    expect(existsSync(join(root, 'extensions/examples/hello/extension.json'))).toBe(true);
  });

  it('falls back to the second root when the first cannot be written', () => {
    // A *file* where the root directory should be: mkdir fails, which is the
    // same failure a locked or read-only %TEMP% produces.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const fallback = join(dir, 'fallback');
    const out = materializeAssets('extensions/examples', { root: blocked, fallbackRoot: fallback });
    expect(out).toBe(join(fallback, 'extensions', 'examples'));
    expect(existsSync(join(fallback, 'extensions/examples/hello/extension.json'))).toBe(true);
  });

  it('does not rewrite a file that already holds the same bytes', () => {
    // The write is what EPERM's on Windows when another process holds the file;
    // an identical cache must not need one.
    const root = join(dir, 'primary');
    materializeAssets('extensions/examples', { root });
    const target = join(root, 'extensions/examples/hello/extension.json');
    const before = statSync(target).mtimeMs;
    const later = materializeAssets('extensions/examples', { root });
    expect(later).toBe(join(root, 'extensions', 'examples'));
    expect(statSync(target).mtimeMs).toBe(before);
  });

  it('returns undefined when nothing is embedded', () => {
    delete (globalThis as { __NOLANGUAGE_EMBEDDED__?: Record<string, string> }).__NOLANGUAGE_EMBEDDED__;
    expect(materializeAssets('extensions/examples', { root: join(dir, 'x') })).toBeUndefined();
  });
});

describe('desktop · what a windowless failure tells the user', () => {
  let dir = '';
  let previous: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nlg-fatal-'));
    previous = process.env.NOLANGUAGE_DATA;
    process.env.NOLANGUAGE_DATA = dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.NOLANGUAGE_DATA;
    else process.env.NOLANGUAGE_DATA = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries the message, the stack and the boot log tail', () => {
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(
      join(dir, 'logs', 'boot.log'),
      ['{"ev":"boot"}', '{"ev":"server-starting"}', '{"ev":"server-start-failed"}'].join('\n'),
      'utf8',
    );
    const err = new Error('EPERM: operation not permitted, open X');
    err.stack = 'Error: EPERM\n    at writeFileSync\n    at materialize';
    const { text } = describeFailure(err, '0.7.23');
    expect(text).toContain('could not start');
    expect(text).toContain('EPERM');
    expect(text).toContain('at writeFileSync');
    // The tail is what explains the failure; the head of a log is a week old.
    expect(text).toContain('server-start-failed');
    expect(text).toContain('logs/boot.log');
  });

  it('keeps an untruncated copy on disk even when the dialog text is capped', () => {
    const err = new Error('x'.repeat(4000));
    const { text, file } = describeFailure(err, '0.7.23');
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain('truncated');
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk.length).toBeGreaterThan(4000);
    expect(file.endsWith('last-error.txt')).toBe(true);
  });

  it('never throws when the log directory cannot be written', () => {
    // The app data dir is frequently the thing that just failed.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');
    process.env.NOLANGUAGE_DATA = blocked;
    expect(() => describeFailure(new Error('boom'), '0.7.23')).not.toThrow();
  });
});

// ---------------------------------------------------------------- dependencies
// The Packages view is only as honest as its parser. These cover the three
// formats, the "not declared" hint, and the one thing that must never happen:
// a package name that an installer would read as a flag.

describe('project dependencies', () => {
  it('reads a requirements file: comments, extras, pins, -r skipped', () => {
    const text = [
      '# runtime',
      'requests==2.31.0',
      'numpy>=1.26',
      'uvicorn[standard]',
      '',
      '-r other.txt',
      '  # indented comment',
      'Flask',
    ].join('\n');
    expect(parseDependencies('requirements', text)).toEqual([
      { name: 'requests', version: '==2.31.0' },
      { name: 'numpy', version: '>=1.26' },
      { name: 'uvicorn' },
      { name: 'Flask' },
    ]);
  });

  it('reads both go.mod require forms', () => {
    const text = [
      'module example.com/app',
      '',
      'go 1.22',
      '',
      'require github.com/gin-gonic/gin v1.9.1',
      '',
      'require (',
      '\tgithub.com/spf13/cobra v1.8.0',
      '\tgolang.org/x/text v0.14.0 // indirect',
      ')',
    ].join('\n');
    expect(parseDependencies('gomod', text)).toEqual([
      { name: 'github.com/gin-gonic/gin', version: 'v1.9.1' },
      { name: 'github.com/spf13/cobra', version: 'v1.8.0' },
      { name: 'golang.org/x/text', version: 'v0.14.0' },
    ]);
  });

  it('reads Cargo.toml simple and inline-table dependency declarations', () => {
    const text = [
      '[package]',
      'name = "demo"',
      '',
      '[dependencies]',
      'serde = "1.0"',
      'tokio = { version = "1.40", features = ["macros"] }',
      '',
      '[dev-dependencies]',
      'pretty_assertions = "1"',
      '',
      '[build-dependencies]',
      'cc = "1"',
    ].join('\n');
    expect(parseDependencies('cargo', text)).toEqual([
      { name: 'serde', version: '1.0' },
      { name: 'tokio', version: '1.40' },
      { name: 'pretty_assertions', version: '1' },
    ]);
  });

  it('reads Gradle dependency coordinates from a build file', () => {
    const text = [
      'plugins { id "java" }',
      'dependencies {',
      "    implementation 'org.springframework.boot:spring-boot-starter-web:3.3.5'",
      '    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")',
      "    implementation platform('com.example:bom:1.0')",
      "    implementation 'org.springframework.boot:spring-boot-starter-web:3.3.5'",
      '}',
    ].join('\n');
    expect(parseDependencies('gradle', text)).toEqual([
      { name: 'org.springframework.boot:spring-boot-starter-web', version: '3.3.5' },
      { name: 'org.junit.jupiter:junit-jupiter', version: '5.10.2' },
      { name: 'com.example:bom', version: '1.0' },
    ]);
  });

  it('reads pom.xml dependency blocks, including BOM-managed ones without a version', () => {
    const text = [
      '<project>',
      '  <dependencies>',
      '    <dependency><groupId>org.example</groupId><artifactId>core</artifactId><version>1.2.3</version></dependency>',
      '    <dependency>',
      '      <groupId>com.fasterxml.jackson.core</groupId>',
      '      <artifactId>jackson-databind</artifactId>',
      '    </dependency>',
      '  </dependencies>',
      '</project>',
    ].join('\n');
    expect(parseDependencies('maven', text)).toEqual([
      { name: 'org.example:core', version: '1.2.3' },
      { name: 'com.fasterxml.jackson.core:jackson-databind' },
    ]);
  });

  it('reads Maven dependency XML blocks and ignores dependencyManagement', () => {
    const text = [
      '<project>',
      '  <dependencyManagement><dependencies>',
      '    <dependency><groupId>org.example</groupId><artifactId>bom</artifactId><version>1</version></dependency>',
      '  </dependencies></dependencyManagement>',
      '  <dependencies>',
      '    <dependency><groupId>org.example</groupId><artifactId>core</artifactId><version>1.2.3</version></dependency>',
      '    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId></dependency>',
      '  </dependencies>',
      '</project>',
    ].join('\n');
    expect(parseDependencies('maven', text)).toEqual([
      { name: 'org.example:core', version: '1.2.3' },
      { name: 'com.fasterxml.jackson.core:jackson-databind' },
    ]);
  });

  it('reads package.json dependencies and devDependencies', () => {
    const text = JSON.stringify({ dependencies: { react: '^18.0.0' }, devDependencies: { vitest: '^2' } });
    expect(parseDependencies('npm', text)).toEqual([
      { name: 'react', version: '^18.0.0' },
      { name: 'vitest', version: '^2' },
    ]);
  });

  it('treats a broken package.json as empty rather than throwing', () => {
    expect(parseDependencies('npm', '{ not json')).toEqual([]);
  });

  it('reads pyproject.toml: only [project].dependencies, never [build-system]', () => {
    // Read as a requirements list this file yields `name = "demo"` and
    // `version = "1.0.0"` as "packages" and misses the two real ones — which is
    // exactly what the Python plugin used to declare.
    const text = [
      '[build-system]',
      'requires = ["setuptools>=61"]',
      'build-backend = "setuptools.build_meta"',
      '',
      '[project]',
      'name = "demo"',
      'version = "1.0.0"',
      'dependencies = [',
      '  "requests>=2.31",',
      '  "flask",  # web',
      ']',
      '',
      '[project.optional-dependencies]',
      'test = ["pytest"]',
    ].join('\n');
    expect(parseDependencies('pyproject', text)).toEqual([
      { name: 'requests', version: '>=2.31' },
      { name: 'flask' },
    ]);
  });

  it('reads a single-line pyproject dependencies array', () => {
    const text = '[project]\ndependencies = ["a>=1", "b"]\n';
    expect(parseDependencies('pyproject', text)).toEqual([
      { name: 'a', version: '>=1' },
      { name: 'b' },
    ]);
  });

  it('reads no packages out of a pyproject with no [project] table', () => {
    expect(parseDependencies('pyproject', '[tool.black]\nline-length = 100\n')).toEqual([]);
  });

  it('flags an import no declared package covers, and only once', () => {
    const code = 'import requests\nimport requests.adapters\nfrom flask import Flask\nimport json\n';
    // Grouped by pattern, not by source order: `import` forms first, then `from`.
    expect(undeclaredImports(code, [{ name: 'requests' }])).toEqual(['json', 'flask']);
  });

  it('matches a declared name case- and dash-insensitively', () => {
    // pip normalises My-Module to my_module; the import says my_module.
    expect(undeclaredImports('import my_module\n', [{ name: 'My-Module' }])).toEqual([]);
    expect(undeclaredImports('import My_Module\n', [{ name: 'my-module' }])).toEqual([]);
  });

  it('refuses a package name an installer would read as a flag', () => {
    expect(packageNameProblem('-r')).toContain('cannot start with');
    expect(packageNameProblem('--index-url')).toContain('cannot start with');
    expect(packageNameProblem('two words')).toContain('misread');
    expect(packageNameProblem('a;b')).toContain('misread');
    expect(packageNameProblem('')).toContain('required');
  });

  it('accepts the shapes a real installer takes', () => {
    for (const ok of ['requests', 'requests==2.31.0', 'requests>=2', '@scope/pkg', 'github.com/x/y@v1']) {
      expect(packageNameProblem(ok)).toBeUndefined();
    }
  });

  it('honours a per-file format: requirements.txt and pyproject.toml disagree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-deps-'));
    try {
      // Only a pyproject.toml: the manifest's default format is `requirements`,
      // so reading it that way would produce five fake packages.
      writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "demo"\ndependencies = ["requests>=2.31"]\n');
      const report = await readDependencies('python', {
        format: 'requirements',
        files: ['requirements.txt', { file: 'pyproject.toml', format: 'pyproject' }],
      }, dir, 'import requests\nimport flask\n');
      expect(report.file).toBe('pyproject.toml');
      expect(report.format).toBe('pyproject');
      expect(report.packages).toEqual([{ name: 'requests', version: '>=2.31' }]);
      expect(report.undeclared).toEqual(['flask']);
      // The empty state must name every candidate, not just the strings.
      expect(report.searched).toEqual(['requirements.txt', 'pyproject.toml']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the file the manifest names, from the project root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-deps-'));
    try {
      writeFileSync(join(dir, 'requirements.txt'), 'requests==2.31.0\n');
      const report = await readDependencies('python', {
        format: 'requirements',
        files: ['requirements.txt', 'pyproject.toml'],
      }, dir, 'import requests\nimport flask\n');
      expect(report.supported).toBe(true);
      expect(report.file).toBe('requirements.txt');
      expect(report.packages).toEqual([{ name: 'requests', version: '==2.31.0' }]);
      expect(report.undeclared).toEqual(['flask']);
      expect(report.installable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing file as an empty state, not an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-deps-'));
    try {
      const report = await readDependencies('go', { format: 'gomod', files: ['go.mod'] }, dir, '');
      expect(report.supported).toBe(true);
      expect(report.file).toBeUndefined();
      expect(report.note).toContain('go.mod');
      expect(report.packages).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says so when the language declares no dependency file', async () => {
    const report = await readDependencies('markdown', undefined, tmpdir(), '');
    expect(report.supported).toBe(false);
    expect(report.note).toContain('manifest.dependencies');
  });

  it('ignores a manifest entry that escapes the project root', async () => {
    // A `files` entry is data, and data can be wrong. Reading ../../etc/passwd
    // because a plugin asked for it is not a feature.
    const dir = mkdtempSync(join(tmpdir(), 'nl-deps-'));
    try {
      const report = await readDependencies('x', {
        format: 'requirements',
        files: ['../../../../etc/passwd', 'requirements.txt'],
      }, dir, '');
      expect(report.file).toBeUndefined();
      expect(report.packages).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------- package install
// The installer is the one place the product runs a toolchain to *change* the
// project. These use the Node binary itself as the "installer" so the argv,
// the streaming and the exit code are all checked without the network.

describe('package install', () => {
  /** A spec whose "installer" echoes its argv, so the test can read it back. */
  const echoSpec = {
    format: 'npm' as const,
    files: ['package.json'],
    install: [process.execPath, '-e', 'process.stdout.write(process.argv.slice(1).join(" "))'],
  };

  it('appends the package name to the declared command and streams its output', async () => {
    const seen: string[] = [];
    const r = await installPackage(echoSpec, 'left-pad', undefined, tmpdir(), {
      onData: (stream, text) => seen.push(`${stream}:${text}`),
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.output).toBe('left-pad');
    expect(seen.join('')).toContain('left-pad');
    expect(r.command).toContain('left-pad');
    expect(r.truncated).toBe(false);
  });

  it('inserts a declared local kind before an in-project path and passes the absolute path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nl-local-'));
    const pkg = join(root, 'pkg');
    mkdirSync(pkg);
    // A script file, not `node -e`: the declared `editable` flag is itself `-e`,
    // and reusing it as node's own flag would mangle the fake installer's argv.
    const echo = join(root, 'echo.cjs');
    writeFileSync(echo, 'process.stdout.write(process.argv.slice(2).join(" "))');
    const spec = {
      format: 'requirements' as const,
      files: ['requirements.txt'],
      install: [process.execPath, echo],
      local: { editable: { args: ['-e'], label: 'Editable' } },
    };
    const r = await installPackage(spec, { kind: 'editable', value: 'pkg' }, undefined, root, {
      onData: () => undefined,
    });
    expect(r.ok).toBe(true);
    // The flag lands before the path, and the path is resolved to an absolute
    // one — pip -e needs a real checkout, not a string it might interpret.
    expect(r.output.replace(/\\/g, '/')).toBe(`-e ${pkg.replace(/\\/g, '/')}`);
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a local kind the manifest never declared, without spawning', async () => {
    let spawned = false;
    const r = await installPackage(echoSpec, { kind: 'editable', value: 'pkg' }, undefined, tmpdir(), {
      onData: () => undefined,
      onSpawn: () => { spawned = true; },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('does not declare');
    expect(spawned).toBe(false);
  });

  it('refuses a local path outside the project or that does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nl-local-bounds-'));
    const spec = {
      format: 'requirements' as const,
      files: ['requirements.txt'],
      install: [process.execPath, '-e', 'process.stdout.write(process.argv.slice(1).join(" "))'],
      local: { file: { args: [] } },
    };
    let spawned = false;
    const outside = await installPackage(spec, { kind: 'file', value: '../elsewhere' }, undefined, root, {
      onData: () => undefined,
      onSpawn: () => { spawned = true; },
    });
    expect(outside.ok).toBe(false);
    expect(outside.error).toContain('inside the project');
    const missing = await installPackage(spec, { kind: 'file', value: 'nope' }, undefined, root, {
      onData: () => undefined,
      onSpawn: () => { spawned = true; },
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('no such path');
    expect(spawned).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the declared local kinds in the dependency report', async () => {
    const spec = {
      format: 'requirements' as const,
      files: ['requirements.txt'],
      install: [process.execPath],
      local: { editable: { label: 'Editable' }, file: {} },
    };
    const report = await readDependencies('python', spec, tmpdir(), '');
    expect(report.installLocal).toEqual([
      { kind: 'editable', label: 'Editable' },
      { kind: 'file', label: 'file' },
    ]);
  });

  it('expands {toolchain} in the command and the arguments', async () => {
    const spec = {
      format: 'requirements' as const,
      files: ['requirements.txt'],
      install: [process.execPath, '-e', 'process.stdout.write(process.argv.slice(1).join(" "))', '{toolchain}'],
    };
    const r = await installPackage(spec, 'pkg', 'PYTHON', tmpdir(), { onData: () => undefined });
    expect(r.ok).toBe(true);
    // The literal placeholder must be gone, and the toolchain must have landed.
    expect(r.output).toBe('PYTHON pkg');
    expect(r.command).not.toContain('{toolchain}');
  });

  it('refuses a flag-shaped name without running anything', async () => {
    let spawned = false;
    const r = await installPackage(echoSpec, '-r', undefined, tmpdir(), {
      onData: () => undefined,
      onSpawn: () => { spawned = true; },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('cannot start with');
    expect(spawned).toBe(false);
  });

  it('refuses when the language declares no install command', async () => {
    const r = await installPackage({ format: 'npm', files: ['package.json'] }, 'x', undefined, tmpdir(), {
      onData: () => undefined,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('install command');
  });

  it('reports a non-zero exit with the installer own message', async () => {
    const spec = {
      format: 'npm' as const,
      files: ['package.json'],
      install: [process.execPath, '-e', 'process.stderr.write("no such package"); process.exit(3)'],
    };
    const r = await installPackage(spec, 'nope', undefined, tmpdir(), { onData: () => undefined });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.output).toContain('no such package');
  });

  it('hands the child to the caller so a cancel is possible', async () => {
    let pid = 0;
    const spec = {
      format: 'npm' as const,
      files: ['package.json'],
      install: [process.execPath, '-e', 'setTimeout(() => {}, 800)'],
    };
    const done = installPackage(spec, 'slow', undefined, tmpdir(), {
      onData: () => undefined,
      onSpawn: (c) => { pid = c.pid ?? 0; },
    });
    expect(pid).toBeGreaterThan(0);
    const r = await done;
    // The test does not kill it; the point is only that the child was exposed
    // before it finished, which is what makes Stop work while pip is running.
    expect(r.ok).toBe(true);
  }, 20000);
});

describe('folding ranges · textDocument/foldingRange', () => {
  /**
   * The gutter paints whatever comes out of here, so the three failure modes are
   * layout bugs: an unsorted list puts arrows on the wrong lines, a duplicate
   * stacks two markers, and a zero-height span is a marker that does nothing.
   */
  it('sorts, de-duplicates and drops zero-height spans', () => {
    const out = normalizeFoldingRanges([
      { startLine: 3, endLine: 9 },
      { startLine: 3, endLine: 9, kind: 'region' },
      { startLine: 1, endLine: 1 },
      { startLine: 0, endLine: 4, kind: 'class' },
      { endLine: 7 },
      'nope',
      null,
    ]);
    expect(out).toEqual([
      { startLine: 0, endLine: 4, kind: 'class' },
      { startLine: 3, endLine: 9 },
    ]);
  });

  it('returns nothing for a reply that is not a list', () => {
    expect(normalizeFoldingRanges(null)).toEqual([]);
    expect(normalizeFoldingRanges({ startLine: 0, endLine: 2 })).toEqual([]);
  });
});

describe('inlay hints · textDocument/inlayHint', () => {
  /**
   * Hints are painted as zero-width widgets, so a hint without a position pins to
   * line 0 and an empty label is an invisible mark — both must be dropped before
   * the editor sees them. The wire format also lets a server send `label` as parts
   * that carry a jump target; a plain inline label joins the text and drops it.
   */
  it('joins label parts, drops the location, and keeps kind and padding', () => {
    const out = normalizeInlayHints([
      {
        position: { line: 4, character: 12 },
        label: [{ value: 'count: ' }, { value: 'int', location: { uri: 'file:///x' } }],
        kind: 2,
        paddingLeft: true,
      },
      { position: { line: 2, character: 0 }, label: 'str', kind: 1, paddingRight: false },
    ]);
    expect(out).toEqual([
      { line: 2, character: 0, label: 'str', kind: 'type' },
      { line: 4, character: 12, label: 'count: int', kind: 'parameter', paddingLeft: true },
    ]);
  });

  it('drops hints it cannot draw and sorts the rest by position', () => {
    const out = normalizeInlayHints([
      { position: { line: 9, character: 3 }, label: 'late' },
      { label: 'no position' },
      { position: { line: -1, character: 0 }, label: 'negative' },
      { position: { line: 5, character: 0 }, label: '' },
      { position: { line: 5, character: 8 }, label: 'early' },
      'nope',
      null,
    ]);
    expect(out).toEqual([
      { line: 5, character: 8, label: 'early' },
      { line: 9, character: 3, label: 'late' },
    ]);
  });

  it('keeps an unknown kind as a hint without a style', () => {
    const out = normalizeInlayHints([{ position: { line: 1, character: 1 }, label: 'x', kind: 99 }]);
    expect(out).toEqual([{ line: 1, character: 1, label: 'x' }]);
  });

  it('returns nothing for a reply that is not a list', () => {
    expect(normalizeInlayHints(null)).toEqual([]);
    expect(normalizeInlayHints({ position: { line: 0, character: 0 }, label: 'x' })).toEqual([]);
  });
});

describe('workspace edits · multi-file rename', () => {
  it('applies several edits bottom-up in one file', () => {
    const out = applyTextEdits('alpha beta alpha', [
      { line: 0, character: 0, endLine: 0, endCharacter: 5, newText: 'gamma' },
      { line: 0, character: 11, endLine: 0, endCharacter: 16, newText: 'gamma' },
    ]);
    expect(out).toEqual({ ok: true, text: 'gamma beta gamma', applied: 2 });
  });

  it('rejects an out-of-range edit without touching the text', () => {
    const out = applyTextEdits('one\ntwo', [
      { line: 9, character: 0, endLine: 9, endCharacter: 1, newText: 'x' },
    ]);
    expect(out.ok).toBe(false);
  });

  it('rejects overlapping edits and reversed ranges', () => {
    const overlap = applyTextEdits('abcdef', [
      { line: 0, character: 0, endLine: 0, endCharacter: 4, newText: 'x' },
      { line: 0, character: 2, endLine: 0, endCharacter: 6, newText: 'y' },
    ]);
    const reversed = applyTextEdits('abc', [
      { line: 0, character: 2, endLine: 0, endCharacter: 1, newText: '' },
    ]);
    expect(overlap.ok).toBe(false);
    expect(reversed.ok).toBe(false);
  });

  it('turns pyright URIs into usable paths', () => {
    expect(editPath('file:///c%3A/tmp/pkg/a.py')).toBe('c:/tmp/pkg/a.py');
    expect(editPath('file:///C:/work/b.py')).toBe('C:/work/b.py');
    expect(editPath('src/main.py')).toBe('src/main.py');
  });
});

describe('environment creation · run.interpreters.create', () => {
  const create = {
    venv: { command: ['{toolchain}', '-m', 'venv', '{path}'], defaultPath: '.venv' },
    conda: { command: ['conda', 'create', '-p', '{path}', 'python={version}'], wantsVersion: true },
  };

  it('substitutes the three placeholders and nothing else', () => {
    const plan = planEnvironment({
      create,
      provider: 'venv',
      root: 'C:/proj',
      dir: '.venv',
      toolchain: 'C:/py/python.exe',
    });
    expect(plan.command).toHaveLength(4);
    expect(plan.command[0]).toBe('C:/py/python.exe');
    expect(plan.command[3].replace(/\\/g, '/')).toBe('C:/proj/.venv');
    expect(plan.display).toBe(plan.command.join(' '));
  });

  it('refuses a target outside the project, and allows an absolute one inside', () => {
    expect(() => planEnvironment({ create, provider: 'venv', root: 'C:/proj', dir: '../elsewhere', toolchain: 'py' })).toThrow(
      /inside the project/,
    );
    const plan = planEnvironment({
      create,
      provider: 'venv',
      root: 'C:/proj',
      dir: 'C:/proj/envs/a',
      toolchain: 'py',
    });
    expect(plan.dir.replace(/\\/g, '/')).toBe('C:/proj/envs/a');
  });

  it('asks for what the provider needs instead of spawning a broken command', () => {
    expect(() => planEnvironment({ create, provider: 'conda', root: 'C:/proj', dir: '.conda' })).toThrow(/version/);
    expect(() => planEnvironment({ create, provider: 'venv', root: 'C:/proj', dir: '.venv' })).toThrow(/interpreter/);
  });

  it('names the providers it does have when asked for one it does not', () => {
    expect(() => planEnvironment({ create, provider: 'pixi', root: 'C:/proj', dir: '.p' })).toThrow(/venv, conda/);
    expect(() => planEnvironment({ create: undefined, provider: 'venv', root: 'C:/proj', dir: '.venv' })).toThrow(
      /no environment providers/,
    );
  });

  it('finds the interpreter the new environment will have', () => {
    // `join` decides the separator, so compare in one normalised form.
    const norm = (p: string): string => p.replace(/\\/g, '/');
    const found = environmentExecutable('C:/proj/.venv', ['bin/python', 'Scripts/python.exe'], (p) => norm(p).endsWith('Scripts/python.exe'));
    expect(found && norm(found)).toBe('C:/proj/.venv/Scripts/python.exe');
    expect(environmentExecutable('C:/proj/.venv', ['bin/python'], () => false)).toBeUndefined();
  });

  it('rejects a manifest whose create command would reach spawn as a literal token', () => {
    const base = {
      id: 'x',
      displayName: 'X',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      file: { extensions: ['x'] },
      run: { mode: 'template', interpreters: { create: { venv: { command: ['{toolchain}', '{foo}', '{path}'] } } } },
    };
    const bad = validateManifest(base);
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.issues)).toContain('{foo}');

    const ok = validateManifest({
      ...base,
      run: { mode: 'template', interpreters: { create: { venv: { command: ['{toolchain}', '{path}'] } } } },
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects a defaultPath that escapes the project', () => {
    const bad = validateManifest({
      id: 'x',
      displayName: 'X',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      file: { extensions: ['x'] },
      run: { mode: 'template', interpreters: { create: { venv: { command: ['{path}'], defaultPath: '../out' } } } },
    });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.issues)).toContain('escape');
  });

  it('accepts a declared local install alongside an install command', () => {
    const ok = validateManifest({
      id: 'x',
      displayName: 'X',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      file: { extensions: ['x'] },
      dependencies: {
        format: 'requirements', files: ['requirements.txt'], install: ['pip', 'install'],
        local: { editable: { args: ['-e'], label: 'Editable' }, file: {} },
      },
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects a local install block without an install command', () => {
    const bad = validateManifest({
      id: 'x', displayName: 'X', version: '1.0.0', apiVersion: '^1.0.0',
      file: { extensions: ['x'] },
      dependencies: { format: 'requirements', files: ['requirements.txt'], local: { editable: {} } },
    });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.issues)).toContain('dependencies.local');
  });

  it('rejects malformed local specs (array args, empty label)', () => {
    const bad = validateManifest({
      id: 'x', displayName: 'X', version: '1.0.0', apiVersion: '^1.0.0',
      file: { extensions: ['x'] },
      dependencies: {
        format: 'requirements', files: ['requirements.txt'], install: ['pip'],
        local: { editable: { args: ['-e', 3] }, file: { label: '' } },
      },
    });
    expect(bad.ok).toBe(false);
    const issues = JSON.stringify(bad.issues);
    expect(issues).toContain('dependencies.local.editable.args');
    expect(issues).toContain('dependencies.local.file.label');
  });
});

describe('workspace edits · server handler', () => {
  const makeWorkspace = () => {
    const home = mkdtempSync(join(tmpdir(), 'nl-edits-'));
    const ws = join(home, 'ws');
    mkdirSync(join(ws, 'pkg'), { recursive: true });
    writeFileSync(join(ws, 'main.py'), 'def old_name():\n    return 1\n');
    writeFileSync(join(ws, 'pkg', 'util.py'), 'def old_name():\n    return 2\n');
    return { home, ws };
  };

  const renameTo = (uri: string) => ({
    uri, line: 0, character: 4, endLine: 0, endCharacter: 12, newText: 'new_name',
  });

  it('writes every target file and preserves line endings', async () => {
    const { home, ws } = makeWorkspace();
    writeFileSync(join(ws, 'pkg', 'util.py'), 'def old_name():\r\n    return 2\r\n');
    try {
      let out: any;
      await handleApplyWorkspaceEdits(new FsService(ws), {
        requestId: 1,
        edits: [renameTo('main.py'), renameTo('file:///pkg/util.py')],
      }, (p) => { out = p; });
      expect(out).toMatchObject({ kind: 'workspaceEditsApplied', ok: true, applied: 2 });
      expect(String(out.reason ?? '')).toBe('');
      expect(readFileSync(join(ws, 'main.py'), 'utf8')).toBe('def new_name():\n    return 1\n');
      expect(readFileSync(join(ws, 'pkg', 'util.py'), 'utf8')).toBe('def new_name():\r\n    return 2\r\n');
      expect(out.files.every((f: any) => typeof f.content === 'string')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes nothing when one target has an invalid range', async () => {
    const { home, ws } = makeWorkspace();
    try {
      let out: any;
      await handleApplyWorkspaceEdits(new FsService(ws), {
        requestId: 2,
        edits: [renameTo('main.py'), { ...renameTo('pkg/util.py'), endCharacter: 999 }],
      }, (p) => { out = p; });
      expect(out.ok).toBe(false);
      expect(readFileSync(join(ws, 'main.py'), 'utf8')).toContain('old_name');
      expect(readFileSync(join(ws, 'pkg', 'util.py'), 'utf8')).toContain('old_name');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rolls back every file, including the one that failed mid-write', async () => {
    const { home, ws } = makeWorkspace();
    let failNext = true;
    class FaultInjectingFs extends FsService {
      override async commitAtomic(rel: string, content: string) {
        if (rel === 'pkg/util.py' && failNext) {
          failNext = false;
          // Simulate a crash after the temp file was written but before the
          // handler was told: the rollback must still restore this file.
          await super.commitAtomic(rel, 'PARTIAL WRITE\n');
          throw new Error('injected write failure');
        }
        return super.commitAtomic(rel, content);
      }
    }
    try {
      let out: any;
      await handleApplyWorkspaceEdits(new FaultInjectingFs(ws), {
        requestId: 4,
        edits: [renameTo('main.py'), renameTo('pkg/util.py')],
      }, (p) => { out = p; });
      expect(out.ok).toBe(false);
      expect(String(out.reason)).toContain('injected write failure');
      expect(String(out.reason)).not.toContain('rollback failed');
      expect(readFileSync(join(ws, 'main.py'), 'utf8')).toContain('old_name');
      expect(readFileSync(join(ws, 'pkg', 'util.py'), 'utf8')).toContain('old_name');
      expect(readdirSync(join(ws, 'pkg')).some((n) => n.endsWith('.tmp'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a path outside the workspace', async () => {
    const { home, ws } = makeWorkspace();
    try {
      let out: any;
      await handleApplyWorkspaceEdits(new FsService(ws), {
        requestId: 3, edits: [renameTo('file:///c%3A/Windows/System32/hosts')],
      }, (p) => { out = p; });
      expect(out.ok).toBe(false);
      expect(String(out.reason)).toContain('outside');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('crash recovery · draft copies', () => {
  /**
   * A draft is written *outside* the workspace and read back by path, so the two
   * halves that matter are: nothing lands in the project, and the copy survives a
   * new FsService (i.e. a new session pointed at the same folder).
   */
  it('keeps a dirty buffer outside the workspace and reads it back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nl-drafts-'));
    const workspace = join(home, 'ws');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'app.py'), 'x = 1\n');
    const prev = process.env.NOLANGUAGE_DATA;
    process.env.NOLANGUAGE_DATA = join(home, 'data');
    try {
      const reply = async (msg: Record<string, unknown>): Promise<any> => {
        let out: any;
        await handleDraft(new FsService(workspace), msg, (p) => { out = p; });
        return out;
      };
      expect(await reply({ kind: 'draftSave', path: 'app.py', content: 'x = 2\n' })).toMatchObject({ kind: 'draftSaved', path: 'app.py' });

      const listed = await reply({ kind: 'draftList' });
      expect(listed.kind).toBe('drafts');
      expect(listed.drafts).toHaveLength(1);
      expect(listed.drafts[0]).toMatchObject({ path: 'app.py', content: 'x = 2\n', stale: false, sameAsDisk: false });
      // The project folder gained nothing: a draft is app state, not a file.
      expect(readdirSync(workspace)).toEqual(['app.py']);

      // A second session (new service, same folder) sees the same copy.
      const again: any[] = [];
      await handleDraft(new FsService(workspace), { kind: 'draftList' }, (p) => again.push(p));
      expect(again[0].drafts[0].content).toBe('x = 2\n');

      await reply({ kind: 'draftDrop', path: 'app.py' });
      expect((await reply({ kind: 'draftList' })).drafts).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.NOLANGUAGE_DATA;
      else process.env.NOLANGUAGE_DATA = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('marks a draft stale when its file disappeared, so restore cannot overwrite', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nl-drafts-stale-'));
    const workspace = join(home, 'ws');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'gone.py'), 'y = 1\n');
    const prev = process.env.NOLANGUAGE_DATA;
    process.env.NOLANGUAGE_DATA = join(home, 'data');
    try {
      const fs = new FsService(workspace);
      await handleDraft(fs, { kind: 'draftSave', path: 'gone.py', content: 'y = 2\n' }, () => undefined);
      rmSync(join(workspace, 'gone.py'));
      let listed: any;
      await handleDraft(fs, { kind: 'draftList' }, (p) => { listed = p; });
      expect(listed.drafts[0]).toMatchObject({ path: 'gone.py', stale: true, sameAsDisk: false });
    } finally {
      if (prev === undefined) delete process.env.NOLANGUAGE_DATA;
      else process.env.NOLANGUAGE_DATA = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses an absolute or escaping path instead of storing an unreachable copy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nl-drafts-bad-'));
    const prev = process.env.NOLANGUAGE_DATA;
    process.env.NOLANGUAGE_DATA = join(home, 'data');
    try {
      const fs = new FsService(home);
      const says: any[] = [];
      await handleDraft(fs, { kind: 'draftSave', path: 'C:/Windows/x.py', content: 'z' }, (p) => says.push(p));
      await handleDraft(fs, { kind: 'draftSave', path: '../outside.py', content: 'z' }, (p) => says.push(p));
      expect(says.map((m) => m.kind)).toEqual(['draftError', 'draftError']);
    } finally {
      if (prev === undefined) delete process.env.NOLANGUAGE_DATA;
      else process.env.NOLANGUAGE_DATA = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('go test output parser', () => {
  it('turns a passing suite into per-case events with timings', () => {
    const events = parseGoTest([
      '=== RUN   TestAdd',
      '--- PASS: TestAdd (0.00s)',
      '=== RUN   TestSub',
      '--- PASS: TestSub (0.12s)',
      'PASS',
      'ok  \tnolanguage/session\t0.145s',
    ]);
    const cases = events.filter((e) => e.status !== 'output' && e.status !== 'run');
    expect(cases.map((c) => [c.name, c.status])).toEqual([
      ['TestAdd', 'pass'],
      ['TestSub', 'pass'],
    ]);
    expect(events.filter((e) => e.status === 'run').map((e) => e.name)).toEqual(['TestAdd', 'TestSub']);
    expect(cases[1].ms).toBe(120);
  });

  it('attributes a file:line message to the case that was running', () => {
    const events = parseGoTest([
      '=== RUN   TestBad',
      '    main_test.go:14: got 3, want 4',
      '--- FAIL: TestBad (0.00s)',
      'FAIL',
      'FAIL\tnolanguage/session\t0.02s',
    ]);
    const failed = events.find((e) => e.name === 'TestBad' && e.status === 'fail')!;
    expect(failed.file).toBe('main_test.go');
    expect(failed.line).toBe(14);
    expect(failed.message).toContain('got 3, want 4');
  });

  it('emits output lines while a case runs instead of dropping them', () => {
    const p = createGoTestParser();
    const first = p.push('=== RUN   TestLog');
    const second = p.push('log line from the test');
    // push() reuses an internal buffer, so a returned event list must not be
    // mutated by the next line: a caller that stores the first result (the test
    // tree does) would otherwise see the last line's event instead.
    expect(first).toEqual([{ name: 'TestLog', status: 'run' }]);
    expect(second).toEqual([{ name: 'TestLog', status: 'output', message: 'log line from the test' }]);
    expect(p.running).toEqual(['TestLog']);
  });

  it('reads subtests as their own cases and keeps the parent separate', () => {
    const events = parseGoTest([
      '=== RUN   TestGroup',
      '=== RUN   TestGroup/a',
      '--- PASS: TestGroup/a (0.00s)',
      '--- PASS: TestGroup (0.01s)',
    ]);
    const names = events.filter((e) => e.status !== 'output').map((e) => e.name + ':' + e.status);
    expect(names).toEqual(['TestGroup:run', 'TestGroup/a:run', 'TestGroup/a:pass', 'TestGroup:pass']);
  });
});

describe('test selector validation', () => {
  it('accepts a bare name and an explicit -run fragment, adding the flag once', () => {
    expect(sanitizeTestFilter('TestFoo')).toBe('-run TestFoo');
    expect(sanitizeTestFilter('-run ^TestFoo$')).toBe('-run ^TestFoo$');
    expect(sanitizeTestFilter('')).toBe('');
  });

  it('rejects anything that could become a second command', () => {
    expect(sanitizeTestFilter('TestFoo; rm -rf /')).toBeUndefined();
    expect(sanitizeTestFilter('TestFoo && calc')).toBeUndefined();
    expect(sanitizeTestFilter('"quoted"')).toBeUndefined();
    expect(sanitizeTestFilter(42)).toBeUndefined();
    expect(sanitizeTestFilter('a'.repeat(200))).toBeUndefined();
  });
});

describe('launch program containment', () => {
  // The debug handler flushes the open buffer to this path before launching, so a
  // `program` that escapes the root is a write primitive, not just a wrong path.
  const root = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';

  it('accepts a relative path inside the root, existing or not', async () => {
    expect(await resolveLaunchProgram(root, 'main.py')).toBe(join(root, 'main.py'));
    expect(await resolveLaunchProgram(root, 'src/app.py')).toBe(join(root, 'src', 'app.py'));
  });

  it('rejects anything that resolves outside the root', async () => {
    expect(await resolveLaunchProgram(root, '../evil.py')).toBeUndefined();
    expect(await resolveLaunchProgram(root, '../../../../etc/passwd')).toBeUndefined();
    expect(await resolveLaunchProgram(root, '.')).toBeUndefined();
  });

  it('rejects absolute paths, which never belong to the workspace', async () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\x.py' : '/etc/passwd';
    expect(await resolveLaunchProgram(root, outside)).toBeUndefined();
  });
});

describe('debug preLaunch planning', () => {
  const vars = {
    '{toolchain}': 'C:\\Program Files\\Compiler\\bin\\cc.exe',
    '{file}': 'D:\\work\\my project\\main.cpp',
    '{workdir}': 'D:\\work\\my project',
    '{exe}': '.exe',
  };

  it('keeps argv elements intact, including paths with spaces', () => {
    const plan = planPreLaunch(
      { argv: ['{toolchain}', '-g', '{file}', '-o', '{workdir}/nl_dbg{exe}'] },
      vars,
    );
    expect(plan?.legacy).toBe(false);
    expect(plan?.argv).toEqual([
      'C:\\Program Files\\Compiler\\bin\\cc.exe',
      '-g',
      'D:\\work\\my project\\main.cpp',
      '-o',
      'D:\\work\\my project/nl_dbg.exe',
    ]);
  });

  it('tokenises a legacy cmd locally and never hands it to a shell', () => {
    const plan = planPreLaunch(
      { cmd: '"{toolchain}" -std=c++17 "{file}" && echo pwned' },
      vars,
    );
    expect(plan?.legacy).toBe(true);
    expect(plan?.argv).toEqual([
      'C:\\Program Files\\Compiler\\bin\\cc.exe',
      '-std=c++17',
      'D:\\work\\my project\\main.cpp',
      '&&',
      'echo',
      'pwned',
    ]);
  });
});

describe('expected sha256 parsing', () => {
  const hex = 'deadbeef'.repeat(8);

  it('accepts the bare hex form and the sha256: prefix, normalised to lowercase', () => {
    expect(parseSha256(hex)).toBe(hex);
    expect(parseSha256(`sha256:${hex}`)).toBe(hex);
    expect(parseSha256(hex.toUpperCase())).toBe(hex);
    expect(parseSha256(`  sha256:${hex}  `)).toBe(hex);
  });

  it('rejects anything that could never match, so the caller refuses instead of comparing', () => {
    expect(parseSha256(undefined)).toBeUndefined();
    expect(parseSha256(42)).toBeUndefined();
    expect(parseSha256('')).toBeUndefined();
    expect(parseSha256('not-a-hash')).toBeUndefined();
    expect(parseSha256(hex.slice(0, 63))).toBeUndefined();
    expect(parseSha256(`${hex}0`)).toBeUndefined();
  });
});

describe('AI provider settings', () => {
  it('accepts http(s) base URLs and strips the trailing slash', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeBaseUrl('  https://api.example.com  ')).toBe('https://api.example.com');
  });

  it('refuses schemes and URLs that would smuggle the key somewhere else', () => {
    expect(normalizeBaseUrl('file:///etc/passwd')).toBeUndefined();
    expect(normalizeBaseUrl('ftp://example.com')).toBeUndefined();
    expect(normalizeBaseUrl('https://user:secret@example.com/v1')).toBeUndefined();
    expect(normalizeBaseUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeBaseUrl('')).toBeUndefined();
    expect(normalizeBaseUrl(7)).toBeUndefined();
  });

  it('accepts ordinary model ids and rejects whitespace or control characters', () => {
    expect(normalizeModel('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(normalizeModel('qwen2.5:7b')).toBe('qwen2.5:7b');
    expect(normalizeModel('meta/llama-3@fp16')).toBe('meta/llama-3@fp16');
    expect(normalizeModel('two words')).toBeUndefined();
    expect(normalizeModel('bad\nmodel')).toBeUndefined();
    expect(normalizeModel(undefined)).toBeUndefined();
  });

  it('builds an OpenAI-compatible streaming request and only sends the key as a header', () => {
    const req = buildChatRequest(
      { baseUrl: 'https://api.example.com/v1/', model: 'gpt-4o-mini', key: 'sk-test-123' },
      'why?',
      { language: 'go' },
    );
    expect(req.url).toBe('https://api.example.com/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test-123');
    expect(req.headers.accept).toBe('text/event-stream');
    expect(req.body).not.toContain('sk-test-123');
    const body = JSON.parse(req.body) as { model: string; stream: boolean; max_tokens: number; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([{ role: 'user', content: 'The user is editing a go file.\n\nwhy?' }]);
  });

  it('omits the authorization header when no key is configured and clamps max_tokens', () => {
    const req = buildChatRequest({ baseUrl: 'http://127.0.0.1:1', model: 'm' }, 'hi', { maxTokens: 99999 });
    expect(req.headers.authorization).toBeUndefined();
    expect((JSON.parse(req.body) as { max_tokens: number }).max_tokens).toBe(4096);
  });
});

describe('AI SSE decoding', () => {
  const frame = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

  it('handles a chunk boundary in the middle of a line', () => {
    const d = new SseDecoder();
    expect(d.push('data: {"choices":[{"delta":{"content":"Hel')).toEqual([]);
    expect(d.push('lo"}}]}\n\n')).toEqual(['Hello']);
    expect(d.done).toBe(false);
  });

  it('reads several frames from one chunk and stops at [DONE]', () => {
    const d = new SseDecoder();
    expect(d.push(frame('a') + frame('b') + 'data: [DONE]\n\n' + frame('ignored'))).toEqual(['a', 'b']);
    expect(d.done).toBe(true);
  });

  it('falls back to message.content for providers that answer in one piece', () => {
    const d = new SseDecoder();
    expect(d.push(`data: ${JSON.stringify({ choices: [{ message: { content: 'whole' } }] })}\n\n`)).toEqual(['whole']);
  });

  it('reports an error frame instead of throwing', () => {
    const d = new SseDecoder();
    expect(d.push(`data: ${JSON.stringify({ error: { message: 'bad key' } })}\n\n`)).toEqual([]);
    expect(d.done).toBe(true);
    expect(d.error).toBe('bad key');
  });

  it('reports malformed JSON as an error and ignores commentary lines', () => {
    const d = new SseDecoder();
    expect(d.push(': keep-alive\ndata: {not json}\n\n')).toEqual([]);
    expect(d.done).toBe(true);
    expect(d.error).toBe('the provider sent a line that is not JSON');
  });
});

describe('scaffolded language plugin', () => {
  it('emits a manifest every runtime mode can load', () => {
    for (const run of RUN_MODES) {
      const built = buildLanguagePlugin({ id: 'demo', extensions: ['dm'], run, lspCommand: 'demo-lsp' });
      const verdict = validateManifest(built.manifest);
      expect({ run, ok: verdict.ok, issues: verdict.issues }).toEqual({ run, ok: true, issues: [] });
      expect(built.files.some((f) => f.path === 'manifest.json')).toBe(true);
    }
  });

  it('ships the companion file each run mode needs, and no run block for none', () => {
    const scriptHost = buildLanguagePlugin({ id: 'demo', extensions: ['dm'], run: 'script-host' });
    expect(scriptHost.files.map((f) => f.path)).toEqual(['manifest.json', 'runtime.js']);
    const repl = buildLanguagePlugin({ id: 'demo', extensions: ['dm'], run: 'repl-session' });
    expect(repl.files.map((f) => f.path)).toEqual(['manifest.json', 'bootstrap.py']);
    const none = buildLanguagePlugin({ id: 'demo', extensions: ['dm'] });
    expect(none.manifest.run).toBeUndefined();
    expect(none.todos.join(' ')).toMatch(/Run is disabled/);
  });

  it('escapes grammar input so keywords and comment prefixes stay literal', () => {
    const built = buildLanguagePlugin({
      id: 'demo',
      extensions: ['dm'],
      commentPrefix: '--',
      keywords: ['a.b', 'if'],
    });
    const rules = built.manifest.grammar?.rules ?? [];
    // Comments first: a keyword inside a comment must not win.
    expect(rules[0].cls).toBe('c');
    expect(rules[0].re.startsWith('--')).toBe(true);
    const keyword = rules.find((r) => r.cls === 'k');
    expect(keyword?.re).toContain('a\\.b');
    for (const rule of rules) expect(() => new RegExp(rule.re, 'y')).not.toThrow();
  });

  it('refuses input the registry would reject anyway', () => {
    expect(() => buildLanguagePlugin({ id: 'Bad Id', extensions: ['dm'] })).toThrow(/invalid language id/);
    expect(() => buildLanguagePlugin({ id: 'demo', extensions: [] })).toThrow(/extension is required/);
    expect(() => buildLanguagePlugin({ id: 'demo', extensions: ['a b'] })).toThrow(/invalid file extension/);
  });

  it('normalises extensions with a leading dot and splits a comma list', () => {
    const built = buildLanguagePlugin({ id: 'demo', extensions: ['.dm,.dmo'] });
    expect(built.manifest.file.extensions).toEqual(['dm', 'dmo']);
    expect(built.manifest.file.defaultExt).toBe('dm');
  });
});

describe('local revision history', () => {
  it('snapshots before a write and restores exactly that content', async () => {
    const previous = process.env.NOLANGUAGE_DATA;
    const dir = mkdtempSync(join(tmpdir(), 'nlg-history-'));
    try {
      process.env.NOLANGUAGE_DATA = dir;
      const store = new HistoryStore();
      expect(await store.list('/work/proj', 'main.py')).toEqual([]);

      const first = await store.snapshot('/work/proj', 'main.py', 'original\n', 'save');
      const second = await store.snapshot('/work/proj', 'main.py', 'edited\n', 'save');
      expect(first?.path).toBe('main.py');
      expect(second?.reason).toBe('save');

      const entries = await store.list('/work/proj', 'main.py');
      expect(entries.length).toBe(2);
      expect(entries[0].id).toBe(second?.id);
      expect(entries.every((e) => e.root === '/work/proj')).toBe(true);
      const recent = await store.list('/work/proj');
      expect(recent.length).toBe(2);

      const restored = await store.read('/work/proj', String(first?.id));
      expect(restored?.content).toBe('original\n');
      expect(await store.read('/other/proj', String(first?.id))).toBeUndefined();
      expect(await store.read('/work/proj', '../escape')).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.NOLANGUAGE_DATA;
      else process.env.NOLANGUAGE_DATA = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses traversal paths and oversized snapshots', async () => {
    const previous = process.env.NOLANGUAGE_DATA;
    const dir = mkdtempSync(join(tmpdir(), 'nlg-history-bad-'));
    try {
      process.env.NOLANGUAGE_DATA = dir;
      const store = new HistoryStore();
      expect(await store.snapshot('/work', '../outside.py', 'x')).toBeUndefined();
      expect(await store.snapshot('/work', 'C:/outside.py', 'x')).toBeUndefined();
      expect(await store.snapshot('/work', 'big.py', 'x'.repeat(600 * 1024))).toBeUndefined();
      expect(existsSync(join(dir, 'history'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NOLANGUAGE_DATA;
      else process.env.NOLANGUAGE_DATA = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
