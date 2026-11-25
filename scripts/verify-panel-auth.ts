/**
 * D · the panel is only loopback-cheap.
 *
 * The default bind is `127.0.0.1`, where the Origin check is the whole threat
 * model. The moment `PANEL_HOST` points anywhere else, "no Origin" (a native
 * client) proves nothing and the panel would be an unauthenticated shell — so the
 * server must refuse to start without `PANEL_TOKEN`, and every page load and
 * WebSocket upgrade must then present it.
 *
 * This suite boots the real server three ways (loopback, exposed without a
 * token, exposed with one) and drives it over plain HTTP + a raw upgrade.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-panel-auth.ts
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const BASE_PORT = Number(process.env.VERIFY_PORT ?? 7455);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TOKEN = 'verify-panel-token-0123456789';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Child {
  child: ReturnType<typeof spawn>;
  output: () => string;
  exited: Promise<number | null>;
}

/** Boot `src/panel/server.ts` with an environment of the caller's choosing. */
function boot(port: number, env: Record<string, string>): Child {
  let out = '';
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', '--experimental-loader', './resolve-loader.mjs', 'src/panel/server.ts'],
    {
      env: { ...process.env, PANEL_PORT: String(port), PANEL_NO_STORE: '1', PANEL_NO_DEMO: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (d) => (out += String(d)));
  child.stderr.on('data', (d) => (out += String(d)));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  return { child, output: () => out, exited };
}

/** One HTTP request, headers included — `fetch` would hide `set-cookie`. */
function http(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = connect(port, '127.0.0.1', () => {
      req.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n`);
      for (const [k, v] of Object.entries(headers)) req.write(`${k}: ${v}\r\n`);
      req.write('\r\n');
    });
    let raw = '';
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('http timeout'));
    });
    req.on('error', reject);
    req.on('data', (c) => (raw += c.toString('utf8')));
    req.on('close', () => {
      const at = raw.indexOf('\r\n\r\n');
      const head = at >= 0 ? raw.slice(0, at) : raw;
      const body = at >= 0 ? raw.slice(at + 4) : '';
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
      const map: Record<string, string> = {};
      for (const line of head.split('\r\n').slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status, body, headers: map });
    });
  });
}

/** Status line of a WebSocket upgrade attempt, without completing a session. */
function upgradeStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    const expected = createHash('sha1').update(key + GUID).digest('base64');
    let raw = '';
    sock.setTimeout(8000, () => {
      sock.destroy();
      reject(new Error('upgrade timeout'));
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`,
      );
      for (const [k, v] of Object.entries(headers)) sock.write(`${k}: ${v}\r\n`);
      sock.write('\r\n');
    });
    sock.on('data', (c) => {
      raw += c.toString('utf8');
      const line = raw.split('\r\n')[0] ?? '';
      sock.destroy();
      resolve(line.includes(expected) ? '101 Switching Protocols' : line);
    });
  });
}

async function reachable(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await http(port, '/health');
      if (r.status === 200) return true;
    } catch {
      /* not listening yet */
    }
    await delay(150);
  }
  return false;
}

async function main(): Promise<void> {
  // ---- 1. exposed without a token: refuse to start ------------------------
  const exposed = boot(BASE_PORT, { PANEL_HOST: '0.0.0.0' });
  const exited = await exposed.exited;
  check('exposed bind without a token refuses to start', exited === 1, `exit=${exited}`);
  check(
    'the refusal says why and what to set',
    /PANEL_TOKEN is required/.test(exposed.output()),
    exposed.output().split('\n').find((l) => l.includes('PANEL_TOKEN is required'))?.trim() ?? '',
  );

  // ---- 2. a token too short to be worth brute-forcing ---------------------
  const shortToken = boot(BASE_PORT + 1, { PANEL_HOST: '0.0.0.0', PANEL_TOKEN: 'abc' });
  const shortExit = await shortToken.exited;
  check(
    'a token shorter than 16 characters is refused',
    shortExit === 1 && /at least 16 characters/.test(shortToken.output()),
    `exit=${shortExit}`,
  );

  // ---- 3. exposed with a token: every entry needs it ----------------------
  const guarded = boot(BASE_PORT + 2, { PANEL_HOST: '0.0.0.0', PANEL_TOKEN: TOKEN });
  try {
    const up = await reachable(BASE_PORT + 2, 20_000);
    check('the token-guarded server starts on the exposed bind', up, `port ${BASE_PORT + 2}`);

    const health = await http(BASE_PORT + 2, '/health');
    check('health stays open (the launcher probes it before any token)', health.status === 200, `status=${health.status}`);

    const noToken = await http(BASE_PORT + 2, '/');
    check('the page refuses to load without the token', noToken.status === 401, `status=${noToken.status}`);
    check('the 401 explains the token query', /token=/.test(noToken.body), noToken.body.slice(0, 60));

    const withToken = await http(BASE_PORT + 2, `/?token=${TOKEN}`);
    check('the page loads with ?token=', withToken.status === 200, `status=${withToken.status}`);
    const cookie = withToken.headers['set-cookie'] ?? '';
    check('the token is remembered as an HttpOnly cookie', /nlpanel=/.test(cookie) && /HttpOnly/i.test(cookie), cookie.slice(0, 48));

    const wrong = await http(BASE_PORT + 2, `/?token=${TOKEN}x`);
    check('a near-miss token is still refused', wrong.status === 401, `status=${wrong.status}`);

    const upgradeOpen = await upgradeStatus(BASE_PORT + 2, '/');
    check('a socket upgrade without the token is refused', upgradeOpen.includes('401'), upgradeOpen);

    const upgradeQuery = await upgradeStatus(BASE_PORT + 2, `/?token=${TOKEN}`);
    check('a socket upgrade with ?token= is accepted', upgradeQuery.includes('101'), upgradeQuery);

    const upgradeHeader = await upgradeStatus(BASE_PORT + 2, '/', { 'x-panel-token': TOKEN });
    check('...and with the header, for native clients', upgradeHeader.includes('101'), upgradeHeader);

    const upgradeCookie = await upgradeStatus(BASE_PORT + 2, '/', { cookie: `nlpanel=${TOKEN}` });
    check('...and with the cookie a browser page already has', upgradeCookie.includes('101'), upgradeCookie);
  } finally {
    guarded.child.kill();
    await guarded.exited;
  }

  // ---- 4. loopback stays frictionless (regression) -----------------------
  const loop = boot(BASE_PORT + 3, {});
  try {
    const up = await reachable(BASE_PORT + 3, 20_000);
    check('a loopback bind still starts without a token', up, `port ${BASE_PORT + 3}`);
    const page = await http(BASE_PORT + 3, '/');
    check('a loopback page needs no token', page.status === 200, `status=${page.status}`);
    const up101 = await upgradeStatus(BASE_PORT + 3, '/');
    check('a loopback upgrade needs no token', up101.includes('101'), up101);
  } finally {
    loop.child.kill();
    await loop.exited;
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nfailed:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
