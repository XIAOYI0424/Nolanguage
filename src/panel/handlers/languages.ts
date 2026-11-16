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
import { installPackage, readDependencies } from '../../langs/dependencies.js';
import { stateFor } from '../conn-state.js';

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
    const r = await workspace.complete(language, code, line, character);
    reply({
      kind: 'completion',
      language,
      requestId,
      // Carried on every LSP-backed reply: "no server" must not look like "no
      // suggestions". The client falls back to its own word list either way.
      ...(r.unsupported ? { unsupported: r.unsupported } : {}),
      // `insertText` is what makes accepting a function insert `get(url, timeout)`
      // instead of a bare name; `sortText` carries the server's ranking, which is
      // better than alphabetical. Both were being dropped here, so a real server
      // (pyright, gopls, tsserver) looked worse than it is.
      items: r.items.slice(0, 100).map((i) => ({
        label: i.label,
        kind: i.kind,
        detail: i.detail,
        ...(i.insertText ? { insertText: i.insertText } : {}),
        ...(i.sortText ? { sortText: i.sortText } : {}),
        ...(i.filterText ? { filterText: i.filterText } : {}),
      })),
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `completion failed: ${(err as Error).message}` });
  }
}


/**
 * Whole-document formatting.
 *
 * The client has its own indenter (`basicFormat`) and keeps it: this is the
 * path that lets the *language's* formatter do the job — gofmt, rustfmt,
 * prettier, black — through the server that already knows the file. `unsupported`
 * tells the client which of the two it is looking at.
 */
export async function handleFormat(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const language = asLanguage(msg.language, workspace);
  const requestId = Number(msg.requestId ?? 0);
  try {
    const r = await workspace.format(language, code);
    reply({
      kind: 'formatResult',
      language,
      requestId,
      edits: r.ok ? r.value : [],
      ...(r.ok ? {} : { unsupported: r.reason }),
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `format failed: ${(err as Error).message}` });
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


/**
 * Parameter hints.
 *
 * Replies with `unsupported` when the server does not advertise
 * `signatureHelpProvider`, so the popup can stay closed instead of showing an
 * empty box that looks like a bug.
 */
export async function handleSignatureHelp(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const requestId = Number(msg.requestId ?? 0);
  try {
    const r = await workspace.signatureHelp(language, String(msg.code ?? ''), Number(msg.line ?? 0), Number(msg.character ?? 0));
    if (!r.ok) {
      reply({ kind: 'signatureResult', requestId, signatures: [], activeParameter: 0, unsupported: r.reason });
      return;
    }
    reply({
      kind: 'signatureResult',
      requestId,
      signatures: r.value.signatures.slice(0, 5),
      activeSignature: r.value.activeSignature,
      activeParameter: r.value.activeParameter,
    });
  } catch (err) {
    reply({ kind: 'error', language, message: `signature help failed: ${(err as Error).message}` });
  }
}


/**
 * One completion item's documentation, on demand.
 *
 * Kept out of the `completion` frame on purpose: a hundred items with full
 * docstrings is tens of kilobytes sent on every keystroke, and the user reads at
 * most one of them.
 */
export async function handleCompletionResolve(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const requestId = Number(msg.requestId ?? 0);
  const label = String(msg.label ?? '');
  try {
    const r = await workspace.resolveCompletion(language, label);
    reply(
      r.ok
        ? { kind: 'completionItemDetail', requestId, label, ...r.value }
        : { kind: 'completionItemDetail', requestId, label, unsupported: r.reason },
    );
  } catch (err) {
    reply({ kind: 'error', language, message: `completion detail failed: ${(err as Error).message}` });
  }
}


// ---------------- project packages ----------------
// Three messages, one concern each: read the declaration, install one more
// package, cancel that install. The install is the only place in the product
// that runs a toolchain to *change* the project rather than to execute it, so it
// reports everything: the argv it ran, the exit code, the output, and whether
// the language server came back afterwards.

/**
 * What the project declares, for the Packages pane.
 *
 * `rootOf` is a getter, not a path: the explorer can be repointed at runtime
 * (`openFolder`), and a cached root would keep reporting the folder the panel
 * booted on.
 */
export async function handleDependencyReport(
  workspace: WorkspaceService,
  rootOf: () => string,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  try {
    const manifest = workspace.manifestOf(language);
    if (!manifest) {
      reply({ kind: 'dependencies', language, supported: false, note: `unknown language: ${language}` });
      return;
    }
    const report = await readDependencies(language, manifest.dependencies, rootOf(), String(msg.code ?? ''));
    reply({ kind: 'dependencies', ...report });
  } catch (err) {
    reply({ kind: 'error', language, message: `dependency read failed: ${(err as Error).message}` });
  }
}

/**
 * Install one package through the plugin's own installer.
 *
 * One install at a time per connection: two `pip install` processes in the same
 * project directory can corrupt each other's metadata, and the second one's
 * output would interleave into the first one's console.
 */
export async function handleDependencyInstall(
  workspace: WorkspaceService,
  rootOf: () => string,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
  conn: unknown,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const packageName = String(msg.package ?? '').trim();
  const st = stateFor(conn);
  const fail = (error: string): void => {
    reply({ kind: 'dependencyResult', ok: false, language, package: packageName, error });
  };
  if (st.installChild) {
    fail('an install is already running');
    return;
  }
  const manifest = workspace.manifestOf(language);
  if (!manifest) {
    fail(`unknown language: ${language}`);
    return;
  }

  const started = Date.now();
  const toolchain = workspace.toolchainFor(language);
  reply({ kind: 'dependencyStart', language, package: packageName, toolchain: toolchain ?? null });
  const result = await installPackage(manifest.dependencies, packageName, toolchain, rootOf(), {
    onData: (stream, text) => reply({ kind: 'dependencyOut', language, stream, text }),
    onSpawn: (child) => { st.installChild = child; },
  });
  st.installChild = undefined;

  // A successful install changed what the language server can see. Restarting it
  // is the whole of the post-install refresh: the server cached the import graph,
  // and a new module stays invisible until it re-reads the project.
  let refresh: { ok: boolean; error?: string } | undefined;
  if (result.ok) {
    refresh = await workspace.restartLanguageServer(language).catch((err: unknown) => ({
      ok: false,
      error: (err as Error).message,
    }));
  }

  reply({
    kind: 'dependencyResult',
    language,
    package: packageName,
    ok: result.ok,
    code: result.code,
    ...(result.signal ? { signal: result.signal } : {}),
    ms: result.ms || Date.now() - started,
    command: result.command,
    truncated: result.truncated,
    ...(result.error ? { error: result.error } : {}),
    ...(refresh ? { refresh } : {}),
  });
}

/** Stop the running installer, if any. Answers whether something was stopped. */
export function handleDependencyCancel(conn: unknown, reply: (p: unknown) => void): void {
  const st = stateFor(conn);
  const child = st.installChild;
  if (!child) {
    reply({ kind: 'dependencyCancelled', ok: false, error: 'no install is running' });
    return;
  }
  st.installChild = undefined;
  try {
    // SIGTERM lets pip/npm run their cleanup; a process that ignores it still
    // dies with the server, because the socket close handler kills it outright.
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  reply({ kind: 'dependencyCancelled', ok: true });
}

