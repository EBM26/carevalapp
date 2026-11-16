// GET  /api/cars?sort=max|min|date&status=…   list cars (scores refreshed first)
// POST /api/cars   body: car object → create; or array of cars → import (upsert by id)
import { fromRow, sanitizeCar } from '../../../public/fields.js';
import { ENUMS } from '../../../public/scoring.js';
import { json, error, readJson, upsertStatement, refreshScores, getCar, ID_RE } from '../../_lib/cars.js';

const ORDER = {
  max: 'score_max DESC, score_min DESC, date_added DESC',
  min: 'score_min DESC, score_max DESC, date_added DESC',
  date: 'date_added DESC, updated_at DESC',
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const order = ORDER[url.searchParams.get('sort')] || ORDER.max;
  const status = url.searchParams.get('status');

  await refreshScores(env.DB);

  const stmt = ENUMS.status.includes(status)
    ? env.DB.prepare(`SELECT * FROM cars WHERE status = ? ORDER BY ${order}`).bind(status)
    : env.DB.prepare(`SELECT * FROM cars ORDER BY ${order}`);
  const { results } = await stmt.all();
  return json(results.map(fromRow));
}

export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  if (body === undefined) return error(400, 'Invalid JSON');

  // Import: array of cars. Existing IDs are overwritten (restoring a backup is idempotent).
  if (Array.isArray(body)) {
    if (body.length > 2000) return error(400, 'Too many cars in one import');
    const stmts = body.map((raw) => {
      const id = typeof raw?.id === 'string' && ID_RE.test(raw.id) ? raw.id : crypto.randomUUID();
      const dateAdded = /^\d{4}-\d{2}-\d{2}$/.test(raw?.dateAdded ?? '') ? raw.dateAdded : null;
      return upsertStatement(env.DB, id, sanitizeCar(raw), dateAdded);
    });
    // D1 batches run as one transaction: all or nothing.
    if (stmts.length) await env.DB.batch(stmts);
    return json({ imported: stmts.length });
  }

  if (typeof body !== 'object' || body === null) return error(400, 'Expected a car object');
  const id = crypto.randomUUID();
  await upsertStatement(env.DB, id, sanitizeCar(body)).run();
  return json(await getCar(env.DB, id), 201);
}
