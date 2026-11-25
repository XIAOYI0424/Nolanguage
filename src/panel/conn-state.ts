/**
 * Per-connection interactive-execution state.
 *
 * Keyed by the live connection object: an attached terminal child, the active
 * run's stdin sink, and the debug session with the thread it last stopped on.
 * It lives on its own because both `server.ts` (the message switch, the close
 * handler) and `handlers/run.ts` (the run/debug handlers) need it — putting it
 * in either one would make the other import it back.
 */
import type { ChildProcess } from 'node:child_process';
import type { DapClient } from '../dap/DapClient.js';
import { FsService } from './FsService.js';

export interface ConnState {
  /**
   * This connection's project explorer. `openFolder` repoints only this
   * instance, so two IDE windows can work in different projects without one
   * window's File > Open Folder silently moving the other one's file tree.
   */
  projectFs?: FsService;
  runSink?: (d: string) => void;
  termChild?: ChildProcess;
  /**
   * The package installer this connection started, if any.
   *
   * Separate from `termChild`: the terminal is attached and interactive, while
   * an install is a one-shot with no stdin, and the Packages view must be able
   * to cancel it without disturbing whatever the terminal is running.
   */
  installChild?: ChildProcess;
  dap?: DapClient;
  /**
   * Thread the adapter last reported as stopped. Continue / step / pause must
   * name the same thread, or an adapter with more than one thread answers
   * "notStopped" and the toolbar silently does nothing.
   */
  dapThreadId?: number;
  /**
   * The test run this connection started.
   *
   * A test run is a normal `workspace.run` with `mode: 'test'`, so it already
   * has a cancellation path through the workspace's per-session controller —
   * but the Tests view's Stop must not also stop a Run the user launched, and
   * the run button's Stop must not silently kill a test run. The controller is
   * that separation: the handler aborts exactly the run it started.
   */
  testAbort?: AbortController;
  /**
   * The AI answer streaming to this connection, if any.
   *
   * One answer at a time: the panel renders a single transcript, and a second
   * request would interleave two providers' tokens into it. Stop and window
   * close both abort through this handle, which destroys the HTTP socket.
   */
  aiAbort?: AbortController;
}

const connState = new Map<unknown, ConnState>();

export function stateFor(conn: unknown): ConnState {
  let s = connState.get(conn);
  if (!s) { s = {}; connState.set(conn, s); }
  return s;
}

/**
 * Get (or create) this connection's project explorer. New windows inherit the
 * most recently opened folder, supplied by the caller as a getter so it is
 * read only when a connection is first seen.
 */
export function projectFsFor(conn: object, initialRoot: () => string): FsService {
  const s = stateFor(conn);
  if (!s.projectFs) s.projectFs = new FsService(initialRoot());
  return s.projectFs;
}

/** Read the state without creating an entry (for read-only handlers). */
export function peekConnection(conn: unknown): ConnState | undefined {
  return connState.get(conn);
}

/** Drop the debug session but keep the terminal/sink, e.g. after `stop`. */
export function dropDap(conn: unknown): void {
  const s = connState.get(conn);
  if (s) { s.dap = undefined; s.dapThreadId = undefined; }
}

/**
 * Remove a connection and hand back what it was holding.
 *
 * The close handler needs the state to kill the terminal and stop the adapter,
 * but must not leave the entry behind — a stale entry would keep a dead
 * `ChildProcess` (and its pid) alive for the life of the server.
 */
export function takeConnection(conn: unknown): ConnState | undefined {
  const s = connState.get(conn);
  if (s) connState.delete(conn);
  return s;
}
