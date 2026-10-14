/**
 * Focused unit test for LspLogCollector line parsing. Run:
 *   node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/test-logcollector.ts
 */
import { LspLogCollector } from '../src/lsp/LspLogCollector.js';
import { LogLevel, LOG_LEVEL_NAMES } from '../src/log/LogLevel.js';

type Rec = [LogLevel, string, Record<string, unknown> | undefined];
const recs: Rec[] = [];
const fake = {
  fatal: (m: string, f?: Record<string, unknown>) => recs.push([LogLevel.FATAL, m, f]),
  error: (m: string, f?: Record<string, unknown>) => recs.push([LogLevel.ERROR, m, f]),
  warn: (m: string, f?: Record<string, unknown>) => recs.push([LogLevel.WARN, m, f]),
  info: (m: string, f?: Record<string, unknown>) => recs.push([LogLevel.INFO, m, f]),
  debug: (m: string, f?: Record<string, unknown>) => recs.push([LogLevel.DEBUG, m, f]),
  trace: (m: string, f?: Record<string, unknown>) => recs.push([LogLevel.TRACE, m, f]),
} as unknown as Parameters<typeof LspLogCollector.prototype.write> extends never ? never : never;

const collector = new LspLogCollector(fake as never, { languageId: 'python', stream: 'stderr' });
const lines = [
  '[Info - 10:49:36] Starting language server {"server": "x"}',
  '[Debug - 10:49:36] Document opened {"uri": "a"}',
  '[Trace - 10:49:36] Completion computed {"count": 35}',
  '[Error - 10:49:36] Something broke',
  'Error: unhandled exception in language server',
  'Traceback (most recent call last):',
  '  File "x.py", line 1, in <module>',
  '{"level":"warn","msg":"json line","extra":1}',
  'ERROR: plain error prefix',
  'WARNING: plain warn prefix',
];
for (const l of lines) collector.write(l + '\n');

const expected: Array<[string, LogLevel, string]> = [
  ['bracket-info', LogLevel.INFO, 'Starting language server'],
  ['bracket-debug', LogLevel.DEBUG, 'Document opened'],
  ['bracket-trace', LogLevel.TRACE, 'Completion computed'],
  ['bracket-error', LogLevel.ERROR, 'Something broke'],
  ['plain-error', LogLevel.ERROR, 'unhandled exception in language server'],
  ['traceback-head', LogLevel.ERROR, 'Traceback (most recent call last):'],
  ['continuation', LogLevel.ERROR, 'File "x.py", line 1, in <module>'],
  ['json-warn', LogLevel.WARN, 'json line'],
  ['plain-error2', LogLevel.ERROR, 'plain error prefix'],
  ['plain-warn', LogLevel.WARN, 'plain warn prefix'],
];

let pass = 0;
let fail = 0;
expected.forEach(([name, wantLevel, wantMsgPrefix], i) => {
  const got = recs[i];
  if (!got) {
    console.log(`FAIL  ${name}: missing record`);
    fail++;
    return;
  }
  const [lv, msg] = got;
  const ok = lv === wantLevel && msg.startsWith(wantMsgPrefix);
  if (ok) {
    pass++;
    console.log(`PASS  ${name.padEnd(18)} ${LOG_LEVEL_NAMES[lv].padEnd(6)} ${JSON.stringify(msg).slice(0, 52)}`);
  } else {
    fail++;
    console.log(
      `FAIL  ${name.padEnd(18)} got ${LOG_LEVEL_NAMES[lv]}/${JSON.stringify(msg).slice(0, 40)} ` +
        `want ${LOG_LEVEL_NAMES[wantLevel]}/${JSON.stringify(wantMsgPrefix)}`,
    );
  }
});
console.log(`\n${pass}/${pass + fail} parsing checks passed`);
process.exit(fail ? 1 : 0);
