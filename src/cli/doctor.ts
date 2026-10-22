/**
 * `nlg doctor` — one read-only report that answers "why is there no UI?".
 *
 * The desktop is a GUI process with no console: when it starts but no window
 * appears, the user has nothing to look at. This module collects the facts a
 * support conversation would otherwise ask for — which build is installed,
 * which server/browser pids the session recorded, whether a *visible* window
 * exists, who owns 7310, and whether Edge/Git/Python/Go are discoverable.
 *
 * It never starts, stops or modifies anything. `diagnose()` is pure so the
 * classification can be tested without a desktop session.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { appDataPath } from '../util/appData.js';
import { findWindowProcesses, findVisibleWindows, isAlive, readSession } from '../desktop/session.js';
import { findEdgeBinary, webView2Version, webViewProfileDir } from '../desktop/WebViewHost.js';
import { gitVersion, probeGit } from '../git/GitProbe.js';
import { discoverBinary, probeVersion } from '../langs/discover.js';
import type { BinaryDiscoverySpec } from '../runtimes/types.js';

export type Diagnosis = 'ok' | 'not-running' | 'orphan-server' | 'port-conflict' | 'window-missing';

export interface HealthInfo {
  status?: string;
  appVersion?: string;
  clients?: number;
  build?: { appVersion?: string; pid?: number; exePath?: string; exeSize?: number; startedAt?: string };
}

export interface InstallReceipt {
  version?: string;
  exePath?: string;
  exeSize?: number;
  startedAt?: string;
}

export interface DoctorReport {
  diagnosis: Diagnosis;
  app: { version: string; exePath: string; exeSize: number; sha256?: string; receipt?: InstallReceipt };
  session: {
    serverPid?: number;
    serverAlive: boolean;
    browserPid?: number;
    browserAlive: boolean;
    profile: string;
    windowPids: number[];
    visible: number[];
  };
  health?: HealthInfo;
  port: { port: number; open: boolean; healthy: boolean };
  edge: { path?: string; webview2?: string };
  git: { available: boolean; version?: string; repo?: boolean; commit?: string; branch?: string; dirty?: boolean };
  python: string | null;
  go: string | null;
  hints: string[];
}

/** Pure classification: no filesystem, no process access. */
export function diagnose(input: {
  health?: HealthInfo;
  serverAlive: boolean;
  visible: number[];
  portOpen: boolean;
}): Diagnosis {
  if (input.health && input.visible.length > 0) return 'ok';
  if (input.health && input.serverAlive) return 'orphan-server';
  if (input.portOpen && !input.health) return 'port-conflict';
  if (input.serverAlive) return 'window-missing';
  return 'not-running';
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function hashOf(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

function readReceipt(): InstallReceipt | undefined {
  try {
    return JSON.parse(readFileSync(appDataPath('install-receipt.json'), 'utf8')) as InstallReceipt;
  } catch {
    return undefined;
  }
}

async function readHealth(port: number): Promise<HealthInfo | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    return (await res.json()) as HealthInfo;
  } catch {
    return undefined;
  }
}

function probePort(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

/** The plugin manifest is the declared discovery policy; fall back to PATH. */
function manifestDiscovery(id: string): BinaryDiscoverySpec {
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'builtin', id, 'manifest.json'), 'utf8')) as {
      run?: { discovery?: BinaryDiscoverySpec };
    };
    return raw.run?.discovery ?? { commands: [id.split('@')[0]] };
  } catch {
    return { commands: [id.split('@')[0]] };
  }
}

async function toolchainVersion(id: string, args: string[]): Promise<string | null> {
  const bin = discoverBinary(manifestDiscovery(id), { root: process.cwd() });
  if (bin.source === 'missing' || !bin.bin) return null;
  return await probeVersion(bin.bin, args);
}

function buildHints(r: Omit<DoctorReport, 'hints'>): string[] {
  const hints: string[] = [];
  if (r.diagnosis === 'orphan-server') {
    hints.push(
      `server ${r.session.serverPid ?? '?'} is answering /health but no visible window exists; end it from Task Manager or taskkill /PID ${r.session.serverPid ?? '<pid>'} /T /F, then relaunch`,
    );
  }
  if (r.diagnosis === 'port-conflict') {
    hints.push(`port ${r.port.port} is open but /health is not ours; find the owner with Get-NetTCPConnection -LocalPort ${r.port.port}`);
  }
  if (r.diagnosis === 'not-running') hints.push('Nolanguage is not running; launch the installed app.');
  if (r.diagnosis === 'window-missing') hints.push('the session says the server is alive but no window is visible; relaunch the app.');
  if (!r.app.receipt) hints.push('no install-receipt.json yet — the app has not started from this build.');
  if (!r.edge.path) hints.push('Edge was not found; the desktop falls back to the system browser.');
  if (!r.git.available) hints.push('git was not found; baselines/correlation degrade to "unknown".');
  if (!r.python) hints.push('Python was not discovered; Python run/LSP are unavailable.');
  if (!r.go) hints.push('Go was not discovered; Go run/LSP are unavailable.');
  return hints;
}

export async function collectDoctorReport(): Promise<DoctorReport> {
  const port = Number(process.env.PANEL_PORT ?? 7310);
  const session = readSession();
  const profile = session?.profile ?? webViewProfileDir();
  const windowPids = await findWindowProcesses(profile);
  const visible = windowPids.length ? await findVisibleWindows(windowPids) : [];
  const health = await readHealth(port);
  const portOpen = await probePort(port);
  const receipt = readReceipt();
  // Never fall back to `process.execPath`: doctor usually runs on node.exe, and
  // reporting the interpreter as "the installed app" is worse than `unknown`.
  const exePath = receipt?.exePath ?? health?.build?.exePath;
  const exeSize = exePath ? sizeOf(exePath) : 0;

  const gitInfo = await probeGit(process.cwd());
  const git = {
    available: gitInfo.available,
    version: gitInfo.available ? (await gitVersion()) || undefined : undefined,
    repo: gitInfo.repo,
    commit: gitInfo.commit,
    branch: gitInfo.branch,
    dirty: gitInfo.dirty,
  };

  const diagnosis = diagnose({
    health,
    serverAlive: isAlive(session?.serverPid),
    visible,
    portOpen,
  });

  const base: Omit<DoctorReport, 'hints'> = {
    diagnosis,
    app: {
      version: health?.build?.appVersion ?? health?.appVersion ?? receipt?.version ?? 'unknown',
      exePath: exePath ?? 'unknown',
      exeSize,
      sha256: exePath ? hashOf(exePath) : undefined,
      receipt,
    },
    session: {
      serverPid: session?.serverPid,
      serverAlive: isAlive(session?.serverPid),
      browserPid: session?.browserPid,
      browserAlive: isAlive(session?.browserPid),
      profile,
      windowPids,
      visible,
    },
    health,
    port: { port, open: portOpen, healthy: !!health },
    edge: { path: findEdgeBinary(), webview2: webView2Version() },
    git,
    python: await toolchainVersion('python@1.0.0', ['--version']),
    go: await toolchainVersion('go@1.0.0', ['version']),
  };
  return { ...base, hints: buildHints(base) };
}

const LABEL: Record<Diagnosis, string> = {
  ok: 'ok',
  'not-running': 'not running',
  'orphan-server': 'orphan server (no visible window)',
  'port-conflict': 'port occupied by another process',
  'window-missing': 'server alive but no window',
};

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatDoctor(r: DoctorReport): string {
  const lines: string[] = [];
  lines.push('Nolanguage doctor');
  lines.push(`  diagnosis  ${LABEL[r.diagnosis]}`);
  lines.push(`  app        ${r.app.version} · ${r.app.exePath} (${mib(r.app.exeSize)})`);
  if (r.app.sha256) lines.push(`  sha256     ${r.app.sha256}`);
  if (r.app.receipt) {
    lines.push(
      `  receipt    ${r.app.receipt.version ?? '?'} · ${r.app.receipt.startedAt ?? '?'} · ${r.app.receipt.exePath ?? '?'}`,
    );
  } else {
    lines.push('  receipt    (none)');
  }
  lines.push(
    `  session    server ${r.session.serverPid ?? '-'} (${r.session.serverAlive ? 'alive' : 'dead'}) · ` +
      `browser ${r.session.browserPid ?? '-'} (${r.session.browserAlive ? 'alive' : 'dead'}) · ` +
      `visible [${r.session.visible.join(',') || '-'}]`,
  );
  lines.push(
    r.health
      ? `  health     ${r.health.status ?? '?'} · clients ${r.health.clients ?? '?'} · ${r.health.appVersion ?? '?'}`
      : '  health     (no response)',
  );
  lines.push(`  port       ${r.port.port} ${r.port.open ? 'open' : 'closed'} · health ${r.port.healthy ? 'yes' : 'no'}`);
  lines.push(`  profile    ${r.session.profile}`);
  lines.push(
    `  edge       ${r.edge.path ?? '(not found)'}${r.edge.webview2 ? ` · WebView2 ${r.edge.webview2}` : ''}`,
  );
  lines.push(
    `  git        ${r.git.available ? `${r.git.version ?? '?'} · ${r.git.branch ?? '?'} · ${r.git.commit ?? '?'}${r.git.dirty ? ' · dirty' : ''}` : '(not found)'}`,
  );
  lines.push(`  python     ${r.python ?? '(not found)'}`);
  lines.push(`  go         ${r.go ?? '(not found)'}`);
  for (const hint of r.hints) lines.push(`  hint       ${hint}`);
  return lines.join('\n');
}
