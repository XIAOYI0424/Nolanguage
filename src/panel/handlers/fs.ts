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
import { isAbsolute, join, relative, resolve } from 'node:path';
import { appDataDir } from '../../util/appData.js';
import type { FsService } from '../FsService.js';
import { FsError } from '../FsService.js';
import { applyTextEdits, editPath, type WorkspaceTextEdit } from '../../lsp/workspaceEdits.js';
import { HistoryStore } from '../../util/history.js';

const history = new HistoryStore();

/** Best-effort pre-write snapshot: history must never make a save fail. */
async function snapshotCurrent(fs: FsService, rel: string, reason: string): Promise<void> {
  if (!rel) return;
  try {
    const file = await fs.read(rel).catch(() => undefined);
    if (!file || file.truncated) return;
    await history.snapshot(fs.root, rel, String(file.content ?? ''), reason);
  } catch {
    // A full disk or a corrupt snapshot file is not a reason to lose the edit.
  }
}

export async function handleFs(
  fs: FsService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
  onRootChanged?: (root: string) => void | Promise<void>,
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
        const next = typeof msg.content === 'string' ? msg.content : '';
        await snapshotCurrent(fs, path, 'save');
        const saved = await fs.write(path, next);
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
        await snapshotCurrent(fs, path, 'rename');
        const entry = await fs.rename(path, to);
        // `from` travels back so the UI can remap any open tab / expanded node.
        reply({ kind: 'fsChanged', reqId, op: 'rename', path: entry.path, from: path, entry });
        return;
      }
      case 'fsDelete': {
        await snapshotCurrent(fs, path, 'delete');
        const removed = await fs.remove(path);
        reply({ kind: 'fsChanged', reqId, op: 'delete', path: removed.path });
        return;
      }
      case 'openFolder': {
        await fs.setRoot(path);
        // The explorer is the authority for the *current* project. Everything
        // else that is project-relative (templates, environments, packages,
        // debug) is told about the new root here instead of keeping a second
        // startup-only copy of it.
        if (onRootChanged) await onRootChanged(fs.root);
        reply({ kind: 'fsRoot', reqId, ...fs.describe() });
        return;
      }
      case 'historyList': {
        const entries = await history.list(fs.root, path || undefined);
        reply({ kind: 'historyEntries', reqId, path, entries });
        return;
      }
      case 'historyRead': {
        const id = typeof msg.id === 'string' ? msg.id : '';
        const record = await history.read(fs.root, id);
        if (!record) {
          reply({ kind: 'fsError', reqId, path, code: 'missing', message: 'revision not found' });
          return;
        }
        reply({ kind: 'historyFile', reqId, id, path: record.path, savedAt: record.savedAt, reason: record.reason, content: record.content });
        return;
      }
      case 'historyRevert': {
        const id = typeof msg.id === 'string' ? msg.id : '';
        const record = await history.read(fs.root, id);
        if (!record) {
          reply({ kind: 'fsError', reqId, path, code: 'missing', message: 'revision not found' });
          return;
        }
        await snapshotCurrent(fs, record.path, 'before-revert');
        const saved = await fs.write(record.path, record.content);
        reply({ kind: 'historyReverted', reqId, path: saved.path, id, mtime: saved.mtime, size: saved.size });
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


type Reply = (payload: unknown) => void;

interface EditWithPath extends WorkspaceTextEdit {
  uri: string;
  path: string;
}

const MAX_FILES = 100;
const MAX_EDITS = 5000;

/** LSP uris may be absolute inside the root; FsService needs a relative path. */
function toRelative(uri: string, root: string): string {
  const path = editPath(uri);
  if (!path) throw new FsError('edit names an empty path', 'outside');
  // UNC paths and plain relative names are already in the form FsService wants.
  if (!isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !path.startsWith('//')) return path;
  // `file:///pkg/util.py` has an empty authority: on Windows that is a
  // drive-root-relative path, not an absolute path outside the workspace.
  // POSIX file URIs with a leading slash really are absolute and stay rejected.
  if (process.platform === 'win32' && path.startsWith('/') && !/^\/[A-Za-z]:/.test(path)) {
    return path.slice(1).replace(/\\/g, '/');
  }
  const rel = relative(root, resolve(path));
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new FsError(`edit is outside the workspace: ${uri}`, 'outside');
  }
  return rel.replace(/\\/g, '/');
}

function asEdit(v: unknown, root: string): EditWithPath {
  const e = (v ?? {}) as Record<string, unknown>;
  return {
    uri: typeof e.uri === 'string' ? e.uri : '',
    path: toRelative(typeof e.uri === 'string' ? e.uri : '', root),
    line: Number(e.line),
    character: Number(e.character),
    endLine: Number(e.endLine),
    endCharacter: Number(e.endCharacter),
    newText: typeof e.newText === 'string' ? e.newText : '',
  };
}

/**
 * Handle `applyWorkspaceEdits`.
 *
 * Reply shape:
 *   ok=true  → { kind:'workspaceEditsApplied', requestId, ok:true, files:[{path, mtime, size}] }
 *   ok=false → { kind:'workspaceEditsApplied', requestId, ok:false, reason, rolledBack? }
 */
export async function handleApplyWorkspaceEdits(
  fs: FsService,
  msg: Record<string, unknown>,
  reply: Reply,
): Promise<void> {
  const requestId = Number(msg.requestId ?? 0);
  const fail = (reason: string, rolledBack?: boolean): void => {
    reply({
      kind: 'workspaceEditsApplied',
      requestId,
      ok: false,
      reason,
      ...(rolledBack === undefined ? {} : { rolledBack }),
    });
  };

  try {
    const raw = Array.isArray(msg.edits) ? msg.edits : [];
    if (!raw.length) return fail('no edits to apply');
    if (raw.length > MAX_EDITS) return fail(`too many edits (limit ${MAX_EDITS})`);

    const root = fs.root;
    const edits = raw.map((e) => asEdit(e, root));
    const byPath = new Map<string, EditWithPath[]>();
    for (const e of edits) {
      const list = byPath.get(e.path) ?? [];
      list.push(e);
      byPath.set(e.path, list);
    }
    if (byPath.size > MAX_FILES) return fail(`too many files (limit ${MAX_FILES})`);

    // ---- preflight: read + validate everything before the first write ----
    const planned: Array<{ path: string; original: string; next: string; content: string }> = [];
    for (const [path, fileEdits] of byPath) {
      const file = await fs.read(path);
      if (file.truncated) return fail(`${path}: ${file.note || 'file is not editable'}`);
          const rawText = String(file.content ?? '');
      const bom = rawText.charCodeAt(0) === 0xFEFF;
      const logical = (bom ? rawText.slice(1) : rawText).replace(/\r\n?/g, '\n');
      const result = applyTextEdits(logical, fileEdits);
      if (!result.ok) return fail(`${path}: ${result.reason}`);
      // Preserve the file's existing line endings and BOM: a rename must not
      // turn a CRLF file into LF as a side effect.
      const next = (bom ? '\uFEFF' : '') + (file.content?.indexOf('\r\n') !== -1 ? result.text.replace(/\n/g, '\r\n') : result.text);
      planned.push({ path, original: rawText, next, content: result.text });
    }

    // ---- commit ----
    // Record the file *before* writing it. A failure after a temp file was
    // created (or a rename that only half-succeeded) must still roll that file
    // back; omitting the current file was how a partial write could survive.
    const touched: Array<{ path: string; original: string }> = [];
    const files: Array<{ path: string; content: string; mtime: number; size: number }> = [];
    for (const p of planned) {
      touched.push({ path: p.path, original: p.original });
      try {
        // Use the content read during preflight, not a second read that might
        // already see another editor's write.
        await history.snapshot(fs.root, p.path, p.original, 'refactor').catch(() => undefined);
        const saved = await fs.commitAtomic(p.path, p.next);
        // `content` is the normalised (LF) text: open buffers must be able to
        // refresh without a second read that would steal focus or open a tab.
        files.push({ path: saved.path, content: p.content, mtime: saved.mtime, size: saved.size });
      } catch (err) {
        // Undo in reverse order: later files may depend on earlier ones. Every
        // restore is atomic too, so a second crash cannot expose a half-file.
        const restoreErrors: string[] = [];
        for (const w of [...touched].reverse()) {
          try { await fs.commitAtomic(w.path, w.original); } catch (e) { restoreErrors.push(`${w.path}: ${(e as Error).message}`); }
        }
        return fail(
          `${p.path}: ${(err as Error).message}` + (restoreErrors.length ? `; rollback failed for ${restoreErrors.join(', ')}` : ''),
          restoreErrors.length === 0,
        );
      }
    }
    reply({ kind: 'workspaceEditsApplied', requestId, ok: true, files, applied: edits.length });
  } catch (err) {
    fail((err as Error).message);
  }
}
