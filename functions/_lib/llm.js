// Shared LLM call for /api/extract and /api/model-notes. The API key comes
// from the environment and never leaves the server.
//
//   LLM_PROVIDER      'gemini' (default) | 'anthropic'
//   GEMINI_API_KEY / GEMINI_MODEL, ANTHROPIC_API_KEY / ANTHROPIC_MODEL
import { PROVIDERS, parseGeminiResponse, parseAnthropicResponse } from '../../public/extraction.js';

const TIMEOUT = 90_000;

export class LlmConfigError extends Error {}

/** Returns { provider, keyName } or throws LlmConfigError. */
export function llmConfig(env) {
  const provider = (env.LLM_PROVIDER || 'gemini').toLowerCase();
  if (!PROVIDERS[provider]) throw new LlmConfigError(`Unknown LLM_PROVIDER "${provider}"`);
  const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!env[keyName]) throw new LlmConfigError(`${keyName} is not configured`);
  return { provider, keyName };
}

async function upstreamError(res, name) {
  let detail = '';
  try {
    const b = await res.json();
    detail = b?.error?.message || b?.error?.type || '';
  } catch { /* not JSON */ }
  return `${name} API error (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ''}`;
}

/**
 * build: { gemini: () => body, anthropic: (model) => body }
 * Returns { provider, model, raw } where raw is the parsed JSON / tool input.
 */
export async function callLLM(env, build) {
  const { provider } = llmConfig(env);
  if (provider === 'gemini') {
    const model = env.GEMINI_MODEL || PROVIDERS.gemini.defaultModel;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(build.gemini()),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(await upstreamError(res, 'Gemini'));
    return { provider, model, raw: parseGeminiResponse(await res.json()) };
  }
  const model = env.ANTHROPIC_MODEL || PROVIDERS.anthropic.defaultModel;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(build.anthropic(model)),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(await upstreamError(res, 'Anthropic'));
  return { provider, model, raw: parseAnthropicResponse(await res.json()) };
}

export const llmErrorMessage = (e) => (e.name === 'TimeoutError' ? 'The LLM took too long to respond' : String(e.message || e));
