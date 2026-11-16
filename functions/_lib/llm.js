// Shared LLM call for /api/extract, /api/price-estimate, /api/seller-message
// and /api/model-notes. The API key comes from the environment and never
// leaves the server.
//
//   LLM_PROVIDER         'gemini' (default) | 'anthropic'
//   GEMINI_API_KEY
//   GEMINI_MODEL_VISION  screenshots (default gemini-3.6-flash; GEMINI_MODEL still works as a legacy override)
//   GEMINI_MODEL_TEXT    price estimate, seller message, model notes (default gemini-3.5-flash-lite)
//   ANTHROPIC_API_KEY / ANTHROPIC_MODEL
//
// Quota handling: if the vision model answers 429 (rate/quota) or 503
// (overloaded), the request is retried once on the text model, which also
// reads images. If that fails too — or a text task hits 429/503 — the call
// throws LlmQuotaError, which endpoints turn into a short friendly message.
import { PROVIDERS, parseGeminiResponse, parseAnthropicResponse } from '../../public/extraction.js';
import { json } from './cars.js';

const TIMEOUT = 90_000;
export const QUOTA_STATUSES = new Set([429, 503]);

export class LlmConfigError extends Error {}
export class LlmQuotaError extends Error {}

class UpstreamError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Returns { provider, keyName } or throws LlmConfigError. */
export function llmConfig(env) {
  const provider = (env.LLM_PROVIDER || 'gemini').toLowerCase();
  if (!PROVIDERS[provider]) throw new LlmConfigError(`Unknown LLM_PROVIDER "${provider}"`);
  const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!env[keyName]) throw new LlmConfigError(`${keyName} is not configured`);
  return { provider, keyName };
}

/** The Gemini model for each task. */
export function geminiModels(env) {
  return {
    vision: env.GEMINI_MODEL_VISION || env.GEMINI_MODEL || PROVIDERS.gemini.visionModel,
    text: env.GEMINI_MODEL_TEXT || PROVIDERS.gemini.textModel,
  };
}

async function upstreamError(res, name) {
  let detail = '';
  try {
    const b = await res.json();
    detail = b?.error?.message || b?.error?.type || '';
  } catch { /* not JSON */ }
  return new UpstreamError(`${name} API error (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ''}`, res.status);
}

async function callGemini(env, model, body) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw await upstreamError(res, 'Gemini');
  return parseGeminiResponse(await res.json());
}

const isQuota = (e) => QUOTA_STATUSES.has(e?.status);

/**
 * build: { gemini: () => body, anthropic: (model) => body }
 * opts.task: 'vision' (screenshots) | 'text' (everything else)
 * Returns { provider, model, raw, retried }.
 */
export async function callLLM(env, build, { task = 'text' } = {}) {
  const { provider } = llmConfig(env);
  if (provider === 'gemini') {
    const models = geminiModels(env);
    const primary = task === 'vision' ? models.vision : models.text;
    const body = build.gemini();
    try {
      return { provider, model: primary, raw: await callGemini(env, primary, body), retried: false };
    } catch (e) {
      if (task === 'vision' && isQuota(e) && models.text !== primary) {
        try {
          return { provider, model: models.text, raw: await callGemini(env, models.text, body), retried: true };
        } catch (e2) {
          throw new LlmQuotaError(`Vision model ${e.status}, text model failed too: ${e2.message}`);
        }
      }
      if (isQuota(e)) throw new LlmQuotaError(e.message);
      throw e;
    }
  }
  const model = env.ANTHROPIC_MODEL || PROVIDERS.anthropic.defaultModel;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(build.anthropic(model)),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const err = await upstreamError(res, 'Anthropic');
    if (isQuota(err) || res.status === 529) throw new LlmQuotaError(err.message);
    throw err;
  }
  return { provider, model, raw: parseAnthropicResponse(await res.json()), retried: false };
}

export const llmErrorMessage = (e) => (e.name === 'TimeoutError' ? 'The LLM took too long to respond' : String(e.message || e));

/**
 * The response for a failed LLM call. Quota/overload → 429 { error: 'ai_limit' }
 * (the app shows a friendly, translated message); anything else → 502 with detail.
 */
export function llmErrorResponse(e) {
  if (e instanceof LlmQuotaError) return json({ error: 'ai_limit' }, 429);
  return json({ error: llmErrorMessage(e) }, 502);
}
