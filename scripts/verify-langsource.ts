/**
 * Language source resolution — the layer that turns "what the user typed" into
 * a directory before `LanguageRegistry.install()` ever sees it.
 *
 * The archives here are built by hand (a stored zip and a ustar tar) so the
 * suite needs no external archiver and runs anywhere. That also keeps the
 * fixtures minimal: what is under test is the reader's parsing and, above all,
 * its refusal to write outside the destination.
 *
 * Network and git are exercised only through `classifySource` — they are the
 * two paths that need a network or a toolchain a suite must not assume. Every
 * check that could reach the network is deliberately a pure classification,
 * except the sha256 block: it serves its own bytes from a loopback server so
 * the hash comparison is a real download, not a stub.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sha256Hex } from '../src/util/hash.js';
import {
  SourceError,
  classifySource,
  disposeSource,
  resolveSource,
  safeJoin,
} from '../src/langs/SourceResolver.js';

let passed = 0;
let total = 0;

function check(name: string, ok: boolean, detail?: string): void {
  total++;
  if (ok) {
    passed++;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

/** Expect a rejection, and surface the message so a *wrong* error is visible. */
async function rejects(name: string, fn: () => Promise<unknown>, wantFragment?: string): Promise<void> {
  try {
    await fn();
    check(name, false, 'it did not throw');
  } catch (err) {
    const message = (err as Error).message;
    const ok = err instanceof SourceError && (!wantFragment || message.includes(wantFragment));
    check(name, ok, message);
  }
}

// ---------------------------------------------------------------- fixtures

const MANIFEST = JSON.stringify(
  {
    id: 'fixture',
    displayName: 'Fixture',
    version: '1.2.3',
    apiVersion: '^1.0.0',
    file: { extensions: ['fixt'], defaultExt: 'fixt' },
  },
  null,
  2,
);

/** CRC-32 (zip needs it; implemented here to avoid a version-dependent API). */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** A zip with every entry stored (method 0) — the simplest valid container. */
function buildStoredZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + entry.data.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

interface TarEntry {
  name: string;
  data: Buffer;
  typeflag?: string;
}

function tarHeader(name: string, size: number, typeflag: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('000644 \0', 100, 8, 'ascii');
  header.write('000000 \0', 108, 8, 'ascii');
  header.write('000000 \0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'ascii');
  header.write('        ', 136, 8, 'ascii'); // mtime
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function buildTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const typeflag = entry.typeflag ?? '0';
    const size = typeflag === '5' ? 0 : entry.data.length;
    blocks.push(tarHeader(entry.name, size, typeflag));
    if (size > 0) {
      blocks.push(entry.data);
      const pad = (512 - (size % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return Buffer.concat(blocks);
}

async function readJson(path: string): Promise<{ id?: string; version?: string }> {
  return JSON.parse(await readFile(path, 'utf8')) as { id?: string; version?: string };
}

// ---------------------------------------------------------------- suite

async function main(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'nlg-langsrc-'));

  try {
    // ---- classification: pure, so it is safe to test every shape ----
    check('classify: an existing directory is a directory', classifySource(work) === 'dir');
    check('classify: git@ scp form is git', classifySource('git@github.com:someone/nolang-rust.git') === 'git');
    check('classify: https + .git is git', classifySource('https://github.com/someone/nolang-rust.git') === 'git');
    check('classify: ssh:// is git', classifySource('ssh://git@host/repo.git') === 'git');
    check('classify: an https archive is a url', classifySource('https://example.org/plugin.zip') === 'url');
    check('classify: an unknown extension is still a url (refused later)', classifySource('https://example.org/plugin.bin') === 'url');
    check('classify: garbage is unknown', classifySource('not a source at all') === 'unknown');

    const zipPath = join(work, 'plugin.zip');
    await writeFile(zipPath, buildStoredZip([{ name: 'manifest.json', data: Buffer.from(MANIFEST) }]));
    check('classify: a real .zip file is a zip', classifySource(zipPath) === 'zip');

    const tarPath = join(work, 'plugin.tar.gz');
    await writeFile(
      tarPath,
      gzipSync(buildTar([{ name: 'manifest.json', data: Buffer.from(MANIFEST) }])),
    );
    check('classify: a real .tar.gz is a tar', classifySource(tarPath) === 'tar');

    // ---- a directory is used in place and never deleted ----
    const dirSource = join(work, 'plain');
    await mkdir(dirSource, { recursive: true });
    await writeFile(join(dirSource, 'manifest.json'), MANIFEST);
    const fromDir = await resolveSource(dirSource);
    check('dir: resolved to the same directory', fromDir.dir === resolve(dirSource));
    check('dir: marked as not-temporary', fromDir.temp === false);
    await disposeSource(fromDir);
    check('dir: dispose leaves the user directory alone', existsSync(dirSource));

    await rejects('dir: a directory without a manifest is refused', () => resolveSource(work), 'manifest.json');

    // ---- archives unpack to a temp directory ----
    const fromZip = await resolveSource(zipPath);
    const zipManifest = await readJson(join(fromZip.dir, 'manifest.json'));
    check('zip: manifest survives extraction', zipManifest.id === 'fixture' && zipManifest.version === '1.2.3');
    check('zip: marked as temporary', fromZip.temp === true);
    const zipDir = fromZip.dir;
    await disposeSource(fromZip);
    check('zip: dispose removes the temp directory', !existsSync(zipDir));

    const fromTar = await resolveSource(tarPath);
    const tarManifest = await readJson(join(fromTar.dir, 'manifest.json'));
    check('tar.gz: manifest survives extraction', tarManifest.id === 'fixture');
    await disposeSource(fromTar);

    // ---- archives usually wrap everything in one folder ----
    const wrapped = join(work, 'wrapped.zip');
    await writeFile(
      wrapped,
      buildStoredZip([
        { name: 'plugin/', data: Buffer.alloc(0) },
        { name: 'plugin/manifest.json', data: Buffer.from(MANIFEST) },
        { name: 'plugin/notes.txt', data: Buffer.from('hello') },
      ]),
    );
    const fromWrapped = await resolveSource(wrapped);
    check('zip: descends into the single wrapper folder', existsSync(join(fromWrapped.dir, 'manifest.json')));
    await disposeSource(fromWrapped);

    // ---- the security half: nothing may escape the destination ----
    const evilZip = join(work, 'evil.zip');
    await writeFile(
      evilZip,
      buildStoredZip([
        { name: 'manifest.json', data: Buffer.from(MANIFEST) },
        { name: '../escaped.txt', data: Buffer.from('owned') },
      ]),
    );
    await rejects('zip slip: a ../ entry is refused', () => resolveSource(evilZip), 'escape');

    const evilTar = join(work, 'evil.tar.gz');
    await writeFile(
      evilTar,
      gzipSync(
        buildTar([
          { name: 'manifest.json', data: Buffer.from(MANIFEST) },
          { name: '../escaped.txt', data: Buffer.from('owned') },
        ]),
      ),
    );
    await rejects('tar slip: a ../ entry is refused', () => resolveSource(evilTar), 'escape');

    const evilAbs = join(work, 'abs.zip');
    await writeFile(evilAbs, buildStoredZip([{ name: '/etc/passwd', data: Buffer.from('x') }]));
    await rejects('zip: an absolute path is refused', () => resolveSource(evilAbs), 'escape');

    // ---- safeJoin, directly ----
    const base = join(work, 'base');
    check('safeJoin: a normal name resolves inside', safeJoin(base, 'a/b.txt') === join(base, 'a', 'b.txt'));
    check('safeJoin: .. is rejected', safeJoin(base, '../out.txt') === null);
    check('safeJoin: an absolute path is rejected', safeJoin(base, '/tmp/x') === null);
    check('safeJoin: a drive letter is rejected', safeJoin(base, 'C:/x') === null);
    check('safeJoin: backslashes are normalised', safeJoin(base, 'a\\b.txt') === join(base, 'a', 'b.txt'));

    // ---- an archive with no manifest is reported, not guessed ----
    const empty = join(work, 'empty.zip');
    await writeFile(empty, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('hi') }]));
    await rejects('zip: no manifest anywhere is refused', () => resolveSource(empty), 'manifest.json');

    // ---- expansion bombs are bounded before anything is written ----
    await rejects(
      'zip bomb: the entry count is capped',
      () => resolveSource(zipPath, { maxEntries: 0 }),
      'entries',
    );
    await rejects(
      'zip bomb: a single entry has an uncompressed cap',
      () => resolveSource(zipPath, { maxEntryBytes: 1 }),
      'declares',
    );
    await rejects(
      'zip bomb: total expanded bytes are capped',
      () => resolveSource(zipPath, { maxExpandedBytes: 1 }),
      'expands',
    );
    await rejects(
      'tar bomb: total expanded bytes are capped',
      () => resolveSource(tarPath, { maxExpandedBytes: 1 }),
      'expands',
    );

    // ---- sha256: a download is hashed before anything is unpacked ----
    // A loopback server is the only network here, and it serves bytes from this
    // process — the point is the *check*, not the transport.
    const served = buildStoredZip([{ name: 'manifest.json', data: Buffer.from(MANIFEST) }]);
    const server = createServer((req, res) => {
      if (req.url === '/plugin.zip') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end(served);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/plugin.zip`;
    try {
      const good = sha256Hex(served);
      const verified = await resolveSource(url, { expectSha256: good });
      check('sha256: a matching hash installs', existsSync(join(verified.dir, 'manifest.json')));
      await disposeSource(verified);
      const prefixed = await resolveSource(url, { expectSha256: `sha256:${good}` });
      check('sha256: the sha256: prefix is accepted', existsSync(join(prefixed.dir, 'manifest.json')));
      await disposeSource(prefixed);
      await rejects(
        'sha256: a mismatch is refused',
        () => resolveSource(url, { expectSha256: 'a'.repeat(64) }),
        'hash mismatch',
      );
      await rejects(
        'sha256: a malformed expectation is refused',
        () => resolveSource(url, { expectSha256: 'not-a-hash' }),
        'not 64 hex',
      );
      await rejects(
        'sha256: a remote install with no expectation is refused by default',
        () => resolveSource(url),
        'no sha256',
      );
      const optedIn = await resolveSource(url, { allowUnverifiedRemote: true });
      check('sha256: an explicit opt-in allows an unverified remote install', existsSync(optedIn.dir));
      await disposeSource(optedIn);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(`${passed}/${total} checks passed`);
  process.exit(passed === total ? 0 : 1);
}

void main();
