/**
 * What does real use look like?
 *
 * Reads `logs/usage*.jsonl` (written by `UsageLog`) and answers the questions the
 * optimisation work keeps asking: how long do servers sit idle, what do requests
 * actually cost, how big are the documents people open.
 *
 *   npm run usage                      # the installed app's data
 *   npm run usage -- path/to/logs      # a specific directory
 *   npm run usage -- --json            # machine-readable, for a spreadsheet
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LanguageManifest } from '../src/langs/manifest.js';
import { judgeTtl, summarizeIdle } from '../src/lsp/ttlStats.js';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dir = args.find((a) => !a.startsWith('--')) ?? join(homedir(), '.nolanguage', 'logs');

if (!existsSync(dir)) {
  console.log(`no usage log at ${dir}`);
  process.exit(0);
}

const files = readdirSync(dir)
  .filter((f) => /^usage(\.\d+)?\.jsonl$/.test(f))
  .sort();
if (!files.length) {
  console.log(`no usage log files in ${dir} — run the app for a while first`);
  process.exit(0);
}

/** Configured TTLs, so the report can judge the number actually in force. */
const ttls = new Map<string, number>();
for (const d of ['builtin', 'examples']) {
  for (const entry of readdirSync(join(ROOT, d))) {
    const path = join(ROOT, d, entry, 'manifest.json');
    if (!existsSync(path)) continue;
    const m = JSON.parse(readFileSync(path, 'utf8')) as LanguageManifest;
    if (m.lsp && !m.lsp.disabled) ttls.set(m.id, m.lsp.idleTtlMs ?? 5 * 60_000);
  }
}

interface Row {
  t: string;
  sid: string;
  v: string;
  event: string;
  [k: string]: unknown;
}

const rows: Row[] = [];
let broken = 0;
for (const file of files) {
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      broken++;
    }
  }
}

const sessions = new Set(rows.map((r) => r.sid));
const versions = new Set(rows.filter((r) => typeof r.appVersion === 'string').map((r) => String(r.appVersion)));
const first = rows[0]?.t ?? '?';
const last = rows[rows.length - 1]?.t ?? '?';

const by = (event: string): Row[] => rows.filter((r) => r.event === event);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : -1);
const fmt = (ms: number): string => (ms < 0 ? '-' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

const report = {
  files: files.length,
  records: rows.length,
  brokenLines: broken,
  sessions: sessions.size,
  versions: [...versions],
  window: { first, last },
  requests: [] as Array<{ language: string; method: string; n: number; median: number; p90: number; max: number; failures: number }>,
  lspStarts: [] as Array<{ n: number; median: number; p90: number }>,
  idle: [] as Array<{ language: string; reuses: number; median: number; p90: number; max: number; ttl: number; verdict: string }>,
  documents: [] as Array<{ language: string; n: number; medianLines: number; p90Lines: number; maxLines: number }>,
  reaps: by('lsp.reap').length,
};

// ---- requests, per language and method -------------------------------------
const groups = new Map<string, Row[]>();
for (const r of by('request')) {
  const key = `${String(r.language ?? '?')}\u0000${String(r.method ?? '?')}`;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}
for (const [key, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const [language, method] = key.split('\u0000');
  const s = summarizeIdle(list.map((r) => num(r.ms)).filter((n) => n >= 0));
  report.requests.push({
    language,
    method,
    n: s.count,
    median: s.medianMs,
    p90: s.p90Ms,
    max: s.maxMs,
    failures: list.filter((r) => r.ok === false).length,
  });
}

// ---- server lifecycle ------------------------------------------------------
const startTimes = by('lsp.start').filter((r) => r.ok !== false).map((r) => num(r.startMs));
const startSummary = summarizeIdle(startTimes);
report.lspStarts.push({ n: startSummary.count, median: startSummary.medianMs, p90: startSummary.p90Ms });

const idleByLang = new Map<string, number[]>();
for (const r of by('lsp.reuse')) {
  const lang = String(r.language ?? '?');
  const list = idleByLang.get(lang) ?? [];
  list.push(num(r.idleMs));
  idleByLang.set(lang, list);
}
for (const [language, values] of idleByLang) {
  const s = summarizeIdle(values);
  const ttl = ttls.get(language) ?? 5 * 60_000;
  report.idle.push({ language, reuses: s.count, median: s.medianMs, p90: s.p90Ms, max: s.maxMs, ttl, verdict: judgeTtl(s, ttl) });
}

// ---- document sizes (the CM6 trigger) --------------------------------------
const docByLang = new Map<string, number[]>();
for (const r of by('editor.open')) {
  const lang = String(r.language ?? '?');
  const list = docByLang.get(lang) ?? [];
  list.push(num(r.lines));
  docByLang.set(lang, list);
}
for (const [language, values] of docByLang) {
  const s = summarizeIdle(values);
  report.documents.push({ language, n: s.count, medianLines: s.medianMs, p90Lines: s.p90Ms, maxLines: s.maxMs });
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`files: ${report.files} · records: ${report.records}${broken ? ` · unreadable lines: ${broken}` : ''}`);
console.log(`sessions: ${report.sessions} · versions: ${report.versions.join(', ') || '?'} · window: ${first} → ${last}`);

if (report.requests.length) {
  console.log('\nrequests');
  console.log('language     method            n     median      p90       max   failed');
  for (const r of report.requests) {
    console.log(
      `${r.language.padEnd(12)} ${r.method.padEnd(16)} ${String(r.n).padStart(5)}  ${fmt(r.median).padStart(9)} ${fmt(r.p90).padStart(8)} ${fmt(r.max).padStart(9)} ${String(r.failures).padStart(7)}`,
    );
  }
}

console.log('\nservers');
for (const s of report.lspStarts) console.log(`  starts: ${s.n} · median ${fmt(s.median)} · p90 ${fmt(s.p90)}`);
for (const i of report.idle) {
  console.log(
    `  ${i.language.padEnd(10)} reuses ${String(i.reuses).padStart(4)} · idle median ${fmt(i.median)} · p90 ${fmt(i.p90)} · max ${fmt(i.max)} · TTL ${fmt(i.ttl)} · ${i.verdict}`,
  );
}
if (report.reaps) console.log(`  reaped: ${report.reaps} time(s) — the TTL (or the memory budget) actually stopped a server`);

if (report.documents.length) {
  console.log('\ndocuments opened');
  for (const d of report.documents) {
    console.log(`  ${d.language.padEnd(10)} n ${String(d.n).padStart(4)} · lines median ${Math.round(d.medianLines)} · p90 ${Math.round(d.p90Lines)} · max ${Math.round(d.maxLines)}`);
  }
  console.log('  the CM5 -> CM6 trigger is a 100k-line document; max above is what real use reached.');
}
