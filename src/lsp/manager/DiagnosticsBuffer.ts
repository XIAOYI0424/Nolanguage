/**
 * Diagnostics buffering: dedupe, then truncate.
 *
 * A language server can publish the same diagnostic on every keystroke, and a
 * project-wide analysis can publish tens of thousands at once. Both are normal;
 * neither should reach the UI unbounded. The caps are deliberately generous —
 * this is a memory guard, not a display policy.
 */
import type { Diagnostic } from '../LspClient.js';

export interface BufferStats {
  total: number;
  kept: number;
  dropped: number;
  /** Distinct files currently buffered. */
  files: number;
}

/** Hard ceiling across every file. */
export const MAX_DIAGNOSTICS = 12_000;
/** Per-file ceiling, so one broken generated file cannot eat the budget. */
export const MAX_PER_FILE = 2_000;

function keyOf(d: Diagnostic): string {
  const s = d.range.start;
  const e = d.range.end;
  return `${s.line}:${s.character}-${e.line}:${e.character}|${d.severity ?? 0}|${String(d.code ?? '')}|${d.message}`;
}

export class DiagnosticsBuffer {
  private byUri = new Map<string, Diagnostic[]>();
  private order: string[] = [];

  constructor(
    private readonly limit = MAX_DIAGNOSTICS,
    private readonly perFile = MAX_PER_FILE,
  ) {}

  /**
   * Replace one file's diagnostics.
   *
   * Replacement, not append: `publishDiagnostics` is a full snapshot for that
   * URI, and appending would grow without bound while the user types.
   */
  set(uri: string, items: Diagnostic[]): BufferStats {
    const seen = new Set<string>();
    const unique: Diagnostic[] = [];
    for (const d of items) {
      const k = keyOf(d);
      if (seen.has(k)) continue;
      seen.add(k);
      if (unique.length >= this.perFile) break;
      unique.push(d);
    }
    if (!this.byUri.has(uri)) this.order.push(uri);
    this.byUri.set(uri, unique);
    return this.stats();
  }

  get(uri: string): Diagnostic[] {
    return this.byUri.get(uri) ?? [];
  }

  clear(uri?: string): void {
    if (uri === undefined) {
      this.byUri.clear();
      this.order = [];
      return;
    }
    this.byUri.delete(uri);
    this.order = this.order.filter((u) => u !== uri);
  }

  /**
   * Everything, in arrival order, truncated to the global ceiling.
   *
   * Truncation drops the *last* files rather than the last entries of each file:
   * a half-reported file is worse than an unreported one, because the UI would
   * show a count that looks complete.
   */
  all(): Array<{ uri: string; items: Diagnostic[] }> {
    const out: Array<{ uri: string; items: Diagnostic[] }> = [];
    let total = 0;
    for (const uri of this.order) {
      const items = this.byUri.get(uri) ?? [];
      if (!items.length) continue;
      if (total + items.length > this.limit) break;
      out.push({ uri, items });
      total += items.length;
    }
    return out;
  }

  stats(): BufferStats {
    let total = 0;
    for (const items of this.byUri.values()) total += items.length;
    return {
      total: Math.min(total, this.limit),
      kept: Math.min(total, this.limit),
      dropped: Math.max(0, total - this.limit),
      files: this.byUri.size,
    };
  }
}
