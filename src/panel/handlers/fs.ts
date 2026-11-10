/**
 * Project explorer: one dispatcher for every file-system message.
 *
 * A shared error funnel matters here: `FsService` signals a rejected path
 * (traversal, absolute, missing) by throwing `FsError`, and the client must be
 * told *which* path failed and why — otherwise a refused `..` looks identical to
 * a broken explorer. Every branch reports `reqId` back so the UI can clear its
 * pending state, and no rejection ever reaches the socket.
 */
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
