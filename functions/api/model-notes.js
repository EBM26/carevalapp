// POST /api/model-notes — body: { make, model, year?, id?, items? }
// "Known issues for this model": up to 3 short, well-documented issues from
// the LLM, in English and Hebrew. Cached per car in cars.model_notes so each
// car is looked up once (the cache is keyed by make/model/year, so editing
// those fields makes the button available again).
//
//   id     a saved car: use/fill its cache
//   items  issues already fetched for an unsaved car; stored without a new
//          LLM call once the car has an id
import { cleanValue } from '../../public/fields.js';
import { modelKey, notesPrompt, buildGeminiNotesRequest, buildAnthropicNotesRequest, normalizeNotes } from '../../public/modelnotes.js';
import { json, error, readJson, ID_RE } from '../_lib/cars.js';
import { callLLM, llmConfig, LlmConfigError, llmErrorResponse } from '../_lib/llm.js';

function parseCache(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return error(400, 'Expected a JSON object');
  const make = cleanValue('text', body.make, 60);
  const model = cleanValue('text', body.model, 60);
  const year = cleanValue('int', body.year);
  const key = modelKey({ make, model, year });
  if (!key) return error(400, 'Make and model are required');
  const id = typeof body.id === 'string' && ID_RE.test(body.id) ? body.id : null;

  // Cache lookup. If the model_notes column doesn't exist yet (migration not
  // applied), carry on without caching rather than failing.
  let cacheAvailable = Boolean(id);
  if (id) {
    try {
      const row = await env.DB.prepare('SELECT model_notes FROM cars WHERE id = ?').bind(id).first();
      const cached = parseCache(row?.model_notes);
      if (cached?.key === key && Array.isArray(cached.items)) {
        return json({ key, items: cached.items, cached: true });
      }
    } catch {
      cacheAvailable = false;
    }
  }

  let items;
  if (Array.isArray(body.items)) {
    items = normalizeNotes({ items: body.items });
  } else {
    try { llmConfig(env); } catch (e) {
      if (e instanceof LlmConfigError) return error(500, e.message);
      throw e;
    }
    try {
      const prompt = notesPrompt({ make, model, year });
      const { raw } = await callLLM(env, {
        gemini: () => buildGeminiNotesRequest(prompt),
        anthropic: (m) => buildAnthropicNotesRequest(prompt, m),
      }, { task: 'text' });
      items = normalizeNotes(raw);
    } catch (e) {
      return llmErrorResponse(e);
    }
  }

  let stored = false;
  if (id && cacheAvailable) {
    try {
      const value = JSON.stringify({ key, items, fetchedAt: new Date().toISOString() });
      const res = await env.DB.prepare('UPDATE cars SET model_notes = ? WHERE id = ?').bind(value, id).run();
      stored = Boolean(res.meta?.changes);
    } catch { /* column missing: return uncached */ }
  }
  return json({ key, items, cached: false, stored });
}
