/**
 * The plugin *catalogue* — the "library" layer the `/plugins` page and
 * `nlg lang search` share.
 *
 * It deliberately does **not** invent a backend. An index is a static
 * `index.json` (a plain file or an `https://` URL) listing concrete plugin
 * packages with their `downloadUrl` + `sha256`. Multiple sources coexist via a
 * `sources.json` (or `--source` flags), merged by id with the highest version
 * winning. This is the lightweight stand-in for the full "extension market"
 * the roadmap cut: no search server, no accounts, no ratings — just JSON.
 *
 * Everything here is pure and side-effect-free except `fetchIndex`, which is
 * the single seam that touches the network (or the filesystem for a local
 * index). Tests inject a stub through that seam, so none of them hit the wire.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** One installable package as advertised by an index. */
export interface PluginIndexEntry {
  id: string;
  displayName?: string;
  version: string;
  publisher?: string;
  description?: string;
  categories?: string[];
  /** The engine API this build of the package was built against. */
  apiVersion?: string;
  /** Host runtimes it needs (e.g. `template@^1.0.0`) — not installable plugins. */
  requires?: string[];
  /** Concrete URL `nlg lang add` can hand to the source resolver. */
  downloadUrl: string;
  sha256?: string;
  updatedAt?: string;
}

/** The shape of a `index.json` document. */
export interface PluginIndex {
  updatedAt?: string;
  plugins: PluginIndexEntry[];
}

/** A place to read an index from. */
export interface SourceConfig {
  id: string;
  url: string;
  /** Higher wins ties when two sources advertise the same id@version. */
  priority?: number;
}

export class CatalogError extends Error {}

/**
 * The built-in default index. It is a *placeholder* — there is no server yet.
 * `search` degrades gracefully when it is unreachable; real deployments point
 * `sources.json` / `--source` at their own index instead.
 */
export const DEFAULT_INDEX_URL = 'https://plugins.nolanguage.dev/index.json';

/** Minimal fetch surface so tests can inject a deterministic stub. */
export interface FetchLike {
  (url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

const defaultFetch: FetchLike = (url) => {
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!f) throw new CatalogError(`global fetch is unavailable to read ${url}`);
  return f(url as unknown as URL) as unknown as Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
};

/**
 * Where to look for indexes, in priority order:
 *   1. `--source <url>` flags passed on the command line (highest priority),
 *   2. `<home>/sources.json` (a JSON array of {@link SourceConfig}),
 *   3. the {@link DEFAULT_INDEX_URL} — but only when nothing else is configured,
 *      so a deployment that lists its own sources is never polluted by the stub.
 */
export function resolveSources(home: string, extra: string[] = []): SourceConfig[] {
  const sources: SourceConfig[] = [];

  try {
    const raw = JSON.parse(readFileSync(join(home, 'sources.json'), 'utf8')) as unknown;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const s = item as Partial<SourceConfig>;
        if (s && typeof s.url === 'string') {
          sources.push({ id: s.id ?? s.url, url: s.url, priority: s.priority });
        }
      }
    }
  } catch {
    // No sources.json (or unreadable / not JSON) — fine; we fall back below.
  }

  for (const url of extra) {
    sources.push({ id: url, url, priority: 1000 });
  }

  if (!sources.length) {
    sources.push({ id: 'default', url: DEFAULT_INDEX_URL, priority: 0 });
  }
  return sources;
}

async function readIndexFromLocation(url: string, fetchImpl: FetchLike): Promise<PluginIndex> {
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new CatalogError(`index ${url} responded ${res.status}`);
      return (await res.json()) as PluginIndex;
    } catch (err) {
      if (err instanceof CatalogError) throw err;
      throw new CatalogError(`index ${url} could not be fetched: ${(err as Error).message}`);
    }
  }
  // Otherwise treat it as a filesystem path (optionally `file://`).
  const path = url.replace(/^file:\/\//i, '');
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  try {
    const text = await readFile(abs, 'utf8');
    return JSON.parse(text) as PluginIndex;
  } catch (err) {
    throw new CatalogError(`index ${url} could not be read: ${(err as Error).message}`);
  }
}

/** Fetch a single index. Throws {@link CatalogError} on transport or shape problems. */
export async function fetchIndex(
  source: SourceConfig,
  fetchImpl: FetchLike = defaultFetch,
): Promise<{ source: SourceConfig; index: PluginIndex }> {
  const index = await readIndexFromLocation(source.url, fetchImpl);
  if (!index || !Array.isArray(index.plugins)) {
    throw new CatalogError(`index ${source.url} has no "plugins" array`);
  }
  return { source, index };
}

/** Compare concrete versions: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Merge several indexes into one entry per plugin id. When two sources list the
 * same id, the higher version wins; on a version tie, the higher-priority
 * source wins. This is what lets a local override beat the default index.
 */
export function mergeEntries(
  sources: Array<{ source: SourceConfig; index: PluginIndex }>,
): PluginIndexEntry[] {
  const best = new Map<string, { entry: PluginIndexEntry; priority: number }>();
  for (const { source, index } of sources) {
    const prio = source.priority ?? 0;
    for (const e of index.plugins) {
      const cur = best.get(e.id);
      if (!cur) {
        best.set(e.id, { entry: e, priority: prio });
        continue;
      }
      const cmp = compareVersions(e.version, cur.entry.version);
      if (cmp > 0 || (cmp === 0 && prio > cur.priority)) {
        best.set(e.id, { entry: e, priority: prio });
      }
    }
  }
  return [...best.values()].map((b) => b.entry);
}

/** Filter + sort entries for `nlg lang search [query]`. Empty query lists all. */
export function searchEntries(entries: PluginIndexEntry[], query?: string): PluginIndexEntry[] {
  const q = query?.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) =>
        [e.id, e.displayName, e.description, ...(e.categories ?? [])]
          .filter((f): f is string => typeof f === 'string')
          .some((f) => f.toLowerCase().includes(q)),
      )
    : entries;
  return filtered.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Pick the best entry for a bare plugin id (id or displayName, case-insensitive),
 * preferring the highest version. Returns `undefined` when nothing matches — the
 * caller turns that into a clean "not found in any index" message.
 */
export function resolveEntry(
  entries: PluginIndexEntry[],
  id: string,
): PluginIndexEntry | undefined {
  const q = id.toLowerCase();
  const matches = entries.filter(
    (e) => e.id.toLowerCase() === q || e.displayName?.toLowerCase() === q,
  );
  if (!matches.length) return undefined;
  return matches.sort((a, b) => compareVersions(b.version, a.version))[0];
}
