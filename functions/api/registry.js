// POST /api/registry — body: { id, fields, ad? }
// fields: registry values; ad: the ad's own identity values that differed
// (kept only for the seller-trust check, e.g. a newer year than registered).
// Stores a cleaned snapshot of the registry (gov) data for a saved car, so
// the list can show seller-trust flags without a new registry lookup.
// Needs migrations/0004_registry_snapshot.sql; without it, returns 503 and
// the app simply works without the list flag.
import { cleanSnapshot } from '../../public/govcompare.js';
import { json, error, readJson, ID_RE } from '../_lib/cars.js';

export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  const id = typeof body?.id === 'string' && ID_RE.test(body.id) ? body.id : null;
  if (!id || !body.fields || typeof body.fields !== 'object') return error(400, 'Expected { id, fields }');
  const value = JSON.stringify({ ...cleanSnapshot(body.fields, body.ad), fetchedAt: new Date().toISOString() });
  try {
    const res = await env.DB.prepare('UPDATE cars SET registry = ? WHERE id = ?').bind(value, id).run();
    if (!res.meta?.changes) return error(404, 'Car not found');
  } catch {
    return error(503, 'The registry column is missing. Apply migrations/0004_registry_snapshot.sql.');
  }
  return json({ stored: true });
}
