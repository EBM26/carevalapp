// POST /api/price-estimate — body: { make, model, trim?, year, km?, ownership?, id?, estimate? }
// A rough AI estimate of the typical Israeli private-sale price range, used by
// the quick check when there are fewer than 3 comparable saved cars.
// Cached per car in cars.price_estimate, keyed by make/model/year/km, so it's
// only fetched again when one of those changes.
//
//   id        a saved car: use/fill its cache
//   estimate  { low, high } already fetched for an unsaved car: store it once
//             the car has an id, without a new LLM call
import { cleanValue } from '../../public/fields.js';
import { estimateKey } from '../../public/quickcheck.js';
import { estimatePrompt, buildGeminiEstimateRequest, buildAnthropicEstimateRequest, normalizeEstimate } from '../../public/priceestimate.js';
import { ENUMS } from '../../public/scoring.js';
import { json, error, readJson, ID_RE } from '../_lib/cars.js';
import { callLLM, llmConfig, LlmConfigError, llmErrorResponse } from '../_lib/llm.js';

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return error(400, 'Expected a JSON object');
  const car = {
    make: cleanValue('text', body.make, 60),
    model: cleanValue('text', body.model, 60),
    trim: cleanValue('text', body.trim, 60),
    year: cleanValue('int', body.year),
    km: cleanValue('int', body.km),
    ownership: cleanValue('enum', body.ownership, ENUMS.ownershipType),
  };
  const key = estimateKey({ make: car.make, model: car.model, year: car.year, currentKm: car.km });
  if (!key) return error(400, 'Make, model and year are required');
  const id = typeof body.id === 'string' && ID_RE.test(body.id) ? body.id : null;

  let cacheAvailable = Boolean(id);
  if (id) {
    try {
      const row = await env.DB.prepare('SELECT price_estimate FROM cars WHERE id = ?').bind(id).first();
      const cached = parse(row?.price_estimate);
      if (cached?.key === key) return json({ key, low: cached.low, high: cached.high, cached: true });
    } catch {
      cacheAvailable = false; // column missing (migration not applied): work uncached
    }
  }

  let range;
  if (body.estimate && typeof body.estimate === 'object') {
    range = normalizeEstimate(body.estimate);
  } else {
    try { llmConfig(env); } catch (e) {
      if (e instanceof LlmConfigError) return error(500, e.message);
      throw e;
    }
    try {
      const prompt = estimatePrompt(car);
      const { raw } = await callLLM(env, {
        gemini: () => buildGeminiEstimateRequest(prompt),
        anthropic: (m) => buildAnthropicEstimateRequest(prompt, m),
      }, { task: 'text' });
      range = normalizeEstimate(raw);
    } catch (e) {
      return llmErrorResponse(e);
    }
  }

  let stored = false;
  if (id && cacheAvailable) {
    try {
      const value = JSON.stringify({ key, ...range, fetchedAt: new Date().toISOString() });
      const res = await env.DB.prepare('UPDATE cars SET price_estimate = ? WHERE id = ?').bind(value, id).run();
      stored = Boolean(res.meta?.changes);
    } catch { /* uncached */ }
  }
  return json({ key, ...range, cached: false, stored });
}
