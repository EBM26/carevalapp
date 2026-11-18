// POST /api/parse-reply — body: { text?, files?: [{ mimeType, data(base64) }], sent?: string, asked?: string[] }
// Reads the seller's reply (pasted text and/or screenshots/PDFs) and returns
// the answers mapped to car fields: { fields, dealBreakers, notes }. Nothing
// is stored; the app shows a preview and applies it on confirmation.
// Text only → the text model; with files → the vision model (same quota fallback as /api/extract).
import { validateImages } from '../../public/extraction.js';
import { replyPrompt, buildGeminiReplyRequest, buildAnthropicReplyRequest, normalizeReply, validateReplyBody } from '../../public/reply.js';
import { json, error, readJson } from '../_lib/cars.js';
import { callLLM, llmConfig, LlmConfigError, llmErrorResponse } from '../_lib/llm.js';

const ASKABLE = new Set(['plate', 'insuranceClaims', 'serviceHistory', 'testExpiry', 'originalOwnership', 'trim', 'handCount']);

export async function onRequestPost({ request, env }) {
  try { llmConfig(env); } catch (e) {
    if (e instanceof LlmConfigError) return error(500, e.message);
    throw e;
  }
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return error(400, 'Expected a JSON body');
  const bad = validateReplyBody(body) || validateImages(body.files?.length ? body.files : undefined, { optional: true });
  if (bad) return error(400, bad);

  const files = Array.isArray(body.files) ? body.files : [];
  const asked = Array.isArray(body.asked) ? body.asked.filter((f) => ASKABLE.has(f)) : [];
  const prompt = replyPrompt({ sent: typeof body.sent === 'string' ? body.sent : '', asked, text: body.text, hasFiles: files.length > 0 });
  try {
    const { provider, model, raw } = await callLLM(env, {
      gemini: () => buildGeminiReplyRequest(prompt, files),
      anthropic: (m) => buildAnthropicReplyRequest(prompt, files, m),
    }, { task: files.length ? 'vision' : 'text' });
    return json({ provider, model, ...normalizeReply(raw) });
  } catch (e) {
    return llmErrorResponse(e);
  }
}
