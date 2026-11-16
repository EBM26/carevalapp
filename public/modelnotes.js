// modelnotes.js — "known issues for this model". Pure: prompt, schema,
// provider request builders, output cleaning and the cache key. The network
// call lives in functions/api/model-notes.js.

export const MAX_NOTES = 3;
const MAX_LEN = 140;

/** Cache key for a make/model/year. null when make or model is missing. */
export function modelKey({ make, model, year }) {
  const n = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!n(make) || !n(model)) return null;
  const y = Number.isInteger(Number(year)) && Number(year) > 1900 ? Number(year) : '';
  return `${n(make)}|${n(model)}|${y}`;
}

export const NOTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: MAX_NOTES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['en', 'he'],
        properties: {
          en: { type: 'string', description: 'The issue in English, max 80 characters.' },
          he: { type: 'string', description: 'The same issue in Hebrew, max 80 characters.' },
        },
      },
    },
  },
};

export function notesPrompt({ make, model, year }) {
  const car = [year, make, model].filter(Boolean).join(' ');
  return `Someone in Israel is inspecting a used car: ${car}. Names may be written in Hebrew.

List up to ${MAX_NOTES} common, well-documented problems for this model and generation (the one sold around that year): the kind that show up in recalls, reliability surveys and owner forums.
- One short line each, max 80 characters: the component and the symptom. No advice, no filler.
- Give each line in English (en) and Hebrew (he).
- If you are not confident about well-documented problems for this specific model and generation, return an empty list. Do not guess or invent.`;
}

export function buildGeminiNotesRequest(prompt) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: NOTES_SCHEMA },
  };
}

export function buildAnthropicNotesRequest(prompt, model) {
  return {
    model,
    max_tokens: 800,
    temperature: 0,
    tools: [{ name: 'record_issues', description: 'Record the known issues for this model.', input_schema: NOTES_SCHEMA }],
    tool_choice: { type: 'tool', name: 'record_issues' },
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);

/** Model output (or client-supplied items) → [{ en, he }], at most 3, both strings non-empty. */
export function normalizeNotes(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return items
    .map((i) => ({ en: clean(i?.en), he: clean(i?.he) }))
    .filter((i) => i.en && i.he)
    .slice(0, MAX_NOTES);
}
