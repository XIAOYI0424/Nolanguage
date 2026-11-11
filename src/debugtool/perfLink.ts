/**
 * The jump from a live debug session to the engine's Performance page.
 *
 * These are two different tools looking at the same minute. ndebug knows *what
 * the code was doing* (a stack, at a timestamp); `/perf` knows *what the engine
 * was doing* (a metric, at a timestamp). Sending a time window across is the
 * only thing that connects them without inventing a shared id neither side has.
 *
 * Two rules, because a link that lies is worse than no link:
 *
 *   1. **Only http(s).** The address comes from the environment, and a `file:`
 *      or `javascript:` URL in an `href` is a script execution vector.
 *   2. **A window, not a guess.** Both ends must be finite and ordered; if they
 *      are not, there is no link rather than a broken one.
 */
export interface PerfLinkOptions {
  /** Start of the window, epoch milliseconds. */
  from: number;
  /** End of the window, epoch milliseconds. */
  to: number;
  /** Who is asking (`ndebug:<session>`), shown in the banner on the far side. */
  src: string;
}

/**
 * Build the URL, or `null` when the inputs cannot make an honest one.
 *
 * Returning null rather than throwing is deliberate: a missing engine is the
 * normal case for a standalone tool, and the caller's job is to hide the link.
 */
export function perfLink(engineUrl: string, opts: PerfLinkOptions): string | null {
  const base = normaliseEngineUrl(engineUrl);
  if (!base) return null;

  const { from, to } = opts;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from <= 0 || to < from) return null;

  const params = new URLSearchParams({
    from: String(Math.round(from)),
    to: String(Math.round(to)),
    src: opts.src,
  });
  return `${base}/perf?${params.toString()}`;
}

/**
 * `http://127.0.0.1:7310/` -> `http://127.0.0.1:7310`, or null.
 *
 * A trailing slash, a path, or a hash would all produce a URL like
 * `http://host//perf` or `http://host/some/path/perf`; normalising here keeps the
 * one place that builds links from having to think about it.
 */
export function normaliseEngineUrl(input: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/** Read a window out of a query string. Returns null unless both ends are sane. */
export function parseWindow(search: string): { from: number; to: number; src: string } | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to < from) return null;
  return { from, to, src: params.get('src') ?? '' };
}
