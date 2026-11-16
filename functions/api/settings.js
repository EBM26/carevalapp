// GET /api/settings        → { budgetCeiling }
// PUT /api/settings        body { budgetCeiling } (₪, or null for no limit)
// Stored in the `settings` table (migrations/0003_quick_check.sql).
import { cleanValue } from '../../public/fields.js';
import { json, error, readJson } from '../_lib/cars.js';

const DEFAULTS = { budgetCeiling: null };

export async function onRequestGet({ env }) {
  try {
    const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
    const out = { ...DEFAULTS };
    for (const row of results) {
      if (row.key === 'budgetCeiling') out.budgetCeiling = cleanValue('int', row.value);
    }
    return json(out);
  } catch {
    // Table missing (migration not applied yet): behave as "no settings".
    return json({ ...DEFAULTS, unavailable: true });
  }
}

export async function onRequestPut({ request, env }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return error(400, 'Expected a JSON object');
  const budget = cleanValue('int', body.budgetCeiling);
  if (budget !== null && budget < 1000) return error(400, 'Budget must be at least ₪1,000');
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('budgetCeiling', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(budget === null ? null : String(budget), now).run();
  } catch {
    return error(503, 'The settings table is missing. Apply migrations/0003_quick_check.sql.');
  }
  return json({ budgetCeiling: budget });
}
