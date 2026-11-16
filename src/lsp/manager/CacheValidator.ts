/**
 * The gate between a persisted index and a running manager.
 *
 * The rule is one line: **a signature mismatch invalidates the cache, it does
 * not "refresh" it.** An index built by a different jdtls, a different JDK or a
 * different schema describes a world that no longer exists, and half-reusing it
 * is how an IDE reports errors that were fixed last week.
 *
 * Persisted state is best-effort: an unreadable or unwritable cache directory
 * degrades to "no cache", never to a failure.
 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexMetadata, LanguagePlugin } from './types.js';
import { ContentHashStrategy, headCommit } from './strategies.js';
import { shortSignature } from './signature.js';

export interface ValidateOutcome {
  valid: boolean;
  reason: string;
}

export interface EnsureOutcome {
  metadata: IndexMetadata;
  /** True when the previous state could not be reused. */
  rebuilt: boolean;
  reason: string;
}

export class CacheValidator {
  private readonly hash = new ContentHashStrategy();
  private readonly memo = new Map<string, EnsureOutcome>();

  /** @param dir `<home>/index` — one JSON file per plugin. */
  constructor(private readonly dir: string) {}

  private pathFor(pluginId: string): string {
    // Plugin ids are validated elsewhere (`ID_RE`), but a path segment is a path
    // segment: refuse anything that could escape the directory anyway.
    const safe = pluginId.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  async load(pluginId: string): Promise<IndexMetadata | undefined> {
    try {
      const raw = await readFile(this.pathFor(pluginId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<IndexMetadata>;
      if (typeof parsed.signature !== 'string' || typeof parsed.indexedAt !== 'string') return undefined;
      return {
        signature: parsed.signature,
        indexedCommit: typeof parsed.indexedCommit === 'string' ? parsed.indexedCommit : null,
        indexedAt: parsed.indexedAt,
        ...(parsed.stamps && typeof parsed.stamps === 'object' ? { stamps: parsed.stamps } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async save(pluginId: string, metadata: IndexMetadata): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.pathFor(pluginId), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    } catch {
      /* a read-only home is not a reason to refuse to work */
    }
  }

  async drop(pluginId: string): Promise<void> {
    try {
      await rm(this.pathFor(pluginId), { force: true });
    } catch {
      /* best effort */
    }
    this.memo.delete(pluginId);
  }

  /**
   * Can `metadata` be reused for `plugin`?
   *
   * Nothing else is considered: not the mtime of the file, not the age. Those
   * would let a *wrong* cache through, which is the failure this exists to
   * prevent.
   */
  validate(plugin: LanguagePlugin, metadata: IndexMetadata | undefined): ValidateOutcome {
    if (!metadata) return { valid: false, reason: 'no cached index' };
    const expected = plugin.versionSignature();
    if (metadata.signature !== expected) {
      return {
        valid: false,
        reason: `signature changed (${shortSignature(metadata.signature)} → ${shortSignature(expected)})`,
      };
    }
    return { valid: true, reason: `signature ${shortSignature(expected)}` };
  }

  /**
   * Validate, and build fresh metadata when the cache cannot be trusted.
   *
   * Memoised per plugin for the life of the manager: the check runs before a
   * cold start, and re-walking a project for stamps on every request would cost
   * more than the cache saves.
   */
  async ensure(plugin: LanguagePlugin, root: string): Promise<EnsureOutcome> {
    const hit = this.memo.get(plugin.id);
    if (hit) return hit;

    const previous = await this.load(plugin.id);
    const verdict = this.validate(plugin, previous);
    if (verdict.valid && previous) {
      const outcome: EnsureOutcome = { metadata: previous, rebuilt: false, reason: verdict.reason };
      this.memo.set(plugin.id, outcome);
      return outcome;
    }

    const metadata: IndexMetadata = {
      signature: plugin.versionSignature(),
      indexedCommit: await headCommit(root),
      indexedAt: new Date().toISOString(),
      ...(plugin.incremental()?.kind === 'content-hash' ? { stamps: await this.hash.stampsFor(root) } : {}),
    };
    await this.save(plugin.id, metadata);
    const outcome: EnsureOutcome = { metadata, rebuilt: true, reason: verdict.reason };
    this.memo.set(plugin.id, outcome);
    return outcome;
  }

  /** Forget the memoised state — used when the plugin list changes. */
  reset(pluginId?: string): void {
    if (pluginId === undefined) this.memo.clear();
    else this.memo.delete(pluginId);
  }
}
