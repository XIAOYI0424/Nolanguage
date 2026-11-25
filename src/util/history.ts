/**
 * Local revision snapshots.
 *
 * This is deliberately independent of Git and of the panel layer: an editor
 * needs to get back a change made two saves ago even when the project has no
 * repository at all. Snapshots live in the application data directory, are
 * keyed by a hash of (workspace root, relative path), and never interpolate a
 * client-supplied path into a filename.
 *
 * A snapshot is taken *before* a write, so list[0] is the version that was
 * replaced by the most recent write. Reverting writes that content back through
 * FsService, which also produces another snapshot — so a revert is reversible.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appDataDir } from './appData.js';

export interface HistoryEntry {
  id: string;
  path: string;
  root: string;
  savedAt: number;
  size: number;
  reason: string;
}

interface HistoryRecord extends HistoryEntry {
  content: string;
}

const MAX_REVISIONS = 40;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const ID_RE = /^[a-f0-9]{40}-\d+-[a-f0-9]{8}$/;

function historyDir(): string {
  return join(appDataDir(), 'history');
}

function keyFor(root: string, rel: string): string {
  return createHash('sha1').update(root + '\u0000' + rel.replace(/\\/g, '/')).digest('hex');
}

function safeRel(rel: string): boolean {
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.replace(/\\/g, '/').split('/').some((p) => p === '..');
}

async function readRecord(file: string): Promise<HistoryRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as HistoryRecord;
    if (!raw || typeof raw.id !== 'string' || typeof raw.path !== 'string' ||
        typeof raw.root !== 'string' || typeof raw.content !== 'string') return undefined;
    return raw;
  } catch {
    // A truncated or hand-edited snapshot must never fail a whole history list.
    return undefined;
  }
}

function publicEntry(r: HistoryRecord): HistoryEntry {
  return { id: r.id, path: r.path, root: r.root, savedAt: r.savedAt, size: r.size, reason: r.reason };
}

export class HistoryStore {
  /** Snapshot the current disk content before an edit. Best-effort by design. */
  async snapshot(root: string, rel: string, content: string, reason = 'save'): Promise<HistoryEntry | undefined> {
    if (!safeRel(rel)) return undefined;
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_BYTES) return undefined;
    const id = keyFor(root, rel) + '-' + Date.now() + '-' + randomUUID().slice(0, 8);
    const record: HistoryRecord = {
      id, root, path: rel, content: text, reason,
      savedAt: Date.now(), size: Buffer.byteLength(text, 'utf8'),
    };
    await mkdir(historyDir(), { recursive: true });
    await writeFile(join(historyDir(), id + '.json'), JSON.stringify(record), 'utf8');
    await this.prune(keyFor(root, rel));
    return publicEntry(record);
  }

  /** Recent snapshots, newest first. With no path, this is Recent Changes. */
  async list(root: string, rel?: string): Promise<HistoryEntry[]> {
    const files = await readdir(historyDir()).catch(() => [] as string[]);
    const entries: HistoryEntry[] = [];
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const record = await readRecord(join(historyDir(), name));
      if (!record || record.root !== root) continue;
      if (rel && record.path !== rel) continue;
      entries.push(publicEntry(record));
    }
    entries.sort((a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id));
    return entries.slice(0, MAX_REVISIONS);
  }

  /** Full content for one snapshot. The id format is validated before any IO. */
  async read(root: string, id: string): Promise<HistoryRecord | undefined> {
    if (!ID_RE.test(id)) return undefined;
    const record = await readRecord(join(historyDir(), id + '.json'));
    return record && record.root === root ? record : undefined;
  }

  private async prune(prefix: string): Promise<void> {
    const files = await readdir(historyDir()).catch(() => [] as string[]);
    const mine = files.filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_REVISIONS))) {
      await rm(join(historyDir(), old), { force: true }).catch(() => undefined);
    }
  }
}
