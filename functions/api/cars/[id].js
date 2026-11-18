// PUT    /api/cars/:id   replace a car's fields (scores recomputed)
// DELETE /api/cars/:id
import { sanitizeCar } from '../../../public/fields.js';
import { json, error, readJson, updateStatement, withTitle, getCar, ID_RE } from '../../_lib/cars.js';

export async function onRequestPut({ request, env, params }) {
  if (!ID_RE.test(params.id)) return error(400, 'Invalid id');
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'Expected a car object');
  const res = await updateStatement(env.DB, params.id, await withTitle(env.DB, sanitizeCar(body), params.id)).run();
  if (!res.meta.changes) return error(404, 'Car not found');
  return json(await getCar(env.DB, params.id));
}

export async function onRequestDelete({ env, params }) {
  if (!ID_RE.test(params.id)) return error(400, 'Invalid id');
  const res = await env.DB.prepare('DELETE FROM cars WHERE id = ?').bind(params.id).run();
  if (!res.meta.changes) return error(404, 'Car not found');
  return json({ deleted: params.id });
}
