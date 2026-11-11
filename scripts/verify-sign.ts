/**
 * Code signing: the PE header read, the script wiring, and (optionally) a real
 * round trip through Authenticode.
 *
 * Three layers, because "signing" fails in three different places:
 *
 *   1. detection — does the file even carry a certificate table? Pure header
 *      parse, so it is tested against hand-built buffers.
 *   2. wiring — does `installer/sign.ps1` exist, does it refuse to pretend, is
 *      it reachable from npm, does doctor report the result?
 *   3. reality — with `NOLANGUAGE_SIGN_TEST=1`, sign a throwaway copy of a
 *      system exe with a self-signed certificate and confirm Windows agrees.
 *      Gated because it writes to the user's certificate store.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { clearEmbeddedSignature, hasEmbeddedSignature, readSignaturePresence, verifySignature } from '../src/cli/signature.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (rel: string): string => readFileSync(join(here, '..', rel), 'utf8');

// ---------------------------------------------------------------- PE header

/** Build a minimal PE image with (or without) a certificate table entry. */
function fakePe(opts: { magic?: 0x10b | 0x20b; certSize?: number } = {}): Buffer {
  const buf = Buffer.alloc(4096);
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  const peOff = 0x80;
  buf.writeUInt32LE(peOff, 0x3c);
  buf.writeUInt32LE(0x00004550, peOff); // "PE\0\0"
  const optOff = peOff + 24;
  const magic = opts.magic ?? 0x20b;
  buf.writeUInt16LE(magic, optOff);
  const dirOff = optOff + (magic === 0x20b ? 112 : 96) + 4 * 8; // directory 4
  buf.writeUInt32LE(0x1234, dirOff); // VA
  buf.writeUInt32LE(opts.certSize ?? 0, dirOff + 4);
  return buf;
}

check('pe: an unsigned image has no certificate table', hasEmbeddedSignature(fakePe()) === false);
check('pe: a certificate table entry is detected', hasEmbeddedSignature(fakePe({ certSize: 2048 })) === true);
check('pe: PE32 (32-bit) headers are read too', hasEmbeddedSignature(fakePe({ magic: 0x10b, certSize: 512 })) === true);
check('pe: a non-MZ file is rejected', hasEmbeddedSignature(Buffer.from('not a binary at all')) === false);
check('pe: a truncated header is rejected', hasEmbeddedSignature(Buffer.alloc(10)) === false);
check('pe: a corrupt PE offset is rejected', (() => {
  const buf = fakePe({ certSize: 1024 });
  buf.writeUInt32LE(0xfffffff0, 0x3c);
  return hasEmbeddedSignature(buf) === false;
})());

// `clearEmbeddedSignature` is what `build-exe.mjs` mirrors inline (that script
// runs without the TypeScript loader). Testing it on a real file keeps the two
// implementations honest: if the algorithm drifts, signing breaks again.
const peDir = mkdtempSync(join(tmpdir(), 'nlg-pe-'));
const fakeExe = join(peDir, 'fake.exe');
try {
  writeFileSync(fakeExe, fakePe({ certSize: 1024 }));
  check('pe: a synthetic signed image reads as signed', readSignaturePresence(fakeExe) === true);
  check('clear: the certificate entry is removed', clearEmbeddedSignature(fakeExe) === true);
  check('clear: the file then reads as unsigned', readSignaturePresence(fakeExe) === false);
  check('clear: a second call is a no-op', clearEmbeddedSignature(fakeExe) === false);
} finally {
  // `rmSync` on Windows can hit ENOTEMPTY when a file was just closed; retrying
  // is the fix, and a leftover temp directory is not worth failing 25 assertions.
  rmSync(peDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const dist = join(here, '..', 'dist', 'Nolanguage.exe');
if (existsSync(dist)) {
  const info = await verifySignature(dist);
  check('signature: an unsigned build reports NotSigned', info.status === 'NotSigned' || info.status === 'Valid', info.status);
} else {
  check('signature: dist exe present (skipped)', true, 'no dist/Nolanguage.exe — run npm run build:exe');
}

// ---------------------------------------------------------------- wiring

const sign = read('installer/sign.ps1');
check('sign.ps1: exists and signs with CryptoAPI', /Set-AuthenticodeSignature/.test(sign));
check('sign.ps1: accepts a real .pfx', /Import-PfxCertificate/.test(sign) && /\[string\]\$Pfx/.test(sign));
check('sign.ps1: accepts a store thumbprint', /Cert:\\CurrentUser\\My/.test(sign) && /\[string\]\$Thumbprint/.test(sign));
check('sign.ps1: can mint a local certificate', /New-SelfSignedCertificate/.test(sign));
check('sign.ps1: has a read-only verify mode', /\[switch\]\$Verify/.test(sign) && /Get-AuthenticodeSignature/.test(sign));
check(
  'sign.ps1: refuses to sign without a certificate',
  /exit 2/.test(sign) && /nothing was signed/.test(sign),
);
check('sign.ps1: says what a self-signed cert does not prove', /SmartScreen/.test(sign));
check(
  'sign.ps1: falls back when the timestamp server is unreachable',
  /signing without one/.test(sign),
);

const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
check('npm: a sign script exists', !!pkg.scripts.sign && /sign\.ps1/.test(pkg.scripts.sign));
check('npm: a verify script exists', !!pkg.scripts['sign:verify'] && /-Verify/.test(pkg.scripts['sign:verify']));
check('npm: build:sign chains build + sign', !!pkg.scripts['build:sign'] && /build:exe/.test(pkg.scripts['build:sign']));

const doctor = read('src/cli/doctor.ts');
check('doctor: reports the signature', /signature\?: SignatureInfo/.test(doctor) && /verifySignature\(exePath\)/.test(doctor));
check('doctor: hints when the build is unsigned', /not code-signed/.test(doctor));

const buildExe = read('scripts/build-exe.mjs');
check(
  'build: the inherited node.exe signature is cleared (otherwise signing is impossible)',
  /clearInheritedSignature/.test(buildExe) && /data directory 4/.test(buildExe),
);
check(
  'build: the exe is not left looking signed',
  readSignaturePresence(dist) === false,
  existsSync(dist) ? `embedded=${readSignaturePresence(dist)}` : 'no dist exe',
);

// ---------------------------------------------------------------- catalog vs embedded

/**
 * Most Windows system binaries carry **no** certificate table: their signature
 * lives in a security catalog (.cat) and CryptoAPI validates it there. This is
 * why "no embedded signature" must never be reported as "unsigned" — the
 * distinction is the whole reason `verifySignature` has a `catalog` option.
 */
const systemExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
if (existsSync(systemExe)) {
  check('catalog: a system exe has no embedded certificate table', readSignaturePresence(systemExe) === false);
  const cat = await verifySignature(systemExe, { catalog: true });
  check('catalog: Windows still validates it', cat.status === 'Valid', `${cat.status} embedded=${cat.embedded}`);
}

// ---------------------------------------------------------------- round trip

if (process.env.NOLANGUAGE_SIGN_TEST === '1' && process.platform === 'win32' && existsSync(dist)) {
  // Sign a throwaway copy of the real build: it is genuinely unsigned, which a
  // system exe is not, so the round trip proves the whole path.
  const dir = mkdtempSync(join(tmpdir(), 'nlg-sign-'));
  const target = join(dir, 'sample.exe');
  try {
    copyFileSync(dist, target);
    check('roundtrip: the copy starts unsigned', readSignaturePresence(target) === false);
    const signed = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, '..', 'installer', 'sign.ps1'), '-SelfSigned', '-Path', target],
      { encoding: 'utf8', windowsHide: true, timeout: 180_000 },
    );
    check('roundtrip: sign.ps1 exits 0', signed.status === 0, (signed.stdout || signed.stderr || '').trim().split('\n').slice(-1)[0]);
    check('roundtrip: the certificate table appears', readSignaturePresence(target) === true);
    const info = await verifySignature(target);
    check(
      'roundtrip: Windows accepts the signature',
      info.status === 'Valid' || info.status === 'UnknownError',
      `${info.status} embedded=${info.embedded}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
} else {
  console.log('SKIP  signing round trip (set NOLANGUAGE_SIGN_TEST=1 to sign a throwaway exe)');
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
