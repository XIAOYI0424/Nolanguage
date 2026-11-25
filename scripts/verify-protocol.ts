/**
 * The protocol register vs. the two switches that actually implement it.
 *
 * `src/panel/protocol.ts` lists every frame kind in both directions. This suite
 * reads the router in `src/panel/server.ts` (`switch (msg.kind)`) and the driver in
 * `src/ui/client/50-runtime.js` (`function handle(m)`) as text, and fails when:
 *
 *   - a side handles a kind that is not in the register (undocumented),
 *   - the register names a kind no side handles (dead entry, or a rename forgot it),
 *   - a list repeats a kind, or
 *   - the switches moved and this suite can no longer find them (a silent gate is
 *     worse than a red one, so that is a failure too).
 *
 * It does not check payload shapes: the frames are plain objects on both sides and
 * the register is about the set of kinds, not their fields.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-protocol.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENT_TO_ENGINE, ENGINE_TO_CLIENT } from '../src/panel/protocol.js';

const ROOT = process.cwd();
const SERVER = join(ROOT, 'src/panel/server.ts');
const CLIENT = join(ROOT, 'src/ui/client/50-runtime.js');

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Located {
  kind: string;
  line: number;
}

/**
 * The `case 'x':` labels of one switch, matched by brace depth.
 *
 * Returns undefined when the switch cannot be found, so the caller can fail instead
 * of comparing against an empty list and reporting success.
 */
function switchKinds(file: string, anchor: string): Located[] | undefined {
  const text = readFileSync(file, 'utf8');
  const at = text.indexOf(anchor);
  if (at < 0) return undefined;
  const open = text.indexOf('{', at);
  if (open < 0) return undefined;
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return undefined;
  const block = text.slice(open, end);
  const found: Located[] = [];
  const re = /case\s+'([^']+)'\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const line = text.slice(0, open + m.index).split('\n').length;
    found.push({ kind: m[1], line });
  }
  return found;
}

function main(): void {
  const handledByServer = switchKinds(SERVER, 'switch (msg.kind) {');
  const handledByClient = switchKinds(CLIENT, 'function handle(m) {');

  check('the server router is where the suite expects it', handledByServer !== undefined, 'switch (msg.kind)');
  check('the client driver is where the suite expects it', handledByClient !== undefined, 'function handle(m)');
  if (!handledByServer || !handledByClient) {
    finish();
    return;
  }
  check('the server router handles frames', handledByServer.length > 0, `${handledByServer.length} kinds`);
  check('the client driver handles frames', handledByClient.length > 0, `${handledByClient.length} kinds`);

  const serverKinds = new Set(handledByServer.map((k) => k.kind));
  const clientKinds = new Set(handledByClient.map((k) => k.kind));
  const registerIn = new Set<string>(CLIENT_TO_ENGINE);
  const registerOut = new Set<string>(ENGINE_TO_CLIENT);

  const missingFromRegister = handledByServer.filter((k) => !registerIn.has(k.kind));
  check(
    'every kind the server handles is registered in CLIENT_TO_ENGINE',
    missingFromRegister.length === 0,
    missingFromRegister
      .slice(0, 8)
      .map((k) => `${k.kind} (server.ts:${k.line})`)
      .join(', ') || `${serverKinds.size} kinds`,
  );

  const missingFromClientRegister = handledByClient.filter((k) => !registerOut.has(k.kind));
  check(
    'every kind the client handles is registered in ENGINE_TO_CLIENT',
    missingFromClientRegister.length === 0,
    missingFromClientRegister
      .slice(0, 8)
      .map((k) => `${k.kind} (50-runtime.js:${k.line})`)
      .join(', ') || `${clientKinds.size} kinds`,
  );

  const deadIn = CLIENT_TO_ENGINE.filter((k) => !serverKinds.has(k));
  check(
    'every CLIENT_TO_ENGINE kind is handled by the server (no dead register entry)',
    deadIn.length === 0,
    deadIn.join(', ') || `${CLIENT_TO_ENGINE.length} entries`,
  );

  const deadOut = ENGINE_TO_CLIENT.filter((k) => !clientKinds.has(k));
  check(
    'every ENGINE_TO_CLIENT kind is handled by the client (no dead register entry)',
    deadOut.length === 0,
    deadOut.join(', ') || `${ENGINE_TO_CLIENT.length} entries`,
  );

  const dupIn = duplicated(CLIENT_TO_ENGINE);
  check('CLIENT_TO_ENGINE has no duplicate kind', dupIn.length === 0, dupIn.join(', ') || 'none');
  const dupOut = duplicated(ENGINE_TO_CLIENT);
  check('ENGINE_TO_CLIENT has no duplicate kind', dupOut.length === 0, dupOut.join(', ') || 'none');

  // A client-kind that no server arm answers would hang the UI on a spinner.
  const answered = new Set([...handledByServer.map((k) => k.kind)]);
  const unanswerable = CLIENT_TO_ENGINE.filter((k) => !answered.has(k));
  check(
    'no request kind is sent without a server arm',
    unanswerable.length === 0,
    unanswerable.join(', ') || `${CLIENT_TO_ENGINE.length} requests`,
  );

  finish();
}

function duplicated(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const k of list) {
    if (seen.has(k)) dup.push(k);
    seen.add(k);
  }
  return dup;
}

function finish(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nfailed:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
    process.exit(1);
  }
}

main();
