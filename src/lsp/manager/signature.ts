/**
 * Cache identity for an index.
 *
 * A persisted index is only reusable if it was built by *this* server build with
 * *this* schema. Anything else is not "a bit stale" — it is wrong, and reusing
 * it reports problems that no longer exist while hiding the ones that do.
 *
 * The signature therefore has to include every input that can change what the
 * index means:
 *
 * - the language-server binary version (a gopls upgrade changes diagnostics),
 * - the LSP protocol revision (capability semantics move between revisions),
 * - this manager's index schema (our own shape changes invalidate old files),
 * - the language toolchain version (jdtls behaviour depends on the JDK).
 *
 * The toolchain part is a placeholder on purpose: probing a JDK costs a process
 * spawn, so the adapter passes whatever it already knows and `unknown` is an
 * accepted value that still yields a stable signature.
 */
import { createHash } from 'node:crypto';

/** Bump when `IndexMetadata` or what we store alongside it changes shape. */
export const INDEX_SCHEMA_VERSION = 1;

/** The LSP revision this client speaks. */
export const LSP_PROTOCOL_VERSION = '3.17';

export interface SignatureParts {
  pluginId: string;
  serverName: string;
  /** `jdtls --version` output, or `unknown` when probing failed. */
  serverVersion?: string;
  /** Toolchain build (JDK, Go, Node), or `unknown`. */
  toolchainVersion?: string;
  /** Overridden by tests to simulate a server upgrade. */
  schemaVersion?: number;
  protocolVersion?: string;
}

/**
 * A stable hex digest. Same inputs → same signature, on every machine and every
 * run, which is what makes a persisted cache safe to trust across sessions.
 */
export function versionSignature(parts: SignatureParts): string {
  const payload = [
    `plugin=${parts.pluginId}`,
    `server=${parts.serverName}`,
    `serverVersion=${parts.serverVersion ?? 'unknown'}`,
    `protocol=${parts.protocolVersion ?? LSP_PROTOCOL_VERSION}`,
    `schema=${parts.schemaVersion ?? INDEX_SCHEMA_VERSION}`,
    `toolchain=${parts.toolchainVersion ?? 'unknown'}`,
  ].join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Short form for logs and the status bar. */
export const shortSignature = (sig: string): string => sig.slice(0, 12);
