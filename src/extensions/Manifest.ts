/**
 * Extension manifest (spec 4.3 · 激活模型).
 *
 * A manifest is *data only*: the kernel parses it at startup and loads no
 * extension code, which is what keeps cold start under a couple of seconds.
 * Code is only imported inside an extension host child process, and only
 * after one of the manifest's `activationEvents` fires.
 *
 * ```json
 * {
 *   "id": "demo.hello",
 *   "engines": { "kernel": "^0.6.0" },
 *   "host": "child-process",
 *   "activationEvents": ["onCommand:demo.hello"],
 *   "entry": "extension.js",
 *   "contributes": { "commands": [{ "id": "demo.hello", "title": "…" }] }
 * }
 * ```
 */
export interface CommandContribution {
  id: string;
  title?: string;
  category?: string;
}

export interface LanguageContribution {
  id: string;
  extensions: string[];
}

export interface ViewContribution {
  slot: string;
  id: string;
  title?: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  /** Kernel version range, e.g. `^0.6.0`. */
  engines: { kernel: string };
  /** `child-process` (default) runs the extension in an isolated host process. */
  host: 'child-process' | 'in-process';
  /** Module path relative to the manifest file. */
  entry: string;
  /** `onCommand:<id>` / `onLanguage:<id>` / `onStartup`. */
  activationEvents: string[];
  dependencies?: { services?: string[] };
  contributes?: {
    commands?: CommandContribution[];
    languages?: LanguageContribution[];
    views?: ViewContribution[];
  };
}

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;

export class ManifestError extends Error {}

/** Leading `major.minor.patch` of a (possibly suffixed) version string. */
function semver(v: string): [number, number, number] | undefined {
  const m = SEMVER_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/**
 * Caret/ exact range check (`^1.2.3`, `1.2.3`). RHS is the kernel's own
 * version, which may carry a `-workspace` style suffix — only the leading
 * semver triple participates.
 */
export function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  const mine = semver(version);
  const want = semver(r.replace(/^[\^~>=]+/, ''));
  if (!mine || !want) return false;
  if (r.startsWith('^')) {
    // ^0.x pins minor too (the usual semver rule for 0.x).
    if (want[0] === 0) {
      return mine[0] === 0 && mine[1] === want[1] && mine[2] >= want[2];
    }
    return mine[0] === want[0] && (mine[1] > want[1] || (mine[1] === want[1] && mine[2] >= want[2]));
  }
  return mine[0] === want[0] && mine[1] === want[1] && mine[2] === want[2];
}

/** Validate and normalise a raw manifest object (throws ManifestError). */
export function parseManifest(raw: unknown, source = 'manifest.json'): ExtensionManifest {
  if (!raw || typeof raw !== 'object') throw new ManifestError(`${source}: not an object`);
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id : '';
  if (!ID_RE.test(id)) {
    throw new ManifestError(`${source}: id must be lowercase [a-z0-9.-], got "${id}"`);
  }
  const engines = m.engines as { kernel?: unknown } | undefined;
  if (!engines || typeof engines.kernel !== 'string' || !engines.kernel.trim()) {
    throw new ManifestError(`${source}: engines.kernel is required`);
  }
  const entry = typeof m.entry === 'string' ? m.entry : '';
  if (!entry) throw new ManifestError(`${source}: entry is required`);
  const host = m.host === 'in-process' ? 'in-process' : 'child-process';
  const version = typeof m.version === 'string' ? m.version : '0.0.0';
  const name = typeof m.name === 'string' ? m.name : id;
  const activationEvents = Array.isArray(m.activationEvents)
    ? m.activationEvents.filter((e): e is string => typeof e === 'string')
    : [];
  const contributes = (m.contributes ?? {}) as ExtensionManifest['contributes'];

  const manifest: ExtensionManifest = {
    id,
    name,
    version,
    engines: { kernel: engines.kernel },
    host,
    entry,
    activationEvents,
    contributes,
  };
  if (m.dependencies && typeof m.dependencies === 'object') {
    manifest.dependencies = m.dependencies as ExtensionManifest['dependencies'];
  }
  return manifest;
}

/** True when the manifest declares `onCommand:<id>`. */
export function activatesOnCommand(manifest: ExtensionManifest, commandId: string): boolean {
  return manifest.activationEvents.includes(`onCommand:${commandId}`);
}

/** True when the manifest should be activated as soon as the kernel starts. */
export function activatesOnStartup(manifest: ExtensionManifest): boolean {
  return manifest.activationEvents.includes('onStartup');
}

/** `onLanguage:<id>` triggers the manifest wants, if any. */
export function activatesOnLanguage(manifest: ExtensionManifest, languageId: string): boolean {
  return manifest.activationEvents.includes(`onLanguage:${languageId}`);
}

/** Flatten the manifest's contributed command declarations. */
export function contributedCommands(manifest: ExtensionManifest): CommandContribution[] {
  return manifest.contributes?.commands ?? [];
}
