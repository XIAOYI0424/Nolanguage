/**
 * Count outbound network attempts during a boot.
 *
 * "The engine does not phone home at boot" is a claim that decays silently: one
 * import-time `fetch` for a version check, and every launch leaks a request (and
 * hangs for 30 seconds behind a captive portal). Counting is the only mechanical
 * answer: patch the client entry points, write the counts on exit, and let the
 * caller assert zero.
 *
 * Loaded with `--import`, so it runs before the entry module — an import-time
 * call in the boot graph is inside the window. Plain JavaScript on purpose: this
 * file is loaded before (and independently of) the TypeScript loader.
 */
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';

const counts = { fetch: 0, http: 0, https: 0, dns: 0 };
const sink = process.env.NET_PROBE_FILE;

const realFetch = globalThis.fetch;
if (typeof realFetch === 'function') {
  globalThis.fetch = function patchedFetch(...args) {
    record('fetch');
    return realFetch(...args);
  };
}

for (const [mod, key] of [
  [http, 'http'],
  [https, 'https'],
]) {
  for (const name of ['request', 'get']) {
    const original = mod[name];
    if (typeof original !== 'function') continue;
    mod[name] = function patched(...args) {
      record(key);
      return original.apply(mod, args);
    };
  }
}

const realLookup = dns.lookup;
dns.lookup = function patchedLookup(...args) {
  record('dns');
  return realLookup.apply(dns, args);
};

/**
 * Rewrite the report after every attempt.
 *
 * Not only on exit: Windows terminates a child without running `exit` handlers, and
 * the caller kills the server it is measuring. The counts are tiny and attempts are
 * rare by contract, so a synchronous rewrite per attempt costs nothing.
 */
function flush() {
  if (!sink) return;
  try {
    writeFileSync(sink, JSON.stringify({ ...counts, pid: process.pid }), 'utf8');
  } catch {
    /* the probe must never break the process it is measuring */
  }
}

const record = (kind) => {
  counts[kind]++;
  flush();
};

process.on('exit', flush);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    flush();
    process.exit(0);
  });
}
