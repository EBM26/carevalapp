// extraction.js — screenshot → car fields. Pure: builds provider requests and
// parses/cleans responses. The network call and the API key live only in
// functions/api/extract.js.

import { cleanValue } from './fields.js';
import { normYm } from './govmap.js';

export const PROVIDERS = {
  gemini: { defaultModel: 'gemini-3.6-flash' },
  anthropic: { defaultModel: 'claude-opus-5-5' },
};

export const MAX_IMAGES = 6;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Fields we ask the model for. Deliberately excluded: insuranceClaims and
// serviceHistory. An ad saying "no accidents" or "dealer serviced" is an
// unverified seller claim; filling those fields would also stop the seller
// message from asking for the Slikah report. Such claims go into notes.
const STR = { type: ['string', 'null'] };
const INT = { type: ['integer', 'null'] };
export const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plate: { ...STR, description: 'Israeli license plate, digits only (7 or 8 digits), from the text or a photo of the car.' },
    make: { ...STR, description: 'Manufacturer as written in the ad.' },
    model: { ...STR, description: 'Model as written in the ad.' },
    trim: { ...STR, description: 'Trim level (רמת גימור) as written in the ad.' },
    year: { ...INT, description: 'Model / production year (שנה, שנת ייצור).' },
    firstRegistration: { ...STR, description: 'First road registration (עלייה לכביש) as YYYY-MM.' },
    currentKm: { ...INT, description: 'Current kilometers (ק"מ), number only.' },
    askingPrice: { ...INT, description: 'Asking price in ₪, number only.' },
    handCount: { ...INT, description: 'Hand (יד): number of owners. יד ראשונה = 1.' },
    originalOwnership: { ...STR, description: 'One of: private, private_lease, fleet_lease, rental, driving_school.' },
    testExpiry: { ...STR, description: 'Test valid until (טסט עד) as YYYY-MM-DD, or YYYY-MM if only the month is shown.' },
    tires: { ...STR, description: 'One of: good, ok, worn. Only if the ad states the tire condition.' },
    sellerPhone: { ...STR, description: 'Seller phone number if visible.' },
    notes: { ...STR, description: 'Up to 300 characters: other facts the ad states (e.g. seller claims about accidents or service history), in the ad\'s language.' },
  },
};
EXTRACT_SCHEMA.required = Object.keys(EXTRACT_SCHEMA.properties);

export const EXTRACT_PROMPT = `You extract data from screenshots of a used-car listing on an Israeli site (Yad2, Facebook Marketplace, or a dealer). The text is usually Hebrew. All screenshots belong to the same listing.

Return only JSON matching the schema. Use null for anything not clearly visible. Do not guess or infer:
- Do not derive first registration from the model year, or the year from the registration.
- Do not assume a hand count or ownership type that the ad does not state.
- Read the plate only if the digits are legible; otherwise null.

Field rules:
- originalOwnership (בעלות / מקוריות): פרטית → private; ליסינג פרטי → private_lease; ליסינג, ליסינג תפעולי, חברה → fleet_lease; השכרה → rental; לימוד נהיגה → driving_school.
- tires: צמיגים חדשים → good; only if stated.
- Numbers: digits only, no separators or currency symbols.
- Do NOT put accident or service-history claims anywhere except notes.`;

// ---------- provider requests ----------

export function buildGeminiRequest(images) {
  return {
    contents: [{
      role: 'user',
      parts: [
        { text: EXTRACT_PROMPT },
        ...images.map((im) => ({ inlineData: { mimeType: im.mimeType, data: im.data } })),
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseJsonSchema: EXTRACT_SCHEMA,
    },
  };
}

export function buildAnthropicRequest(images, model) {
  return {
    model,
    max_tokens: 1024,
    temperature: 0,
    tools: [{
      name: 'record_listing',
      description: 'Record the fields extracted from the listing screenshots.',
      input_schema: EXTRACT_SCHEMA,
    }],
    tool_choice: { type: 'tool', name: 'record_listing' },
    messages: [{
      role: 'user',
      content: [
        ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mimeType, data: im.data } })),
        { type: 'text', text: EXTRACT_PROMPT },
      ],
    }],
  };
}

// ---------- provider responses ----------

export function parseGeminiResponse(body) {
  const block = body?.promptFeedback?.blockReason;
  if (block) throw new Error(`Gemini blocked the request (${block})`);
  const cand = body?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error(`Gemini returned no content${cand?.finishReason ? ` (${cand.finishReason})` : ''}`);
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
}

export function parseAnthropicResponse(body) {
  const tool = (body?.content || []).find((b) => b.type === 'tool_use');
  if (!tool) throw new Error(`Anthropic returned no tool call${body?.stop_reason ? ` (${body.stop_reason})` : ''}`);
  return tool.input;
}

// ---------- cleaning ----------

const TYPES = {
  plate: 'plate', make: 'text', model: 'text', trim: 'text', year: 'int', currentKm: 'int',
  askingPrice: 'int', handCount: 'int', sellerPhone: 'phone',
};

/** Validate model output into car fields. Anything invalid becomes null. */
export function normalizeExtraction(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [k, type] of Object.entries(TYPES)) out[k] = cleanValue(type, r[k]);
  if (out.year !== null && (out.year < 1950 || out.year > 2100)) out.year = null;
  if (out.handCount !== null && (out.handCount < 1 || out.handCount > 20)) out.handCount = null;
  out.firstRegistration = normYm(r.firstRegistration);
  // A test date given only as a month: use the 1st (worst case for validity).
  const te = String(r.testExpiry ?? '').trim();
  out.testExpiry = cleanValue('date', te) ?? (normYm(te) ? `${normYm(te)}-01` : null);
  out.originalOwnership = cleanValue('enum', r.originalOwnership, ['private', 'private_lease', 'fleet_lease', 'rental', 'driving_school']);
  out.tires = cleanValue('enum', r.tires, ['good', 'ok', 'worn']);
  const notes = cleanValue('text', r.notes, 500);
  out.notes = notes;
  return out;
}

/** Validate the request body: [{ mimeType, data(base64) }]. Returns an error string or null. */
export function validateImages(images) {
  if (!Array.isArray(images) || images.length === 0) return 'No images';
  if (images.length > MAX_IMAGES) return `At most ${MAX_IMAGES} images`;
  for (const im of images) {
    if (!im || !IMAGE_TYPES.includes(im.mimeType)) return 'Unsupported image type';
    if (typeof im.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(im.data)) return 'Image data must be base64';
    if (im.data.length < 100) return 'Image is empty';
    if (im.data.length > 8_000_000) return 'Image too large';
  }
  return null;
}
