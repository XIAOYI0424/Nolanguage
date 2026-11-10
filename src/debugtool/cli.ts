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
import { startDebugApp } from './main.js';

const USAGE = `ndebug — live debug observatory

  ndebug <script.py> [options] [-- args for the program]

Options:
  --port <n>    page port (default 7320, 0 = pick one)
  --hz <n>      samples per second (default 10)
  --no-open     do not open a browser
  --quiet       no banner
  -h, --help    this text

Examples:
  ndebug app.py
  ndebug app.py --hz 20 --port 7400
  ndebug app.py -- 60
`;

interface CliOptions {
  script: string;
  port: number;
  hz: number;
  open: boolean;
  quiet: boolean;
  args: string[];
}

export function parseArgs(argv: string[]): CliOptions | { help: true } | { error: string } {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) return { help: true };

  const dashAt = argv.indexOf('--');
  const own = dashAt >= 0 ? argv.slice(0, dashAt) : argv.slice();
  const extra = dashAt >= 0 ? argv.slice(dashAt + 1) : [];
  const script = own.shift();
  if (!script) return { error: 'no script given' };

  let port = 7320;
  let hz = 10;
  let open = true;
  let quiet = false;

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
    }
    else if (a === '--no-open') open = false;
    else if (a === '--quiet') quiet = true;
    else return { error: `unknown option: ${a}` };
  }
  return { script, port, hz, open, quiet, args: extra };
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
    const app = await startDebugApp({
      script: parsed.script,
      port: parsed.port,
      hz: parsed.hz,
      open: false,
      args: parsed.args,
      quiet: parsed.quiet,
    });

    if (!parsed.quiet) {
      process.stdout.write(
        `\n  ndebug · observing ${basename(resolve(parsed.script))}\n` +
          `  page   ${app.url}\n` +
          `  agent  port ${app.session.boundPort} · ${parsed.hz} Hz\n` +
          `  stop   ctrl+c\n\n`,
      );
    }
    if (parsed.open) openBrowser(app.url);

    const code = await app.exited;
    if (!parsed.quiet) {
      process.stdout.write(`\n  target exited (${code}) — the page keeps the last state; ctrl+c to quit\n`);
    }

    // Stay up: the last stacks before a crash are usually the interesting ones,
    // and closing the page out from under the user is hostile.
    await new Promise<void>((resolveStop) => {
      const stop = (): void => resolveStop();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await app.close();
    return code;
  } catch (err) {
    process.stderr.write(`ndebug: ${(err as Error).message}\n`);
    return 1;
  }
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
