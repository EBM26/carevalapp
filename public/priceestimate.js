// priceestimate.js — "rough AI estimate" of a typical Israeli private-sale
// price range. Pure: prompt, schema, request builders and cleaning. The call
// itself lives in functions/api/price-estimate.js.

export const ESTIMATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['low', 'high'],
  properties: {
    low: { type: ['integer', 'null'], description: 'Low end of the typical asking price, in ILS.' },
    high: { type: ['integer', 'null'], description: 'High end of the typical asking price, in ILS.' },
  },
};

const OWNERSHIP_EN = {
  private: 'private', private_lease: 'private lease', fleet_lease: 'fleet lease', rental: 'rental', driving_school: 'driving school',
};

export function estimatePrompt({ make, model, trim, year, km, ownership }, asOf = new Date()) {
  const when = new Date(asOf).toISOString().slice(0, 7);
  const lines = [
    `Car: ${[year, make, model, trim].filter(Boolean).join(' ')} (names may be in Hebrew).`,
    km ? `Mileage: ${km} km.` : null,
    ownership && OWNERSHIP_EN[ownership] ? `Original ownership: ${OWNERSHIP_EN[ownership]}.` : null,
    `Market: Israel, private sale (as on Yad2), around ${when}.`,
  ].filter(Boolean);
  return `${lines.join('\n')}

Give a typical asking-price range in Israeli shekels (ILS) for this car in this condition on the Israeli used market.
- Return integers {low, high}, low ≤ high, a realistic range rather than extremes.
- If you don't know this model well enough to estimate, return null for both. Do not guess wildly.`;
}

export function buildGeminiEstimateRequest(prompt) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: ESTIMATE_SCHEMA },
  };
}

export function buildAnthropicEstimateRequest(prompt, model) {
  return {
    model,
    max_tokens: 200,
    temperature: 0,
    tools: [{ name: 'record_estimate', description: 'Record the price range.', input_schema: ESTIMATE_SCHEMA }],
    tool_choice: { type: 'tool', name: 'record_estimate' },
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
}

/** Model output → { low, high } with sane values, or { low: null, high: null }. */
export function normalizeEstimate(raw) {
  const ok = (v) => Number.isFinite(Number(v)) && Number(v) >= 5000 && Number(v) <= 3_000_000;
  let low = ok(raw?.low) ? Math.round(Number(raw.low)) : null;
  let high = ok(raw?.high) ? Math.round(Number(raw.high)) : null;
  if (low === null || high === null) return { low: null, high: null };
  if (low > high) [low, high] = [high, low];
  if (high > low * 3) return { low: null, high: null }; // not a useful range
  return { low, high };
}
