// fields.js — the car record definition, shared by the browser and Functions.
// One list drives validation, the D1 column mapping, and import/export.

import { ENUMS, DEAL_BREAKERS, num } from './scoring.js';

export const SOURCES = ['manual', 'screenshot', 'gov', 'seller', 'model_list'];

// [key, column, type, arg]
export const FIELDS = [
  ['plate', 'plate', 'plate'],
  ['make', 'make', 'text'],
  ['model', 'model', 'text'],
  ['trim', 'trim', 'text'],
  ['year', 'year', 'int'],
  ['firstRegistration', 'first_registration', 'ym'],
  ['currentKm', 'current_km', 'int'],
  ['lastTestKm', 'last_test_km', 'int'],
  ['lastTestDate', 'last_test_date', 'date'],
  ['askingPrice', 'asking_price', 'int'],
  ['benchmarkPrice', 'benchmark_price', 'int'],
  ['benchmarkSource', 'benchmark_source', 'enum', ENUMS.benchmarkSource],
  ['yad2Low', 'yad2_low', 'int'],
  ['yad2High', 'yad2_high', 'int'],
  ['originalOwnership', 'original_ownership', 'enum', ENUMS.ownershipType],
  ['handCount', 'hand_count', 'int'],
  ['ownershipHistory', 'ownership_history', 'owners'],
  ['testExpiry', 'test_expiry', 'date'],
  ['insuranceClaims', 'insurance_claims', 'enum', ENUMS.insuranceClaims],
  ['serviceHistory', 'service_history', 'enum', ENUMS.serviceHistory],
  ['cabinFit', 'cabin_fit', 'enum', ENUMS.cabinFit],
  ['tires', 'tires', 'enum', ENUMS.tires],
  ['govStructuralChange', 'gov_structural_change', 'bool'],
  ['notes', 'notes', 'text', 5000],
  ['listingUrl', 'listing_url', 'url'],
  ['sellerPhone', 'seller_phone', 'phone'],
  ['status', 'status', 'enum', ENUMS.status],
].map(([key, col, type, arg]) => ({ key, col, type, arg }));

export const DEAL_BREAKER_COLS = {
  structuralDamage: 'db_structural_damage',
  totalLoss: 'db_total_loss',
  lien: 'db_lien',
  sellerRefuses: 'db_seller_refuses',
};

const FIELD_KEYS = new Set([...FIELDS.map((f) => f.key), ...DEAL_BREAKERS.map((k) => `dealBreakers.${k}`)]);

function validYm(s) {
  const m = /^(\d{4})-(\d{2})/.exec(s);
  return m && +m[2] >= 1 && +m[2] <= 12 ? `${m[1]}-${m[2]}` : null;
}
function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Clean a single value by field type. Anything invalid becomes null. */
export function cleanValue(type, v, arg) {
  if (v === undefined || v === null) return null;
  switch (type) {
    case 'text': {
      const s = String(v).trim().slice(0, arg || 200);
      return s || null;
    }
    case 'plate': {
      const s = String(v).replace(/\D/g, '');
      return s.length >= 5 && s.length <= 8 ? s : null;
    }
    case 'int': {
      const n = num(v);
      return n === null ? null : Math.round(n);
    }
    case 'ym': return validYm(String(v).trim());
    case 'date': return validDate(String(v).trim());
    case 'enum': return arg.includes(v) ? v : null;
    case 'bool': return v === true || v === 1 || v === '1' ? true : v === false || v === 0 || v === '0' ? false : null;
    case 'url': {
      const s = String(v).trim();
      return /^https?:\/\/\S+$/i.test(s) && s.length <= 2000 ? s : null;
    }
    case 'phone': {
      const s = String(v).trim().replace(/[^\d+]/g, '');
      const digits = s.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15 ? s : null;
    }
    case 'owners': {
      if (!Array.isArray(v)) return null;
      const list = v.slice(0, 20).map((o) => {
        const type = typeof o === 'string' ? o : o?.type;
        const out = { type: ENUMS.ownershipType.includes(type) ? type : null };
        if (o && typeof o === 'object') {
          const from = validDate(String(o.from ?? ''));
          const to = validDate(String(o.to ?? ''));
          if (from) out.from = from;
          if (to) out.to = to;
        }
        return out;
      });
      return list.length ? list : null;
    }
    default: return null;
  }
}

/** Validate and normalise a car object from any source (form, API body, import file). */
export function sanitizeCar(input) {
  const src = input && typeof input === 'object' ? input : {};
  const car = {};
  for (const f of FIELDS) car[f.key] = cleanValue(f.type, src[f.key], f.arg);
  car.status = car.status || 'considering';

  const db = src.dealBreakers && typeof src.dealBreakers === 'object' ? src.dealBreakers : {};
  car.dealBreakers = {};
  for (const k of DEAL_BREAKERS) car.dealBreakers[k] = ENUMS.triState.includes(db[k]) ? db[k] : 'unknown';

  car.fieldSources = {};
  const fs = src.fieldSources && typeof src.fieldSources === 'object' ? src.fieldSources : {};
  for (const [k, v] of Object.entries(fs)) {
    if (FIELD_KEYS.has(k) && SOURCES.includes(v)) car.fieldSources[k] = v;
  }
  return car;
}

/** Car object → D1 column map (without id / dates / scores). */
export function toColumns(car) {
  const cols = {};
  for (const f of FIELDS) {
    const v = car[f.key];
    cols[f.col] = v === null || v === undefined ? null
      : f.type === 'owners' ? JSON.stringify(v)
      : f.type === 'bool' ? (v ? 1 : 0)
      : v;
  }
  for (const k of DEAL_BREAKERS) cols[DEAL_BREAKER_COLS[k]] = car.dealBreakers?.[k] ?? 'unknown';
  cols.field_sources = JSON.stringify(car.fieldSources || {});
  return cols;
}

/** D1 row → car object (including id, dates and stored scores). */
export function fromRow(row) {
  const car = { id: row.id };
  for (const f of FIELDS) {
    const v = row[f.col];
    car[f.key] = v === null || v === undefined ? null
      : f.type === 'owners' ? safeJson(v, null)
      : f.type === 'bool' ? v === 1
      : v;
  }
  car.dealBreakers = {};
  for (const k of DEAL_BREAKERS) car.dealBreakers[k] = row[DEAL_BREAKER_COLS[k]] || 'unknown';
  car.fieldSources = safeJson(row.field_sources, {});
  car.dateAdded = row.date_added;
  car.updatedAt = row.updated_at;
  car.scoreMin = row.score_min;
  car.scoreMax = row.score_max;
  car.rating = row.rating;
  car.coverage = row.coverage;
  // Read-only cache written by /api/model-notes; not part of FIELDS, so saving a car never overwrites it.
  car.modelNotes = row.model_notes ? safeJson(row.model_notes, null) : null;
  // Read-only cache written by /api/price-estimate (rough AI price range).
  car.priceEstimate = row.price_estimate ? safeJson(row.price_estimate, null) : null;
  return car;
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
