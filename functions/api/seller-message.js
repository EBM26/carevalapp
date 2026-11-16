// POST /api/seller-message — body: { car, lang?: 'he'|'en', reasons?: string[] }
// Writes a short, natural WhatsApp message to the seller: greeting + at most
// 6 questions (plate first if missing, then the missing details, then 1–2
// car-specific questions). The client falls back to the old template if this
// fails. Nothing is stored.
import { sanitizeCar } from '../../public/fields.js';
import { sellerPrompt, buildGeminiMessageRequest, buildAnthropicMessageRequest, normalizeMessage } from '../../public/sellermsg.js';
import { json, error, readJson } from '../_lib/cars.js';
import { callLLM, llmConfig, LlmConfigError, llmErrorMessage } from '../_lib/llm.js';

export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || !body.car || typeof body.car !== 'object') return error(400, 'Expected { car }');
  try { llmConfig(env); } catch (e) {
    if (e instanceof LlmConfigError) return error(500, e.message);
    throw e;
  }
  const car = sanitizeCar(body.car);
  const lang = body.lang === 'en' ? 'en' : 'he';
  const reasons = Array.isArray(body.reasons)
    ? body.reasons.filter((r) => typeof r === 'string').map((r) => r.slice(0, 100)).slice(0, 6)
    : [];
  try {
    const prompt = sellerPrompt(car, { lang, reasons });
    const { raw } = await callLLM(env, {
      gemini: () => buildGeminiMessageRequest(prompt),
      anthropic: (m) => buildAnthropicMessageRequest(prompt, m),
    });
    const message = normalizeMessage(raw);
    if (!message) return error(502, 'The LLM returned an empty message');
    return json({ message, lang });
  } catch (e) {
    return error(502, llmErrorMessage(e));
  }
}
