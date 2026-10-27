/**
 * Authenticode presence checks.
 *
 * Two questions, deliberately kept apart:
 *
 *   hasEmbeddedSignature()  does the file carry a signature blob at all?
 *   verifySignature()       is that signature valid, and by whom?
 *
 * The first is a **PE header read** — the certificate table is data directory
 * entry 4 — so it needs no process, no crypto provider and no Windows SDK. The
 * second genuinely needs CryptoAPI, so it shells out to PowerShell's
 * `Get-AuthenticodeSignature` (hidden, time-boxed) and degrades to `unknown`
 * rather than lying when that fails.
 *
 * Why it matters: an unsigned exe triggers SmartScreen on first run, which
 * users read as "this app is suspicious". `nlg doctor` saying `unsigned` is the
 * difference between a support ticket and a one-line fix.
 */
import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';

export interface SignatureInfo {
  /** A certificate table entry exists in the PE header. */
  embedded: boolean;
  /** `Valid`, `NotSigned`, `UnknownError`, … or `unknown` when unverifiable. */
  status: string;
  /** Subject of the signing certificate, when known. */
  signer?: string;
  /** Why the status could not be determined, when that is the case. */
  error?: string;
}

/**
 * Read the PE certificate-table entry (data directory **4**).
 *
 * Accepts a buffer so tests can build headers by hand; the file wrapper below
 * reads only the first 4 KiB, which always contains the optional header.
 */
export function hasEmbeddedSignature(buf: Buffer): boolean {
  const off = certificateTableOffset(buf);
  return off >= 0 && buf.readUInt32LE(off + 4) > 0;
}

/** `hasEmbeddedSignature` for a file on disk; `false` when unreadable. */
export function readSignaturePresence(path: string): boolean {
  let fd: number | undefined;
  try {
    if (statSync(path).size < 0x40) return false;
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4096);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return hasEmbeddedSignature(buf.subarray(0, read));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Byte offset of the PE certificate-table entry, or `-1` when not a PE. */
export function certificateTableOffset(buf: Buffer): number {
  if (buf.length < 0x40) return -1;
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return -1;
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff <= 0 || peOff + 24 > buf.length) return -1;
  if (buf.readUInt32LE(peOff) !== 0x00004550) return -1;
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  const is64 = magic === 0x20b;
  if (!is64 && magic !== 0x10b) return -1;
  const dirOff = optOff + (is64 ? 112 : 96) + 4 * 8;
  return dirOff + 8 <= buf.length ? dirOff : -1;
}

/**
 * Clear a stale certificate table entry, in place.
 *
 * A Node SEA is `node.exe` plus an appended blob, and it **inherits node.exe's
 * signature**. That entry now points into the middle of the file, so Authenticode
 * refuses to add a new one ("%1 is not a valid Win32 application") — the build
 * looks signed and cannot be signed. Zeroing the directory entry is enough: the
 * old bytes stay (harmless), and the file is honestly unsigned again.
 *
 * Returns true when an entry was actually cleared.
 */
export function clearEmbeddedSignature(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    const head = Buffer.alloc(4096);
    const read = readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, read);
    const off = certificateTableOffset(buf);
    if (off < 0) return false;
    if (buf.readUInt32LE(off + 4) === 0) return false;
    writeSync(fd, Buffer.alloc(8), 0, 8, off);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Ask Windows for the real verdict.
 *
 * `embedded: false` is *not* the same as "unsigned": Windows also validates
 * catalog-signed binaries (most system exes have no certificate table at all —
 * the signature lives in a .cat file). So the presence check short-circuits only
 * when the caller explicitly does not care about catalogs, which is the case for
 * our own build.
 *
 * `-NoProfile` keeps a user's profile from slowing this down or printing
 * banners; `windowsHide` keeps the console from flashing (a diagnostics command
 * must not produce the very popup the user is complaining about).
 */
export async function verifySignature(
  path: string,
  opts: { catalog?: boolean; timeoutMs?: number } = {},
): Promise<SignatureInfo> {
  const embedded = readSignaturePresence(path);
  if (!embedded && !opts.catalog) return { embedded: false, status: 'NotSigned' };
  if (process.platform !== 'win32') return { embedded, status: 'unknown', error: 'Authenticode is Windows-only' };

  const quoted = path.replace(/'/g, "''");
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${quoted}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  const out = await runPowerShell(script, opts.timeoutMs ?? 6000);
  if (!out) return { embedded, status: 'unknown', error: 'Get-AuthenticodeSignature produced no output' };
  const [status, signer] = out.trim().split('|');
  return { embedded, status: status || 'unknown', ...(signer ? { signer } : {}) };
}

function runPowerShell(script: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}
