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

export interface ConnState {
  runSink?: (d: string) => void;
  termChild?: ChildProcess;
  dap?: DapClient;
  /**
   * Thread the adapter last reported as stopped. Continue / step / pause must
   * name the same thread, or an adapter with more than one thread answers
   * "notStopped" and the toolbar silently does nothing.
   */
  dapThreadId?: number;
}

const connState = new Map<unknown, ConnState>();

export function stateFor(conn: unknown): ConnState {
  let s = connState.get(conn);
  if (!s) { s = {}; connState.set(conn, s); }
  return s;
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
