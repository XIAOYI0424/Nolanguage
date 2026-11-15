/**
 * Combined Stage 2 + Stage 3 loop: drives a real Python language server and
 * real Python execution so the **live panel** shows genuine LSP/Python data
 * instead of synthetic demo traffic:
 *
 *   panel  ←  PanelHub  ←  PerfSpine / LogSpine
 *                            ↑            ↑
 *                   rpc.roundtrip.*   language-server logs
 *                            ↑            ↑
 *                        LspClient   ← LspLogCollector
 *                            ↑
 *                   PythonRunner (execution.run, user-code logs)
 *
 * Enable with PANEL_WITH_PYTHON=1 when starting the panel server.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LspClient, fileUri } from '../lsp/LspClient.js';
import { discoverPythonServer } from '../python/serverDiscovery.js';
import { PythonRunner } from '../python/PythonRunner.js';
import type { Kernel } from '../kernel/Kernel.js';
import type { Diagnostic } from '../lsp/LspClient.js';

export interface PythonLoopOptions {
  /** Interval between loop ticks (each tick does LSP + execution work). */
  intervalMs?: number;
  /** Python binary to use. */
  pythonBin?: string;
}

export interface PythonLoopHandle {
  stop(): Promise<void>;
  stats(): { ticks: number; diagnostics: number; completions: number; runs: number };
}

const SOURCE = [
  'import os',
  'import json',
  '',
  '',
  'def load_config(path):',
  '    with open(path) as f:',
  '        return json.load(f)',
  '',
  '',
  'def summarize(items):',
  '    total = sum(items)',
  '    average = total / len(items)',
  '    return {"total": total, "average": average}',
  '',
  '',
  'if __name__ == "__main__":',
  '    print(summarize([1, 2, 3, 4]))',
  '    print(missing_helper())',
  '',
].join('\n');

/**
 * Start the Python loop. Returns a handle; call `stop()` on shutdown.
 * Safe to call when no Python is available — it logs a warning and no-ops.
 */
export async function startPythonLoop(
  kernel: Kernel,
  opts: PythonLoopOptions = {},
): Promise<PythonLoopHandle> {
  const intervalMs = opts.intervalMs ?? 2500;
  const log = kernel.logger.forComponent('stage3.loop');
  const stats = { ticks: 0, diagnostics: 0, completions: 0, runs: 0 };

  kernel.languages.register({
    id: 'python',
    extensions: ['.py', '.pyi'],
    lsp: 'pyright',
    dap: 'debugpy',
    profiler: 'py-spy',
  });

  const workspace = join(tmpdir(), 'nolanguage-panel-py');
  await mkdir(workspace, { recursive: true });
  const filePath = join(workspace, 'main.py');
  await writeFile(filePath, SOURCE, 'utf8');
  const uri = fileUri(filePath);

  const launch = await discoverPythonServer(opts.pythonBin);
  const lsp = new LspClient({ launch });
  let diagnostics: Diagnostic[] = [];
  lsp.on('diagnostics', (p: { diagnostics: Diagnostic[] }) => {
    diagnostics = p.diagnostics;
  });

  try {
    await lsp.start(kernel, fileUri(workspace));
    await lsp.openDocument(uri, SOURCE);
    stats.diagnostics = diagnostics.length;
    log.info('Python language server online', {
      server: launch.serverName,
      diagnostics: diagnostics.length,
    });
  } catch (err) {
    log.error('Python language server failed to start — panel runs without LSP', {}, err as Error);
    return {
      async stop() {
        await lsp.stop();
      },
      stats: () => stats,
    };
  }

  const runner = new PythonRunner(kernel, opts.pythonBin);
  const sessionId = 'sess-panel';
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    stats.ticks++;
    try {
      // Alternate the edit position so completions vary, and re-open the doc
      // periodically so diagnostics flow continuously.
      const line = 10 + (stats.ticks % 3);
      const items = await lsp.completion(uri, { line, character: 12 });
      stats.completions += items.length;

      if (stats.ticks % 4 === 0) {
        await lsp.diagnosticsPull(uri);
        stats.diagnostics = diagnostics.length;
      }
      if (stats.ticks % 3 === 0) {
        await lsp.hover(uri, { line: 11, character: 8 });
      }
      if (stats.ticks % 5 === 0) {
        // Re-publish diagnostics for a fresh document version.
        await lsp.openDocument(uri, SOURCE);
      }

      // Real Python execution every other tick.
      if (stats.ticks % 2 === 0) {
        const n = stats.ticks;
        const result = await runner.run({
          sessionId,
          code: [
            '# Self-contained snippet: functions are re-declared each run (they',
            '# cannot be pickled), while `seen` persists through the session.',
            'try:',
            '    seen',
            'except NameError:',
            '    seen = 0',
            'seen += 1',
            '',
            'def summarize(items):',
            '    return {"total": sum(items), "average": sum(items) / len(items)}',
            '',
            `values = [${n}, ${n * 2}, ${n * 3}]`,
            `print("tick ${n} (session run #" + str(seen) + ")", summarize(values))`,
          ].join('\n'),
        });
        stats.runs++;
        if (result.exitCode !== 0) {
          log.warn('Python tick failed', { exitCode: result.exitCode, tick: stats.ticks });
        }
      }
    } catch (err) {
      log.error('Python loop tick failed', { tick: stats.ticks }, err as Error);
    } finally {
      busy = false;
    }
  };

  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return {
    async stop() {
      if (timer) clearInterval(timer);
      await lsp.stop();
      await runner.close();
      log.info('Python loop stopped', { ...stats });
    },
    stats: () => stats,
  };
}
