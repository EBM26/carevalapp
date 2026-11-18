// reply.js — the questionnaire loop: what the seller answered → car fields. Pure.
// Builds the prompt and provider requests and cleans the JSON that comes back.
// The network call and the API key live only in functions/api/parse-reply.js.
//
// Text goes to the cheap text model; if files (screenshots, PDFs such as the
// Slikah report or a service printout) are attached, the vision model reads
// them, with the same quota fallback as /api/extract.

import { cleanValue } from './fields.js';
import { ENUMS, DEAL_BREAKERS } from './scoring.js';
import { normYm } from './govmap.js';
import { sellerMissing } from './sellermsg.js';
import { geminiFilePart, anthropicFileBlock } from './extraction.js';

export const MAX_REPLY_TEXT = 8000;
export const MAX_SENT_TEXT = 3000;

// ---------- the questions we asked ----------

// sellerMissing() code → the car field it asks about
const MISSING_FIELD = {
  plate: 'plate', slikah: 'insuranceClaims', serviceHistory: 'serviceHistory',
  testExpiry: 'testExpiry', originalOwnership: 'originalOwnership', trim: 'trim',
};
// registry-mismatch question → the field to clarify
const TRUST_FIELD = { fewerHands: 'handCount', ownership: 'originalOwnership', higherTrim: 'trim' };

/** Fields the sent message asked about, in order (plate first): the checklist and the parse context. */
export function askedFields(car, trust = []) {
  const out = [];
  const add = (f) => { if (f && !out.includes(f)) out.push(f); };
  const missing = sellerMissing(car).map((m) => MISSING_FIELD[m]);
  if (missing.includes('plate')) add('plate');
  for (const i of trust || []) add(TRUST_FIELD[i.code]);
  for (const f of missing) add(f);
  return out;
}

// ---------- prompt & schema ----------

const STR = { type: ['string', 'null'] };
const INT = { type: ['integer', 'null'] };
const YESNO = { type: ['string', 'null'], enum: ['yes', 'no', null] };
const enumOf = (values) => ({ type: ['string', 'null'], enum: [...values, null] });

export const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plate: { ...STR, description: 'Israeli license plate, digits only (7 or 8 digits).' },
    originalOwnership: { ...enumOf(ENUMS.ownershipType), description: 'Original ownership: private, private_lease, fleet_lease, rental or driving_school.' },
    handCount: { ...INT, description: 'Hand (יד): number of owners so far. יד ראשונה = 1.' },
    testExpiry: { ...STR, description: 'Test valid until (טסט עד) as YYYY-MM-DD, or YYYY-MM if only the month is given.' },
    trim: { ...STR, description: 'Trim level (רמת גימור).' },
    serviceHistory: { ...enumOf(ENUMS.serviceHistory), description: 'full = complete, authorized garage, on schedule; mostly = mostly complete; missing_1_2_years = gaps of 1–2 years; none = nothing verifiable.' },
    insuranceClaims: { ...enumOf(ENUMS.insuranceClaims), description: 'From the Slikah report (payouts / value loss %): none = no claims; cosmetic = 0–2% value loss; moderate = 3–7%, non-structural; major = over 7% or structural.' },
    dealBreakers: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(DEAL_BREAKERS.map((k) => [k, YESNO])),
      required: DEAL_BREAKERS,
      description: 'yes = the seller or a document confirms it, no = explicitly denied, null = not mentioned. structuralDamage = structural/chassis damage; totalLoss = was declared a total loss; lien = a lien (שעבוד) is on the car; sellerRefuses = refuses an independent inspection or to share the Slikah report.',
    },
    notes: { ...STR, description: 'Up to 400 characters: anything the seller said that does not fit the fields above, in the seller\'s language.' },
  },
};
REPLY_SCHEMA.required = Object.keys(REPLY_SCHEMA.properties);

const FIELD_LABEL = {
  plate: 'the license plate number', insuranceClaims: 'insurance claims (the Slikah report)',
  serviceHistory: 'service history', testExpiry: 'when the annual test (טסט) expires',
  originalOwnership: 'original ownership (private / lease / rental)', trim: 'the trim level',
  handCount: 'the number of owners (hand)',
};

/** sent: the WhatsApp message that was sent; asked: field keys it asked about; text: the seller's reply. */
export function replyPrompt({ sent = '', asked = [], text = '', hasFiles = false } = {}) {
  const questions = asked.filter((f) => FIELD_LABEL[f]).map((f) => `- ${FIELD_LABEL[f]}`);
  const sentText = String(sent || '').trim().slice(0, MAX_SENT_TEXT);
  const reply = String(text || '').trim().slice(0, MAX_REPLY_TEXT);
  return `You read the seller's reply to a buyer's questions about a used car in Israel. The reply is usually Hebrew (WhatsApp), sometimes with attached screenshots or PDFs such as a Slikah (insurance history) report or a service history printout.

The buyer asked about:
${questions.length ? questions.join('\n') : '- (no specific list; read everything)'}
${sentText ? `\nThe message the buyer sent (for context only):\n"""\n${sentText}\n"""\n` : ''}
${reply ? `The seller's reply:\n"""\n${reply}\n"""\n` : ''}${hasFiles ? '\nThe attached files are also from the seller; read them as part of the reply.\n' : ''}
Return only JSON matching the schema. Use null for anything the seller did not clearly answer. Do not guess or infer:
- Only use what the seller (or an attached document) actually says. A vague "everything is fine" is not a tier.
- Short answers refer to the questions in order ("כן" after "do you have a full service history?" means full).
- originalOwnership: פרטית → private; ליסינג פרטי → private_lease; ליסינג, ליסינג תפעולי, חברה → fleet_lease; השכרה → rental; לימוד נהיגה → driving_school.
- insuranceClaims: if a Slikah report is attached, use its payouts and value-loss percentage: none / cosmetic (0–2%) / moderate (3–7%, non-structural) / major (over 7% or structural). A seller's claim of "no accidents" without a report is still "none", but never fill it from a vague answer.
- serviceHistory: full only for a complete record at an authorized garage, on schedule.
- dealBreakers: yes only if explicitly confirmed (e.g. "there is a lien", "it was a total loss"), no only if explicitly denied.
- Numbers: digits only. Put anything else of value in notes.`;
}

// ---------- provider requests ----------

export function buildGeminiReplyRequest(prompt, files = []) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }, ...files.map(geminiFilePart)] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: REPLY_SCHEMA },
  };
}

export function buildAnthropicReplyRequest(prompt, files = [], model) {
  return {
    model,
    max_tokens: 1024,
    temperature: 0,
    tools: [{ name: 'record_reply', description: 'Record what the seller answered.', input_schema: REPLY_SCHEMA }],
    tool_choice: { type: 'tool', name: 'record_reply' },
    messages: [{ role: 'user', content: [...files.map(anthropicFileBlock), { type: 'text', text: prompt }] }],
  };
}

// ---------- cleaning ----------

/**
 * Validate model output: { fields, dealBreakers, notes }. Anything invalid becomes null.
 * `fields` uses car field keys, so it merges straight into a car (upload.js).
 */
export function normalizeReply(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const fields = {
    plate: cleanValue('plate', r.plate),
    originalOwnership: cleanValue('enum', r.originalOwnership, ENUMS.ownershipType),
    handCount: cleanValue('int', r.handCount),
    testExpiry: null,
    trim: cleanValue('text', r.trim),
    serviceHistory: cleanValue('enum', r.serviceHistory, ENUMS.serviceHistory),
    insuranceClaims: cleanValue('enum', r.insuranceClaims, ENUMS.insuranceClaims),
  };
  if (fields.handCount !== null && (fields.handCount < 1 || fields.handCount > 20)) fields.handCount = null;
  const te = String(r.testExpiry ?? '').trim();
  fields.testExpiry = cleanValue('date', te) ?? (normYm(te) ? `${normYm(te)}-01` : null);
  const db = r.dealBreakers && typeof r.dealBreakers === 'object' ? r.dealBreakers : {};
  const dealBreakers = {};
  for (const k of DEAL_BREAKERS) dealBreakers[k] = db[k] === 'yes' || db[k] === 'no' ? db[k] : null;
  return { fields, dealBreakers, notes: cleanValue('text', r.notes, 400) };
}

/** True when the reply gave us anything to apply. */
export function replyHasContent(n) {
  return Object.values(n.fields).some((v) => v !== null) || Object.values(n.dealBreakers).some((v) => v !== null) || Boolean(n.notes);
}

/** Validate the request: some text or files. Returns an error string or null. */
export function validateReplyBody(body) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const files = Array.isArray(body?.files) ? body.files : [];
  if (!text && !files.length) return 'Paste the reply or attach a file';
  if (text.length > MAX_REPLY_TEXT) return 'Reply is too long';
  return null;
}
