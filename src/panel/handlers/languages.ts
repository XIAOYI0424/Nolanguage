/**
 * Language services over the wire: validate the id, run it, answer.
 *
 * Moved out of `server.ts` so the WebSocket switch is a routing table again
 * instead of a 1,800-line file. Every handler here depends on `WorkspaceService`
 * only — no kernel, no hub, no closure over the server's local state — which is
 * what makes the move mechanical rather than a refactor.
 */
import type { WorkspaceService } from '../WorkspaceService.js';
import type { LanguageId } from '../samples.js';
import type { SandboxLanguage } from '../../exec/types.js';

/**
 * Validate a language id coming off the wire.
 *
 * There is no allow-list any more: languages are plugins, so the id is checked
 * against the workspace's registry (which throws a precise "unknown language"
 * for a bad id) rather than against a hardcoded array.
 */
export function asLanguage(v: unknown, workspace?: WorkspaceService): LanguageId {
  if (typeof v !== 'string' || !v) return 'python';
  // An id the workspace does not know is not a crash: it degrades to the
  // default language, which is what the wire contract has always promised.
  if (workspace && !workspace.hasLanguage(v)) return 'python';
  return v;
}


/**
 * Language ids the execution plane can run. This is *not* the same set as
 * `LANGUAGES`: Markdown renders rather than executes, and the pool only keeps
 * warm workers for the interpreted languages.
 */
const SANDBOX_LANGUAGES: SandboxLanguage[] = ['python', 'javascript', 'go'];


/** Validate a sandbox language id coming off the wire, defaulting to Python. */
export function asSandboxLanguage(v: unknown): SandboxLanguage {
  return SANDBOX_LANGUAGES.some((l) => l === v) ? (v as SandboxLanguage) : 'python';
}


export async function handleCheck(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const language = asLanguage(msg.language, workspace);
  try {
    const d = await workspace.diagnose(language, code);
    reply({
      kind: 'diagnostics',
      language,
      uri: d.uri,
      items: d.items,
      errors: d.errors,
      warnings: d.warnings,
      fromLsp: d.fromLsp,
      note: d.note,
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `check failed: ${(err as Error).message}` });
  }
}


export async function handleComplete(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const language = asLanguage(msg.language, workspace);
  const line = Number(msg.line ?? 0);
  const character = Number(msg.character ?? 0);
  const requestId = Number(msg.requestId ?? 0);
  try {
    const items = await workspace.complete(language, code, line, character);
    reply({
      kind: 'completion',
      language,
      requestId,
      items: items.slice(0, 100).map((i) => ({ label: i.label, kind: i.kind, detail: i.detail })),
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `completion failed: ${(err as Error).message}` });
  }
}


export async function handleHover(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const language = asLanguage(msg.language, workspace);
  const line = Number(msg.line ?? 0);
  const character = Number(msg.character ?? 0);
  const requestId = Number(msg.requestId ?? 0);
  try {
    const hover = await workspace.hover(language, code, line, character);
    reply({ kind: 'hover', language, requestId, hover });
  } catch (err) {
    reply({ kind: 'error', language, message: `hover failed: ${(err as Error).message}` });
  }
}


/**
 * Stage 8: render a Markdown document for the preview pane.
 *
 * The reply carries the sanitized HTML plus the metadata the UI shows beside
 * it (title, headings for the outline, render time). `ok: false` keeps the
 * pane in a recoverable state instead of leaving it spinning — a renderer
 * bug must degrade one document, not the connection.
 */
export async function handleMdRender(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const language = asLanguage(msg.language, workspace);
  const requestId = Number(msg.requestId ?? 0);
  try {
    const p = await workspace.preview(language, code);
    reply({ kind: 'mdPreview', language, requestId, ok: true, ...p });
  } catch (err) {
    reply({
      kind: 'mdPreview',
      language,
      requestId,
      ok: false,
      html: '',
      headings: [],
      stats: { blocks: 0, words: 0, codeBlocks: 0, links: 0, headings: 0 },
      ms: 0,
      error: `render failed: ${(err as Error).message}`,
    });
  }
}
