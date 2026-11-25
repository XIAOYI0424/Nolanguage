/**
 * SHA-256 helpers, in one place.
 *
 * Two callers need the same answer for the same reason: `nlg doctor` hashes the
 * installed executable to report it, and the plugin installer hashes a download
 * before unpacking it — a package that will be executed as plugin code. Keeping
 * one implementation means the two can never disagree about what "the hash of
 * this file" is (hex, lowercase).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Lowercase hex SHA-256 of `data`. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Lowercase hex SHA-256 of a file's bytes, or `undefined` when it cannot be
 * read. Callers that are reporting (doctor) treat unreadable as "no hash";
 * callers that are verifying must treat it as a failure themselves.
 */
export function sha256File(path: string): string | undefined {
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return undefined;
  }
}

/**
 * Parse an expected hash from an index entry.
 *
 * Accepts the bare 64 hex characters and the `sha256:<hex>` form that some
 * tools emit; anything else is `undefined` so the caller can refuse the package
 * rather than compare against a value that could never match.
 */
export function parseSha256(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const hex = raw.trim().replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}
