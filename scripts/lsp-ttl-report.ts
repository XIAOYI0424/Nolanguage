/**
 * Read the app's log and report what the TTL should be.
 *
 * The manager logs `lsp.server.reused` (with the idle interval), `lsp.server.started`
 * (with the cost) and `lsp.server.reaped`. This turns those lines into the only
 * two numbers a TTL decision needs: how long servers sit idle before being wanted
 * again, and what a restart costs when they are gone.
 *
 *   npm run lsp:ttl                      # the installed app's log
 *   npm run lsp:ttl -- path\to\app.log   # a specific file
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LanguageManifest } from '../src/langs/manifest.js';
import { judgeTtl, summarizeIdle } from '../src/lsp/ttlStats.js';

const ROOT = process.cwd();
const DEFAULT_LOG = join(homedir(), '.nolanguage', 'logs', 'app.log');
const file = process.argv[2] ?? process.env.NOLANGUAGE_LOG_FILE ?? DEFAULT_LOG;

if (!existsSync(file)) {
  console.log(`no log at ${file}`);
  console.log('run the app for a while, then point this at logs/app.log');
  process.exit(0);
}

/** Configured TTLs, so the report can judge the number actually in force. */
const ttls = new Map<string, number>();
const DEFAULT_TTL = 5 * 60_000;
for (const dir of ['builtin', 'examples']) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = join(ROOT, dir, entry, 'manifest.json');
    if (!existsSync(path)) continue;
    const m = JSON.parse(readFileSync(path, 'utf8')) as LanguageManifest;
    if (m.lsp && !m.lsp.disabled) ttls.set(m.id, m.lsp.idleTtlMs ?? DEFAULT_TTL);
  }
}

const idle = new Map<string, number[]>();
const starts: number[] = [];
let reaps = 0;
let lines = 0;

for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.startsWith('{')) continue;
  let rec: { msg?: string; lang?: string; f?: Record<string, unknown> };
  try {
    rec = JSON.parse(line) as typeof rec;
  } catch {
    continue;
  }
  lines++;
  if (rec.msg === 'lsp.server.reused') {
    const lang = String(rec.f?.language ?? '?');
    const ms = Number(rec.f?.idleMs ?? 0);
    if (Number.isFinite(ms)) {
      const list = idle.get(lang) ?? [];
      list.push(ms);
      idle.set(lang, list);
    }
  } else if (rec.msg === 'lsp.server.started') {
    const ms = Number(rec.f?.startMs ?? 0);
    if (Number.isFinite(ms)) starts.push(ms);
  } else if (rec.msg === 'lsp.server.reaped') {
    reaps += 1;
  }
}

console.log(`log: ${file}`);
console.log(`records: ${lines} · reuse events: ${[...idle.values()].reduce((n, v) => n + v.length, 0)} · starts: ${starts.length} · reaps: ${reaps}`);

if (!idle.size) {
  console.log('\nno reuse events yet — the app has to keep a server alive long enough to reuse it');
  process.exit(0);
}

const fmt = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms)} ms`);

console.log('\nlanguage   reuses   median idle   p90 idle    max idle   TTL in force   verdict');
for (const [lang, values] of [...idle.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const s = summarizeIdle(values);
  const ttl = ttls.get(lang) ?? DEFAULT_TTL;
  console.log(
    `${lang.padEnd(10)} ${String(s.count).padStart(6)}   ${fmt(s.medianMs).padStart(11)}   ${fmt(s.p90Ms).padStart(8)}   ${fmt(s.maxMs).padStart(9)}   ${fmt(ttl).padStart(12)}   ${judgeTtl(s, ttl)}`,
  );
}

if (starts.length) {
  const s = summarizeIdle(starts);
  console.log(`\nrestart cost: median ${fmt(s.medianMs)} · p90 ${fmt(s.p90Ms)} · max ${fmt(s.maxMs)} (${s.count} start(s))`);
  console.log('a TTL is worth extending when median idle approaches the TTL and the restart cost is seconds, not milliseconds.');
}
