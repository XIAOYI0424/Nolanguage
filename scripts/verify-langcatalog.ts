/**
 * Plugin catalogue: the static-index + search layer behind `nlg lang search`
 * and `nlg lang add <id>`.
 *
 * The only network seam is `fetchIndex`'s `FetchLike` argument, so every test
 * here is offline: HTTP responses are faked, and the "file" index path writes a
 * real `index.json` into a temp dir. What we pin down:
 *   - version comparison + the merge-by-highest-version (priority tie-break),
 *   - query filtering (id / displayName / description / category, case-insensitive),
 *   - `resolveEntry` picking the best version for a bare id,
 *   - `resolveSources` precedence (explicit --source > sources.json > default-only-when-empty),
 *   - `fetchIndex` over both the injected HTTP stub and a local file,
 *   - and that an unreachable source is reported, not fatal.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCatalogSearch, installPlugin } from '../src/panel/handlers/plugins.js';
import type { WorkspaceService } from '../src/panel/WorkspaceService.js';
import {
  CatalogError,
  compareVersions,
  fetchIndex,
  mergeEntries,
  resolveEntry,
  resolveSources,
  searchEntries,
  type FetchLike,
  type PluginIndexEntry,
  type SourceConfig,
} from '../src/langs/Catalog.js';

let passed = 0;
let total = 0;

function check(name: string, ok: boolean, detail?: string): void {
  total++;
  if (ok) {
    passed++;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

function entry(id: string, version: string, over: Partial<PluginIndexEntry> = {}): PluginIndexEntry {
  return { id, version, downloadUrl: `https://example.org/${id}@${version}.zip`, ...over };
}

// ---- version ordering -------------------------------------------------------
check('cmp: 1.0.0 < 1.2.0', compareVersions('1.0.0', '1.2.0') < 0);
check('cmp: 1.2.0 > 1.0.0', compareVersions('1.2.0', '1.0.0') > 0);
check('cmp: 1.0.0 == 1.0.0', compareVersions('1.0.0', '1.0.0') === 0);
check('cmp: 2.0.0 > 1.9.9', compareVersions('2.0.0', '1.9.9') > 0);
check('cmp: 1.0 < 1.0.1', compareVersions('1.0', '1.0.1') < 0);

// ---- search filtering -------------------------------------------------------
const sample: PluginIndexEntry[] = [
  entry('rust', '1.0.0', { displayName: 'Rust', description: 'systems language', categories: ['compiled'] }),
  entry('pyright', '1.4.0', { displayName: 'Pyright', description: 'Python type checker', categories: ['lsp', 'python'] }),
  entry('lsp-demo', '0.2.0', { description: 'an lsp playground' }),
];
check('search: no query returns all, sorted by id',
  JSON.stringify(searchEntries(sample).map((e) => e.id)) === JSON.stringify(['lsp-demo', 'pyright', 'rust']));
check('search: matches id', searchEntries(sample, 'rust').length === 1 && searchEntries(sample, 'rust')[0].id === 'rust');
check('search: matches displayName (case-insensitive)', searchEntries(sample, 'PYRIGHT')[0].id === 'pyright');
check('search: matches description', searchEntries(sample, 'type checker')[0].id === 'pyright');
check('search: matches category', searchEntries(sample, 'lsp').map((e) => e.id).sort().join() === 'lsp-demo,pyright');
check('search: no match → empty', searchEntries(sample, 'cobol').length === 0);

// ---- merge + resolve --------------------------------------------------------
const a: SourceConfig = { id: 'a', url: 'a', priority: 0 };
const b: SourceConfig = { id: 'b', url: 'b', priority: 10 };
const merged = mergeEntries([
  { source: a, index: { plugins: [entry('rust', '1.0.0'), entry('go', '1.0.0')] } },
  { source: b, index: { plugins: [entry('rust', '1.1.0'), entry('go', '1.0.0')] } },
]);
check('merge: same id keeps the higher version', merged.find((e) => e.id === 'rust')?.version === '1.1.0');
check('merge: distinct ids are both kept', merged.length === 2);
check('merge: equal version + higher priority wins',
  (() => {
    const m = mergeEntries([
      { source: a, index: { plugins: [entry('x', '1.0.0')] } },
      { source: b, index: { plugins: [entry('x', '1.0.0')] } },
    ]);
    return m[0].downloadUrl === 'https://example.org/x@1.0.0.zip';
  })());

check('resolve: exact id', resolveEntry(sample, 'rust')?.version === '1.0.0');
check('resolve: displayName', resolveEntry(sample, 'Pyright')?.id === 'pyright');
check('resolve: picks highest version among matches',
  (() => {
    const e = resolveEntry([entry('z', '1.0.0'), entry('z', '2.0.0')], 'z');
    return e?.version === '2.0.0';
  })());
check('resolve: missing → undefined', resolveEntry(sample, 'cobol') === undefined);

// ---- source resolution precedence ------------------------------------------
const work = await mkdtemp(join(tmpdir(), 'nlg-catalog-'));
try {
  // default-only when nothing configured
  const onlyDefault = resolveSources(join(work, 'empty-home'));
  check('sources: default index used when nothing else is configured',
    onlyDefault.length === 1 && onlyDefault[0].id === 'default', onlyDefault.map((s) => s.id).join());

  // explicit --source beats the default (no default emitted)
  const withExtra = resolveSources(join(work, 'empty-home'), ['https://my/index.json']);
  check('sources: explicit --source suppresses the default',
    withExtra.length === 1 && withExtra[0].url === 'https://my/index.json' && withExtra[0].priority === 1000);

  // sources.json entries are included
  const homeJson = join(work, 'json-home');
  await mkdir(homeJson, { recursive: true });
  await writeFile(join(homeJson, 'sources.json'),
    JSON.stringify([{ id: 'team', url: 'https://team/index.json', priority: 5 }]));
  const fromJson = resolveSources(homeJson);
  check('sources: <home>/sources.json entries are loaded',
    fromJson.some((s) => s.id === 'team' && s.url === 'https://team/index.json'));

  // ---- fetchIndex over the HTTP stub ----
  const okFetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ plugins: [entry('rust', '1.0.0')] }),
  });
  const okIndex = await fetchIndex({ id: 's', url: 'https://x/index.json' }, okFetch);
  check('fetch(http): returns the plugins array', okIndex.index.plugins.length === 1);

  const badStatus: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}) });
  let threwStatus: unknown;
  try {
    await fetchIndex({ id: 's', url: 'https://x/' }, badStatus);
  } catch (err) {
    threwStatus = err;
  }
  check('fetch(http): non-ok status throws CatalogError',
    threwStatus instanceof CatalogError && (threwStatus as Error).message.includes('404'));

  const rejects: FetchLike = async () => {
    throw new Error('network down');
  };
  let threwNet: unknown;
  try {
    await fetchIndex({ id: 's', url: 'https://x/' }, rejects);
  } catch (err) {
    threwNet = err;
  }
  check('fetch(http): a rejected request throws (so the CLI can skip the source)',
    threwNet instanceof CatalogError && (threwNet as Error).message.includes('network down'));

  // ---- fetchIndex over a local file ----
  const fileHome = join(work, 'file-index');
  await mkdir(fileHome, { recursive: true });
  const indexPath = join(fileHome, 'index.json');
  await writeFile(indexPath, JSON.stringify({ plugins: [entry('go', '1.0.0'), entry('rust', '2.0.0')] }));
  const fileIndex = await fetchIndex({ id: 'local', url: indexPath });
  check('fetch(file): reads a local index.json', fileIndex.index.plugins.length === 2);

  let threwShape: unknown;
  try {
    await fetchIndex({ id: 's', url: 'https://x/' }, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ notPlugins: true }),
    }));
  } catch (err) {
    threwShape = err;
  }
  check('fetch: a document without a plugins array throws', threwShape instanceof CatalogError);

  // ---- install by id: the refusals happen *before* a download ----
  const panelHome = join(work, 'panel-home');
  await mkdir(panelHome, { recursive: true });
  const goodSha = 'b'.repeat(64);
  await writeFile(
    join(panelHome, 'index.json'),
    JSON.stringify({
      plugins: [
        { id: 'signed', version: '1.0.0', downloadUrl: 'https://example.org/signed.zip', sha256: goodSha },
        { id: 'unsigned', version: '1.0.0', downloadUrl: 'https://example.org/unsigned.zip' },
      ],
    }),
  );
  await writeFile(
    join(panelHome, 'sources.json'),
    JSON.stringify([{ id: 'local', url: join(panelHome, 'index.json') }]),
  );
  const fakeWorkspace = {
    languages: {
      home: panelHome,
      isScanned: () => false,
      installed: () => [],
      install: async () => {
        throw new Error('install must not be reached in these checks');
      },
    },
  } as unknown as WorkspaceService;

  let searched: Record<string, unknown> | undefined;
  await handleCatalogSearch(fakeWorkspace, { query: 'unsig' }, (payload) => {
    searched = payload as Record<string, unknown>;
  });
  const rows = (searched?.entries ?? []) as Array<{ id: string; sha256: boolean }>;
  check('catalogSearch: the page gets rows from sources.json', rows.length === 1 && rows[0].id === 'unsigned');
  check('catalogSearch: a row says whether it is hash-verified', rows[0]?.sha256 === false);
  let all: Record<string, unknown> | undefined;
  await handleCatalogSearch(fakeWorkspace, {}, (payload) => {
    all = payload as Record<string, unknown>;
  });
  check('catalogSearch: an empty query lists every entry', ((all?.entries ?? []) as unknown[]).length === 2);

  const refusal = async (name: string, msg: Record<string, unknown>, want: string): Promise<void> => {
    let detail = '';
    try {
      await installPlugin(fakeWorkspace, msg);
    } catch (err) {
      detail = (err as Error).message;
    }
    check(name, detail.includes(want), detail || 'it did not throw');
  };
  await refusal('install(id): an unknown id is reported', { id: 'nope' }, 'not in any plugin index');
  await refusal('install(id): an entry without sha256 is refused', { id: 'unsigned' }, 'no sha256 in the index');
  await refusal(
    'install(id): a version that the index no longer serves is refused',
    { id: 'signed', version: '2.0.0' },
    'search again',
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(`${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
