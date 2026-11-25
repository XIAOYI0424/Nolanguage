/**
 * A minimal OpenAI-compatible chat client, for the AI Assistant panel.
 *
 * Scope is deliberately one request at a time and one protocol:
 *
 *   POST <baseUrl>/chat/completions
 *   Authorization: Bearer <key>
 *   { model, messages: [{role:'user', content}], stream: true }
 *
 * The reply is read as server-sent events and only `choices[0].delta.content`
 * is forwarded. Nothing here knows about the panel; the handler owns sockets and
 * the UI. That split is what lets a test drive this against a loopback server.
 *
 * Safety rules that are not negotiable:
 *
 *  - The key never leaves this process. It is stored in `<appData>/ai.json`
 *    (mode 0600 where the platform allows it) and is never echoed to the client:
 *    the config frame carries `hasKey`, not the key.
 *  - Error text never contains request headers, so a stack trace or a log line
 *    cannot leak the key. Only the HTTP status is reported.
 *  - The response body is capped; a provider that streams forever cannot grow
 *    the panel without bound.
 */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync, renameSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

/** What the client is allowed to see about the configuration. */
export interface AiConfigView {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

/** The full configuration, including the key. Engine-side only. */
export interface AiSettings {
  baseUrl: string;
  model: string;
  key?: string;
}

export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_AI_MODEL = 'gpt-4o-mini';
/** Hard cap on one answer; the panel stops appending past this. */
export const AI_MAX_RESPONSE_BYTES = 1024 * 1024;
export const AI_MAX_PROMPT_CHARS = 8000;
export const AI_TIMEOUT_MS = 60000;

/**
 * Normalise a user-supplied base URL, or return undefined when it cannot be one.
 *
 * Only http(s) is accepted: a `file:` URL here would make the "AI provider" read
 * local files, and credentials embedded in the URL are refused so the key has
 * exactly one home.
 */
export function normalizeBaseUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text || text.length > 500) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password) return undefined;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Reject a model name that could not be sent as a JSON string field cleanly. */
export function normalizeModel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text || text.length > 120) return undefined;
  if (!/^[\w.:@/-]+$/.test(text)) return undefined;
  return text;
}

/** The exact HTTP request one prompt turns into. Pure, so a test can inspect it. */
export function buildChatRequest(
  cfg: AiSettings,
  prompt: string,
  opts: { language?: string; maxTokens?: number } = {},
): { url: string; headers: Record<string, string>; body: string } {
  const base = normalizeBaseUrl(cfg.baseUrl) ?? DEFAULT_AI_BASE_URL;
  const content = opts.language
    ? `The user is editing a ${opts.language} file.\n\n${prompt}`
    : prompt;
  const body = JSON.stringify({
    model: normalizeModel(cfg.model) ?? DEFAULT_AI_MODEL,
    stream: true,
    max_tokens: Math.max(1, Math.min(4096, opts.maxTokens ?? 2048)),
    messages: [{ role: 'user', content }],
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
  return { url: `${base}/chat/completions`, headers, body };
}

/**
 * Incremental server-sent-events reader.
 *
 * `push` takes whatever the socket delivered (which may split a line anywhere)
 * and returns the text deltas it completed, plus whether the provider said
 * `[DONE]`. Malformed JSON is reported as an error rather than thrown: one bad
 * line should end the answer with a message, not swallow it.
 */
export class SseDecoder {
  private buffer = '';
  done = false;
  error: string | undefined;
  bytes = 0;

  constructor(private readonly maxBytes = AI_MAX_RESPONSE_BYTES) {}

  push(chunk: string): string[] {
    if (this.done) return [];
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      this.error = 'the answer is larger than the panel accepts (1 MB)';
      this.done = true;
      return [];
    }
    this.buffer += chunk;
    const out: string[] = [];
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      const delta = this.consumeLine(line);
      if (delta) out.push(delta);
      if (this.done) break;
      index = this.buffer.indexOf('\n');
    }
    return out;
  }

  private consumeLine(line: string): string | undefined {
    if (!line.startsWith('data:')) return undefined;
    const payload = line.slice(5).trim();
    if (!payload) return undefined;
    if (payload === '[DONE]') {
      this.done = true;
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.error = 'the provider sent a line that is not JSON';
      this.done = true;
      return undefined;
    }
    const frame = parsed as {
      error?: { message?: unknown };
      choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
    };
    if (frame.error) {
      this.error = typeof frame.error.message === 'string' ? frame.error.message.slice(0, 300) : 'the provider returned an error';
      this.done = true;
      return undefined;
    }
    const choice = frame.choices?.[0];
    const text = choice?.delta?.content ?? choice?.message?.content;
    return typeof text === 'string' && text ? text : undefined;
  }
}

export interface StreamResult {
  ok: boolean;
  status: number;
  bytes: number;
  error?: string;
}

/**
 * POST one chat request and stream the deltas out through `onDelta`.
 *
 * Resolves (never rejects) once the response ends, the timeout fires, or the
 * caller aborts; the panel needs one `aiDone` either way.
 */
export function streamChat(opts: {
  url: string;
  headers: Record<string, string>;
  body: string;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<StreamResult> {
  const timeoutMs = opts.timeoutMs ?? AI_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let bytes = 0;
    const decoder = new SseDecoder();
    const finish = (result: StreamResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const protocol = opts.url.startsWith('https:') ? httpsRequest : httpRequest;
    let req: ReturnType<typeof httpsRequest>;
    try {
      req = protocol(opts.url, { method: 'POST', headers: opts.headers }, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          // Drain a bounded amount so the socket can close, but do not surface
          // the body: it is the provider's text, and the panel only needs status.
          let seen = 0;
          res.on('data', (d: Buffer) => { seen += d.length; if (seen > 4096) res.destroy(); });
          res.on('error', () => {});
          res.on('close', () => finish({ ok: false, status, bytes, error: `provider returned HTTP ${status}` }));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          bytes += chunk.length;
          for (const delta of decoder.push(chunk)) opts.onDelta(delta);
          if (decoder.done) {
            res.destroy();
            finish({ ok: !decoder.error, status, bytes, error: decoder.error });
          }
        });
        res.on('end', () => finish({ ok: !decoder.error, status, bytes, error: decoder.error }));
        res.on('error', (err: Error) => finish({ ok: false, status, bytes, error: err.message }));
      });
    } catch (err) {
      finish({ ok: false, status: 0, bytes: 0, error: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, status: 0, bytes, error: `the provider did not answer within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    const abort = (): void => {
      req.destroy();
      finish({ ok: false, status: 0, bytes, error: 'cancelled' });
    };
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener('abort', abort, { once: true });
    }
    req.on('error', (err: Error) => finish({ ok: false, status: 0, bytes, error: err.message }));
    req.end(opts.body);
  });
}

/** Read `<appData>/ai.json`. A missing or broken file is "not configured". */
export function readAiSettings(path: string): AiSettings {
  if (!existsSync(path)) return { baseUrl: '', model: '' };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      key: typeof raw.key === 'string' && raw.key ? raw.key : undefined,
    };
  } catch {
    return { baseUrl: '', model: '' };
  }
}

/** Write `<appData>/ai.json` atomically, with the narrowest permissions we can. */
export function writeAiSettings(path: string, settings: AiSettings): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows ignores POSIX modes; the file is still user-scoped */
  }
}

/** The client-facing projection: configured, but never the key itself. */
export function configView(settings: AiSettings): AiConfigView {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasKey: !!settings.key,
  };
}
