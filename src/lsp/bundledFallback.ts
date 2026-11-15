/**
 * The server a *platform* ships for a language, when the real one is missing.
 *
 * # Why this is a module and not a branch
 *
 * `manifest.lsp.bundledFallback` used to be the literal `"stub"`, and the engine
 * resolved it by calling `fallbackServerSpec()` — which hard-codes Python's
 * interpreter, Python's language id and Python's script path. The name said
 * "named capability, not a language check"; the implementation was a language
 * check with extra steps. A second language could declare `"stub"` and would
 * silently get Python's server.
 *
 * So the plugin now declares the command itself, and this module only expands
 * the two placeholders that cannot be written as literals:
 *
 *   `{toolchain}`        the interpreter/compiler the slot resolved
 *   `{embedded:<key>}`   a file the executable carries (packaged build), or
 *                        `src/<sourceDir>/<key>` in a source run
 *
 * Nothing here knows which language is asking.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddedAssetPath } from '../assets/embeddedAssets.js';
import type { LspLaunchSpec } from './LspClient.js';

/** The subset of `manifest.lsp.bundledFallback` this needs. */
export interface BundledFallbackSpec {
  /** Defaults to the slot's language id. */
  languageId?: string;
  /** Defaults to the slot's language id. */
  serverName?: string;
  /**
   * Command plus arguments. `command[0]` is the executable.
   * Placeholders: `{toolchain}`, `{embedded:<key>}`.
   */
  command: string[];
  /**
   * Where `{embedded:<key>}` lives in a **source** run, relative to `src/`
   * (e.g. `"python"` for `src/python/pyrightServer.py`). Ignored when packaged:
   * the asset is already inside the executable.
   */
  sourceDir?: string;
}

export interface ResolveContext {
  /** Language id of the slot asking — used for the defaults. */
  languageId: string;
  /** Interpreter/compiler the slot resolved; empty when none was found. */
  toolchain?: string;
}

/**
 * Directory of this module. `import.meta.url` is not a `file://` URL inside the
 * SEA bundle (esbuild emits CommonJS there), so fall back to the cwd — the
 * packaged build resolves assets through `embeddedAssetPath` anyway.
 */
function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Resolve `{embedded:<key>}`: the packaged asset if present, else the source
 * tree. Returns `undefined` when neither exists, which the caller turns into the
 * manifest's `degradedNote` rather than a crash.
 */
function resolveAsset(key: string, sourceDir: string | undefined): string | undefined {
  const embedded = embeddedAssetPath(key);
  if (embedded) return embedded;
  if (!sourceDir) return undefined;
  // This module lives in `src/lsp`, so `..` is `src`.
  const candidate = resolve(join(moduleDir(), '..', sourceDir, key));
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Turn a declared fallback into a launch spec, or `undefined` when it cannot run
 * (no toolchain, or the asset is missing). Never throws: a broken fallback
 * degrades to "no language server", which the panel already renders.
 */
export function resolveBundledFallback(
  spec: BundledFallbackSpec | undefined,
  ctx: ResolveContext,
): LspLaunchSpec | undefined {
  if (!spec || !Array.isArray(spec.command) || !spec.command.length) return undefined;

  const expanded: string[] = [];
  for (const part of spec.command) {
    if (typeof part !== 'string' || !part) return undefined;
    if (part === '{toolchain}') {
      // Without an interpreter there is nothing to launch; a placeholder left in
      // place would fail later with a confusing ENOENT.
      if (!ctx.toolchain) return undefined;
      expanded.push(ctx.toolchain);
      continue;
    }
    const asset = /^\{embedded:(.+)\}$/.exec(part);
    if (asset) {
      const path = resolveAsset(asset[1], spec.sourceDir);
      if (!path) return undefined;
      expanded.push(path);
      continue;
    }
    expanded.push(part);
  }

  const [command, ...args] = expanded;
  if (!command) return undefined;
  return {
    languageId: spec.languageId ?? ctx.languageId,
    serverName: spec.serverName ?? ctx.languageId,
    command,
    args,
    cwd: process.cwd(),
  };
}
