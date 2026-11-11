/**
 * Redaction rules: the pure part, plus what they do to a real tree.
 *
 * The point of this suite is the two failures the old hard-coded list had:
 * a name nobody could add (false negative), and a name nobody could exempt
 * (false positive). Both are asserted here, because both are silent in
 * production — a leaked secret looks like a normal field, and an over-redacted
 * one looks like a cautious tool.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-redact.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_REDACT,
  defaultConfig,
  describeConfig,
  isSensitiveName,
  loadRedactConfig,
  mergeConfig,
  normaliseList,
  parseConfig,
} from '../src/debugtool/redact.js';
import { serializeJs } from '../src/debugtool/serializer.js';
import type { SNode } from '../src/debugtool/protocol.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ------------------------------------------------------------ 1. the defaults

{
  const base = defaultConfig();
  check('defaults: a token field is sensitive', isSensitiveName('api_token', base));
  check('defaults: a password field is sensitive', isSensitiveName('db_password_hash', base));
  check('defaults: a normal field is not', !isSensitiveName('price', base));
  check('defaults: matching is case-insensitive', isSensitiveName('API_TOKEN', base));
  check('defaults: there is no allowlist', base.allow.length === 0);
  check('defaults: every default name is lower-case', DEFAULT_REDACT.every((n) => n === n.toLowerCase()), DEFAULT_REDACT.join(','));
}

// ------------------------------------------------------------ 2. the allowlist

{
  // The false positive that made people distrust the tool: a *count* of tokens
  // is not a token.
  const cfg = mergeConfig(defaultConfig(), { allow: ['token_count'] });
  check('allow: an exempted field is visible', !isSensitiveName('token_count', cfg));
  check('allow: the field it would have matched is still hidden', isSensitiveName('api_token', cfg));
  check('allow: a partial name also exempts', !isSensitiveName('my_token_count_total', cfg));
  check('allow: matching is case-insensitive', !isSensitiveName('Token_Count', cfg));
}

{
  // An allowlist entry that matches everything would disable redaction entirely;
  // that is the user's call, but it must be an explicit one.
  const cfg = mergeConfig(defaultConfig(), { allow: ['a'] });
  check('allow: a broad entry really does exempt broadly', !isSensitiveName('api_token', cfg));
}

// ------------------------------------------------------------ 3. adding names

{
  const cfg = mergeConfig(defaultConfig(), { names: ['sessionid', 'x-api-key'] });
  check('names: a custom name is redacted', isSensitiveName('sessionid', cfg));
  check('names: a custom name with punctuation works', isSensitiveName('x-api-key', cfg));
  check('names: the defaults survive', isSensitiveName('password', cfg));
}

{
  // A config file must not be able to un-redact `password` by omission: `names`
  // only accumulates. Getting this wrong is how a "config" becomes a leak.
  const cfg = mergeConfig(defaultConfig(), { names: ['sessionid'] });
  check('names: merging never removes a default', isSensitiveName('password', cfg) && cfg.names.length > DEFAULT_REDACT.length, String(cfg.names.length));
  const merged = mergeConfig(defaultConfig(), { names: ['password'] });
  check('names: a duplicate is not added twice', merged.names.filter((n) => n === 'password').length === 1);
}

// ------------------------------------------------------------ 4. normalising

{
  check('normalise: trims and lower-cases', normaliseList([' Token ', 'API_KEY']).join(',') === 'token,api_key');
  check('normalise: drops empties and duplicates', normaliseList(['a', '', '  ', 'a', 'b']).join(',') === 'a,b');
  check('normalise: tolerates undefined', normaliseList(undefined).length === 0);
}

// ------------------------------------------------------------ 5. config files

{
  const arrayForm = parseConfig({ redact: ['sessionid'] });
  check('config: the array shorthand means names', arrayForm.ok && arrayForm.config.names.join(',') === 'sessionid' && arrayForm.config.allow.length === 0);

  const objectForm = parseConfig({ redact: { names: ['sessionid'], allow: ['token_count'] } });
  check('config: the object form carries both lists', objectForm.ok && objectForm.config.names.join(',') === 'sessionid' && objectForm.config.allow.join(',') === 'token_count');

  const empty = parseConfig({});
  check('config: an empty object is valid', empty.ok && empty.config.names.length === 0);

  const badType = parseConfig({ redact: 'nope' });
  check('config: a non-array redact is an error', !badType.ok && /must be an array/.test(badType.error), badType.ok ? '' : badType.error);

  const badEntry = parseConfig({ redact: [1, 2] });
  check('config: a non-string entry is an error', !badEntry.ok, badEntry.ok ? '' : badEntry.error);

  const unknown = parseConfig({ redact: { name: ['x'] } });
  check('config: a misspelled key is an error, not a no-op', !unknown.ok && /unknown key/.test(unknown.error), unknown.ok ? '' : unknown.error);

  const notObject = parseConfig([]);
  check('config: a top-level array is refused', !notObject.ok);
}

{
  const dir = mkdtempSync(join(tmpdir(), 'nlg-cfg-'));
  try {
    const good = join(dir, 'ndebug.json');
    writeFileSync(good, JSON.stringify({ redact: { names: ['sessionid'], allow: ['token_count'] } }), 'utf8');
    const loaded = loadRedactConfig(good);
    check('file: a valid config loads', loaded.ok && loaded.config.names.join(',') === 'sessionid', loaded.ok ? '' : loaded.error);

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json', 'utf8');
    const badJson = loadRedactConfig(broken);
    check('file: invalid JSON is reported with the path', !badJson.ok && badJson.error.includes('broken.json'), badJson.ok ? '' : badJson.error);

    const missing = loadRedactConfig(join(dir, 'nope.json'));
    check('file: a missing file is an error, not "defaults"', !missing.ok && /cannot read/.test(missing.error), missing.ok ? '' : missing.error);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
  }
}

// ------------------------------------------------------------ 6. real trees

{
  const field = (node: SNode, name: string): SNode | undefined => (node.k === 'obj' ? node.fields.find(([k]) => k === name)?.[1] : undefined);

  const cfg = mergeConfig(defaultConfig(), { allow: ['token_count'], names: ['sessionid'] });
  const tree = serializeJs(
    { api_token: 'sk-live', token_count: 3, sessionid: 'abc', price: 9.5 },
    { ...{ maxDepth: 6, maxItems: 50, maxString: 512, maxNodes: 5000 }, redact: cfg.names, redactAllow: cfg.allow },
  );

  const token = field(tree, 'api_token');
  check('tree: a matching field is redacted', token?.k === 'trunc' && token.why === 'redacted', token?.k === 'trunc' ? token.why : String(token?.k));
  const count = field(tree, 'token_count');
  check('tree: an exempted field keeps its value', count?.k === 'prim' && count.v === '3', count?.k === 'prim' ? count.v : String(count?.k));
  const session = field(tree, 'sessionid');
  check('tree: a custom name is redacted', session?.k === 'trunc' && session.why === 'redacted', session?.k === 'trunc' ? session.why : String(session?.k));
  const price = field(tree, 'price');
  check('tree: an unrelated field is untouched', price?.k === 'prim' && price.v === '9.5', price?.k === 'prim' ? price.v : String(price?.k));
}

{
  // Without an allowlist the same tree hides the count too — the behaviour the
  // allowlist exists to change.
  const tree = serializeJs(
    { api_token: 'sk-live', token_count: 3 },
    { maxDepth: 6, maxItems: 50, maxString: 512, maxNodes: 5000, redact: defaultConfig().names },
  );
  const count = tree.k === 'obj' ? tree.fields.find(([k]) => k === 'token_count')?.[1] : undefined;
  check('tree: without an allowlist the count is hidden', count?.k === 'trunc', count?.k ?? '');
}

// ------------------------------------------------------------ 7. the banner

{
  check('banner: counts both lists', describeConfig({ names: ['a', 'b'], allow: ['c'] }) === '2 redacted names, 1 exempt', describeConfig({ names: ['a', 'b'], allow: ['c'] }));
  check('banner: singular reads correctly', describeConfig({ names: ['a'], allow: [] }) === '1 redacted name', describeConfig({ names: ['a'], allow: [] }));
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = 1;
}
