/**
 * The AI Assistant, engine side.
 *
 * One request at a time per client: the panel streams one answer, so a second
 * `aiAsk` before the first `aiDone` is refused instead of being interleaved. The
 * abort handle lives on the connection (`ConnState.aiAbort`), so closing the
 * window or pressing Stop releases the socket exactly like a cancelled run.
 *
 * The prompt is never logged. Neither is the answer and neither is the key: the
 * log line carries `{requestId, ms, bytes, ok}` and nothing else. The log is
 * persisted and full-text searchable, so a prompt written into it would be a
 * data leak that survives restart.
 */
import { join } from 'node:path';
import { appDataPath } from '../../util/appData.js';
import {
  AI_MAX_PROMPT_CHARS,
  buildChatRequest,
  configView,
  normalizeBaseUrl,
  normalizeModel,
  readAiSettings,
  streamChat,
  writeAiSettings,
  type AiSettings,
} from '../../net/ai.js';
import { stateFor } from '../conn-state.js';

export interface AiDeps {
  reply: (payload: unknown) => void;
  log: (level: 'info' | 'warn', message: string, fields?: Record<string, unknown>) => void;
}

function configPath(): string {
  return join(appDataPath(), 'ai.json');
}

/** Answer with the client-facing configuration (never the key). */
export function handleAiConfig(deps: AiDeps): void {
  deps.reply({ kind: 'aiConfig', ...configView(readAiSettings(configPath())) });
}

/**
 * `aiSetConfig {baseUrl, model, key?}`: validate, persist, answer with the view.
 *
 * `key: ''` clears a stored key; an absent `key` keeps the current one. The reply
 * never contains the key, only `hasKey`, so the client cannot re-read what it
 * wrote.
 */
export function handleAiSetConfig(deps: AiDeps, msg: Record<string, unknown>): void {
  const path = configPath();
  const current = readAiSettings(path);
  const baseUrl = normalizeBaseUrl(msg.baseUrl);
  const model = normalizeModel(msg.model);
  if (!baseUrl) {
    deps.reply({ kind: 'aiConfig', ...configView(current), error: 'baseUrl must be an http(s) URL without credentials' });
    return;
  }
  if (!model) {
    deps.reply({ kind: 'aiConfig', ...configView(current), error: 'model is required (letters, digits, . _ : @ / -)' });
    return;
  }
  const next: AiSettings = { baseUrl, model };
  const rawKey = msg.key;
  if (typeof rawKey === 'string') {
    const key = rawKey.trim();
    if (key.length > 4000) {
      deps.reply({ kind: 'aiConfig', ...configView(current), error: 'the key is too long' });
      return;
    }
    if (key) next.key = key;
  } else if (current.key) {
    next.key = current.key;
  }
  writeAiSettings(path, next);
  deps.log('info', 'ai: configuration saved', { baseUrl, model, hasKey: !!next.key });
  deps.reply({ kind: 'aiConfig', ...configView(next) });
}

/** `aiAsk {requestId, prompt, language?}`: stream one answer as `aiOut` frames. */
export async function handleAiAsk(client: object, deps: AiDeps, msg: Record<string, unknown>): Promise<void> {
  const rawId = Number(msg.requestId);
  const requestId = Number.isFinite(rawId) ? rawId : 0;
  const prompt = typeof msg.prompt === 'string' ? msg.prompt.trim() : '';
  if (!prompt) {
    deps.reply({ kind: 'aiDone', requestId, ok: false, error: 'the prompt is empty' });
    return;
  }
  if (prompt.length > AI_MAX_PROMPT_CHARS) {
    deps.reply({ kind: 'aiDone', requestId, ok: false, error: `the prompt is longer than ${AI_MAX_PROMPT_CHARS} characters` });
    return;
  }
  const settings = readAiSettings(configPath());
  if (!settings.baseUrl) {
    deps.reply({
      kind: 'aiDone', requestId, ok: false,
      error: 'no AI provider is configured — set a base URL and model in the AI panel first',
    });
    return;
  }
  const state = stateFor(client);
  if (state.aiAbort) {
    deps.reply({ kind: 'aiDone', requestId, ok: false, error: 'an answer is already streaming — wait for it or press Stop' });
    return;
  }
  const abort = new AbortController();
  state.aiAbort = abort;
  const request = buildChatRequest(settings, prompt, {
    language: typeof msg.language === 'string' && msg.language ? msg.language : undefined,
  });
  const started = Date.now();
  let bytes = 0;
  const result = await streamChat({
    url: request.url,
    headers: request.headers,
    body: request.body,
    signal: abort.signal,
    onDelta: (text) => {
      bytes += text.length;
      deps.reply({ kind: 'aiOut', requestId, text });
    },
  });
  if (state.aiAbort === abort) state.aiAbort = undefined;
  // Log the shape of the exchange, never its content.
  deps.log(result.ok ? 'info' : 'warn', 'ai: answer finished', {
    requestId, ms: Date.now() - started, bytes, ok: result.ok, status: result.status,
  });
  deps.reply({
    kind: 'aiDone',
    requestId,
    ok: result.ok,
    ms: Date.now() - started,
    bytes,
    ...(result.ok ? {} : { error: result.error ?? 'the provider returned nothing' }),
  });
}

/** `aiCancel {requestId}`: stop the stream and say whether anything was running. */
export function handleAiCancel(client: object, deps: AiDeps, msg: Record<string, unknown>): void {
  const rawId = Number(msg.requestId);
  const requestId = Number.isFinite(rawId) ? rawId : 0;
  const state = stateFor(client);
  const running = !!state.aiAbort;
  if (state.aiAbort) {
    state.aiAbort.abort();
    state.aiAbort = undefined;
  }
  deps.reply({ kind: 'aiCancelled', requestId, ok: running });
}
