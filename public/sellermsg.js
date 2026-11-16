// sellermsg.js — stage 2: a tailored WhatsApp message to the seller, written
// by the LLM. Pure: which details are missing, which car-specific questions
// to add, the prompt and output cleaning. The call lives in
// functions/api/seller-message.js; the old template (seller.js) is the fallback.

import { num } from './scoring.js';
import { kmPerYear } from './quickcheck.js';

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
  if ((kpy && kpy.low > 20000) || num(car.currentKm) > 120000) topics.push('highKm');
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

/**
 * car: sanitized car. reasons: short English phrases from the quick check
 * (context only; never to be quoted to the seller).
 */
export function sellerPrompt(car, { lang = 'he', reasons = [], asOf } = {}) {
  const missing = sellerMissing(car);
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
  const asks = [
    ...missing.map((m) => `- ${MISSING_TEXT[m]}`),
    ...topics.map((t) => `- ${TOPIC_TEXT[t]}`),
  ];
  if (!asks.length) asks.push('- Ask whether the car is still available and when it could be seen.');
  return `You are a private buyer in Israel writing a WhatsApp message to the seller of a used car you saw in an ad.

${language} It must sound like a real person typing on their phone, not a form: no bullet points, no numbering, no headings.
Structure: one short greeting line, then at most ${MAX_QUESTIONS} short questions woven into a few natural sentences.

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
