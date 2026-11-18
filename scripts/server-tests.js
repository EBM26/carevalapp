// Server-side tests for the LLM plumbing and the four AI endpoints.
// `fetch` is replaced with a mock: no test ever reaches the real Gemini or
// Anthropic API. Any request that isn't mocked fails the test run.
//   npm test   (runs this after scripts/run-tests.js)

import { callLLM, geminiModels, LlmQuotaError } from '../functions/_lib/llm.js';
import { onRequestPost as extract } from '../functions/api/extract.js';
import { onRequestPost as priceEstimate } from '../functions/api/price-estimate.js';
import { onRequestPost as sellerMessage } from '../functions/api/seller-message.js';
import { onRequestPost as modelNotes } from '../functions/api/model-notes.js';
import { onRequestPost as registrySnapshot } from '../functions/api/registry.js';
import { scoreColumns, withTitle, backfillTitles } from '../functions/_lib/cars.js';
import { onRequestPost as parseReply } from '../functions/api/parse-reply.js';
import { onRequestPost as createCars } from '../functions/api/cars/index.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequest as middleware } from '../functions/_middleware.js';
import { onRequestPut as updateCar } from '../functions/api/cars/[id].js';
import { onRequestGet as listCars } from '../functions/api/cars/index.js';
import { onRequestPost as sellerMessageWithTrust } from '../functions/api/seller-message.js';

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
await test('/api/seller-message: suspicious mismatches reach the prompt as polite questions', async () => {
  reset(geminiOk({ message: 'היי! ברישום מופיעים 2 בעלים, אפשר להבהיר?' }));
  const res = await sellerMessageWithTrust({ request: req({ car: { make: 'Kia' }, trust: [{ code: 'fewerHands', ad: 1, gov: 2 }, { code: 'evil', ad: 'x', gov: 'y' }] }), env: ENV });
  const prompt = calls[0].body.contents[0].parts[0].text;
  eq([res.status, prompt.includes('registry shows 2 owners so far'), prompt.includes('evil')], [200, true, false]);
});
// minimal D1 stand-in for the snapshot endpoint
const fakeDb = (changes, fail = false) => {
  const writes = [];
  return { writes, prepare: (sql) => ({ bind: (...args) => ({ run: async () => { if (fail) throw new Error('no such column: registry'); writes.push({ sql, args }); return { meta: { changes } }; } }) }) };
};
await test('/api/registry: stores a cleaned snapshot for a saved car', async () => {
  const DB = fakeDb(1);
  const res = await registrySnapshot({ request: req({ id: 'abc-123', fields: { handCount: 2, lastTestKm: '90,000', junk: 'x' } }), env: { DB } });
  const stored = JSON.parse(DB.writes[0].args[0]);
  eq([res.status, stored.fields, DB.writes[0].args[1]], [200, { handCount: 2, lastTestKm: 90000 }, 'abc-123']);
});
await test('/api/registry: missing column → 503; unknown car → 404; bad body → 400', async () => {
  eq((await registrySnapshot({ request: req({ id: 'abc', fields: {} }), env: { DB: fakeDb(1, true) } })).status, 503);
  eq((await registrySnapshot({ request: req({ id: 'abc', fields: {} }), env: { DB: fakeDb(0) } })).status, 404);
  eq((await registrySnapshot({ request: req({ fields: {} }), env: { DB: fakeDb(1) } })).status, 400);
});
await test('stored score columns use registry values when a snapshot exists', async () => {
  const car = { firstRegistration: '2023-01', handCount: 1, originalOwnership: 'private', dealBreakers: {} };
  const plain = scoreColumns(car);
  const withReg = scoreColumns({ ...car, registry: { fields: { handCount: 3, originalOwnership: 'private' } } });
  // raw 94 → 100; ownership 15 → 0 gives raw 79 → 84 (scaled ×100/94)
  eq([plain.score_max, withReg.score_max], [100, 84], '3 registered hands on a young car → ownership 0 instead of 15');
});
await test('/api/registry: stores the ad\'s differing identity claims next to the registry fields', async () => {
  const DB = fakeDb(1);
  await registrySnapshot({ request: req({ id: 'abc', fields: { year: 2021 }, ad: { year: '2022', junk: 1 } }), env: { DB } });
  const stored = JSON.parse(DB.writes[0].args[0]);
  eq([stored.fields, stored.ad], [{ year: 2021 }, { year: 2022 }]);
});
// ---------- PDFs ----------
const PDF = { mimeType: 'application/pdf', data: 'JVBERi0xLjQK'.repeat(20) };
await test('/api/extract: a PDF and an image together go to the vision model, the PDF inline as application/pdf', async () => {
  reset(geminiOk({ make: 'Kia', model: 'Niro' }));
  const res = await extract({ request: req({ images: [IMG, PDF] }), env: ENV });
  const parts = calls[0].body.contents[0].parts;
  eq([res.status, calls[0].model, parts[1].inlineData.mimeType, parts[2].inlineData.mimeType], [200, 'gemini-3.6-flash', 'image/jpeg', 'application/pdf']);
});
await test('/api/extract: PDF with vision 429 → same fallback to the text model', async () => {
  reset(geminiErr(429), geminiOk({ make: 'Kia' }));
  const res = await extract({ request: req({ images: [PDF] }), env: ENV });
  eq([res.status, calls.map((c) => c.model), calls[1].body.contents[0].parts[1].inlineData.mimeType], [200, ['gemini-3.6-flash', 'gemini-3.5-flash-lite'], 'application/pdf']);
});
await test('/api/extract: more than 4 files → 400', async () => {
  reset();
  const res = await extract({ request: req({ images: [IMG, IMG, IMG, IMG, IMG] }), env: ENV });
  eq([res.status, calls.length], [400, 0]);
});

// ---------- /api/parse-reply (mocked) ----------
const REPLY = { plate: '12-345-67', originalOwnership: 'private', handCount: 2, testExpiry: '2027-03-15', trim: null,
  serviceHistory: 'full', insuranceClaims: 'none', dealBreakers: { structuralDamage: 'no', totalLoss: null, lien: null, sellerRefuses: null }, notes: 'Can meet Friday' };
await test('/api/parse-reply: text only → the text model; answers mapped and cleaned', async () => {
  reset(geminiOk(REPLY));
  const res = await parseReply({ request: req({ text: 'כן, יד שנייה, פרטית', sent: 'היי, מה מספר הרישוי?', asked: ['plate', 'bogus', 'serviceHistory'] }), env: ENV });
  const data = await res.json();
  const prompt = calls[0].body.contents[0].parts[0].text;
  eq([res.status, calls[0].model, data.fields.plate, data.fields.handCount, data.fields.insuranceClaims, data.dealBreakers.structuralDamage, data.notes],
    [200, 'gemini-3.5-flash-lite', '1234567', 2, 'none', 'no', 'Can meet Friday']);
  eq([prompt.includes('היי, מה מספר הרישוי?'), prompt.includes('the license plate number'), prompt.includes('bogus'), calls[0].body.contents[0].parts.length], [true, true, false, 1]);
});
await test('/api/parse-reply: with a PDF → the vision model; the PDF is inline', async () => {
  reset(geminiOk({ ...REPLY, insuranceClaims: 'moderate' }));
  const res = await parseReply({ request: req({ files: [PDF], asked: ['insuranceClaims'] }), env: ENV });
  eq([res.status, calls[0].model, calls[0].body.contents[0].parts[1].inlineData.mimeType, (await res.json()).fields.insuranceClaims], [200, 'gemini-3.6-flash', 'application/pdf', 'moderate']);
});
await test('/api/parse-reply: text and files together; vision 429 → text model fallback', async () => {
  reset(geminiErr(429), geminiOk(REPLY));
  const res = await parseReply({ request: req({ text: 'ראו מצורף', files: [IMG, PDF] }), env: ENV });
  eq([res.status, calls.map((c) => c.model)], [200, ['gemini-3.6-flash', 'gemini-3.5-flash-lite']]);
});
await test('/api/parse-reply: quota → ai_limit; nothing to read → 400; bad file → 400', async () => {
  reset(geminiErr(429));
  let res = await parseReply({ request: req({ text: 'כן' }), env: ENV });
  eq([res.status, (await res.json()).error], [429, 'ai_limit']);
  reset();
  eq((await parseReply({ request: req({}), env: ENV })).status, 400);
  eq((await parseReply({ request: req({ files: [{ mimeType: 'text/html', data: 'QUJD'.repeat(40) }] }), env: ENV })).status, 400);
  eq(calls.length, 0);
});
await test('/api/parse-reply: junk from the model is cleaned to nulls', async () => {
  reset(geminiOk({ originalOwnership: 'company', handCount: 50, insuranceClaims: 'huge', dealBreakers: { lien: 'maybe' } }));
  const data = await (await parseReply({ request: req({ text: 'x' }), env: ENV })).json();
  eq([Object.values(data.fields).every((v) => v === null), data.dealBreakers.lien], [true, null]);
});

// ---------- titles: unique per car (fake D1) ----------
function titleDb(rows) {
  const writes = [];
  return {
    writes,
    prepare: (sql) => ({
      all: async () => ({ results: rows }),
      bind: (...args) => ({ run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; }, args, sql }),
    }),
    batch: async (stmts) => { writes.push(...stmts.map((s) => ({ sql: s.sql, args: s.args }))); },
  };
}
const CAR = { model: 'Corolla', year: 2022, location: 'Petah Tikva', askingPrice: 70000 };
await test('title: generated on first save, then " (2)", " (3)" for the same car', async () => {
  eq((await withTitle(titleDb([]), CAR)).title, 'Corolla 2022 · Petah Tikva · ₪70k');
  eq((await withTitle(titleDb([{ id: 'a', title: 'Corolla 2022 · Petah Tikva · ₪70k' }]), CAR)).title, 'Corolla 2022 · Petah Tikva · ₪70k (2)');
  const rows = [{ id: 'a', title: 'Corolla 2022 · Petah Tikva · ₪70k' }, { id: 'b', title: 'Corolla 2022 · Petah Tikva · ₪70k (2)' }];
  eq((await withTitle(titleDb(rows), CAR)).title, 'Corolla 2022 · Petah Tikva · ₪70k (3)');
});
await test('title: editing a car keeps its own title (it does not clash with itself)', async () => {
  const rows = [{ id: 'a', title: 'My Corolla' }, { id: 'b', title: 'Other' }];
  eq((await withTitle(titleDb(rows), { ...CAR, title: 'My Corolla' }, 'a')).title, 'My Corolla');
  eq((await withTitle(titleDb(rows), { ...CAR, title: 'Other' }, 'a')).title, 'Other (2)'); // renamed onto another car's title
});
await test('title: a typed title is kept; an empty one is regenerated', async () => {
  eq((await withTitle(titleDb([]), { ...CAR, title: 'Family car' })).title, 'Family car');
  eq((await withTitle(titleDb([]), { ...CAR, title: '  ' })).title, 'Corolla 2022 · Petah Tikva · ₪70k');
});
await test('title: POST /api/cars stores a unique generated title', async () => {
  const DB = titleDb([{ id: 'a', title: 'Corolla 2022 · Petah Tikva · ₪70k' }]);
  const res = await createCars({ request: req(CAR), env: { DB } }).catch((e) => ({ status: 0, e }));
  // getCar() reads a row we don't fake; the insert itself is what matters
  const insert = DB.writes.find((w) => /INSERT INTO cars/.test(w.sql));
  eq(res.status === 0 || res.status === 201, true);
  eq(insert.args.includes('Corolla 2022 · Petah Tikva · ₪70k (2)'), true);
});
await test('title: cars from before titles get unique ones once', async () => {
  const rows = [
    { id: 'a', model: 'Corolla', year: 2022, asking_price: 70000, date_added: '2026-01-01', title: null },
    { id: 'b', model: 'Corolla', year: 2022, asking_price: 70000, date_added: '2026-01-02', title: null },
    { id: 'c', title: 'Kept', date_added: '2026-01-03' },
  ];
  const DB = titleDb(rows);
  eq(await backfillTitles(DB), 2);
  eq(DB.writes.map((w) => w.args), [['Corolla 2022 · ₪70k', 'a'], ['Corolla 2022 · ₪70k (2)', 'b']]);
});

// ---------- save flow: login → create → edit → save (real SQL on node:sqlite) ----------
// A D1-shaped adapter, so a missing column fails exactly as it does in production.
const d1 = (sqlite) => ({
  prepare: (sql) => {
    const mk = (args) => ({
      bind: (...a) => mk(a),
      run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
    });
    return mk([]);
  },
  batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
});
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const newDb = (drop = []) => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  for (const c of drop) sqlite.exec(`ALTER TABLE cars DROP COLUMN ${c}`); // an un-migrated database
  return d1(sqlite);
};
const AUTH_ENV = { APP_PASSWORD: 'pw-for-tests', SESSION_SECRET: 'x'.repeat(40) };
const login = async () => {
  const form = new FormData(); form.set('password', AUTH_ENV.APP_PASSWORD);
  const res = await middleware({ request: new Request('https://app.test/auth/login', { method: 'POST', body: form }), env: AUTH_ENV, next: () => { throw new Error('unreachable'); } });
  return { res, cookie: res.headers.get('set-cookie') };
};
// Route through the real middleware with the session cookie, like a browser would.
const call = async (cookie, method, path, body, handlers, env) => {
  const request = new Request(`https://app.test${path}`, {
    method, headers: { cookie: cookie.split(';')[0], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const id = /\/api\/cars\/([\w-]+)/.exec(path)?.[1];
  return middleware({ request, env: { ...AUTH_ENV, ...env }, next: () => handlers({ request, env: { ...AUTH_ENV, ...env }, params: { id } }) });
};
await test('session cookie: __Host-, Path=/, HttpOnly, SameSite=Lax, Secure, Max-Age 30 days in seconds', async () => {
  const { res, cookie } = await login();
  eq(res.status, 303);
  eq(cookie.startsWith('__Host-session=v1.'), true);
  for (const a of ['Path=/;', 'HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=2592000']) eq(cookie.includes(a), true, a);
  eq(/Domain=/i.test(cookie), false);
});
await test('save flow: create, edit and save a car with the session cookie', async () => {
  const DB = newDb();
  const { cookie } = await login();
  const car = { make: 'Toyota', model: 'Corolla', year: 2022, askingPrice: 70000, currentKm: 40000, location: 'Petah Tikva', sellerName: 'Dan', sellerPhone: '0501234567', adValues: { currentKm: 40000 } };
  const created = await call(cookie, 'POST', '/api/cars', car, createCars, { DB });
  eq(created.status, 201);
  const saved = await created.json();
  eq(saved.title, 'Corolla 2022 · Petah Tikva · ₪70k');
  const put = await call(cookie, 'PUT', `/api/cars/${saved.id}`, { ...saved, currentKm: 41000, notes: 'edited' }, updateCar, { DB });
  eq(put.status, 200);
  const after = await put.json();
  eq([after.currentKm, after.notes, after.title], [41000, 'edited', saved.title]);
  eq((await (await call(cookie, 'GET', '/api/cars', null, listCars, { DB })).json()).length, 1);
});
await test('save without a valid cookie is 401 JSON (the only case that means "session expired")', async () => {
  const request = new Request('https://app.test/api/cars', { method: 'POST', body: '{}', headers: { cookie: '__Host-session=v1.1.bad' } });
  const res = await middleware({ request, env: AUTH_ENV, next: () => { throw new Error('unreachable'); } });
  eq(res.status, 401);
  eq((await res.json()).error, 'unauthorized');
});
await test('save on an un-migrated database: JSON 500 with the cause, never 401', async () => {
  const DB = newDb(['title', 'ad_values', 'seller_name']);
  const { cookie } = await login();
  const origErr = console.error; console.error = () => {};
  const res = await call(cookie, 'POST', '/api/cars', { make: 'Mazda', model: '3', year: 2020 }, createCars, { DB });
  console.error = origErr;
  eq(res.status, 500);
  eq(res.headers.get('content-type').includes('application/json'), true);
  eq(/no such column|no column/i.test((await res.json()).detail), true);
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
