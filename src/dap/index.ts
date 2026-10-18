/**
 * DAP support (Phase 6).
 *
 * `DapClient` is the transport; this module is the part that reads a manifest
 * and turns `manifest.debug` into a launch. A language plugin declares its
 * debug adapter the same way it declares its toolchain and its language server —
 * discovery first, explicit command as the fallback.
 */
import type { Kernel } from '../kernel/Kernel.js';
import type { LanguageManifest } from '../langs/manifest.js';
import { discoverBinary } from '../langs/discover.js';
import {
  DapClient,
  type DapCapabilities,
  type DapHandlers,
  type DapLaunch,
  type DapScope,
  type DapSession,
  type DapStackFrame,
  type DapVariable,
} from './DapClient.js';

export interface ResolvedDebugAdapter {
  adapter: string;
  /** Binary to start, or `undefined` when discovery failed. */
  command: string | undefined;
  args: string[];
  serverName: string;
  /** Why discovery failed, for the UI. */
  degradedNote: string;
  available: boolean;
}

/**
 * Resolve `manifest.debug` into a launch.
 *
 * Discovery order is the same one the toolchain and the language server use —
 * deliberately: there is one "how do we find a binary" in this codebase, not
 * three.
 */
export function resolveDebugAdapter(manifest: LanguageManifest): ResolvedDebugAdapter | undefined {
  const spec = manifest.debug;
  if (!spec) return undefined;
  const serverName = spec.serverName ?? spec.adapter;
  const degraded: ResolvedDebugAdapter = {
    adapter: spec.adapter,
    command: undefined,
    args: [],
    serverName,
    degradedNote: spec.degradedNote ?? `${serverName} not found — debugging is unavailable for ${manifest.displayName}`,
    available: false,
  };
  // A command that is already absolute needs no discovery: `"command":
  // ["C:/tools/dlv", "dap"]` works on a machine where dlv is not on PATH.
  // (Discovery still runs first when it is declared, so the same field can be
  // filled in by the machine's configuration instead of hardcoding a path.)
  const literal = spec.command ?? [];
  const needsDiscovery = literal.some((c) => c.includes('{resolved}'));
  if (!needsDiscovery && literal.length) {
    return { ...degraded, command: literal[0], args: [...literal.slice(1), ...(spec.args ?? [])], available: true };
  }
  const found = discoverBinary(spec.discovery);
  if (found.source !== 'missing' && found.bin) {
    const cmd = literal.map((c) => c.replace(/\{resolved\}/g, found.bin!));
    return {
      ...degraded,
      command: cmd[0],
      args: [...cmd.slice(1), ...(spec.args ?? [])],
      available: true,
    };
  }
  return degraded;
}

/** Start a debug session for a language. Rejects when the adapter is absent. */
export async function startDebugSession(
  kernel: Kernel,
  manifest: LanguageManifest,
  opts: { cwd?: string; launchArgs?: Record<string, unknown>; handlers?: DapHandlers } = {},
): Promise<{ client: DapClient; session: DapSession }> {
  const resolved = resolveDebugAdapter(manifest);
  if (!resolved) throw new Error(`"${manifest.displayName}" declares no debug adapter in its manifest`);
  if (!resolved.available || !resolved.command) throw new Error(resolved.degradedNote);
  const launch: DapLaunch = {
    command: resolved.command,
    args: resolved.args,
    adapterId: manifest.debug?.type ?? resolved.adapter,
    cwd: opts.cwd,
    ...(opts.launchArgs !== undefined ? { launchArgs: opts.launchArgs } : {}),
  };
  const client = new DapClient(kernel, launch, opts.handlers);
  await client.start();
  return { client, session: client.current };
}

export { DapClient, type DapLaunch, type DapSession, type DapCapabilities, type DapStackFrame, type DapScope, type DapVariable, type DapHandlers };
