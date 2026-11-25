/**
 * Performance domain of the panel protocol: profiling, coverage, flame graph.
 *
 * Extracted from the 375-line switch in `server.ts` for one reason: these six
 * cases are the only ones that carry **state** (`lastProfile`) and a **fan-out**
 * (a profile taken in one window is pushed to every other window). Keeping them
 * inline meant `main()` had to own a mutable variable and a client set that no
 * other case needed.
 *
 * The class owns the state; the deps are injected. That is the pattern for the
 * remaining fat cases — the thin ones (`mcpList`, `sandboxCreate`, …) stay in the
 * switch on purpose: they are three-line delegations to services that already
 * own the logic, and moving them would add a context object without removing a
 * decision.
 */
import type { WorkspaceService } from '../WorkspaceService.js';
import type { ProfilerService } from '../../profiler/ProfilerService.js';
import type { FlameSampler, FlameSink } from '../../perf/flame.js';
import { runPythonCoverage } from '../../runtimes/coverage.js';
import { asLanguage } from './languages.js';

export type Reply = (payload: unknown) => void;

export interface PerfDeps {
  workspace: WorkspaceService;
  profiler: ProfilerService | undefined;
  flame: FlameSampler;
  /** Send to every page except the one that asked, so a /profile tab updates live. */
  broadcastToOthers: (payload: unknown, except?: unknown) => void;
}

export class PerfHandlers {
  /** Last profile result, for a /profile page that opens after the run. */
  private lastProfile: unknown = null;

  constructor(private readonly deps: PerfDeps) {}

  /** Returns true when this handler owns `kind`. */
  handle(kind: string, msg: Record<string, unknown>, reply: Reply, self?: unknown): boolean {
    switch (kind) {
      case 'profile':
        this.profile(msg, reply, self);
        return true;
      case 'profileLast':
        this.profileLast(reply);
        return true;
      case 'profileCaps':
        this.profileCaps(reply);
        return true;
      case 'coverage':
        this.coverage(msg, reply);
        return true;
      case 'flameStart':
        this.deps.flame.subscribe(reply as unknown as FlameSink, msg.intervalMs ? Number(msg.intervalMs) : undefined);
        return true;
      case 'flameStop':
        this.deps.flame.unsubscribe(reply as unknown as FlameSink);
        return true;
      default:
        return false;
    }
  }

  private profile(msg: Record<string, unknown>, reply: Reply, self?: unknown): void {
    const profiler = this.deps.profiler;
    if (!profiler) {
      reply({ kind: 'profileResult', ok: false, error: 'profiler unavailable', hotspots: [], sampleCount: 0 });
      return;
    }
    // Ask the profiler which languages it has adapters for rather than picking
    // ids here — it is the last component that knows about languages at all.
    const wanted = String(msg.language ?? '');
    const language = profiler.supports(wanted) ? wanted : profiler.defaultLanguage();
    void profiler
      .profile({
        languageId: language,
        code: String(msg.code ?? ''),
        timeoutMs: msg.timeoutMs ? Number(msg.timeoutMs) : undefined,
      })
      .then((r) => {
        this.lastProfile = r;
        reply({ kind: 'profileResult', ...r });
        // A /profile page opened in another tab gets it live.
        this.deps.broadcastToOthers({ kind: 'profileResult', ...r }, self);
      })
      .catch((err: unknown) =>
        reply({ kind: 'profileResult', ok: false, error: (err as Error).message, hotspots: [], sampleCount: 0 }),
      );
  }

  private profileLast(reply: Reply): void {
    reply(
      this.lastProfile
        ? { kind: 'profileResult', ...(this.lastProfile as object) }
        : { kind: 'profileResult', ok: false, error: 'no profile yet', hotspots: [], sampleCount: 0 },
    );
  }

  private profileCaps(reply: Reply): void {
    const profiler = this.deps.profiler;
    reply({
      kind: 'profileCaps',
      languages: profiler
        ? profiler.languages().map((m) => ({
            id: m.id,
            displayName: m.displayName,
            adapter: m.profiler?.adapter ?? '',
            available: profiler.adapterFor(m.id)?.available ?? false,
          }))
        : [],
    });
  }

  private coverage(msg: Record<string, unknown>, reply: Reply): void {
    const workspace = this.deps.workspace;
    const language = asLanguage(msg.language, workspace);
    // Declared by the plugin (`run.coverage`), not compared by name: a language
    // that grows a line-coverage implementation opts in from its manifest.
    const spec = workspace.manifests().find((m) => m.id === language);
    if (!spec?.run?.coverage) {
      reply({
        kind: 'coverageResult',
        ok: false,
        language,
        error: `${language} does not declare line coverage (run.coverage)`,
      });
      return;
    }
    const bin =
      workspace.languageStatus(language).binary || spec.run.discovery?.commands?.[0] || '';
    void runPythonCoverage(bin, String(msg.code ?? ''), {
      timeoutMs: msg.timeoutMs ? Number(msg.timeoutMs) : 30_000,
    })
      .then((r) => reply({ kind: 'coverageResult', ...r }))
      .catch((err: unknown) => reply({ kind: 'coverageResult', ok: false, language, error: (err as Error).message }));
  }
}
