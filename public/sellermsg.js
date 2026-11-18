// sellermsg.js — stage 2: a tailored WhatsApp message to the seller, written
// by the LLM. Pure: which details are missing, which car-specific questions
// to add, the prompt and output cleaning. The call lives in
// functions/api/seller-message.js; the old template (seller.js) is the fallback.

import { num } from './scoring.js';
import { kmPerYear } from './scoring.js';
import { TRUST_CODES } from './govcompare.js';
import { greeting } from './seller.js';

export const MAX_QUESTIONS = 6;
const MAX_LEN = 1200;

/** Missing details to ask about, in order. The plate always comes first. */
export function sellerMissing(car) {
  const out = [];
  const empty = (v) => v === null || v === undefined || v === '';
  if (empty(car.plate)) out.push('plate');
  if (empty(car.insuranceClaims)) out.push('slikah');
  if (empty(car.serviceHistory)) out.push('serviceHistory');
  if (empty(car.testExpiry)) out.push('testExpiry');
  if (empty(car.originalOwnership)) out.push('originalOwnership');
  if (empty(car.trim)) out.push('trim');
  return out;
}

const HYBRID = /hybrid|hev|phev|hsd|היבריד/i;

/** Up to 2 questions specific to this car. */
export function sellerTopics(car, { asOf } = {}) {
  const topics = [];
  const kpy = kmPerYear(car, asOf);
  const hands = num(car.handCount) ?? (Array.isArray(car.ownershipHistory) ? car.ownershipHistory.length || null : null);
  if ((kpy && kpy.value > 20000) || num(car.currentKm) > 120000) topics.push('highKm');
  if (HYBRID.test(`${car.make || ''} ${car.model || ''} ${car.trim || ''}`)) topics.push('hybrid');
  if (car.originalOwnership === 'private_lease' || car.originalOwnership === 'fleet_lease') topics.push('leaseRecords');
  if (hands !== null && hands >= 2) topics.push('whySelling');
  return topics.slice(0, 2);
}

const MISSING_TEXT = {
  plate: 'the license plate number (ask this first)',
  slikah: 'the Slikah report (insurance claims / accident history)',
  serviceHistory: 'the service history: complete or not, and at an authorized garage or not',
  testExpiry: 'when the annual test (טסט) expires',
  originalOwnership: 'the original ownership: private, lease or rental',
  trim: 'the exact trim level',
};
const TOPIC_TEXT = {
  highKm: 'Because of the mileage, ask whether the major services were done (e.g. timing belt or gearbox oil).',
  hybrid: 'Ask about the hybrid battery: is it still under warranty, and was the car serviced at the dealer.',
  leaseRecords: 'It was a lease car: ask whether they have the service records from the leasing company.',
  whySelling: 'Ask, politely, why they are selling.',
};

const OWN_EN = { private: 'private', private_lease: 'private lease', fleet_lease: 'lease / fleet', rental: 'rental', driving_school: 'driving school' };
const TRUST_TEXT = {
  fewerHands: (i) => `The registry shows ${i.gov} owners so far, while the ad says hand ${i.ad}. Politely ask them to clarify.`,
  ownership: (i) => `The registry lists the original ownership as ${OWN_EN[i.gov] || i.gov}, while the ad says private. Politely ask them to clarify.`,
  odometer: (i) => `The last annual test recorded ${i.gov} km, more than the ${i.ad} km in the ad. Politely ask them to clarify.`,
  newerYear: (i) => `The registry shows model year ${i.gov}, while the ad says ${i.ad}. Politely ask them to confirm.`,
  higherTrim: (i) => `The registry shows trim "${i.gov}", while the ad says "${i.ad}". Politely ask them to confirm the trim.`,
};

/** Keep only well-formed trust items: [{ code, ad, gov }] with short values. */
export function cleanTrust(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((i) => i && TRUST_CODES.includes(i.code)).slice(0, 5)
    .map((i) => ({ code: i.code, ad: String(i.ad ?? '').slice(0, 40), gov: String(i.gov ?? '').slice(0, 40) }));
}

/**
 * car: sanitized car. reasons: short English phrases from the quick check
 * (context only; never to be quoted to the seller).
 */
export function sellerPrompt(car, { lang = 'he', reasons = [], trust = [], asOf } = {}) {
  const missing = sellerMissing(car);
  const trustLines = cleanTrust(trust).map((i) => `- ${TRUST_TEXT[i.code](i)}`);
  const topics = sellerTopics(car, { asOf });
  const facts = [
    car.make || car.model ? `Car: ${[car.year, car.make, car.model, car.trim].filter(Boolean).join(' ')}` : null,
    num(car.currentKm) !== null ? `Mileage in the ad: ${car.currentKm} km` : null,
    num(car.askingPrice) !== null ? `Asking price: ${car.askingPrice} ILS` : null,
    num(car.handCount) !== null ? `Hand (number of owners): ${car.handCount}` : null,
  ].filter(Boolean);
  const language = lang === 'en'
    ? 'Write in natural, friendly English.'
    : 'Write in natural, friendly, everyday Israeli Hebrew, the way people actually text on WhatsApp.';
  // Plate first (if missing), then one polite question per registry mismatch, then the rest.
  const asks = [
    ...missing.filter((m) => m === 'plate').map((m) => `- ${MISSING_TEXT[m]}`),
    ...trustLines,
    ...missing.filter((m) => m !== 'plate').map((m) => `- ${MISSING_TEXT[m]}`),
    ...topics.map((t) => `- ${TOPIC_TEXT[t]}`),
  ];
  if (!asks.length) asks.push('- Ask whether the car is still available and when it could be seen.');
  return `You are a private buyer in Israel writing a WhatsApp message to the seller of a used car you saw in an ad.

${language} It must sound like a real person typing on their phone, not a form: no bullet points, no numbering, no headings.
Structure: one short greeting line starting exactly with "${greeting(car.sellerName, lang)}", then at most ${MAX_QUESTIONS} short questions woven into a few natural sentences.

What to ask, in this order:
${asks.join('\n')}

What you know about the car (you may mention the model and year naturally):
${facts.length ? facts.map((f) => `- ${f}`).join('\n') : '- Only what was in the ad.'}
${reasons.length ? `\nBackground for you only, to choose your wording. Do not mention it: ${reasons.join('; ')}.` : ''}

Rules:
- Never state or assume any fact that isn't listed above.
- Never mention scores, ratings, checks, an app or AI. Don't haggle about the price. Don't sign with a name.
- Return JSON: {"message": "<the message>"}.`;
}

export const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: { message: { type: 'string' } },
};

export function buildGeminiMessageRequest(prompt) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // Some variety so "Rewrite" gives a different wording.
    generationConfig: { temperature: 0.8, responseMimeType: 'application/json', responseJsonSchema: MESSAGE_SCHEMA },
  };
}

export function buildAnthropicMessageRequest(prompt, model) {
  return {
    model,
    max_tokens: 800,
    temperature: 0.8,
    tools: [{ name: 'record_message', description: 'Record the WhatsApp message.', input_schema: MESSAGE_SCHEMA }],
    tool_choice: { type: 'tool', name: 'record_message' },
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
}

/** Clean the model's message; null if unusable. */
export function normalizeMessage(raw) {
  const s = String(raw?.message ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length < 10) return null;
  return s.slice(0, MAX_LEN);
}
