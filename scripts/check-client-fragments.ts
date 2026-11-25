/**
 * The client fragments are not modules — they are text.
 *
 * `src/ui/pycharm-client.ts` joins `src/ui/client/*.js` into one IIFE and then
 * substitutes `${seed}` tokens with JSON. That is why the whole UI ships as a
 * single HTML file with no build step, and it is also why a stray character in a
 * comment can break the entire page: a backtick ends the enclosing literal the
 * fragments are stitched into, and an unknown `${…}` survives substitution and
 * lands in the page as a syntax error.
 *
 * `verify-pycharm.ts` already asserts both *after* assembling — by then the
 * failure reads "the page did not mount", with no file or line. This suite checks
 * the sources first, so the message is `50-runtime.js:812: backtick`.
 *
 * It also checks the two things the assembler cannot: that every `.js` file in
 * `src/ui/client/` is actually listed in `client-assets.ts` (an unlisted fragment
 * is silently never shipped), and that two fragments do not declare the same
 * IIFE-scope name (the second silently wins).
 *
 * The banned APIs (`eval`, `new Function`, `document.write`) turn "render some
 * markup" into "execute a string". Markup by concatenation is this codebase's
 * normal style (with `esc()`), so that is not flagged; executing strings never is
 * necessary here.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/check-client-fragments.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CLIENT_DIR = join(ROOT, 'src/ui/client');
const ASSETS = join(ROOT, 'src/ui/client-assets.ts');
const ASSEMBLER = join(ROOT, 'src/ui/pycharm-client.ts');

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Finding {
  file: string;
  line: number;
  what: string;
  text: string;
}

function report(hits: Finding[], limit = 6): string {
  return hits
    .slice(0, limit)
    .map((h) => `${h.file}:${h.line} ${h.text.slice(0, 70)}`)
    .join(' | ');
}

/** Seed names the assembler substitutes, read from the one declaration. */
function readSeeds(): string[] {
  const text = readFileSync(ASSEMBLER, 'utf8');
  const block = /const SEEDS[^=]*=\s*\[([\s\S]*?)\]/.exec(text);
  if (!block) return [];
  return [...block[1].matchAll(/'([A-Za-z0-9_$]+)'/g)].map((m) => m[1]);
}

/** Fragment files the assembler imports, in declaration order. */
function readListed(): string[] {
  const text = readFileSync(ASSETS, 'utf8');
  return [...text.matchAll(/from '\.\/client\/([^']+)\?raw'/g)].map((m) => m[1]);
}

function main(): void {
  let files: string[] = [];
  try {
    files = readdirSync(CLIENT_DIR)
      .filter((f) => f.endsWith('.js'))
      .sort();
  } catch (err) {
    console.error(`cannot read ${CLIENT_DIR}: ${(err as Error).message}`);
    process.exit(1);
  }
  check('client fragments exist', files.length > 0, `${files.length} fragment(s)`);

  const seeds = readSeeds();
  check('the assembler declares its seeds', seeds.length > 0, seeds.join(', ') || 'none found');

  const listed = readListed();
  const unlisted = files.filter((f) => !listed.includes(f));
  const missing = listed.filter((f) => !files.includes(f));
  check(
    'every fragment file is listed in client-assets.ts (an unlisted one never ships)',
    unlisted.length === 0,
    unlisted.length ? report(unlisted.map((f) => ({ file: f, line: 0, what: 'unlisted', text: '' }))) : `${listed.length} listed`,
  );
  check(
    'every imported fragment exists',
    missing.length === 0,
    missing.length ? missing.join(', ') : `${listed.length} resolved`,
  );

  const scanned: string[] = listed.filter((f) => files.includes(f));
  const findings: Finding[] = [];
  const decls = new Map<string, string[]>();

  for (const name of scanned) {
    const text = readFileSync(join(CLIENT_DIR, name), 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const at = i + 1;
      if (line.includes('`')) findings.push({ file: name, line: at, what: 'backtick', text: line.trim() });
      for (const token of line.matchAll(/\$\{([^}]*)\}/g)) {
        if (!seeds.includes(token[1].trim())) {
          findings.push({ file: name, line: at, what: 'unknown seed', text: line.trim() });
        }
      }
      // A `${` with no closing brace is just as fatal once substituted.
      if (line.includes('${') && !/\$\{[^}]*\}/.test(line)) {
        findings.push({ file: name, line: at, what: 'unterminated seed', text: line.trim() });
      }
      for (const banned of ['eval(', 'new Function(', 'document.write(']) {
        if (line.includes(banned)) findings.push({ file: name, line: at, what: banned, text: line.trim() });
      }
      // Fragments share one IIFE, whose top level is indented two spaces.
      const decl = /^ {2}(?:function|var|const|let)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (decl) {
        const list = decls.get(decl[1]) ?? [];
        list.push(name);
        decls.set(decl[1], list);
      }
    }
  }

  for (const what of ['backtick', 'unknown seed', 'unterminated seed', 'eval(', 'new Function(', 'document.write(']) {
    const hits = findings.filter((f) => f.what === what);
    const why =
      what === 'backtick'
        ? 'a backtick would end the literal the fragments are stitched into'
        : what.includes('seed')
          ? 'the assembler only substitutes the seeds it declares'
          : 'markup is not code';
    check(`no ${what} in a fragment (${why})`, hits.length === 0, hits.length ? report(hits) : `${scanned.length} files scanned`);
  }

  const dupes = [...decls].filter(([, where]) => new Set(where).size > 1);
  check(
    'no IIFE-level name is declared by two fragments (the second silently wins)',
    dupes.length === 0,
    dupes
      .slice(0, 6)
      .map(([name, where]) => `${name}: ${[...new Set(where)].join(', ')}`)
      .join(' | ') || `${decls.size} names`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nfailed:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
    process.exit(1);
  }
}

main();
