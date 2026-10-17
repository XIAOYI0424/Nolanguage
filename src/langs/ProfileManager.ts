/**
 * ProfileManager — the memory budget for language plugins (Phase 4).
 *
 * Why this is *not* part of WorkspaceService: the workspace knows how to start a
 * language server, but a budget is a policy that needs its own tests. This class
 * holds the policy and asks a provider to stop a server; the provider holds the
 * processes. That split lets the whole budget/LRU/idle machinery be verified
 * without spawning a single gopls.
 *
 * Policy, in one paragraph:
 *
 *   - Every language is attributed a memory cost from its manifest
 *     (`lsp.memoryHint`, `profiler.memoryHint`, a runtime default).
 *   - Two budgets: a total one and a language-server-only one, because language
 *     servers are the only reclaimable part — you cannot un-load a runner you
 *     are using.
 *   - Under pressure, stop the least-recently-used server that is not `eager`;
 *     idle reclamation likewise never touches an eager language.
 *   - `eager` means "the user asked for this to be ready", and a budget does not
 *     override an explicit choice: when only eager languages are left we report
 *     `overBudget` rather than killing the user's default language mid-session.
 *     The budget then governs which additional languages get a server, which is
 *     the useful thing a budget can do.
 *   - Independently of pressure, a server nobody touched for `idleMs` is
 *     reclaimed (non-eager only).
 *   - Nothing here throws. A stop that fails is recorded and retried next tick.
 */
const KB = 1024;
const MB = KB * 1024;

const UNITS: Record<string, number> = {
  b: 1,
  k: KB,
  kb: KB,
  m: MB,
  mb: MB,
  g: MB * KB,
  gb: MB * KB,
  t: MB * KB * KB,
  tb: MB * KB * KB,
};

/** One language's current resource shape, as seen by the manager. */
export interface ResourceProfile {
  languageId: string;
  /** Everything attributed to the language: server + profiler + runner. */
  memoryBytes: number;
  /** The part a language server holds — the only reclaimable part. */
  lspMemoryBytes: number;
  /** True when a server process is alive right now. */
  lspRunning: boolean;
  /** Declared `lsp.eager`; exempt from idle reclamation. */
  eager: boolean;
  /** Last time the workspace saw a run/check/complete/hover for this language. */
  lastUsedAt: number;
}

/** What ProfileManager calls back into. Implemented by WorkspaceService. */
export interface ResourceProvider {
  profiles(): ResourceProfile[];
  stopLsp(id: string): Promise<void>;
}

export type ReapReason = 'lsp-budget' | 'total-budget' | 'idle';

export interface ReapRecord {
  id: string;
  reason: ReapReason;
  freedBytes: number;
}

export interface ResourceSummary {
  budgetBytes: number;
  lspBudgetBytes: number;
  totalBytes: number;
  lspBytes: number;
  /** Budgets were exceeded and no server could be stopped. */
  overBudget: boolean;
  /** A stop failed (recorded, retried on the next tick). */
  failedStops: string[];
  idleMs: number;
  running: number;
  lastEnforcedAt: number;
  profiles: ResourceProfile[];
}

export interface ProfileManagerOptions {
  /** Total bytes for all language plugins. Default `NOLANGUAGE_LANG_MEMORY_BUDGET` MB, else 8 GiB. */
  budgetBytes?: number;
  /** Bytes for language servers specifically. Default 60% of the budget. */
  lspBudgetBytes?: number;
  /** Stop a quiet server after this. `0` disables idle reclamation. */
  idleMs?: number;
  /** How often `enforce()` runs while started. `0` disables the timer. */
  tickMs?: number;
  now?(): number;
}

/**
 * `"380MB"` → bytes. A bare number is bytes; an unknown unit is treated as
 * bytes too, because a hint we cannot parse must never look like "free".
 * (Rejecting the plugin instead would make a typo in a display field disable a
 * whole language — the same reason `validateManifest` leaves it alone.)
 */
export function parseMemoryHint(hint: string | undefined): number {
  if (!hint) return 0;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*([a-zA-Z]*)\s*$/.exec(String(hint));
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return 0;
  const unit = (m[2] || 'b').toLowerCase();
  return Math.round(n * (UNITS[unit] ?? 1));
}

/** Rough cost of a runner process when the manifest does not say. */
export function runtimeMemoryBytes(mode: string | undefined): number {
  switch (mode) {
    case 'repl-session':
    case 'directory-session':
      return 64 * MB;
    case 'script-host':
      return 48 * MB;
    case 'inline-vm':
      return 32 * MB;
    default:
      return 8 * MB;
  }
}

/**
 * Least-recently-used **non-eager** server, or `undefined` when only eager
 * languages are left running. That is the point: an eager language was
 * explicitly asked to be ready, so a budget may not take it away.
 */
function pickVictim(running: ResourceProfile[]): ResourceProfile | undefined {
  const candidates = running.filter((p) => !p.eager);
  if (!candidates.length) return undefined;
  return candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
}

export class ProfileManager {
  private readonly budgetBytes: number;
  private readonly lspBudgetBytes: number;
  private readonly idleMs: number;
  private readonly tickMs: number;
  private readonly now: () => number;
  private provider: ResourceProvider | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Usage clock; the manager owns it so idle pressure is testable. */
  private used = new Map<string, number>();
  private lastEnforcedAt = 0;
  private lastReaps: ReapRecord[] = [];
  private failedStops: string[] = [];

  constructor(opts: ProfileManagerOptions = {}) {
    const budget =
      opts.budgetBytes ??
      (process.env.NOLANGUAGE_LANG_MEMORY_BUDGET
        ? Number(process.env.NOLANGUAGE_LANG_MEMORY_BUDGET) * MB
        : 8 * MB * KB);
    this.budgetBytes = budget > 0 ? budget : 8 * MB * KB;
    this.lspBudgetBytes =
      opts.lspBudgetBytes ??
      (process.env.NOLANGUAGE_LANG_LSP_BUDGET
        ? Number(process.env.NOLANGUAGE_LANG_LSP_BUDGET) * MB
        : Math.floor(this.budgetBytes * 0.6));
    this.idleMs = opts.idleMs ?? Number(process.env.NOLANGUAGE_LANG_IDLE_MS ?? 10 * 60 * 1000);
    this.tickMs = opts.tickMs ?? Number(process.env.NOLANGUAGE_LANG_TICK_MS ?? 30_000);
    this.now = opts.now ?? (() => Date.now());
  }

  /** The workspace binds itself so the manager can stop servers. */
  bind(provider: ResourceProvider): void {
    this.provider = provider;
  }

  start(): void {
    if (this.timer || this.tickMs <= 0) return;
    this.timer = setInterval(() => void this.enforce(), this.tickMs);
    // A timer must never keep a process alive on its own.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Record a use, so LRU and idle both see it. */
  noteUse(id: string): void {
    this.used.set(id, this.now());
  }

  forget(id: string): void {
    this.used.delete(id);
  }

  lastUsedAt(id: string, fallback = 0): number {
    return this.used.get(id) ?? fallback;
  }

  /** Run one enforcement pass. Safe to call manually (tests, `status()`). */
  async enforce(): Promise<ReapRecord[]> {
    this.lastEnforcedAt = this.now();
    this.lastReaps = [];
    this.failedStops = [];
    if (!this.provider) return this.lastReaps;
    await this.relievePressure();
    await this.reclaimIdle();
    return this.lastReaps;
  }

  /**
   * Ask the provider to stop `id` and record what that freed.
   *
   * The freed size is read *after* the stop, so a provider that ignores the
   * request contributes 0 — which also makes the caller's loop notice that
   * stopping did not help and give up instead of spinning.
   */
  private async stop(id: string, reason: ReapReason): Promise<void> {
    try {
      await this.provider?.stopLsp(id);
    } catch {
      this.failedStops.push(id);
      return;
    }
    this.used.delete(id);
    const freed = (this.provider?.profiles() ?? []).find((p) => p.languageId === id)?.lspMemoryBytes ?? 0;
    this.lastReaps.push({ id, reason, freedBytes: freed });
  }

  /**
   * Stop servers while a budget is exceeded. LRU first, eager last.
   *
   * The loop re-reads profiles after every stop because a stopped server stops
   * counting; without that it would keep reaping until everything is gone.
   */
  private async relievePressure(): Promise<void> {
    for (let guard = 0; guard < 64; guard++) {
      const profiles = this.provider?.profiles() ?? [];
      const running = profiles.filter((p) => p.lspRunning);
      const lspBytes = running.reduce((a, p) => a + p.lspMemoryBytes, 0);
      const totalBytes = profiles.reduce((a, p) => a + p.memoryBytes, 0);
      const overLsp = lspBytes > this.lspBudgetBytes;
      const overTotal = totalBytes > this.budgetBytes;
      if (!overLsp && !overTotal) return;
      if (!running.length) return; // Nothing reclaimable; `overBudget` reports it.
      const victim = pickVictim(running);
      if (!victim) return;
      await this.stop(victim.languageId, overLsp ? 'lsp-budget' : 'total-budget');
      const after =
        (this.provider?.profiles() ?? []).filter((p) => p.lspRunning).reduce((a, p) => a + p.lspMemoryBytes, 0);
      if (after >= lspBytes) return; // The stop did not help; do not loop.
    }
  }

  /** Independent of pressure: stop servers nobody has touched for `idleMs`. */
  private async reclaimIdle(): Promise<void> {
    if (this.idleMs <= 0) return;
    const cutoff = this.now() - this.idleMs;
    for (const p of this.provider?.profiles() ?? []) {
      if (!p.lspRunning || p.eager) continue;
      if (this.lastUsedAt(p.languageId, p.lastUsedAt) > cutoff) continue;
      await this.stop(p.languageId, 'idle');
    }
  }

  summary(): ResourceSummary {
    const profiles = (this.provider?.profiles() ?? []).map((p) => ({
      ...p,
      lastUsedAt: this.lastUsedAt(p.languageId, p.lastUsedAt),
    }));
    const running = profiles.filter((p) => p.lspRunning);
    const lspBytes = running.reduce((a, p) => a + p.lspMemoryBytes, 0);
    const totalBytes = profiles.reduce((a, p) => a + p.memoryBytes, 0);
    return {
      budgetBytes: this.budgetBytes,
      lspBudgetBytes: this.lspBudgetBytes,
      totalBytes,
      lspBytes,
      overBudget: totalBytes > this.budgetBytes || lspBytes > this.lspBudgetBytes,
      failedStops: this.failedStops,
      idleMs: this.idleMs,
      running: running.length,
      lastEnforcedAt: this.lastEnforcedAt,
      profiles,
    };
  }

  /** What the last `enforce()` did — for logs and tests. */
  reaps(): ReapRecord[] {
    return this.lastReaps;
  }

  get options(): { budgetBytes: number; lspBudgetBytes: number; idleMs: number } {
    return { budgetBytes: this.budgetBytes, lspBudgetBytes: this.lspBudgetBytes, idleMs: this.idleMs };
  }
}
