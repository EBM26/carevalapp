// Server-side tests for the LLM plumbing and the four AI endpoints.
// `fetch` is replaced with a mock: no test ever reaches the real Gemini or
// Anthropic API. Any request that isn't mocked fails the test run.
//   npm test   (runs this after scripts/run-tests.js)

import { callLLM, geminiModels, LlmQuotaError } from '../functions/_lib/llm.js';
import { onRequestPost as extract } from '../functions/api/extract.js';
import { onRequestPost as priceEstimate } from '../functions/api/price-estimate.js';
import { onRequestPost as sellerMessage } from '../functions/api/seller-message.js';
import { onRequestPost as modelNotes } from '../functions/api/model-notes.js';

// ---------- fetch mock ----------
let calls = [];
let script = [];   // queue of responses: { status, body }
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!/generativelanguage\.googleapis\.com|api\.anthropic\.com/.test(u)) {
    throw new Error(`Unexpected network request in tests: ${u}`);
  }
  const model = /models\/([^:]+):generateContent/.exec(u)?.[1] ?? 'anthropic';
  calls.push({ url: u, model: decodeURIComponent(model), body: init.body ? JSON.parse(init.body) : null });
  const next = script.shift();
  if (!next) throw new Error(`No mocked response left for ${u}`);
  return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
};
const geminiOk = (obj) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });
const geminiErr = (status) => ({ status, body: { error: { message: `mock ${status}` } } });
const reset = (...responses) => { calls = []; script = responses; };

const ENV = { GEMINI_API_KEY: 'test-key-not-real' };
const BUILD = { gemini: () => ({ contents: [] }), anthropic: (m) => ({ model: m }) };
const req = (body) => new Request('http://localhost/api/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const IMG = { mimeType: 'image/jpeg', data: 'QUJD'.repeat(40) };

// ---------- tiny runner ----------
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); }
}
function eq(a, b, label = '') {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${label ? `${label}: ` : ''}expected ${y}, got ${x}`);
}

// ---------- model selection ----------
await test('defaults: vision gemini-3.6-flash, text gemini-3.5-flash-lite', () =>
  eq(geminiModels({}), { vision: 'gemini-3.6-flash', text: 'gemini-3.5-flash-lite' }));
await test('env overrides: GEMINI_MODEL_VISION / GEMINI_MODEL_TEXT (GEMINI_MODEL = legacy vision override)', () => {
  eq(geminiModels({ GEMINI_MODEL_VISION: 'v', GEMINI_MODEL_TEXT: 't' }), { vision: 'v', text: 't' });
  eq(geminiModels({ GEMINI_MODEL: 'legacy' }), { vision: 'legacy', text: 'gemini-3.5-flash-lite' });
});
await test('text task uses the text model', async () => {
  reset(geminiOk({ ok: 1 }));
  const r = await callLLM(ENV, BUILD, { task: 'text' });
  eq([calls.map((c) => c.model), r.model, r.retried], [['gemini-3.5-flash-lite'], 'gemini-3.5-flash-lite', false]);
});
await test('vision task uses the vision model', async () => {
  reset(geminiOk({ ok: 1 }));
  const r = await callLLM(ENV, BUILD, { task: 'vision' });
  eq([calls.map((c) => c.model), r.retried], [['gemini-3.6-flash'], false]);
});

// ---------- retry & quota ----------
for (const status of [429, 503]) {
  await test(`vision ${status} → retried once on the text model (same request body)`, async () => {
    reset(geminiErr(status), geminiOk({ make: 'Kia' }));
    const r = await callLLM(ENV, { gemini: () => ({ contents: ['img'] }) }, { task: 'vision' });
    eq([calls.map((c) => c.model), r.model, r.retried, r.raw], [['gemini-3.6-flash', 'gemini-3.5-flash-lite'], 'gemini-3.5-flash-lite', true, { make: 'Kia' }]);
    eq(calls[0].body, calls[1].body, 'same body');
  });
}
await test('vision 429, then text fails too → LlmQuotaError (no third call)', async () => {
  reset(geminiErr(429), geminiErr(429));
  let err;
  try { await callLLM(ENV, BUILD, { task: 'vision' }); } catch (e) { err = e; }
  eq([err instanceof LlmQuotaError, calls.length], [true, 2]);
});
await test('vision 429, then text 500 → still the friendly quota error', async () => {
  reset(geminiErr(429), geminiErr(500));
  let err;
  try { await callLLM(ENV, BUILD, { task: 'vision' }); } catch (e) { err = e; }
  eq(err instanceof LlmQuotaError, true);
});
await test('vision 400 (not quota) → no retry, raw error', async () => {
  reset(geminiErr(400));
  let err;
  try { await callLLM(ENV, BUILD, { task: 'vision' }); } catch (e) { err = e; }
  eq([err instanceof LlmQuotaError, calls.length, /HTTP 400/.test(err.message)], [false, 1, true]);
});
await test('text task 429 → quota error, no retry', async () => {
  reset(geminiErr(429));
  let err;
  try { await callLLM(ENV, BUILD, { task: 'text' }); } catch (e) { err = e; }
  eq([err instanceof LlmQuotaError, calls.length], [true, 1]);
});
await test('no retry when vision and text are the same model', async () => {
  reset(geminiErr(429));
  let err;
  try { await callLLM({ ...ENV, GEMINI_MODEL_VISION: 'same', GEMINI_MODEL_TEXT: 'same' }, BUILD, { task: 'vision' }); } catch (e) { err = e; }
  eq([err instanceof LlmQuotaError, calls.length], [true, 1]);
});

// ---------- endpoints (mocked upstream) ----------
await test('/api/extract: vision model, fields cleaned', async () => {
  reset(geminiOk({ make: 'Kia', model: 'Niro', currentKm: '95,000' }));
  const res = await extract({ request: req({ images: [IMG] }), env: ENV });
  const data = await res.json();
  eq([res.status, calls[0].model, data.fields.make, data.fields.currentKm], [200, 'gemini-3.6-flash', 'Kia', 95000]);
});
await test('/api/extract: vision 429 → text model succeeds', async () => {
  reset(geminiErr(429), geminiOk({ make: 'Kia' }));
  const res = await extract({ request: req({ images: [IMG] }), env: ENV });
  eq([res.status, (await res.json()).model], [200, 'gemini-3.5-flash-lite']);
});
await test('/api/extract: both models at quota → 429 { error: "ai_limit" } (no raw API text)', async () => {
  reset(geminiErr(429), geminiErr(503));
  const res = await extract({ request: req({ images: [IMG] }), env: ENV });
  eq([res.status, await res.json()], [429, { error: 'ai_limit' }]);
});
await test('/api/price-estimate: text model; quota → ai_limit', async () => {
  reset(geminiOk({ low: 90000, high: 100000 }));
  let res = await priceEstimate({ request: req({ make: 'Kia', model: 'Niro', year: 2020, km: 95000 }), env: ENV });
  eq([res.status, calls[0].model, (await res.json()).low], [200, 'gemini-3.5-flash-lite', 90000]);
  reset(geminiErr(429));
  res = await priceEstimate({ request: req({ make: 'Kia', model: 'Niro', year: 2020 }), env: ENV });
  eq([res.status, (await res.json()).error], [429, 'ai_limit']);
});
await test('/api/seller-message: text model; quota → ai_limit', async () => {
  reset(geminiOk({ message: 'היי! מה מספר הרישוי?' }));
  let res = await sellerMessage({ request: req({ car: { make: 'Kia' } }), env: ENV });
  eq([res.status, calls[0].model, (await res.json()).message], [200, 'gemini-3.5-flash-lite', 'היי! מה מספר הרישוי?']);
  reset(geminiErr(503));
  res = await sellerMessage({ request: req({ car: { make: 'Kia' } }), env: ENV });
  eq([res.status, (await res.json()).error], [429, 'ai_limit']);
});
await test('/api/model-notes: text model; quota → ai_limit', async () => {
  reset(geminiOk({ items: [{ en: 'CVT judder', he: 'רעידות בגיר' }] }));
  let res = await modelNotes({ request: req({ make: 'Kia', model: 'Niro', year: 2020 }), env: ENV });
  eq([res.status, calls[0].model, (await res.json()).items.length], [200, 'gemini-3.5-flash-lite', 1]);
  reset(geminiErr(429));
  res = await modelNotes({ request: req({ make: 'Kia', model: 'Niro' }), env: ENV });
  eq([res.status, (await res.json()).error], [429, 'ai_limit']);
});
await test('network guard: an unmocked request fails loudly', async () => {
  let err;
  try { await fetch('https://example.com/'); } catch (e) { err = e; }
  eq(/Unexpected network request/.test(err?.message), true);
});

// ---------- report ----------
console.log('\nServer (mocked LLM)');
for (const [ok, name, msg] of results) console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      ${msg}`}`);
const failed = results.filter((r) => !r[0]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
