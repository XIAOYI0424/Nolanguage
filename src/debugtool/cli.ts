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
import { startDebugApp, startReplayApp } from './main.js';
import { describeRecording } from './recorder.js';

const USAGE = `ndebug — live debug observatory

  ndebug <script.py> [options] [-- args for the program]
  ndebug --replay <session.ndlog> [options]

Options:
  --port <n>      page port (default 7320, 0 = pick one)
  --hz <n>        samples per second (default 10)
  --record <file> write the session to a .ndlog (replayable)
  --replay <file> play a recording instead of observing a program
  --speed <n>     replay speed: 1 = real time, 0 = as fast as possible
  --no-open       do not open a browser
  --quiet         no banner
  -h, --help      this text

Examples:
  ndebug app.py
  ndebug app.py --hz 20 --port 7400
  ndebug app.py --record crash.ndlog -- 60
  ndebug --replay crash.ndlog --speed 4
`;

export interface CliOptions {
  mode: 'live' | 'replay';
  /** Live: the script to observe. Replay: empty. */
  script: string;
  /** Replay: the recording. Live: empty. */
  file: string;
  port: number;
  hz: number;
  /** Replay only; 1 = real time, 0 = instant. */
  speed: number;
  open: boolean;
  quiet: boolean;
  args: string[];
  record?: string;
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
  let replay = '';
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
    } else if (a === '--no-open') open = false;
    else if (a === '--quiet') quiet = true;
    else if (a.startsWith('-')) return { error: `unknown option: ${a}` };
    else positionals.push(a);
  }

  if (replay) {
    if (positionals.length) {
      // Two targets in one command is a mistake worth naming: silently preferring
      // one of them would hide a typo in the other.
      return { error: `--replay takes no script (got ${positionals[0]})` };
    }
    if (extra.length) return { error: '--replay takes no program arguments' };
    return { mode: 'replay', script: '', file: replay, port, hz, speed, open, quiet, args: [] };
  }

  const script = positionals.shift();
  if (!script) return { error: 'no script given' };
  if (positionals.length) return { error: `unexpected argument: ${positionals[0]}` };
  return {
    mode: 'live',
    script,
    file: '',
    port,
    hz,
    speed,
    open,
    quiet,
    args: extra,
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

  try {
    if (parsed.mode === 'replay') return await runReplay(parsed);

    const app = await startDebugApp({
      script: parsed.script,
      port: parsed.port,
      hz: parsed.hz,
      open: false,
      args: parsed.args,
      quiet: parsed.quiet,
      ...(parsed.record ? { record: parsed.record } : {}),
    });

    if (!parsed.quiet) {
      const rec = app.recorder?.stats();
      process.stdout.write(
        `\n  ndebug · observing ${basename(resolve(parsed.script))}\n` +
          `  page   ${app.url}\n` +
          `  agent  port ${app.session.boundPort} · ${parsed.hz} Hz\n` +
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
