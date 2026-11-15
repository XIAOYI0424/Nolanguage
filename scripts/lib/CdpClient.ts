/**
 * Minimal Chrome DevTools Protocol client.
 *
 * # Why not a dependency
 *
 * The project has zero runtime dependencies and the verification suites keep it
 * that way. Node 22 ships a global `WebSocket`, and CDP is plain JSON over one
 * socket, so the whole client is a promise map and a `send`.
 *
 * # Why this exists at all
 *
 * `verify-ui-dom` runs the client shards in jsdom, and jsdom is not the browser:
 * `initCodeMirror()` explicitly bails when it sees a jsdom user agent, so that
 * suite exercises the textarea fallback. Everything that matters for an editor -
 * CodeMirror owning the document, real focus, real key dispatch - is invisible
 * there. This client drives a real Blink instance instead.
 */

export interface CdpTarget {
  url: string;
  webSocketDebuggerUrl: string;
}

export class CdpClient {
  private seq = 0;
  private pending = new Map<number, (v: unknown) => void>();
  private ws: WebSocket;
  readonly ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error(`CDP socket failed: ${url}`)));
    });
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { id?: number; result?: unknown };
      try {
        msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown };
      } catch {
        return;
      }
      if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
    });
  }

  /** Raw protocol call. Resolves with the whole reply so callers can read errors. */
  send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: Record<string, unknown>; error?: { message?: string } }> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (v: unknown) => void);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * Returns `{ error }` instead of throwing so a failing assertion can report
   * what the page said rather than aborting the suite.
   */
  async eval(expression: string): Promise<{ value?: unknown; error?: string }> {
    const reply = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const r = reply.result as
      | { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
      | undefined;
    if (r?.exceptionDetails) {
      return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed' };
    }
    return { value: r?.result?.value };
  }

  /** Press and release a key the way a user does (browser-level input). */
  async press(key: string, code: string, virtualKey: number, modifiers = 0): Promise<void> {
    const base = { key, code, windowsVirtualKeyCode: virtualKey, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** CDP modifier bits, as `Input.dispatchKeyEvent` expects them. */
export const MOD = { none: 0, alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/** Poll the DevTools HTTP endpoint until the page target shows up. */
export async function findTarget(port: number, urlPrefix: string, timeoutMs: number): Promise<CdpTarget | undefined> {
  const t0 = Date.now();
  for (;;) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as CdpTarget[];
      const hit = list.find((t) => t.url.startsWith(urlPrefix));
      if (hit) return hit;
    } catch {
      /* endpoint not up yet */
    }
    if (Date.now() - t0 > timeoutMs) return undefined;
    await new Promise((r) => setTimeout(r, 250));
  }
}
