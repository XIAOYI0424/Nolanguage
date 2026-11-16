/**
 * MCP (Model Context Protocol) client manager — the engine behind the sidebar
 * "MCP" tool window.
 *
 * # What it does
 *
 * Servers are declared in one JSON file (`<appData>/mcp.json`, overridable with
 * `NOLANGUAGE_MCP_CONFIG`):
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/tmp"],
 *         "env": { "TOKEN": "…" },
 *         "cwd": ".",
 *         "disabled": false,
 *         "timeoutMs": 60000
 *       }
 *     }
 *   }
 *
 * `timeoutMs` is optional and exists for servers that start slowly: the default
 * handshake budget is 12s, and a first `npx` run spends it downloading, so the
 * failure looks like a broken server instead of a cold cache. See
 * `McpServerConfig.timeoutMs`.
 *
 * Each entry is a stdio MCP server: the manager spawns it, performs the
 * `initialize` handshake, asks for `tools/list`, and can forward `tools/call`.
 * Transports other than stdio (SSE/HTTP) are deliberately out of scope here —
 * the sidebar is a local-tools panel, and stdio is what ships in the wild.
 *
 * # Framing
 *
 * MCP over stdio is newline-delimited JSON-RPC 2.0 — the same shape the panel
 * itself uses, so no length prefixes and no content headers. A line may arrive
 * split across chunks, hence the buffered `readline` reader.
 *
 * # Failure model
 *
 * A server that cannot start, crashes or times out becomes `status: "error"`
 * with the message kept on its card; it never takes the panel down. That matters
 * because a half-configured `mcp.json` is the common case.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { appDataPath } from '../util/appData.js';
import { planSpawn } from '../util/spawnPlan.js';

/** One declared server. Everything but `command` is optional. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  description?: string;
  /**
   * How long to wait for *this* server to answer, ms.
   *
   * Needed because the default 12s handshake budget is not enough for the
   * common case: `npx -y some-server` has to download the package on the first
   * connect, and the failure reads as "initialize timed out" — indistinguishable
   * from a server that is actually broken. A config that starts slowly says so
   * here instead of looking dead.
   *
   * Applies to the handshake (`initialize` + `tools/list`) and to `tools/call`
   * unless the call passes its own budget. Clamped to
   * [MCP_TIMEOUT_MIN_MS, MCP_TIMEOUT_MAX_MS]; an unusable value is ignored.
   */
  timeoutMs?: number;
}

/** Below this a handshake is being abandoned before a process could boot. */
export const MCP_TIMEOUT_MIN_MS = 1_000;

/** Above this a "timeout" stops protecting anything (10 minutes). */
export const MCP_TIMEOUT_MAX_MS = 10 * 60_000;

/**
 * Normalise a config-supplied MCP timeout.
 *
 * Same reasoning as the run timeout: `Number('abc')` is NaN and `setTimeout(NaN)`
 * fires immediately, so a typo would make every connect fail at once. An
 * unusable value returns `undefined` — "no opinion, use the default" — rather
 * than a number that means something else.
 */
export function boundedMcpTimeout(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(MCP_TIMEOUT_MAX_MS, Math.max(MCP_TIMEOUT_MIN_MS, Math.round(n)));
}

/** What `initialize` reported, trimmed to what a card can show. */
export interface McpServerInfo {
  name?: string;
  version?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type McpStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'disabled';

/** The live view of one server, as the sidebar receives it. */
export interface McpServerState {
  id: string;
  command: string;
  args: string[];
  description: string;
  status: McpStatus;
  error: string;
  tools: McpToolInfo[];
  protocolVersion?: string;
  serverInfo?: McpServerInfo;
}

/** The frame the client renders; also the shape of the `mcp` message. */
export interface McpPayload {
  kind: 'mcp';
  configPath: string;
  configExists: boolean;
  configError: string;
  servers: McpServerState[];
}

export interface McpLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface McpOptions {
  configPath?: string;
  logger?: McpLogger;
  /** Handshake + tool listing budget, ms. */
  timeoutMs?: number;
}

/** How much stderr is kept per server for the error card. */
const STDERR_TAIL = 4096;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One connected (or connecting) server: the process plus its JSON-RPC state. */
interface LiveServer {
  child: ChildProcessWithoutNullStreams;
  reader: Interface;
  pending: Map<number, Pending>;
  nextId: number;
  stderr: string;
  state: McpServerState;
}

export class McpManager {
  private readonly configPath: string;
  private readonly logger?: McpLogger;
  private readonly timeoutMs: number;
  private config: Record<string, McpServerConfig> = {};
  private configExists = false;
  private configError = '';
  private readonly live = new Map<string, LiveServer>();
  private readonly states = new Map<string, McpServerState>();

  constructor(opts: McpOptions = {}) {
    this.configPath = opts.configPath || appDataPath('mcp.json');
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? 12_000;
  }

  /** Read the config file. A missing file is normal (no servers yet). */
  async load(): Promise<void> {
    this.configError = '';
    try {
      const raw = await readFile(this.configPath, 'utf8');
      this.configExists = true;
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
      const servers = parsed?.mcpServers;
      this.config = servers && typeof servers === 'object' ? servers : {};
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.configExists = code !== 'ENOENT';
      this.config = {};
      if (code !== 'ENOENT') this.configError = `cannot read ${this.configPath}: ${(err as Error).message}`;
    }
    this.syncStates();
  }

  /** The frame the panel renders. */
  payload(): McpPayload {
    this.syncStates();
    return {
      kind: 'mcp',
      configPath: this.configPath,
      configExists: this.configExists,
      configError: this.configError,
      servers: [...this.states.values()],
    };
  }

  /**
   * Write a starter `mcp.json` when none exists. The example ships disabled: a
   * config file that spawns `npx` on first paint would be a surprise, not a help.
   */
  async initConfig(): Promise<void> {
    if (this.configExists) return;
    const example = {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          description: 'Reference filesystem server (edit the path, then Connect)',
          disabled: true,
        },
      },
    };
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, JSON.stringify(example, null, 2) + '\n', 'utf8');
    await this.load();
  }

  /** Connect (and list tools). Safe to call on an already connected server. */
  async connect(id: string): Promise<McpServerState> {
    const cfg = this.config[id];
    if (!cfg) throw new Error(`unknown MCP server "${id}"`);
    if (cfg.disabled) throw new Error(`"${id}" is disabled in ${this.configPath}`);
    if (!cfg.command) throw new Error(`"${id}" has no command`);
    const existing = this.live.get(id);
    if (existing) return existing.state;

    const state: McpServerState = {
      id,
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      description: cfg.description ?? '',
      status: 'connecting',
      error: '',
      tools: [],
    };
    this.states.set(id, state);

    let child: ChildProcessWithoutNullStreams;
    try {
      // On Windows a bare `npx` cannot be spawned at all (ENOENT: CreateProcess
      // does not consult PATHEXT; EINVAL: a .cmd is not a loadable image). The
      // plan resolves it through PATH/PATHEXT and routes .cmd/.bat via cmd.exe;
      // everywhere else it is the identity.
      //
      // Resolve against the *child's* PATH, not ours: a server entry may set
      // `env.PATH` to reach a toolchain we do not have.
      const childEnv = { ...process.env, ...(cfg.env || {}) };
      const plan = planSpawn(cfg.command, state.args, {
        ...(childEnv.PATH !== undefined ? { PATH: childEnv.PATH } : {}),
        ...(childEnv.PATHEXT !== undefined ? { PATHEXT: childEnv.PATHEXT } : {}),
      });
      child = spawn(plan.command, plan.args, {
        cwd: cfg.cwd || process.cwd(),
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(plan.shell ? { shell: true } : {}),
      });
    } catch (err) {
      state.status = 'error';
      state.error = `spawn failed: ${(err as Error).message}`;
      throw new Error(state.error);
    }

    const live: LiveServer = {
      child,
      reader: createInterface({ input: child.stdout }),
      pending: new Map(),
      nextId: 1,
      stderr: '',
      state,
    };
    this.live.set(id, live);

    child.stderr.on('data', (chunk: Buffer) => {
      live.stderr = (live.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    live.reader.on('line', (line) => this.onLine(live, line));
    child.on('error', (err) => {
      this.fail(live, `process error: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      if (live.state.status === 'ready' || live.state.status === 'connecting') {
        const reason = live.stderr.trim().split('\n').slice(-3).join(' | ');
        this.fail(live, `exited (${signal || code})${reason ? ': ' + reason : ''}`);
      }
    });

    try {
      const budget = this.handshakeTimeout(cfg);
      const init = (await this.request(live, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'nolanguage', version: '0.6.0' },
      }, budget)) as { protocolVersion?: string; serverInfo?: McpServerInfo } | undefined;
      state.protocolVersion = init?.protocolVersion;
      state.serverInfo = init?.serverInfo;
      // The spec's second half of the handshake: a notification, no id.
      this.notify(live, 'notifications/initialized', {});
      const listed = (await this.request(live, 'tools/list', {}, budget)) as { tools?: McpToolInfo[] } | undefined;
      state.tools = Array.isArray(listed?.tools)
        ? listed!.tools.map((t) => ({ name: String(t.name), description: t.description ?? '', inputSchema: t.inputSchema }))
        : [];
      state.status = 'ready';
      state.error = '';
      this.logger?.info('MCP server connected', { id, tools: state.tools.length });
      return state;
    } catch (err) {
      this.fail(live, (err as Error).message);
      throw new Error(state.error);
    }
  }

  /** Stop one server and forget its tools. */
  async disconnect(id: string): Promise<void> {
    const live = this.live.get(id);
    if (live) this.stop(live, 'disconnected');
    const cfg = this.config[id];
    this.states.set(id, {
      id,
      command: cfg?.command ?? '',
      args: Array.isArray(cfg?.args) ? cfg!.args!.map(String) : [],
      description: cfg?.description ?? '',
      status: cfg?.disabled ? 'disabled' : 'idle',
      error: '',
      tools: [],
    });
  }

  /** Call one tool. Connects first when needed, so the UI has a single click. */
  async callTool(id: string, tool: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    let live = this.live.get(id);
    if (!live || live.state.status !== 'ready') {
      await this.connect(id);
      live = this.live.get(id);
    }
    if (!live) throw new Error(`"${id}" is not connected`);
    return this.request(
      live,
      'tools/call',
      { name: tool, arguments: args },
      this.callTimeout(this.config[id], timeoutMs),
    );
  }

  /** Handshake budget for one server: its own `timeoutMs`, else the default. */
  private handshakeTimeout(cfg?: McpServerConfig): number {
    return boundedMcpTimeout(cfg?.timeoutMs) ?? this.timeoutMs;
  }

  /**
   * Budget for one `tools/call`.
   *
   * Precedence: the caller's explicit value, then the server's configured one,
   * then the historical 30s. A tool that legitimately runs long belongs in the
   * config, not in every call site.
   */
  private callTimeout(cfg?: McpServerConfig, override?: number): number {
    return boundedMcpTimeout(override) ?? boundedMcpTimeout(cfg?.timeoutMs) ?? 30_000;
  }

  /** Kill every child. Called from the server's shutdown path. */
  async close(): Promise<void> {
    for (const live of this.live.values()) this.stop(live, 'shutdown');
    this.live.clear();
  }

  // ---------------- internals ----------------

  /** Rebuild the state map from config, keeping live entries untouched. */
  private syncStates(): void {
    for (const [id, cfg] of Object.entries(this.config)) {
      if (this.live.has(id)) continue;
      const prev = this.states.get(id);
      if (prev && (prev.status === 'ready' || prev.status === 'connecting')) continue;
      this.states.set(id, {
        id,
        command: cfg.command ?? '',
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        description: cfg.description ?? '',
        status: cfg.disabled ? 'disabled' : 'idle',
        error: '',
        tools: [],
      });
    }
    for (const id of [...this.states.keys()]) {
      if (!this.config[id] && !this.live.has(id)) this.states.delete(id);
    }
  }

  private onLine(live: LiveServer, line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return; // a server that writes banners on stdout is broken; ignore the noise
    }
    if (typeof msg.id !== 'number') return; // notifications/requests from the server
    const pending = live.pending.get(msg.id);
    if (!pending) return;
    live.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(msg.error.message || 'MCP error'));
    else pending.resolve(msg.result);
  }

  private request(live: LiveServer, method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const id = live.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        live.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      live.pending.set(id, { resolve, reject, timer });
      try {
        live.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        live.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`write failed: ${(err as Error).message}`));
      }
    });
  }

  private notify(live: LiveServer, method: string, params: unknown): void {
    try {
      live.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      /* pipe gone; the exit handler reports it */
    }
  }

  private fail(live: LiveServer, message: string): void {
    live.state.status = 'error';
    live.state.error = message;
    live.state.tools = [];
    for (const [, pending] of live.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    live.pending.clear();
    this.logger?.warn('MCP server failed', { id: live.state.id, error: message });
  }

  private stop(live: LiveServer, reason: string): void {
    live.state.status = 'idle';
    live.state.tools = [];
    live.state.error = '';
    for (const [, pending] of live.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    live.pending.clear();
    try {
      live.reader.close();
    } catch {
      /* already closed */
    }
    try {
      live.child.kill();
    } catch {
      /* already gone */
    }
    this.live.delete(live.state.id);
  }
}
