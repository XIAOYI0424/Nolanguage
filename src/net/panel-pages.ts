/**
 * The panel's HTTP pages: which URL serves which document, gzip, and the token gate.
 *
 * This lived inline in `panel/server.ts` as a closure over six rendered pages and
 * the kernel's `/health` payload. It is not panel logic — it is HTTP: route table,
 * `Accept-Encoding`, `set-cookie` — and the server file is the one file the line
 * budget is trying to protect. Passing the pages and the health payload in keeps the
 * module free of panel imports and makes the gate testable on its own.
 *
 * The token gate exists because the panel can read, write and delete files and run
 * commands: a bind that anything can reach is an unauthenticated shell. `/health`
 * stays open (the launcher and doctor probe it before they have a token), and it
 * reports build identity only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { PANEL_TOKEN_COOKIE, isAuthorizedRequest, isLoopbackHost, tokenFromRequest } from './websocket.js';

export interface PanelPagesOptions {
  /** Empty string = no gate (loopback bind). */
  authToken: string;
  /** URL path → document body. First match wins; `?query` is ignored. */
  pages: Record<string, string>;
  /** The `/health` payload, built per request. */
  health: () => unknown;
}

/**
 * Read and validate `PANEL_HOST` / `PANEL_TOKEN`, refusing an exposed bind without one.
 *
 * Throws rather than degrading: a panel reachable from anywhere but this machine
 * that the caller believes is protected is worse than one that fails to start.
 */
export function panelAuthToken(host: string): string {
  const token = (process.env.PANEL_TOKEN ?? '').trim();
  if (!isLoopbackHost(host)) {
    if (!token) {
      throw new Error(
        `PANEL_HOST=${host} exposes the panel beyond this machine, so PANEL_TOKEN is required ` +
          '(at least 16 characters). Without it anyone who can reach the port can run commands ' +
          'and read or write files.',
      );
    }
    if (token.length < 16) {
      throw new Error(`PANEL_TOKEN must be at least 16 characters (got ${token.length})`);
    }
  }
  return token;
}

const TOKEN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Nolanguage · token required</title>' +
  '<p>This panel was started with <code>PANEL_TOKEN</code>, so it needs that token in the URL: ' +
  '<code>/?token=…</code> (it is remembered as a cookie afterwards).</p>';

/** Compressed bodies, keyed by content. The pages change on restart only. */
const gzipCache = new Map<string, Buffer>();

/**
 * The WebSocket server's `onRequest` handler: `true` when the request was answered.
 */
export function createPanelPages(opts: PanelPagesOptions): (req: IncomingMessage, res: ServerResponse) => boolean {
  const { authToken, pages, health } = opts;
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (authToken && url !== '/health' && !isAuthorizedRequest(req, authToken)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(TOKEN_PAGE);
      return true;
    }
    if (authToken && tokenFromRequest(req) === authToken) {
      // The cookie is what lets the page's WebSocket carry the token: a browser
      // cannot set a header on a WS handshake, but it does send cookies.
      res.setHeader('set-cookie', `${PANEL_TOKEN_COOKIE}=${authToken}; HttpOnly; SameSite=Strict; Path=/`);
    }

    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(health()));
      return true;
    }

    const body = pages[url];
    if (body === undefined) return false;

    const accepted = String(req.headers['accept-encoding'] ?? '');
    // Parse Accept-Encoding: match "gzip" and check its q-value is not 0.
    const gzipMatch = /(?:^|,\s*)gzip(?:;\s*q=([0-9.]+))?/i.exec(accepted);
    const gzipQ = gzipMatch ? (gzipMatch[1] !== undefined ? parseFloat(gzipMatch[1]) : 1) : 0;
    const headers: Record<string, string | number> = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      vary: 'Accept-Encoding',
    };
    if (gzipQ > 0 && Buffer.byteLength(body) >= 16 * 1024) {
      let compressed = gzipCache.get(body);
      if (!compressed) {
        compressed = gzipSync(Buffer.from(body), { level: 6 });
        gzipCache.set(body, compressed);
      }
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = compressed.length;
      res.writeHead(200, headers);
      res.end(compressed);
      return true;
    }
    res.writeHead(200, headers);
    res.end(body);
    return true;
  };
}
