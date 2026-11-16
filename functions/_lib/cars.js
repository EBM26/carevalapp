// Shared helpers for the /api/cars Functions.
import { scoreCar } from '../../public/scoring.js';
import { toColumns, fromRow } from '../../public/fields.js';

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const error = (status, message) => json({ error: message }, status);

export async function readJson(request) {
  try { return await request.json(); } catch { return undefined; }
}

const today = () => new Date().toISOString().slice(0, 10);

/** The score columns stored alongside each car, computed as of now. */
export function scoreColumns(car) {
  const r = scoreCar(car);
  return { score_min: r.scoreMin, score_max: r.scoreMax, rating: r.rating, coverage: r.coverage };
}

/** Build an INSERT … ON CONFLICT(id) DO UPDATE statement for a sanitized car. */
export function upsertStatement(db, id, car, dateAdded) {
  const cols = {
    id,
    ...toColumns(car),
    ...scoreColumns(car),
    date_added: dateAdded || today(),
    updated_at: new Date().toISOString(),
  };
  const names = Object.keys(cols);
  const updates = names.filter((n) => n !== 'id' && n !== 'date_added').map((n) => `${n} = excluded.${n}`);
  const sql = `INSERT INTO cars (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
               ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`;
  return db.prepare(sql).bind(...names.map((n) => cols[n]));
}

/** Update an existing car. Returns the statement; check meta.changes for existence. */
export function updateStatement(db, id, car) {
  const cols = { ...toColumns(car), ...scoreColumns(car), updated_at: new Date().toISOString() };
  const names = Object.keys(cols);
  const sql = `UPDATE cars SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`;
  return db.prepare(sql).bind(...names.map((n) => cols[n]), id);
}

/**
 * Scores depend on today's date (test validity, car age), so stored scores
 * drift. Recompute every car and write back only the ones that changed.
 */
export async function refreshScores(db) {
  const { results } = await db.prepare('SELECT * FROM cars').all();
  const stmts = [];
  for (const row of results) {
    const s = scoreColumns(fromRow(row));
    if (s.score_min !== row.score_min || s.score_max !== row.score_max
        || s.rating !== row.rating || s.coverage !== row.coverage) {
      stmts.push(db.prepare('UPDATE cars SET score_min = ?, score_max = ?, rating = ?, coverage = ? WHERE id = ?')
        .bind(s.score_min, s.score_max, s.rating, s.coverage, row.id));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

export async function getCar(db, id) {
  const row = await db.prepare('SELECT * FROM cars WHERE id = ?').bind(id).first();
  return row ? fromRow(row) : null;
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export { today };
