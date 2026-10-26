/**
 * Launch-time version handshake.
 *
 * The desktop launcher is a single exe, but the thing that actually serves the
 * UI is a *server* that may already be running from a **previous** build. When
 * that happens the naive check ("`/health` answers, therefore I am redundant")
 * is wrong in the worst possible way: the user double-clicks the freshly
 * installed 0.7.2, the 0.7.1 server answers, the launcher exits, and the
 * window they get is the old build. Nothing on screen says so — this is the
 * "修了还是老样子" report.
 *
 * So the decision is made on **build identity**, not liveness:
 *
 *   same build + window        -> reuse     (do not open a second window)
 *   same build + no window     -> orphan    (take the port back, restart)
 *   different build            -> update    (replace the old instance)
 *
 * The update path also tells the page which version it replaced, so the first
 * frame can say "updated from 0.7.1" instead of silently looking identical.
 *
 * Everything here is pure: `main.ts` owns the killing, this file owns the
 * judgement, and `verify-handshake` pins the judgement down.
 */

/** What identifies a build for handshake purposes. */
export interface BuildIdentity {
  /** Engine version, e.g. `0.7.2-workspace`. */
  appVersion?: string;
  /**
   * Size of the executable that is running. Catches "same version, different
   * binary" (a rebuild during development) without hashing 90 MiB at startup.
   */
  exeSize?: number;
}

export type LaunchAction = 'start' | 'reuse' | 'takeover-orphan' | 'takeover-update';

export interface LaunchDecision {
  action: LaunchAction;
  /** Why, for the desktop log. */
  reason: string;
  /**
   * Version of the instance being replaced (update/orphan takeovers only).
   * `undefined` when the running server is too old to report a build.
   */
  replacedVersion?: string;
}

export interface HandshakeInput {
  /** `/health` build block of the running server; `undefined` when none runs. */
  runningBuild?: BuildIdentity | null;
  /** Identity of *this* executable. */
  ownBuild: BuildIdentity;
  /** Whether the running instance still owns a visible window. */
  windowAlive: boolean;
}

/** A running server too old to report `build` — we cannot prove it is us. */
const UNKNOWN_VERSION = 'unknown';

/**
 * True when both identities describe the same build.
 *
 * Missing pieces are treated as "cannot disagree": an older server that does
 * not report `exeSize` still matches on version. An older server that reports
 * **no version at all** never matches — that is the case where guessing
 * "probably the same" is what leaves the user on a stale build.
 */
export function sameBuild(a: BuildIdentity | null | undefined, b: BuildIdentity | null | undefined): boolean {
  if (!a || !b) return false;
  if (!a.appVersion || !b.appVersion) return false;
  if (a.appVersion !== b.appVersion) return false;
  const sa = a.exeSize;
  const sb = b.exeSize;
  if (typeof sa === 'number' && typeof sb === 'number' && sa > 0 && sb > 0 && sa !== sb) return false;
  return true;
}

/** Decide what a launch should do about an instance that already answers. */
export function decideLaunch(input: HandshakeInput): LaunchDecision {
  const running = input.runningBuild ?? null;
  if (!running) return { action: 'start', reason: 'no-server' };

  const replacedVersion = running.appVersion ?? UNKNOWN_VERSION;

  if (!input.windowAlive) {
    // Nothing on screen to protect: take the port back and boot properly.
    return { action: 'takeover-orphan', reason: 'no-window', replacedVersion };
  }

  if (sameBuild(running, input.ownBuild)) {
    return { action: 'reuse', reason: 'same-build', replacedVersion };
  }

  // A visible window on a *different* build. The user just launched this exe,
  // so the intent is the new build; keeping the old window would silently
  // ignore the upgrade.
  return {
    action: 'takeover-update',
    reason: running.appVersion ? 'version-mismatch' : 'unknown-build',
    replacedVersion,
  };
}

/**
 * Window URL for a launch.
 *
 * `updated` is only added when an older instance was replaced, so a normal
 * start keeps the plain `/` URL (and its cache/proxy behaviour) untouched.
 */
export function launchUrl(base: string, updatedFrom?: string): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  if (!updatedFrom) return root;
  return `${root}?updated=${encodeURIComponent(updatedFrom)}`;
}
