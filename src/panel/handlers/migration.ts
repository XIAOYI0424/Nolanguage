/**
 * Migration thresholds: interpreter discovery/pinning and `.idea` import.
 *
 * The toolchain pins live in `appDataPath('toolchains.json')` rather than in the
 * workspace: the interpreter belongs to the machine, and a project checked out
 * twice should not disagree with itself about which python it uses.
 */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { WorkspaceService } from '../WorkspaceService.js';
import { asLanguage } from './languages.js';
import { discoverInterpreters, pickInterpreter } from '../../langs/interpreters.js';
import { importIdeaProject } from '../../langs/ideaImport.js';
import { appDataPath } from '../../util/appData.js';

/**
 * Per-language toolchain pins read from the environment.
 *
 * These are the *official* plugin ids; a user-installed plugin is pinned through
 * its own manifest instead. The workspace only ever sees the resulting
 * `Record<pluginId, path>`, so adding a language here is host wiring, not an
 * engine change.
 */
export function envToolchains(): Record<string, string> {
  const pins: Array<[string, string | undefined]> = [
    ['python', process.env.PYTHON_BIN],
    ['go', process.env.GO_BIN],
    ['javascript', process.env.NODE_BIN],
    ['markdown', process.env.MARKSMAN_BIN],
  ];
  const env = Object.fromEntries(pins.filter((p): p is [string, string] => !!p[1]));
  // The interpreter picker's pins sit *under* the environment: an explicit
  // `PYTHON_BIN` is a developer's override for this run and must win.
  return { ...readToolchainPins(), ...env };
}


/**
 * Interpreter candidates for one language — migration threshold 1.
 *
 * The answer always names an `active` interpreter: the pin when one is set,
 * otherwise the project's own environment. Leaving it empty would push the
 * decision back to "whatever PATH has", which is the behaviour the picker
 * exists to replace.
 */
export async function handleInterpreters(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const pinned = workspace.toolchains()[language];
  try {
    const candidates = await discoverInterpreters(workspace.root, language, {
      sdkName: typeof msg.sdkName === 'string' && msg.sdkName ? msg.sdkName : undefined,
    });
    const picked = pickInterpreter(candidates, { pinned });
    reply({
      kind: 'interpreters',
      language,
      root: workspace.root,
      candidates,
      active: picked?.path ?? null,
      pinned: pinned ?? null,
    });
  } catch (err) {
    reply({
      kind: 'interpreters',
      language,
      root: workspace.root,
      candidates: [],
      active: null,
      pinned: pinned ?? null,
      error: (err as Error).message,
    });
  }
}


/** Pin (or unpin) a language's interpreter and rebuild its slot. */
export async function handleSetInterpreter(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const language = asLanguage(msg.language, workspace);
  const path = typeof msg.path === 'string' ? msg.path : undefined;
  try {
    const result = await workspace.setToolchain(language, path);
    if (result.ok) await saveToolchainPins(workspace.toolchains());
    reply({ kind: 'interpreterSet', language, ...result });
  } catch (err) {
    reply({ kind: 'interpreterSet', language, ok: false, error: (err as Error).message });
  }
}


/** Import `.idea/runConfigurations` — migration threshold 2. */
export async function handleImportIdea(
  workspace: WorkspaceService,
  msg: Record<string, unknown>,
  reply: (p: unknown) => void,
): Promise<void> {
  const root = typeof msg.root === 'string' && msg.root.trim() ? msg.root.trim() : workspace.root;
  try {
    const result = await importIdeaProject(root);
    reply({ kind: 'ideaImport', ...result });
  } catch (err) {
    reply({
      kind: 'ideaImport',
      root,
      missing: true,
      projectSdk: undefined,
      modules: [],
      configurations: [],
      warnings: [(err as Error).message],
    });
  }
}


/**
 * Pins chosen in the interpreter picker, persisted across restarts.
 *
 * Kept out of the workspace directory on purpose: the interpreter belongs to
 * the *machine*, and a project checked out twice should not disagree with
 * itself about which python it uses.
 */
function toolchainPinPath(): string {
  return appDataPath('toolchains.json');
}


function readToolchainPins(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(toolchainPinPath(), 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}


async function saveToolchainPins(pins: Record<string, string>): Promise<void> {
  try {
    await mkdir(appDataPath(), { recursive: true });
    await writeFile(toolchainPinPath(), JSON.stringify(pins, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort: a pin that cannot be saved still applies to this session */
  }
}
