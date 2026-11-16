// POST /api/extract — body: { images: [{ mimeType, data(base64) }] }
// Calls the configured LLM with the server-side key and returns cleaned
// fields for the user to review. Screenshots are not stored anywhere.
//
// Environment (Pages settings / .dev.vars):
//   LLM_PROVIDER      'gemini' (default) | 'anthropic'
//   GEMINI_API_KEY    secret, when provider = gemini
//   GEMINI_MODEL      optional override (default in public/extraction.js)
//   ANTHROPIC_API_KEY secret, when provider = anthropic
//   ANTHROPIC_MODEL   optional override
import {
  PROVIDERS, validateImages, normalizeExtraction,
  buildGeminiRequest, parseGeminiResponse, buildAnthropicRequest, parseAnthropicResponse,
} from '../../public/extraction.js';
import { json, error, readJson } from '../_lib/cars.js';

const TIMEOUT = 90_000;

async function upstreamError(res, name) {
  let detail = '';
  try {
    const b = await res.json();
    detail = b?.error?.message || b?.error?.type || '';
  } catch { /* not JSON */ }
  return `${name} API error (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ''}`;
}

async function callGemini(env, images) {
  const model = env.GEMINI_MODEL || PROVIDERS.gemini.defaultModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(buildGeminiRequest(images)),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(await upstreamError(res, 'Gemini'));
  return { model, raw: parseGeminiResponse(await res.json()) };
}

async function callAnthropic(env, images) {
  const model = env.ANTHROPIC_MODEL || PROVIDERS.anthropic.defaultModel;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(buildAnthropicRequest(images, model)),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(await upstreamError(res, 'Anthropic'));
  return { model, raw: parseAnthropicResponse(await res.json()) };
}

export async function onRequestPost({ request, env }) {
  const provider = (env.LLM_PROVIDER || 'gemini').toLowerCase();
  if (!PROVIDERS[provider]) return error(500, `Unknown LLM_PROVIDER "${provider}"`);
  const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!env[keyName]) return error(500, `${keyName} is not configured`);

  const body = await readJson(request);
  const bad = validateImages(body?.images);
  if (bad) return error(400, bad);

  try {
    const { model, raw } = provider === 'gemini'
      ? await callGemini(env, body.images)
      : await callAnthropic(env, body.images);
    return json({ provider, model, fields: normalizeExtraction(raw) });
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'The LLM took too long to respond' : String(e.message || e);
    return error(502, msg);
  }
}
