import { createHash } from 'node:crypto';
import { ulid } from '../util/ulid.js';
import type { LogCorrelation } from './types.js';
import { probeGit, GitProbe, UNKNOWN_GIT } from '../git/GitProbe.js';
import type { GitInfo, GitProbeOptions } from '../git/GitProbe.js';

export interface CorrelationBusOptions extends GitProbeOptions {
  /** Stable workspace / session identity stamped onto every record. */
  sessionId?: string;
  workspaceId?: string;
}

/**
 * Correlation bus (横切基础设施): mints traceId and resolves gitCommit /
 * gitBranch / configHash shared by every perf + log record (spec 二十二).
 *
 * The synchronous accessors (`gitCommit()`, `gitBranch()`) stay synchronous
 * because they are called from hot paths (every perf envelope, every log
 * record). Real git data arrives through `prime()`, which must be awaited once
 * during kernel startup — otherwise the accessors keep returning `'unknown'`.
 */
export class CorrelationBus {
  private git: GitInfo = { ...UNKNOWN_GIT };
  private cachedConfigHash?: string;
  private config?: unknown;
  private primed = false;
  /** True once `setGit()` injected state explicitly — probing must not clobber it. */
  private injected = false;

  readonly probe: GitProbe;
  sessionId?: string;
  workspaceId?: string;

  constructor(opts: CorrelationBusOptions = {}) {
    this.probe = new GitProbe(opts);
    this.sessionId = opts.sessionId;
    this.workspaceId = opts.workspaceId;
  }

  traceId(): string {
    return ulid();
  }

  /**
   * Resolve git state once (async spawn) and cache it. Safe to call repeatedly;
   * pass `force` to re-read after a commit. Explicitly injected state (via
   * `setGit`) always wins, so a host that knows the commit is never overwritten
   * by a probe.
   */
  async prime(force = false): Promise<GitInfo> {
    if (this.injected) return this.git;
    if (this.primed && !force) return this.git;
    try {
      this.git = await probeGit(this.probe.cwd, this.probe.bin);
    } catch {
      this.git = { ...UNKNOWN_GIT };
    }
    this.primed = true;
    return this.git;
  }

  /** Inject git state directly (tests, or a host that already knows it). */
  setGit(info: Partial<GitInfo>): void {
    this.git = { ...this.git, ...info };
    this.primed = true;
    this.injected = true;
  }

  /** Full probe result (available / repo / dirty / subject / …). */
  gitInfo(): GitInfo {
    return this.git;
  }

  gitCommit(): string {
    return this.git.commit || 'unknown';
  }

  gitBranch(): string {
    return this.git.branch || 'unknown';
  }

  gitDirty(): boolean {
    return this.git.dirty;
  }

  /**
   * Register the configuration snapshot whose identity `configHash()` should
   * represent. Records produced afterwards carry the hash of this snapshot, so
   * a metric shift can be attributed to a config change (spec 二十二).
   */
  setConfig(config: unknown): void {
    this.config = config;
    this.cachedConfigHash = undefined;
  }

  configHash(): string {
    if (this.cachedConfigHash === undefined) {
      if (this.config === undefined) {
        // No configuration registered — mint a per-process identity so records
        // still share a consistent hash within this run.
        this.cachedConfigHash = ulid().slice(0, 12);
      } else {
        this.cachedConfigHash = hashConfig(this.config);
      }
    }
    return this.cachedConfigHash;
  }

  newContext(): LogCorrelation {
    return {
      traceId: this.traceId(),
      gitCommit: this.gitCommit(),
      gitBranch: this.gitBranch(),
      configHash: this.configHash(),
      sessionId: this.sessionId,
    };
  }
}

/**
 * Deterministic short hash of a configuration snapshot. Key order is
 * normalised so two structurally-equal configs hash identically.
 */
export function hashConfig(config: unknown): string {
  const canonical = canonicalise(config);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}
