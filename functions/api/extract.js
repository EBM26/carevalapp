// POST /api/extract — body: { images: [{ mimeType, data(base64) }] }
// Calls the configured LLM with the server-side key and returns cleaned
// fields for the user to review. Screenshots are not stored anywhere.
// Provider configuration: see functions/_lib/llm.js.
import { validateImages, normalizeExtraction, buildGeminiRequest, buildAnthropicRequest } from '../../public/extraction.js';
import { json, error, readJson } from '../_lib/cars.js';
import { callLLM, llmConfig, LlmConfigError, llmErrorResponse } from '../_lib/llm.js';

export async function onRequestPost({ request, env }) {
  try { llmConfig(env); } catch (e) {
    if (e instanceof LlmConfigError) return error(500, e.message);
    throw e;
  }

  const body = await readJson(request);
  const bad = validateImages(body?.images);
  if (bad) return error(400, bad);

  try {
    const { provider, model, raw } = await callLLM(env, {
      gemini: () => buildGeminiRequest(body.images),
      anthropic: (m) => buildAnthropicRequest(body.images, m),
    }, { task: 'vision' });
    return json({ provider, model, fields: normalizeExtraction(raw) });
  } catch (e) {
    return llmErrorResponse(e);
  }
}
