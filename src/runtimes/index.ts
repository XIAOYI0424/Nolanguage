/**
 * The five runtime capabilities, registered in one place.
 *
 * This file is the complete list of ways this platform can execute code. If a
 * language needs a sixth, it gets a new file here — not a new branch in the
 * engine.
 */
import { RuntimeRegistry } from './RuntimeRegistry.js';
import { TemplateRuntime } from './template.js';
import { ReplSessionRuntime } from './repl-session.js';
import { DirectorySessionRuntime } from './directory-session.js';
import { InlineVmRuntime } from './inline-vm.js';
import { ScriptHostRuntime } from './script-host.js';

export const RUNTIME_IDS = [
  'template',
  'repl-session',
  'directory-session',
  'inline-vm',
  'script-host',
] as const;

export type RuntimeId = (typeof RUNTIME_IDS)[number];

/** A registry with all five capabilities installed. */
export function defaultRuntimeRegistry(): RuntimeRegistry {
  const reg = new RuntimeRegistry();
  reg.register(new TemplateRuntime());
  reg.register(new ReplSessionRuntime());
  reg.register(new DirectorySessionRuntime());
  reg.register(new InlineVmRuntime());
  reg.register(new ScriptHostRuntime());
  return reg;
}

/**
 * Runtime id -> "does it put `args` on argv?", derived from the classes.
 *
 * A lookup table built once from the extensions themselves, so there is no
 * second list to keep in sync. Unknown or absent modes answer false: a runtime
 * that was not registered cannot take arguments.
 */
const ARGS_CAPABLE = new Map<string, boolean>(
  [
    new TemplateRuntime(),
    new ReplSessionRuntime(),
    new DirectorySessionRuntime(),
    new InlineVmRuntime(),
    new ScriptHostRuntime(),
  ].map((runtime) => [runtime.id, runtime.supportsArgs]),
);

/** Does `manifest.run.mode` accept program arguments? */
export function runtimeSupportsArgs(mode: string | undefined | null): boolean {
  return !!mode && ARGS_CAPABLE.get(mode) === true;
}

export * from './types.js';
export { RuntimeRegistry, satisfies, parseRequirement, parseVersion } from './RuntimeRegistry.js';
export { TemplateRuntime, TemplateRunner } from './template.js';
export { ReplSessionRuntime, ReplSessionRunner } from './repl-session.js';
export { DirectorySessionRuntime, DirectorySessionRunner } from './directory-session.js';
export { InlineVmRuntime, InlineVmRunner } from './inline-vm.js';
export { ScriptHostRuntime, ScriptHostRunner } from './script-host.js';
