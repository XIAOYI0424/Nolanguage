/**
 * `npm run hooks:install` — put the release guard where it cannot be forgotten.
 *
 * The 2026-11-10 incident happened because "remember to commit" was a habit, not
 * a mechanism. This installs a **pre-push** hook that refuses to push while the
 * working tree is dirty.
 *
 * Why pre-push and not pre-commit: a pre-commit hook always sees staged changes
 * (that is what a commit is), so it cannot detect "work that was staged and then
 * left there for nine days". Pushing is the moment where a dirty tree becomes
 * someone else's problem, and it is rare enough that a hard block is not
 * annoying.
 *
 * Hooks live in `.git/hooks`, which is not versioned — hence a script instead of
 * a committed file, and hence a line in the README.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HOOK = `#!/bin/sh
# Installed by \`npm run hooks:install\` (see scripts/install-hooks.mjs).
#
# Blocks a push while the working tree is dirty. 0.7.5 through 0.7.7 were once
# released with three versions of work still sitting in the index; a tag pointed
# at a tree that did not contain the code its CHANGELOG described.
node scripts/check-release.mjs --push || {
  echo ""
  echo "pre-push: commit or stash the changes above, then push again."
  exit 1
}
`;

const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: ROOT, encoding: 'utf8' }).trim();
const hooksPath = resolve(ROOT, hooksDir);
const target = join(hooksPath, 'pre-push');

mkdirSync(hooksPath, { recursive: true });

const previous = existsSync(target) ? readFileSync(target, 'utf8') : '';
if (previous.includes('check-release.mjs --push')) {
  console.log(`[hooks] pre-push already installed at ${target}`);
} else {
  if (previous) {
    // Do not silently clobber someone else's hook: keep it, chain to it.
    writeFileSync(`${target}.bak`, previous, 'utf8');
    console.log(`[hooks] existing pre-push backed up to ${target}.bak`);
  }
  writeFileSync(target, HOOK, 'utf8');
  try {
    chmodSync(target, 0o755);
  } catch {
    /* Windows: git does not need the bit */
  }
  console.log(`[hooks] pre-push installed at ${target}`);
}

console.log('[hooks] it runs: node scripts/check-release.mjs --push');
