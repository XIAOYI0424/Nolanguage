/**
 * Project explorer: one dispatcher for every file-system message.
 *
 * A shared error funnel matters here: `FsService` signals a rejected path
 * (traversal, absolute, missing) by throwing `FsError`, and the client must be
 * told *which* path failed and why — otherwise a refused `..` looks identical to
 * a broken explorer. Every branch reports `reqId` back so the UI can clear its
 * pending state, and no rejection ever reaches the socket.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appDataDir } from '../../util/appData.js';
import type { FsService } from '../FsService.js';
import { FsError } from '../FsService.js';

export async function handleFs(
  fs: FsService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const reqId = Number(msg.reqId ?? 0);
  const path = typeof msg.path === 'string' ? msg.path : '';
  const fail = (err: unknown, at?: string): void => {
    const code = err instanceof FsError ? err.code : 'io';
    reply({ kind: 'fsError', reqId, path: at ?? path, code, message: (err as Error).message });
  };

  try {
    switch (msg.kind) {
      case 'fsList': {
        const listing = await fs.list(path);
        reply({ kind: 'fsListing', reqId, ...listing });
        return;
      }
      case 'fsRead': {
        const file = await fs.read(path);
        reply({ kind: 'fsFile', reqId, file });
        return;
      }
      case 'fsWrite': {
        const saved = await fs.write(path, typeof msg.content === 'string' ? msg.content : '');
        reply({ kind: 'fsSaved', reqId, path: saved.path, mtime: saved.mtime, size: saved.size });
        return;
      }
      case 'fsCreate': {
        const entry = await fs.create(path, msg.entryKind === 'dir' ? 'dir' : 'file');
        reply({ kind: 'fsChanged', reqId, op: 'create', path: entry.path, entry });
        return;
      }
      case 'fsRename': {
        const to = typeof msg.to === 'string' ? msg.to : '';
        const entry = await fs.rename(path, to);
        // `from` travels back so the UI can remap any open tab / expanded node.
        reply({ kind: 'fsChanged', reqId, op: 'rename', path: entry.path, from: path, entry });
        return;
      }
      case 'fsDelete': {
        const removed = await fs.remove(path);
        reply({ kind: 'fsChanged', reqId, op: 'delete', path: removed.path });
        return;
      }
      case 'openFolder': {
        await fs.setRoot(path);
        reply({ kind: 'fsRoot', reqId, ...fs.describe() });
        return;
      }
      default:
        reply({ kind: 'fsError', reqId, code: 'io', message: `unknown fs message: ${String(msg.kind)}` });
    }
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------- draft autosave

/**
 * Crash recovery copies of dirty buffers.
 *
 * A draft is *not* a save: nothing under the project root is written by this
 * handler, and the file itself is never touched. It exists so that a crash, a
 * killed window or a power cut cannot take unsaved text with it, and it lives in
 * the application's own directory (`appDataDir()/autosave`) rather than in the
 * workspace — a user project has no `.tmp/` convention and should not grow one.
 *
 * `baseMtime` is the disk version the user started editing *from*. If the file
 * changed on disk after that, restoring the draft into the same path would
 * silently overwrite someone else's work, so the client opens such a draft as
 * `<name>.recovered` instead. Drafts are removed by a disk ACK (or an explicit
 * discard), never by a successful restore — otherwise a second crash would lose
 * the text that was just recovered.
 */
export interface DraftRecord {
  /** Workspace-relative path, exactly as the client names the buffer. */
  path: string;
  content: string;
  savedAt: number;
  /** Disk mtime when the draft was first written; 0 when the file did not exist. */
  baseMtime: number;
}

/** Drafts are app state, not project state. */
function draftDir(): string {
  return join(appDataDir(), 'autosave');
}

/** Absolute-path-free key: the workspace-relative path is hashed, not joined. */
function draftFileFor(rel: string): string {
  return join(draftDir(), createHash('sha1').update(rel).digest('hex') + '.json');
}

/**
 * A draft key must be a plain relative path.
 *
 * It is only ever hashed, never resolved, but an absolute path or a `..`
 * segment here would mean the client is confused about which buffer it is
 * saving — better to refuse loudly than to store a draft nobody can find.
 */
function draftKeyProblem(rel: string): string | undefined {
  if (!rel) return 'empty path';
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return 'absolute path';
  if (rel.replace(/\\/g, '/').split('/').some((p) => p === '..')) return 'path escapes the workspace';
  return undefined;
}

async function readDraft(file: string): Promise<DraftRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as DraftRecord;
    return raw && typeof raw.path === 'string' && typeof raw.content === 'string' ? raw : undefined;
  } catch {
    // A half-written or hand-edited draft is not worth failing the whole list
    // over: drop it on the floor and keep the rest.
    return undefined;
  }
}

export async function handleDraft(
  fs: FsService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const reqId = Number(msg.reqId ?? 0);
  const path = typeof msg.path === 'string' ? msg.path : '';
  try {
    switch (msg.kind) {
      case 'draftSave': {
        const problem = draftKeyProblem(path);
        if (problem) {
          reply({ kind: 'draftError', reqId, path, message: problem });
          return;
        }
        const file = draftFileFor(path);
        const existing = await readDraft(file);
        // Keep the *original* base across repeated saves: it describes the disk
        // version the editing session started from, not the latest autosave.
        let baseMtime = existing?.baseMtime ?? 0;
        if (!existing) {
          const onDisk = await fs.read(path).catch(() => undefined);
          baseMtime = onDisk ? Number(onDisk.mtime ?? 0) : 0;
        }
        await mkdir(draftDir(), { recursive: true }).catch(() => undefined);
        const record: DraftRecord = {
          path,
          content: typeof msg.content === 'string' ? msg.content : '',
          savedAt: Date.now(),
          baseMtime,
        };
        await writeFile(file, JSON.stringify(record), 'utf8');
        reply({ kind: 'draftSaved', reqId, path, savedAt: record.savedAt });
        return;
      }
      case 'draftList': {
        const dir = draftDir();
        const names = await readdir(dir).catch(() => [] as string[]);
        const drafts: Array<DraftRecord & { stale: boolean; sameAsDisk: boolean }> = [];
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const record = await readDraft(join(dir, name));
          if (!record) continue;
          const onDisk = await fs.read(record.path).catch(() => undefined);
          const sameAsDisk = !!onDisk && String(onDisk.content) === record.content;
          // A draft whose file vanished, or whose file changed after the draft
          // was taken, is stale: restoring it to the same path could overwrite
          // newer work, so the client offers `<name>.recovered` instead.
          const stale = !onDisk || Number(onDisk.mtime ?? 0) !== record.baseMtime;
          drafts.push({ ...record, stale, sameAsDisk });
        }
        drafts.sort((a, b) => b.savedAt - a.savedAt);
        reply({ kind: 'drafts', reqId, drafts });
        return;
      }
      case 'draftDrop': {
        const problem = draftKeyProblem(path);
        if (problem) {
          reply({ kind: 'draftError', reqId, path, message: problem });
          return;
        }
        await rm(draftFileFor(path), { force: true });
        reply({ kind: 'draftDropped', reqId, path });
        return;
      }
      default:
        reply({ kind: 'draftError', reqId, path, message: `unknown draft message: ${String(msg.kind)}` });
    }
  } catch (err) {
    reply({ kind: 'draftError', reqId, path, message: (err as Error).message });
  }
}
