/**
 * Static file server for `frontend/dist` — the `tauri dev` frontend.
 *
 * Tauri's `devUrl` has to be an HTTP address, and this project's frontend is a
 * build artefact rather than a dev server: `scripts/build-frontend.mjs` writes
 * one self-contained `index.html`, so "serving the frontend" means serving that
 * file. That is all this does — no bundler, no watch, no dependencies.
 *
 * The trade-off is accepted deliberately: no hot reload. The page is rendered
 * whole by `renderPyCharmHtml()`, so a change means re-running the build; when
 * that gets annoying, the upgrade path is an SSE endpoint here telling the page
 * to reload, not a bundler.
 *
 * Run: node scripts/serve-dist.mjs          (PORT overrides the default)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'frontend', 'dist');
const PORT = Number(process.env.PORT ?? 1420);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Resolve a request path inside `DIST`, or `null` when it escapes.
 *
 * The bundle is a directory on disk reachable over HTTP, so a `..` segment is a
 * traversal, not a path — the resolved target must stay under `DIST`.
 */
function resolveInDist(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(clean).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const target = join(DIST, rel || 'index.html');
  return target.startsWith(DIST) ? target : null;
}

createServer(async (req, res) => {
  const target = resolveInDist(req.url ?? '/');
  if (!target) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      // The bundle is regenerated on every build; a stale index.html is worse
      // than a fresh fetch.
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serve-dist: frontend/dist on http://127.0.0.1:${PORT}  (no hot reload — re-run build:frontend)`);
});
