/**
 * Project-explorer verification.
 *
 * Two phases, because the two halves fail in different ways:
 *
 *   1. `FsService` directly — containment, CRUD, the size and binary guards,
 *      and the listing cap. These are the properties that decide whether a
 *      path coming from the browser can reach something it should not.
 *   2. The **real panel server** over a **real WebSocket** — every `fs*` frame,
 *      including the `reqId` pairing and the `fsError` funnel, plus the
 *      upgrade-origin check that keeps a random web page from talking to it.
 *
 * Phase 2 is the one that matters most: phase 1 can pass while the wire format
 * is wrong, and a wrong wire format is invisible until the UI silently stops
 * updating.
 *
 * Run: node --experimental-transform-types --experimental-loader ./resolve-loader.mjs scripts/verify-explorer.ts
 */
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsError, FsService, languageOf } from '../src/panel/FsService.js';
import { RawWsClient, delay } from './lib/RawWsClient.js';

const root = join(fileURLToPath(import.meta.url), '..', '..');

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** The `FsError.code`, or a marker that the throw was not an `FsError` at all. */
function codeOf(err: unknown): string {
  if (err instanceof FsError) return err.code;
  return `not-FsError(${(err as Error)?.message ?? err})`;
}

// A per-run directory. Created by *this* process at runtime, so the harness's
// spawn-scoped write allow-list covers it; a fixed path reused across runs
// would not be writable.
const sandbox = process.env.NOLANGUAGE_EXPLORER_DIR ?? join(root, '.tmp', `explorer-${process.pid}-${Date.now().toString(36)}`);

async function setupWorkspace(): Promise<void> {
  await mkdir(join(sandbox, 'pkg', 'deep'), { recursive: true });
  await mkdir(join(sandbox, 'node_modules', 'junk'), { recursive: true });
  await mkdir(join(sandbox, '.git', 'objects'), { recursive: true });
  await writeFile(join(sandbox, 'README.md'), '# readme\n', 'utf8');
  await writeFile(join(sandbox, 'pkg', 'main.py'), 'print("hi")\n', 'utf8');
  await writeFile(join(sandbox, 'pkg', 'deep', 'notes.md'), '# notes\n', 'utf8');
  await writeFile(join(sandbox, 'pkg', 'go.mod'), 'module demo\n', 'utf8');
  // A NUL in the first few KB is what `git` itself treats as "binary".
  await writeFile(join(sandbox, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
  await writeFile(join(sandbox, 'node_modules', 'junk', 'index.js'), 'module.exports = 1;\n', 'utf8');
  await writeFile(join(sandbox, '.git', 'objects', 'x'), 'junk', 'utf8');
}

// =============================================================== phase 1

async function testService(): Promise<void> {
  const svc = new FsService(sandbox);

  // ---- language hints ----
  const langs: Array<[string, string | undefined]> = [
    ['main.py', 'python'],
    ['a.go', 'go'],
    ['notes.md', 'markdown'],
    ['go.mod', undefined],
    // `javascript`, not `typescript`: there is no TypeScript plugin, so
    // `typescript` was an id nothing could act on (no manifest, no language
    // server, no runtime) while a run configuration for the same file said
    // `javascript`. Both resolve through `langs/extensionIndex.ts` now.
    ['app.ts', 'javascript'],
    ['app.tsx', 'javascript'],
    ['run.sh', 'shell'],
    ['.gitignore', 'text'],
    ['Makefile', undefined],
    ['data.unknownext', undefined],
  ];
  const wrong = langs.filter(([name, want]) => languageOf(name) !== want);
  check('languageOf maps the extensions the editor can highlight', wrong.length === 0, wrong.map(([n]) => n).join(', ') || `${langs.length} cases`);

  // ---- describe ----
  const desc = svc.describe();
  check('describe() reports the workspace root and its folder name', desc.root === svc.root && desc.name === basename(sandbox), `${desc.name} @ ${desc.root}`);

  // ---- listing ----
  const top = await svc.list('');
  const names = top.entries.map((e) => e.name);
  check('listing returns one level, folders first', names[0] === 'pkg', names.join(', '));
  check('listing skips dependency and VCS internals', !names.includes('node_modules') && !names.includes('.git'), names.join(', '));
  check('listing marks folders and files apart', top.entries.find((e) => e.name === 'pkg')?.kind === 'dir' && top.entries.find((e) => e.name === 'README.md')?.kind === 'file');
  check('listing carries size and mtime for files', (top.entries.find((e) => e.name === 'README.md')?.mtime ?? 0) > 0);
  check('listing reports the relative path of the folder it read', top.path === '', JSON.stringify(top.path));
  check('a small listing is not reported as truncated', top.truncated === false);

  const pkg = await svc.list('pkg');
  check('a nested folder lists with nested paths', pkg.path === 'pkg' && pkg.entries.every((e) => e.path.startsWith('pkg/')), pkg.entries.map((e) => e.path).join(', '));
  check('listing is case-insensitive alphabetical within a kind', pkg.entries.filter((e) => e.kind === 'file').map((e) => e.name).join(',') === 'go.mod,main.py', pkg.entries.filter((e) => e.kind === 'file').map((e) => e.name).join(','));

  const dirErr = await svc.list('README.md').then(() => '', (e) => codeOf(e));
  check('listing a file is refused', dirErr === 'is-dir', dirErr);
  const missing = await svc.list('nope').then(() => '', (e) => codeOf(e));
  check('listing a missing folder is refused', missing === 'not-found', missing);

  // ---- reading ----
  const py = await svc.read('pkg/main.py');
  check('read returns the content and a language hint', py.content === 'print("hi")\n' && py.languageId === 'python', `${py.languageId}, ${py.size} bytes`);
  check('read reports the file name and path', py.name === 'main.py' && py.path === 'pkg/main.py', `${py.path}`);
  check('read does not flag a text file as truncated', py.truncated === false);

  const blob = await svc.read('blob.bin');
  check('read refuses to show a binary file as text', blob.truncated === true && blob.content === '', blob.note);
  check('the binary refusal names the reason', /binary/.test(blob.note ?? ''), blob.note);

  const readDir = await svc.read('pkg').then(() => '', (e) => codeOf(e));
  check('reading a folder is refused', readDir === 'is-dir', readDir);

  // ---- writing ----
  const wrote = await svc.write('pkg/new.txt', 'hello world');
  check('write returns the saved file descriptor', wrote.path === 'pkg/new.txt' && wrote.size === 11, `${wrote.size} bytes`);
  check('write really lands on disk', (await readFile(join(sandbox, 'pkg', 'new.txt'), 'utf8')) === 'hello world');

  await svc.write('made/up/deep.txt', 'nested');
  check('write creates missing parent folders', (await readFile(join(sandbox, 'made', 'up', 'deep.txt'), 'utf8')) === 'nested');

  const writeDir = await svc.write('pkg', 'x').then(() => '', (e) => codeOf(e));
  check('writing over a folder is refused', writeDir === 'is-dir', writeDir);

  // ---- create ----
  const madeFile = await svc.create('fresh.py', 'file');
  check('create makes an empty file', madeFile.kind === 'file' && madeFile.path === 'fresh.py', madeFile.path);
  const madeDir = await svc.create('freshdir', 'dir');
  check('create makes a folder', madeDir.kind === 'dir', madeDir.path);
  const dup = await svc.create('fresh.py', 'file').then(() => '', (e) => codeOf(e));
  check('create refuses to overwrite an existing path', dup === 'exists', dup);

  // ---- rename ----
  const renamed = await svc.rename('fresh.py', 'renamed.py');
  check('rename reports the new path', renamed.path === 'renamed.py', renamed.path);
  const oldGone = await svc.read('fresh.py').then(() => false, (e) => codeOf(e) === 'not-found');
  check('rename removes the old path', oldGone);

  const onto = await svc.rename('renamed.py', 'README.md').then(() => '', (e) => codeOf(e));
  check('rename refuses to clobber an existing path', onto === 'exists', onto);
  const intoSelf = await svc.rename('freshdir', 'freshdir/inner').then(() => '', (e) => codeOf(e));
  check('rename refuses to move a folder into itself', intoSelf === 'io', intoSelf);
  const samePath = await svc.rename('README.md', 'README.md');
  check('renaming to the same path is a no-op, not an error', samePath.path === 'README.md', samePath.path);

  // ---- remove ----
  const removed = await svc.remove('renamed.py');
  check('remove reports what it deleted', removed.path === 'renamed.py', removed.path);
  await svc.remove('freshdir');
  await svc.remove('made');
  check('remove deletes a folder recursively', await svc.list('made').then(() => false, (e) => codeOf(e) === 'not-found'));
  const rootDel = await svc.remove('').then(() => '', (e) => codeOf(e));
  check('remove refuses to delete the workspace root', rootDel === 'outside', rootDel);
  const missingDel = await svc.remove('nope').then(() => '', (e) => codeOf(e));
  check('removing a missing path is refused', missingDel === 'not-found', missingDel);

  // ---- containment: the security core ----
  // Every operation, against every shape of escape. One check per escape so a
  // failure names the shape that got through.
  const escapes = ['../outside.txt', 'a/../../b', '..\\windows', '/etc/passwd', 'C:/Windows/win.ini', 'pkg/../..', 'pkg/deep/../../../x'];
  for (const bad of escapes) {
    const leaks: string[] = [];
    const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
        leaks.push(`${label}:ALLOWED`);
      } catch (err) {
        if (codeOf(err) !== 'outside') leaks.push(`${label}:${codeOf(err)}`);
      }
    };
    await attempt('list', () => svc.list(bad));
    await attempt('read', () => svc.read(bad));
    await attempt('write', () => svc.write(bad, 'pwned'));
    await attempt('create', () => svc.create(bad, 'file'));
    await attempt('rename-from', () => svc.rename(bad, 'x'));
    await attempt('rename-to', () => svc.rename('README.md', bad));
    await attempt('remove', () => svc.remove(bad));
    check(`every operation refuses the escape "${bad}"`, leaks.length === 0, leaks.join(', ') || '7 operations');
  }

  check('the escaping write never created anything', !(await readFile(join(root, 'outside.txt'), 'utf8').then(() => true, () => false)));

  // ---- containment through a link ----
  // The lexical checks above all pass for `link/secret.txt`: the resolved path
  // *is* under the root. `readFile` still follows the link, so this is the one
  // shape a string comparison cannot catch. `realRoot` exists for it, and until
  // a probe walked out of a scratch workspace with a single junction, nothing
  // read that field.
  //
  // Self-contained on purpose: its own root, so it does not depend on where the
  // `setRoot` block below left the shared service.
  const linkRoot = join(sandbox, 'linktest');
  const linkOutside = join(sandbox, 'linktest-outside');
  await mkdir(join(linkRoot, 'inner'), { recursive: true });
  await mkdir(linkOutside, { recursive: true });
  await writeFile(join(linkOutside, 'secret.txt'), 'should never be readable', 'utf8');
  // A junction needs no administrator rights on Windows; POSIX gets a symlink.
  const linkKind: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';
  let linkReady = true;
  try {
    symlinkSync(linkOutside, join(linkRoot, 'link'), linkKind);
    symlinkSync(join(linkRoot, 'inner'), join(linkRoot, 'alias'), linkKind);
  } catch (err) {
    // A locked-down machine may refuse to create links at all. That is a SKIP,
    // not a pass, and the detail says which.
    linkReady = false;
    check('a link can be created for the containment test', true, `SKIP: ${(err as Error).message}`);
  }
  if (linkReady) {
    const linkSvc = new FsService(linkRoot);
    const throughLink: string[] = [];
    const attemptLink = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
        throughLink.push(`${label}:ALLOWED`);
      } catch (err) {
        if (codeOf(err) !== 'outside') throughLink.push(`${label}:${codeOf(err)}`);
      }
    };
    await attemptLink('list', () => linkSvc.list('link'));
    await attemptLink('read', () => linkSvc.read('link/secret.txt'));
    await attemptLink('write', () => linkSvc.write('link/written.txt', 'pwned'));
    await attemptLink('create', () => linkSvc.create('link/new.txt', 'file'));
    await attemptLink('rename-from', () => linkSvc.rename('link/secret.txt', 'x'));
    await attemptLink('rename-to', () => linkSvc.rename('inner', 'link/moved'));
    await attemptLink('remove', () => linkSvc.remove('link'));
    check('no operation follows a link out of the workspace', throughLink.length === 0, throughLink.join(', ') || '7 operations');
    check(
      'the link target was not written to',
      !(await readFile(join(linkOutside, 'written.txt'), 'utf8').then(() => true, () => false)),
    );

    // A link that stays inside is legitimate (a monorepo linking its own
    // folder), so the guard must not be a blanket ban on links.
    const viaAlias = await linkSvc.list('alias').then((l) => l.path, (e) => codeOf(e));
    check('a link that stays inside the workspace still works', viaAlias === 'alias', viaAlias);
  }

  // ---- setRoot ----
  const otherDir = join(sandbox, 'pkg');
  await svc.setRoot(otherDir);
  check('setRoot repoints the workspace and the containment anchor', svc.describe().name === 'pkg', svc.describe().name);
  const afterSwitch = await svc.list('').then((l) => l.entries.map((e) => e.name).join(','), (e) => codeOf(e));
  check('after setRoot the old root is no longer reachable', afterSwitch === 'deep,go.mod,main.py,new.txt', afterSwitch);
  const upFromNewRoot = await svc.list('..').then(() => '', (e) => codeOf(e));
  check('the escape check still holds after setRoot', upFromNewRoot === 'outside', upFromNewRoot);
  const notADir = await svc.setRoot(join(sandbox, 'README.md')).then(() => '', (e) => codeOf(e));
  check('setRoot refuses a file', notADir === 'is-dir', notADir);
  const noSuchDir = await svc.setRoot(join(sandbox, 'nope')).then(() => '', (e) => codeOf(e));
  check('setRoot refuses a missing folder', noSuchDir === 'not-found', noSuchDir);
  await svc.setRoot(sandbox);

  // ---- the listing cap: a folder that must not be walked forever ----
  // This is the "nothing here is allowed to be slow or fatal" rule, so it is
  // tested at the real boundary (MAX_ENTRIES) rather than a smaller number.
  //
  // The stress root lives in the OS temp dir, not next to the sandbox: the
  // assertion needs ~5000 real directory entries, and removing that many files
  // from inside the project tree is exactly the bulk delete a safety guard is
  // right to refuse. Cleanup is therefore best-effort — a refusal is reported,
  // never allowed to turn a green run red or leave garbage in the workspace.
  try {
    const stressRoot = await mkdtemp(join(tmpdir(), 'nolanguage-explorer-stress-'));
    const many = join(stressRoot, 'many');
    await mkdir(many, { recursive: true });
    for (let batch = 0; batch < 11; batch++) {
      await Promise.all(
        Array.from({ length: 500 }, (_, i) => writeFile(join(many, `f${batch * 500 + i}.txt`), 'x', 'utf8')),
      );
    }
    const capped = await new FsService(stressRoot).list('many');
    check(
      'a huge folder is cut off at the cap',
      capped.truncated === true && capped.entries.length === 5000,
      `${capped.entries.length} entries, truncated=${capped.truncated}`,
    );
    await rm(stressRoot, { recursive: true, force: true }).catch(() => {
      console.log(`  note: left the stress dir behind (cleanup refused) -> ${stressRoot}`);
    });
  } catch (err) {
    check(
      'a huge folder is cut off at the cap',
      false,
      `could not build the stress root: ${(err as Error).message}`,
    );
  }
}


/**
 * Open a real WebSocket, then send a frame whose declared length is 2^53-1.
 *
 * Written by hand because the point is the parser, not the client: a library
 * would refuse to encode it. The server must close instead of buffering.
 */
async function oversizedFrameRefused(port: number): Promise<{ closed: boolean; detail: string }> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    let upgraded = false;
    let buf = '';
    const done = (closed: boolean, detail: string): void => {
      try { sock.destroy(); } catch { /* gone */ }
      resolve({ closed, detail });
    };
    sock.setTimeout(6000, () => done(false, 'timeout: the server neither closed nor answered'));
    sock.on('error', () => done(true, 'socket error (connection torn down)'));
    sock.on('close', () => done(upgraded, upgraded ? 'closed after the oversized header' : 'closed before upgrade'));
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      if (!upgraded) {
        if (!buf.includes('\r\n\r\n')) return;
        if (!/^HTTP\/1\.1 101/.test(buf)) return done(false, `upgrade refused: ${buf.slice(0, 40)}`);
        upgraded = true;
        buf = '';
        // FIN + text, masked, 64-bit length form, length = 2^53-1.
        const head = Buffer.alloc(14);
        head[0] = 0x81;
        head[1] = 0x80 | 0x7f;
        head.writeBigUInt64BE(9007199254740991n, 2);
        head.writeUInt32BE(0x01020304, 10);
        sock.write(head);
        return;
      }
      // A close frame must carry 1009 ("message too big"). Any other code means
      // the socket died for an unrelated reason, which would make this check
      // pass while proving nothing.
      if ((chunk[0] & 0x0f) === 0x8) {
        const code = chunk.length >= 4 ? chunk.readUInt16BE(2) : 0;
        done(code === 1009, `close code ${code}`);
      }
    });
    sock.on('connect', () => {
      sock.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
          `Origin: http://127.0.0.1:${port}\r\n\r\n`,
      );
    });
  });
}

// =============================================================== phase 2

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(p));
    });
  });
}

async function waitForHttp(port: number, ms: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > ms) return false;
    await delay(100);
  }
}

async function testProtocol(): Promise<void> {
  const PORT = await freePort();
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', '--experimental-loader', './resolve-loader.mjs', 'src/panel/server.ts'],
    {
      env: { ...process.env, PANEL_PORT: String(PORT), PANEL_NO_STORE: '1', PANEL_EXPLORER_ROOT: sandbox },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverOut = '';
  child.stdout.on('data', (d) => (serverOut += d.toString()));
  child.stderr.on('data', (d) => (serverOut += d.toString()));

  try {
    const up = await waitForHttp(PORT, 20_000);
    check('the panel server boots with the explorer root', up, up ? `port ${PORT}` : serverOut.slice(-400));
    if (!up) return;

    // ---- the upgrade-origin check ----
    // A WebSocket handshake is exempt from the same-origin policy, so without
    // this a random web page could read and delete files through the explorer.
    const evil = new RawWsClient(PORT, '/', '127.0.0.1', { origin: 'http://evil.example' });
    const evilRefused = await evil.ready.then(() => false, () => true);
    check('a third-party origin cannot upgrade', evilRefused);
    evil.close();

    const nullOrigin = new RawWsClient(PORT, '/', '127.0.0.1', { origin: 'null' });
    check('an opaque origin ("null") cannot upgrade', await nullOrigin.ready.then(() => false, () => true));
    nullOrigin.close();

    const selfOrigin = new RawWsClient(PORT, '/', '127.0.0.1', { origin: `http://127.0.0.1:${PORT}` });
    check('the app\'s own origin can upgrade', await selfOrigin.ready.then(() => true, () => false));
    selfOrigin.close();

    // ---- the frame parser must refuse an impossible length ----
    // Same socket, one layer down. A client may declare a 2^53-byte frame; the
    // server used to wait for those bytes while `this.buffer` grew, so any local
    // process could exhaust the panel's memory without an Origin header at all
    // (`originAllowed` deliberately accepts a native client).
    const capped = await oversizedFrameRefused(PORT);
    check('a frame that declares an impossible length is refused', capped.closed, capped.detail);

    const c = new RawWsClient(PORT);
    await c.ready;
    check('a native client (no Origin header) can upgrade', true);

    // ---- fsRoot on connect ----
    const t0 = Date.now();
    while (!c.find('fsRoot') && Date.now() - t0 < 5000) await delay(50);
    const hello = c.find('fsRoot');
    check('connecting announces the explorer root', !!hello && hello.root === sandbox && hello.name === basename(sandbox), hello ? `${hello.name} @ ${hello.root}` : 'no fsRoot frame');

    /** Send a request and wait for the matching reply, asserting the reqId. */
    let reqSeq = 100;
    const call = async (msg: Record<string, unknown>, want: string): Promise<Record<string, unknown> | undefined> => {
      const reqId = ++reqSeq;
      c.clearReceived();
      c.send({ reqId, ...msg });
      const t = Date.now();
      while (Date.now() - t < 10_000) {
        const hit = c.received.find((m) => (m.kind === want || m.kind === 'fsError') && m.reqId === reqId);
        if (hit) return hit;
        await delay(40);
      }
      return undefined;
    };

    // ---- fsList ----
    const listed = await call({ kind: 'fsList', path: '' }, 'fsListing');
    check('fsList answers with fsListing', listed?.kind === 'fsListing', JSON.stringify(listed?.kind ?? null));
    check('the reply echoes the request id', listed?.reqId === reqSeq, `reqId ${String(listed?.reqId)} / sent ${reqSeq}`);
    const entryNames = ((listed?.entries as Array<{ name: string }>) ?? []).map((e) => e.name);
    check('fsListing carries the folder contents', entryNames.includes('pkg') && entryNames.includes('README.md'), entryNames.join(', '));

    // ---- fsRead ----
    const readFrame = await call({ kind: 'fsRead', path: 'pkg/main.py' }, 'fsFile');
    const file = readFrame?.file as { content: string; languageId: string } | undefined;
    check('fsRead answers with fsFile', readFrame?.kind === 'fsFile' && file?.content === 'print("hi")\n', file?.languageId ?? 'no file');

    // ---- fsWrite ----
    const saved = await call({ kind: 'fsWrite', path: 'pkg/wire.txt', content: 'over the wire' }, 'fsSaved');
    check('fsWrite answers with fsSaved', saved?.kind === 'fsSaved' && saved.path === 'pkg/wire.txt', JSON.stringify(saved?.path ?? null));
    check('fsSaved carries a fresh mtime', typeof saved?.mtime === 'number' && (saved.mtime as number) > 0, String(saved?.mtime));
    check('the written bytes are on disk', (await readFile(join(sandbox, 'pkg', 'wire.txt'), 'utf8')) === 'over the wire');

    // ---- fsCreate ----
    const created = await call({ kind: 'fsCreate', path: 'pkg/wire-new.py', entryKind: 'file' }, 'fsChanged');
    check('fsCreate answers with a create change', created?.kind === 'fsChanged' && created.op === 'create' && created.path === 'pkg/wire-new.py', JSON.stringify(created?.op ?? null));
    check('the created entry is described', (created?.entry as { kind?: string })?.kind === 'file', JSON.stringify((created?.entry as { name?: string })?.name ?? null));

    // ---- fsRename ----
    const renamed = await call({ kind: 'fsRename', path: 'pkg/wire-new.py', to: 'pkg/wire-renamed.py' }, 'fsChanged');
    check('fsRename answers with a rename change', renamed?.kind === 'fsChanged' && renamed.op === 'rename' && renamed.path === 'pkg/wire-renamed.py', JSON.stringify(renamed?.op ?? null));
    check('the rename reply carries `from` so open tabs can be remapped', renamed?.from === 'pkg/wire-new.py', String(renamed?.from));

    // ---- fsDelete ----
    const deleted = await call({ kind: 'fsDelete', path: 'pkg/wire-renamed.py' }, 'fsChanged');
    check('fsDelete answers with a delete change', deleted?.kind === 'fsChanged' && deleted.op === 'delete' && deleted.path === 'pkg/wire-renamed.py', JSON.stringify(deleted?.op ?? null));

    // ---- the error funnel ----
    const escaped = await call({ kind: 'fsRead', path: '../secrets.txt' }, 'fsError');
    check('a traversal read comes back as fsError/outside', escaped?.kind === 'fsError' && escaped.code === 'outside', `${String(escaped?.code)}: ${String(escaped?.message)}`);
    const absWrite = await call({ kind: 'fsWrite', path: 'C:/Windows/System32/drivers/etc/hosts', content: 'x' }, 'fsError');
    check('an absolute write comes back as fsError/outside', absWrite?.kind === 'fsError' && absWrite.code === 'outside', String(absWrite?.code));
    const noFile = await call({ kind: 'fsRead', path: 'ghost.txt' }, 'fsError');
    check('a missing file comes back as fsError/not-found', noFile?.code === 'not-found', String(noFile?.code));
    const listFile = await call({ kind: 'fsList', path: 'README.md' }, 'fsError');
    check('listing a file comes back as fsError/is-dir', listFile?.code === 'is-dir', String(listFile?.code));
    check('an fsError names the path it refused', typeof escaped?.path === 'string' && escaped.path.length > 0, String(escaped?.path));
    // The outer dispatch rejects a kind it does not know, so an unknown `fs*`
    // message never reaches the explorer handler at all. That rejection is a
    // bare `error` frame with no `reqId`, so it cannot go through `call()`.
    c.clearReceived();
    c.send({ kind: 'fsNope' });
    const t2 = Date.now();
    let unknown: Record<string, unknown> | undefined;
    while (Date.now() - t2 < 6000 && !unknown) {
      unknown = c.received.find((m) => m.kind === 'error');
      if (!unknown) await delay(40);
    }
    check(
      'an unknown fs message is rejected, not ignored',
      /unknown message kind/.test(String(unknown?.message ?? '')),
      String(unknown?.message ?? 'no reply'),
    );

    // ---- openFolder moves the anchor, and the checks move with it ----
    const sub = join(sandbox, 'pkg');
    c.clearReceived();
    c.send({ reqId: 999, kind: 'openFolder', path: sub });
    const t1 = Date.now();
    let moved: Record<string, unknown> | undefined;
    while (Date.now() - t1 < 8000) {
      moved = c.received.find((m) => m.kind === 'fsRoot' && m.reqId === 999);
      if (moved) break;
      await delay(40);
    }
    check('openFolder repoints the explorer root', moved?.root === sub && moved?.name === 'pkg', `${String(moved?.name)} @ ${String(moved?.root)}`);
    const afterMove = await call({ kind: 'fsRead', path: 'README.md' }, 'fsError');
    check('after openFolder the previous root is out of reach', afterMove?.code === 'not-found', String(afterMove?.code));
    const stillGuarded = await call({ kind: 'fsList', path: '..' }, 'fsError');
    check('after openFolder the traversal guard still holds', stillGuarded?.code === 'outside', String(stillGuarded?.code));

    c.close();
  } finally {
    child.kill('SIGKILL');
  }

  if (results.some(([n, ok]) => !ok && /panel server boots/.test(n))) {
    console.log('--- server output (tail) ---\n' + serverOut.slice(-1500));
  }
}

// =============================================================== run

/**
 * A phase that dies half way is the worst outcome: the suite reports 0/0, which
 * says nothing about what broke. Run each phase inside a guard so the summary
 * always names the phase and the reason, and the exit code still fails.
 */
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    check(`${name} phase ran to completion`, false, `aborted: ${(err as Error).message}`);
  }
}

await setupWorkspace().catch((err) => {
  check('the explorer workspace can be created', false, (err as Error).message);
});
await guarded('FsService', testService);
console.log('');
await guarded('fs protocol', testProtocol);

// Best-effort: the harness may hold a lock on the tree, and a leftover
// directory must never turn a green run red.
await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
