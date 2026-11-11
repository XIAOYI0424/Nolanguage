/**
 * `ndebug` command line — the only entry point of the standalone app.
 *
 * Kept separate from `main.ts` on purpose: `main.ts` is a library the suite
 * imports, and this file is the thing that runs. A single-file executable has no
 * reliable `import.meta.url`, so entry detection inside the library would be a
 * coin flip in the packaged build; a separate entry makes the question go away.
 */
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { languageOf, startAttachApp, startDebugApp, startReplayApp } from './main.js';
import { goAttachGuide } from './agents/go/guide.js';
import { defaultConfig, describeConfig, loadRedactConfig, mergeConfig, type RedactConfig } from './redact.js';
import { describeRecording, readRecording } from './recorder.js';
import { describeReport, renderSanitized, sanitizeRecording } from './sanitize.js';
import { writeFileSync } from 'node:fs';

const USAGE = `ndebug — live debug observatory

  ndebug <script.py> [options] [-- args for the program]
  ndebug --replay <session.ndlog> [options]
  ndebug --attach <pprof-url> [options]
  ndebug --sanitize <in.ndlog> --out <out.ndlog> [options]

Options:
  --port <n>      page port (default 7320, 0 = pick one)
  --hz <n>        samples per second (default 10)
  --record <file> write the session to a .ndlog (replayable)
  --replay <file> play a recording instead of observing a program
  --attach <url>  observe a Go program through its pprof endpoint
  --sanitize <f>  write a redacted copy of a recording (safe to share)
  --out <file>    destination for --sanitize
  --scrub <re>    regex to blank out in every string (repeatable)
  --speed <n>     replay speed: 1 = real time, 0 = as fast as possible
  --redact <a,b>  extra field names to hide (substring, case-insensitive)
  --allow <a,b>   field names to show even if they match a redaction rule
  --config <file> JSON config: { "redact": { "names": [...], "allow": [...] } }
  --no-open       do not open a browser
  --quiet         no banner
  -h, --help      this text

Examples:
  ndebug app.py
  ndebug app.py --hz 20 --port 7400
  ndebug app.py --record crash.ndlog -- 60
  ndebug --replay crash.ndlog --speed 4
  ndebug --attach http://127.0.0.1:6060
  ndebug app.py --redact sessionid --allow token_count
  ndebug --sanitize crash.ndlog --out share.ndlog --scrub "sk-[A-Za-z0-9]+"
`;

export interface CliOptions {
  mode: 'live' | 'replay' | 'attach' | 'sanitize';
  /** Live: the script to observe. Replay: empty. */
  script: string;
  /** Replay: the recording. Live: empty. */
  file: string;
  /** Attach: the pprof address. Otherwise empty. */
  attach: string;
  port: number;
  hz: number;
  /** Replay only; 1 = real time, 0 = instant. */
  speed: number;
  open: boolean;
  quiet: boolean;
  args: string[];
  record?: string;
  /** Extra names to redact, from `--redact`. */
  redact: string[];
  /** Names to exempt, from `--allow`. */
  allow: string[];
  /** Config file path, from `--config`. */
  config: string;
  /** Sanitize: the output path, from `--out`. */
  out: string;
  /** Sanitize: regex sources to blank out, from `--scrub`. */
  scrub: string[];
}

export function parseArgs(argv: string[]): CliOptions | { help: true } | { error: string } {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) return { help: true };

  const dashAt = argv.indexOf('--');
  const own = dashAt >= 0 ? argv.slice(0, dashAt) : argv.slice();
  const extra = dashAt >= 0 ? argv.slice(dashAt + 1) : [];

  let port = 7320;
  let hz = 10;
  let speed = 1;
  let open = true;
  let quiet = false;
  let record: string | undefined;
  const redactList: string[] = [];
  const allowList: string[] = [];
  let configPath = '';
  let out = '';
  let sanitize = '';
  const scrub: string[] = [];
  let replay = '';
  let attach = '';
  const positionals: string[] = [];

  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    // Parse the raw value, then validate it. `Number(x) || default` looks tidy and
    // silently turns `--hz 0` into 10 — a user asking for a specific rate would
    // get a different one with no warning.
    if (a === '--port') {
      const raw = own[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n < 0 || n > 65535) {
        return { error: `port must be an integer between 0 and 65535 (got ${raw ?? 'nothing'})` };
      }
      port = n;
    } else if (a === '--hz') {
      const raw = own[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isFinite(n) || n < 1 || n > 100) {
        return { error: `hz must be between 1 and 100 (got ${raw ?? 'nothing'})` };
      }
      hz = n;
    } else if (a === '--speed') {
      const raw = own[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isFinite(n) || n < 0 || n > 100) {
        return { error: `speed must be between 0 and 100 (got ${raw ?? 'nothing'})` };
      }
      speed = n;
    } else if (a === '--record') {
      const raw = own[++i];
      if (!raw) return { error: 'record needs a file path' };
      record = raw;
    } else if (a === '--replay') {
      const raw = own[++i];
      if (!raw) return { error: 'replay needs a file path' };
      replay = raw;
    } else if (a === '--redact') {
      const raw = own[++i];
      if (!raw) return { error: 'redact needs a comma-separated list of names' };
      redactList.push(...raw.split(','));
    } else if (a === '--allow') {
      const raw = own[++i];
      if (!raw) return { error: 'allow needs a comma-separated list of names' };
      allowList.push(...raw.split(','));
    } else if (a === '--config') {
      const raw = own[++i];
      if (!raw) return { error: 'config needs a file path' };
      configPath = raw;
    } else if (a === '--sanitize') {
      const raw = own[++i];
      if (!raw) return { error: 'sanitize needs a recording path' };
      sanitize = raw;
    } else if (a === '--out') {
      const raw = own[++i];
      if (!raw) return { error: 'out needs a file path' };
      out = raw;
    } else if (a === '--scrub') {
      const raw = own[++i];
      if (!raw) return { error: 'scrub needs a regular expression' };
      scrub.push(raw);
    } else if (a === '--attach') {
      const raw = own[++i];
      if (!raw) return { error: 'attach needs a pprof address, e.g. http://127.0.0.1:6060' };
      attach = raw;
    } else if (a === '--no-open') open = false;
    else if (a === '--quiet') quiet = true;
    else if (a.startsWith('-')) return { error: `unknown option: ${a}` };
    else positionals.push(a);
  }

  if (replay && attach) {
    return { error: '--replay and --attach are different sources; pick one' };
  }
  if (sanitize && (replay || attach)) {
    return { error: '--sanitize reads a file; it cannot be combined with --replay or --attach' };
  }

  if (sanitize) {
    if (positionals.length) return { error: `--sanitize takes no script (got ${positionals[0]})` };
    if (extra.length) return { error: '--sanitize takes no program arguments' };
    if (!out) return { error: '--sanitize needs --out <file> (it never overwrites the input)' };
    return {
      mode: 'sanitize', script: '', file: sanitize, attach: '', port, hz, speed, open, quiet, args: [],
      redact: redactList, allow: allowList, config: configPath, out, scrub,
    };
  }

  if (attach) {
    if (positionals.length) {
      return { error: `--attach takes no script (got ${positionals[0]})` };
    }
    if (extra.length) return { error: '--attach takes no program arguments' };
    return {
      mode: 'attach', script: '', file: '', attach, port, hz, speed, open, quiet, args: [],
      redact: redactList, allow: allowList, config: configPath, out, scrub,
      ...(record ? { record } : {}),
    };
  }

  if (replay) {
    if (positionals.length) {
      // Two targets in one command is a mistake worth naming: silently preferring
      // one of them would hide a typo in the other.
      return { error: `--replay takes no script (got ${positionals[0]})` };
    }
    if (extra.length) return { error: '--replay takes no program arguments' };
    return {
      mode: 'replay', script: '', file: replay, attach: '', port, hz, speed, open, quiet, args: [],
      redact: redactList, allow: allowList, config: configPath, out, scrub,
    };
  }

  const script = positionals.shift();
  if (!script) return { error: 'no script given' };
  if (positionals.length) return { error: `unexpected argument: ${positionals[0]}` };
  return {
    mode: 'live',
    script,
    file: '',
    attach: '',
    port,
    hz,
    speed,
    open,
    quiet,
    args: extra,
    redact: redactList,
    allow: allowList,
    config: configPath,
    out,
    scrub,
    ...(record ? { record } : {}),
  };
}

/** Run the app; resolves with the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('help' in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }
  if ('error' in parsed) {
    process.stderr.write(`ndebug: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  const redact = resolveRedact(parsed);
  if ('error' in redact) {
    process.stderr.write(`ndebug: ${redact.error}\n`);
    return 2;
  }

  try {
    if (parsed.mode === 'replay') return await runReplay(parsed);
    if (parsed.mode === 'attach') return await runAttach(parsed);
    if (parsed.mode === 'sanitize') return runSanitize(parsed, redact.config);

    // A Go file cannot be attached from outside the process, so the answer is a
    // set of instructions rather than "unsupported".
    if (languageOf(parsed.script) === 'go') {
      process.stderr.write(goAttachGuide(parsed.script) + '\n');
      return 2;
    }

    const app = await startDebugApp({
      script: parsed.script,
      port: parsed.port,
      hz: parsed.hz,
      open: false,
      args: parsed.args,
      quiet: parsed.quiet,
      redact: redact.config,
      ...(parsed.record ? { record: parsed.record } : {}),
    });

    if (!parsed.quiet) {
      const rec = app.recorder?.stats();
      process.stdout.write(
        `\n  ndebug · observing ${basename(resolve(parsed.script))}\n` +
          `  page   ${app.url}\n` +
          `  agent  port ${app.session.boundPort} · ${parsed.hz} Hz\n` +
          `  redact ${describeConfig(app.redactConfig)}\n` +
          (rec ? `  record ${rec.path}${rec.error ? ` (unavailable: ${rec.error})` : ''}\n` : '') +
          `  stop   ctrl+c\n\n`,
      );
    }
    if (parsed.open) openBrowser(app.url);

    const code = await app.exited;
    if (!parsed.quiet) {
      const rec = app.recorder?.stats();
      process.stdout.write(`\n  target exited (${code}) — the page keeps the last state; ctrl+c to quit\n`);
      if (rec) {
        process.stdout.write(
          `  recorded ${rec.lines} events · ${Math.round(rec.bytes / 1024)} KiB` +
            `${rec.truncated ? ' (capped: recording limit reached)' : ''}\n` +
            `  replay   ndebug --replay ${rec.path}\n`,
        );
      }
    }

    // Stay up: the last stacks before a crash are usually the interesting ones,
    // and closing the page out from under the user is hostile.
    await waitForStop();
    await app.close();
    return code;
  } catch (err) {
    process.stderr.write(`ndebug: ${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * Write a redacted copy of a recording.
 *
 * Refusing to overwrite the input is not politeness: a sanitize step that
 * destroys its source on a bad flag is unrecoverable, and the raw file is the
 * only thing that can be re-sanitized with better rules later.
 */
function runSanitize(parsed: CliOptions, config: RedactConfig): number {
  const input = resolve(parsed.file);
  const output = resolve(parsed.out);
  if (input === output) {
    process.stderr.write('ndebug: --out must differ from the input (sanitize never overwrites)\n');
    return 2;
  }

  const patterns: RegExp[] = [];
  for (const source of parsed.scrub) {
    try {
      patterns.push(new RegExp(source, 'g'));
    } catch (err) {
      process.stderr.write(`ndebug: bad --scrub pattern ${JSON.stringify(source)}: ${(err as Error).message}\n`);
      return 2;
    }
  }

  let recording;
  try {
    recording = readRecording(input);
  } catch (err) {
    process.stderr.write(`ndebug: ${(err as Error).message}\n`);
    return 1;
  }

  const result = sanitizeRecording(recording, { redact: config, scrub: patterns });
  try {
    writeFileSync(output, renderSanitized(result), 'utf8');
  } catch (err) {
    process.stderr.write(`ndebug: cannot write ${output}: ${(err as Error).message}\n`);
    return 1;
  }

  if (!parsed.quiet) {
    process.stdout.write(
      `\n  ndebug · sanitized ${basename(input)}\n` +
        `  ${describeRecording(recording)}\n` +
        `  out    ${output}\n` +
        `  ${describeReport(result.report)}\n` +
        (result.report.samples.length ? `  first  ${result.report.samples.slice(0, 5).join(', ')}\n` : '') +
        '\n',
    );
  }
  return 0;
}

async function runAttach(parsed: CliOptions): Promise<number> {
  const app = await startAttachApp({
    url: parsed.attach,
    port: parsed.port,
    hz: parsed.hz,
    quiet: parsed.quiet,
  });

  if (!parsed.quiet) {
    process.stdout.write(
      `\n  ndebug · attaching to a Go pprof endpoint\n` +
        `  dump   ${app.dumpUrl}\n` +
        `  page   ${app.url}\n` +
        `  poll   ${parsed.hz} Hz · goroutine stacks only (no locals)\n` +
        `  stop   ctrl+c\n\n`,
    );
  }
  if (parsed.open) openBrowser(app.url);

  // There is no child process to wait for: the user stops it.
  await waitForStop();
  await app.close();
  return 0;
}

async function runReplay(parsed: CliOptions): Promise<number> {
  const app = await startReplayApp({
    file: parsed.file,
    port: parsed.port,
    speed: parsed.speed,
    quiet: parsed.quiet,
  });

  if (!parsed.quiet) {
    const speed = parsed.speed === 0 ? 'instant' : `${parsed.speed}×`;
    process.stdout.write(
      `\n  ndebug · replaying ${basename(app.recording.path)}\n` +
        `  ${describeRecording(app.recording)}\n` +
        (app.recording.note ? `  note   ${app.recording.note}\n` : '') +
        `  page   ${app.url}\n` +
        `  speed  ${speed}\n` +
        `  stop   ctrl+c\n\n`,
    );
  }
  if (parsed.open) openBrowser(app.url);

  await app.exited;
  await waitForStop();
  await app.close();
  return 0;
}

/**
 * Layer the redaction rules: defaults, then the config file, then the flags.
 *
 * `names` can only grow — a config file cannot remove `password` from the list,
 * because that is the one mistake this feature must make impossible. `allow` is
 * the escape hatch, and it wins at match time.
 */
function resolveRedact(parsed: CliOptions): { config: RedactConfig } | { error: string } {
  let fromFile: Partial<RedactConfig> | undefined;
  if (parsed.config) {
    const loaded = loadRedactConfig(parsed.config);
    if (!loaded.ok) return { error: loaded.error };
    fromFile = loaded.config;
  }
  const config = mergeConfig(defaultConfig(), fromFile, { names: parsed.redact, allow: parsed.allow });
  return { config };
}

/** Resolve on ctrl+c / SIGTERM, or after `timeoutMs` when running unattended. */
function waitForStop(timeoutMs = 0): Promise<void> {
  return new Promise<void>((resolveStop) => {
    if (timeoutMs > 0) {
      const timer = setTimeout(resolveStop, timeoutMs);
      timer.unref?.();
    }
    const stop = (): void => resolveStop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // `start` wants an empty title argument first; windowsHide keeps the
      // console from flashing while the browser window still opens.
      spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* the URL was printed anyway */
  }
}

// Entry detection without `import.meta.url`, which is unreliable in a bundled
// CJS single-file build. Two cases matter:
//   - packaged exe: `execPath` is NDebug.exe, not node  -> always the entry;
//   - from source:  `node cli.ts`                        -> argv[1] ends with cli.ts.
// A test that imports `parseArgs` from this file is neither, so it stays quiet.
const argv1 = process.argv[1] ?? '';
const runningNode = /(^|[\\/])node(\.exe)?$/i.test(process.execPath);
const thisFile = /(^|[\\/])cli\.(ts|js|mjs|cjs)$/i.test(argv1);
if (!runningNode || thisFile) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
