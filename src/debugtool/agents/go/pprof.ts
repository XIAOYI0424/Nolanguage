/**
 * Go support without injecting anything.
 *
 * Go has no `sitecustomize`, no `--require`, and no way to install a hook into a
 * running process from outside. What it *does* have is `net/http/pprof`: any
 * program that serves an HTTP mux with the pprof handlers will answer
 * `GET /debug/pprof/goroutine?debug=2` with a full textual dump of every
 * goroutine and its stack. Polling that endpoint is the only honest way to watch
 * a Go program without editing it, so that is what this module parses.
 *
 * Three consequences, all stated rather than hidden:
 *
 *   1. **It polls; it does not sample in-process.** The rate is bounded by HTTP
 *      round-trips, and the dump is a snapshot of *all* goroutines at one
 *      instant, not a 100 Hz timer.
 *   2. **There are no values.** A pprof dump carries stacks only, so `caps` is
 *      `['stack']` and the page says so instead of showing an empty panel.
 *   3. **The dump includes the goroutine that produced it.** Left in, the
 *      observatory's own HTTP handler is the hottest stack on every page — the
 *      same self-sampling trap the Python and JS agents had to filter.
 *
 * The format is `runtime.Stack(all=true)` output: blocks separated by a blank
 * line, each starting with `goroutine <id> [<state>]:`, then alternating
 * function / `\tfile:line +0xoffset` lines. `created by ...` and
 * `...additional frames elided...` are markers, not frames.
 */
import type { Frame, ThreadState } from '../../protocol.js';

export interface GoGoroutine {
  id: number;
  state: ThreadState;
  /** Raw bracket text (`IO wait`, `sleep`, `chan receive`), for diagnosis. */
  wait: string;
  /** Innermost last, matching the protocol's convention. */
  frames: Frame[];
}

export interface ParseOptions {
  /** Goroutines kept per dump (default 200). */
  maxGoroutines?: number;
  /** Frames kept per goroutine (default 12, same as the session). */
  maxFrames?: number;
}

const DEFAULT_MAX_GOROUTINES = 200;
const DEFAULT_MAX_FRAMES = 12;

/**
 * Normalise anything the user might paste into the dump URL.
 *
 * `http://host:6060`, `http://host:6060/debug/pprof`, and the full
 * `.../goroutine?debug=2` all mean the same thing; guessing wrong would fail
 * with a 404 that looks like "pprof is not enabled".
 */
export function pprofUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('empty pprof address');
  // Any `scheme://` prefix is taken at face value and then checked; only a bare
  // host gets `http://` added. Testing for `^https?://` alone would turn
  // `ftp://box:21` into `http://ftp://box:21`, which parses as host "ftp".
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const withScheme = hasScheme ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`not an http(s) address: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http(s) is supported (got ${url.protocol})`);
  }
  // Rebuild rather than append, so `/debug/pprof/`, `/debug/pprof/goroutine` and
  // a URL that already carries `?debug=2` all collapse to one address.
  url.pathname = '/debug/pprof/goroutine';
  url.search = '?debug=2';
  url.hash = '';
  return url.toString();
}

/**
 * `net/http.(*Server).Serve(0x3e25, {0x7ff7})` -> `http.(*Server).Serve`.
 *
 * Two strips, in this order and for different reasons:
 *
 *   - the argument list is dropped first, because it is addresses and would make
 *     two calls of the same function look like different frames;
 *   - then the module path, so `github.com/x/y.(*S).M` reads as `y.(*S).M`.
 *
 * The sampler check below needs the *full* name, so it runs before this.
 */
function shortFunc(name: string): string {
  const call = name.lastIndexOf('(');
  const bare = call > 0 ? name.slice(0, call) : name;
  const cut = bare.lastIndexOf('/');
  return cut >= 0 ? bare.slice(cut + 1) : bare;
}

/** `net/http.(*Server).Serve` -> `http.(*Server).Serve` (kept for readability). */
function withoutArgs(name: string): string {
  const call = name.lastIndexOf('(');
  return call > 0 ? name.slice(0, call) : name;
}

/** `D:/Go lang/src/runtime/pprof/pprof.go` -> `pprof.go`. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * `[running]` -> running, `[runnable]` -> idle, anything else -> blocked.
 *
 * `runnable` is deliberately *not* `running`: it means "ready but waiting for a
 * CPU", so counting it as running would make the stall detector fire on a
 * perfectly healthy program. `sleep`/`IO wait`/`chan receive` are all "waiting
 * for something", which is what `blocked` means here.
 */
function stateOf(wait: string): ThreadState {
  if (wait === 'running') return 'running';
  if (wait === 'runnable') return 'idle';
  return 'blocked';
}

/**
 * True when this goroutine is the pprof handler that produced the dump.
 *
 * Checked against the *full* name before shortening, because `shortFunc` turns
 * `net/http/pprof.Index` into `pprof.Index` — which no longer says it is the
 * handler, and would leave the observatory's own request as the hottest stack.
 */
function isSamplerName(full: string): boolean {
  const bare = withoutArgs(full);
  return bare.startsWith('runtime/pprof.writeGoroutine') || bare.startsWith('net/http/pprof.');
}

/**
 * Parse a `debug=2` goroutine dump.
 *
 * Unparseable blocks are skipped rather than throwing: a dump from a different
 * Go version that adds a line should cost that goroutine, not the whole sample.
 */
export function parseGoroutineDump(text: string, opts: ParseOptions = {}): GoGoroutine[] {
  const maxGoroutines = opts.maxGoroutines ?? DEFAULT_MAX_GOROUTINES;
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;

  const out: GoGoroutine[] = [];
  const header = /^goroutine\s+(\d+)\s+\[([^\]]*)\]:\s*$/;

  let current: GoGoroutine | undefined;
  let pendingFunc: string | undefined;
  let sampler = false;

  const flush = (): void => {
    if (!current) return;
    // The dump lists innermost first; the protocol wants innermost last.
    current.frames.reverse();
    if (current.frames.length > maxFrames) current.frames = current.frames.slice(-maxFrames);
    if (current.frames.length && !sampler && out.length < maxGoroutines) out.push(current);
    current = undefined;
    sampler = false;
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      pendingFunc = undefined;
      continue;
    }

    const head = header.exec(trimmed);
    if (head) {
      flush();
      pendingFunc = undefined;
      sampler = false;
      // `[chan receive, 9 minutes]` — the duration is not the state.
      const wait = head[2].split(',')[0].trim();
      current = { id: Number(head[1]), state: stateOf(wait), wait, frames: [] };
      continue;
    }

    if (!current) continue;

    // `created by X in goroutine N` describes the creator, not this stack.
    if (trimmed.startsWith('created by ')) {
      pendingFunc = undefined;
      continue;
    }
    if (trimmed.startsWith('...')) {
      pendingFunc = undefined;
      continue;
    }

    // A tab (or leading whitespace) means the `file:line +0x` line that belongs
    // to the function named on the previous line.
    if (/^\s/.test(line)) {
      if (!pendingFunc) continue;
      const loc = /^(.+?):(\d+)(?:\s+\+0x[0-9a-f]+)?$/i.exec(trimmed);
      if (!loc) {
        pendingFunc = undefined;
        continue;
      }
      if (isSamplerName(pendingFunc)) sampler = true;
      current.frames.push({ fn: shortFunc(pendingFunc), file: baseName(loc[1]), line: Number(loc[2]) });
      pendingFunc = undefined;
      continue;
    }

    // Anything else is a function line; the next indented line locates it.
    pendingFunc = trimmed;
  }
  flush();

  return out;
}

/**
 * One dump -> the stack events the session ingests.
 *
 * Emitted through the same NDJSON path a real agent uses, so a Go sample is
 * validated, recorded and replayed exactly like a Python one.
 */
export function dumpToStackLines(goroutines: GoGoroutine[], at: number): string[] {
  return goroutines.map((g) =>
    JSON.stringify({ v: 1, t: 'stack', at, tid: g.id, state: g.state, frames: g.frames }),
  );
}
