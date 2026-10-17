/**
 * script-host OS-level memory cap — pure-function contract.
 *
 * Covers the parser and the resolution precedence/clamp without spawning a
 * real child (that path is exercised end-to-end by verify-langplugins for any
 * plugin that uses `script-host`). Here we pin the *rules*: human-string
 * parsing, env-wins-over-manifest, default fallback, and the [64MB, 4GB]
 * clamp with the 256MB default.
 */
import { parseHumanBytes, resolveMemLimitBytes } from '../src/runtimes/script-host.ts';
import type { RunConfig } from '../src/runtimes/types.ts';

let passed = 0;
let failed = 0;
const MB = 1024 * 1024;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

function cfg(hint?: string): RunConfig {
  return { mode: 'script-host', script: 'runtime.js', sourceExt: '.txt', memoryHint: hint };
}

// --- parseHumanBytes ---
check('parse 256MB -> 256*MB', parseHumanBytes('256MB') === 256 * MB);
check('parse 1GB -> 1024*MB', parseHumanBytes('1GB') === 1024 * MB);
check('parse 1.5GB -> 1536*MB', parseHumanBytes('1.5GB') === 1536 * MB);
check('parse kb -> 1024', parseHumanBytes('1kb') === 1024);
check('parse bare number -> bytes', parseHumanBytes('512') === 512);
check('parse "512" -> 512 bytes', parseHumanBytes('512') === 512);
check('parse empty -> null', parseHumanBytes('') === null);
check('parse undefined -> null', parseHumanBytes(undefined) === null);
check('parse garbage -> null', parseHumanBytes('not-a-size') === null);
check('parse zero -> null (no silent free)', parseHumanBytes('0') === null);
check('parse "256 MB" with space -> 256*MB', parseHumanBytes('256 MB') === 256 * MB);

// --- resolveMemLimitBytes: precedence + clamp + default ---
check('default when nothing set', resolveMemLimitBytes(cfg(), {}) === 256 * MB);
check('manifest hint honored', resolveMemLimitBytes(cfg('1GB'), {}) === 1024 * MB);
check('env beats manifest', resolveMemLimitBytes(cfg('1GB'), { NOLANGUAGE_SCRIPT_HOST_MEM_LIMIT: '512MB' }) === 512 * MB);
check('bad env falls back to manifest', resolveMemLimitBytes(cfg('1GB'), { NOLANGUAGE_SCRIPT_HOST_MEM_LIMIT: 'garbage' }) === 1024 * MB);
check('clamp below min -> 64MB', resolveMemLimitBytes(cfg('1MB'), {}) === 64 * MB);
check('clamp above max -> 4GB', resolveMemLimitBytes(cfg('100GB'), {}) === 4 * 1024 * MB);
check('env clamp below min -> 64MB', resolveMemLimitBytes(cfg(), { NOLANGUAGE_SCRIPT_HOST_MEM_LIMIT: '1MB' }) === 64 * MB);
check('env clamp above max -> 4GB', resolveMemLimitBytes(cfg(), { NOLANGUAGE_SCRIPT_HOST_MEM_LIMIT: '100GB' }) === 4 * 1024 * MB);
check('boundary min 64MB exact', resolveMemLimitBytes(cfg('64MB'), {}) === 64 * MB);
check('boundary max 4GB exact', resolveMemLimitBytes(cfg('4GB'), {}) === 4 * 1024 * MB);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
