// scoring.js — pure scoring logic for the Used Car Scorer.
// No DOM, no I/O. Shared by the browser (ES module) and Pages Functions.
//
// Every input may be null/undefined (unknown). Each scoring part returns a
// [min, max] range: min = worst case over all possible values of the unknown
// inputs, max = best case. The total is the sum of the part ranges.
//
// Output strings are codes (e.g. 'STRONG_BUY', 'odometer_rollback'), never
// UI text — i18n.js maps codes to English/Hebrew.

export const WEIGHTS = {
  history: 30,
  price: 25,
  mileage: 20,
  ownership: 15,
  test: 2,
  tires: 2,
};

/** Raw points available (94). Totals are shown out of 100: raw × 100 / RAW_TOTAL, rounded. */
export const RAW_TOTAL = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
export const scaleTo100 = (raw) => Math.round((raw * 100) / RAW_TOTAL);

export const ENUMS = {
  benchmarkSource: ['levi_yitzhak', 'yad2_comparables'],
  ownershipType: ['private', 'private_lease', 'fleet_lease', 'rental', 'driving_school'],
  insuranceClaims: ['none', 'cosmetic', 'moderate', 'major'],
  serviceHistory: ['full', 'mostly', 'missing_1_2_years', 'none'],
  tires: ['good', 'ok', 'worn'],
  triState: ['no', 'unknown', 'yes'],
  status: ['considering', 'contacted', 'inspected', 'rejected', 'bought'],
};

export const DEAL_BREAKERS = ['structuralDamage', 'totalLoss', 'lien', 'sellerRefuses'];

const CLAIMS_POINTS = { none: 30, cosmetic: 20, moderate: 10, major: 0 };
const SERVICE_POINTS = { full: 30, mostly: 20, missing_1_2_years: 10, none: 0 };
const TIRE_POINTS = { good: 2, ok: 1, worn: 0 };

// ---------- helpers ----------

/** Finite, non-negative number, or null. Accepts numeric strings. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s₪]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function oneOf(v, list) {
  return list.includes(v) ? v : null;
}

function range(values) {
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** Normalise the "as of" date to {y, m (1-12), d} in UTC. */
function ymd(date) {
  const dt = date instanceof Date ? date : new Date(date);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Parse 'YYYY-MM' or 'YYYY-MM-DD' → {y, m}. Returns null if invalid. */
function parseYearMonth(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(s.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2];
  return mo >= 1 && mo <= 12 ? { y, m: mo } : null;
}

/** Parse 'YYYY-MM-DD' → {y, m, d}. Returns null if invalid. */
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s.trim());
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

const monthIndex = (p) => p.y * 12 + (p.m - 1);
const cmpDate = (a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);

function addMonths(p, n) {
  const idx = monthIndex(p) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1, d: p.d };
}

/**
 * Possible car age in whole months at `ref` ({y,m}), as {min, max}, or null.
 * Uses firstRegistration (YYYY-MM) if known; otherwise `year`, assuming first
 * registration anywhere from Jan to Dec of that year. Minimum age is 1 month.
 */
export function ageMonthsRange(car, ref) {
  const fr = parseYearMonth(car.firstRegistration);
  if (fr) {
    const a = Math.max(1, monthIndex(ref) - monthIndex(fr));
    return { min: a, max: a };
  }
  const year = num(car.year);
  if (year !== null && year >= 1900) {
    const max = Math.max(1, monthIndex(ref) - monthIndex({ y: year, m: 1 }));
    const min = Math.max(1, monthIndex(ref) - monthIndex({ y: year, m: 12 }));
    return { min, max };
  }
  return null;
}

// ---------- km per year (the one shared calculation) ----------

/** The car's km: the higher of the ad km and the last-test km, or null. */
export function carKm(car) {
  const ad = num(car.currentKm);
  const test = num(car.lastTestKm);
  if (ad === null) return test;
  return test === null ? ad : Math.max(ad, test);
}

function refMonth(asOf) {
  if (asOf && typeof asOf === 'object' && !(asOf instanceof Date) && 'y' in asOf) return { y: asOf.y, m: asOf.m };
  const { y, m } = ymd(asOf ?? new Date());
  return { y, m };
}

/**
 * Average km per year, or null when there is no km or no age.
 *   km:    the higher of ad km and last-test km.
 *   start: first registration (registry) if known; else July 1 of the model
 *          year ("estimated from year").
 *   end:   today, or the last-test date when the only km is the last-test km.
 * Returns { value (whole km), km, months, from: 'registration' | 'year', estimated, toTest }.
 */
export function kmPerYear(car, asOf) {
  car = car || {};
  const km = carKm(car);
  if (km === null) return null;
  const fr = parseYearMonth(car.firstRegistration);
  const year = num(car.year);
  let start;
  if (fr) start = fr;
  else if (year !== null && year >= 1900) start = { y: Math.floor(year), m: 7 };
  else return null;
  const toTest = num(car.currentKm) === null && parseYearMonth(car.lastTestDate) !== null;
  const end = toTest ? parseYearMonth(car.lastTestDate) : refMonth(asOf);
  const months = Math.max(1, monthIndex(end) - monthIndex(start));
  return { value: Math.round((km * 12) / months), km, months, from: fr ? 'registration' : 'year', estimated: !fr, toTest };
}

// ---------- band functions (single known value → points) ----------

export function claimsPoints(v) { return CLAIMS_POINTS[v]; }
export function servicePoints(v) { return SERVICE_POINTS[v]; }
export function tirePoints(v) { return TIRE_POINTS[v]; }

/**
 * Price points from asking and benchmark. Compares by cross-multiplication so
 * exact ±5% / +10% boundaries are not subject to floating-point error.
 *   d ≤ −5%        → 25
 *   −5% < d ≤ +5%  → 18
 *   +5% < d ≤ +10% → 8
 *   d > +10%       → 0
 */
export function pricePoints(asking, benchmark) {
  if (100 * asking <= 95 * benchmark) return 25;
  if (100 * asking <= 105 * benchmark) return 18;
  if (100 * asking <= 110 * benchmark) return 8;
  return 0;
}

/**
 * Mileage points from km/year (rounded to whole km) and total km.
 *   < 15,000 → 20; 15,000–22,000 → 14; 22,001–28,000 → 7; > 28,000 → 0
 *   total > 130,000 km → 0 regardless.
 */
export function mileagePoints(kmPerYear, totalKm) {
  if (totalKm > 130000) return 0;
  const k = Math.round(kmPerYear);
  if (k < 15000) return 20;
  if (k <= 22000) return 14;
  if (k <= 28000) return 7;
  return 0;
}

/**
 * Test-validity points. ≥ 6 calendar months left → 2; ≥ 3 → 1; else 0.
 * `expiry` and `asOf` are {y,m,d}.
 */
export function testPoints(expiry, asOf) {
  if (cmpDate(expiry, addMonths(asOf, 6)) >= 0) return 2;
  if (cmpDate(expiry, addMonths(asOf, 3)) >= 0) return 1;
  return 0;
}

const LEASE = new Set(['private_lease', 'fleet_lease']);
const DISQUALIFYING = new Set(['rental', 'driving_school']);

/**
 * Ownership points for a fully known scenario.
 * owners: array of ownership types, index 0 = first owner; length = hand count.
 * Returns { points, review }.
 */
export function ownershipPoints(owners, under5Years) {
  const n = owners.length;
  if (owners.some((t) => DISQUALIFYING.has(t))) return { points: 0, review: false };
  if (n >= 3 && under5Years) return { points: 0, review: false };
  if (n === 1) {
    if (owners[0] === 'private') return { points: 15, review: false };
    if (owners[0] === 'private_lease') return { points: 11, review: false };
    if (owners[0] === 'fleet_lease') return { points: 6, review: false };
  }
  if (n === 2) {
    if (owners.every((t) => t === 'private')) return { points: 11, review: false };
    if (LEASE.has(owners[0]) && owners[1] === 'private') return { points: 6, review: false };
  }
  return { points: 6, review: true };
}

// ---------- category scorers (car → range) ----------

function scoreHistory(car) {
  const claims = oneOf(car.insuranceClaims, ENUMS.insuranceClaims);
  const service = oneOf(car.serviceHistory, ENUMS.serviceHistory);
  const missing = [];
  if (!claims) missing.push('insuranceClaims');
  if (!service) missing.push('serviceHistory');
  const c = claims ? range([CLAIMS_POINTS[claims]]) : range(Object.values(CLAIMS_POINTS));
  const s = service ? range([SERVICE_POINTS[service]]) : range(Object.values(SERVICE_POINTS));
  // Score = lower of the two tiers. min(·) is monotone in both arguments.
  const min = Math.min(c.min, s.min);
  const max = Math.min(c.max, s.max);
  return { min, max, missing, notes: [] };
}

/** Resolve the price benchmark. Returns { value, source, lowConfidence } or null. */
export function resolveBenchmark(car) {
  const levi = num(car.benchmarkPrice);
  if (levi !== null && levi > 0 && car.benchmarkSource !== 'yad2_comparables') {
    return { value: levi, source: 'levi_yitzhak', lowConfidence: false };
  }
  const lo = num(car.yad2Low);
  const hi = num(car.yad2High);
  if (lo !== null && hi !== null && lo > 0 && hi > 0) {
    return { value: (lo + hi) / 2, source: 'yad2_comparables', lowConfidence: true };
  }
  if (levi !== null && levi > 0) {
    // A single number entered with source = yad2_comparables.
    return { value: levi, source: 'yad2_comparables', lowConfidence: true };
  }
  return null;
}

function scorePrice(car) {
  const asking = num(car.askingPrice);
  const bench = resolveBenchmark(car);
  const missing = [];
  if (asking === null) missing.push('askingPrice');
  if (!bench) missing.push('benchmarkPrice');
  const notes = [];
  if (bench?.lowConfidence) notes.push('price_confidence_low');
  if (asking === null || !bench) return { min: 0, max: WEIGHTS.price, missing, notes, benchmark: bench };
  const p = pricePoints(asking, bench.value);
  return {
    min: p, max: p, missing, notes, benchmark: bench,
    deviation: (asking - bench.value) / bench.value,
  };
}

function scoreMileage(car, asOf) {
  const km = carKm(car);
  const k = kmPerYear(car, asOf);
  const notes = [];
  if (km !== null && num(car.currentKm) === null) notes.push('km_from_last_test');
  if (k?.estimated) notes.push('km_year_estimated');
  if (km === null) {
    const missing = ['currentKm'];
    if (!parseYearMonth(car.firstRegistration) && num(car.year) === null) missing.push('firstRegistration');
    return { min: 0, max: WEIGHTS.mileage, missing, notes, kmPerYear: null, kpy: null };
  }
  if (km > 130000) return { min: 0, max: 0, missing: [], notes, kmPerYear: k?.value ?? null, kpy: k };
  if (!k) return { min: 0, max: WEIGHTS.mileage, missing: ['firstRegistration'], notes, kmPerYear: null, kpy: null };
  const p = mileagePoints(k.value, km);
  return { min: p, max: p, missing: [], notes, kmPerYear: k.value, kpy: k };
}

function scoreOwnership(car, asOf) {
  const ref = { y: asOf.y, m: asOf.m };
  const history = Array.isArray(car.ownershipHistory) ? car.ownershipHistory : [];
  const histTypes = history.map((h) => oneOf(typeof h === 'string' ? h : h?.type, ENUMS.ownershipType));
  const original = oneOf(car.originalOwnership, ENUMS.ownershipType) ?? histTypes[0] ?? null;

  let hc = num(car.handCount);
  if (hc !== null) hc = Math.max(1, Math.floor(hc));
  else if (history.length > 0) hc = history.length;

  const missing = [];
  if (!original) missing.push('originalOwnership');
  if (hc === null) missing.push('handCount');

  // Age: known under/over 5 years, or both possible.
  const age = ageMonthsRange(car, ref);
  const ageOptions = !age ? [true, false]
    : age.max < 60 ? [true]
    : age.min >= 60 ? [false]
    : [true, false];

  // Hand counts to try; 3 stands in for "3 or more" (scoring is identical for n ≥ 3).
  const handOptions = hc === null ? [1, 2, 3] : [hc];
  const results = [];

  for (const n of handOptions) {
    // Domain for each owner slot. For n ≥ 3 only rental-ness matters, so the
    // reduced domain {private, rental} is exhaustive and keeps this small.
    const full = ENUMS.ownershipType;
    const reduced = ['private', 'rental'];
    const slots = [];
    for (let i = 0; i < n; i++) {
      const known = i === 0 ? original : histTypes[i] ?? null;
      slots.push(known ? [known] : n >= 3 ? reduced : full);
    }
    if (n >= 2 && slots.slice(1).some((s) => s.length > 1) && !missing.includes('ownershipHistory')) {
      missing.push('ownershipHistory');
    }
    for (const owners of cartesian(slots)) {
      for (const u5 of ageOptions) results.push(ownershipPoints(owners, u5));
    }
  }

  const pts = results.map((r) => r.points);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const notes = min === max && results.every((r) => r.review) ? ['ownership_review'] : [];
  return { min, max, missing: min === max ? [] : missing, notes };
}

function* cartesian(slots, i = 0, acc = []) {
  if (i === slots.length) { yield acc.slice(); return; }
  for (const v of slots[i]) { acc.push(v); yield* cartesian(slots, i + 1, acc); acc.pop(); }
}

function scoreSimple(value, table, field) {
  if (value in table) return { min: table[value], max: table[value], missing: [], notes: [] };
  return { min: Math.min(...Object.values(table)), max: Math.max(...Object.values(table)), missing: [field], notes: [] };
}

function scoreTest(car, asOf) {
  const exp = parseDate(car.testExpiry);
  if (!exp) return { min: 0, max: WEIGHTS.test, missing: ['testExpiry'], notes: [] };
  const p = testPoints(exp, asOf);
  return { min: p, max: p, missing: [], notes: [] };
}

// ---------- ratings ----------

export function band(score) {
  if (score >= 80) return 'STRONG_BUY';
  if (score >= 60) return 'OK';
  return 'AVOID';
}

export function dealBreakerStatus(car) {
  const db = car.dealBreakers || {};
  const confirmed = [];
  const open = [];
  for (const k of DEAL_BREAKERS) {
    const v = db[k];
    if (v === 'yes') confirmed.push(k);
    else if (v !== 'no') open.push(k); // null / undefined / 'unknown' are open flags
  }
  return { confirmed, open };
}

export function warnings(car) {
  const w = [];
  const cur = num(car.currentKm);
  const lt = num(car.lastTestKm);
  if (cur !== null && lt !== null && cur < lt) w.push('odometer_rollback');
  if (car.govStructuralChange === true) w.push('structural_change');
  return w;
}

// ---------- main entry ----------

/**
 * Score a car. `opts.asOf` (Date or ISO string) defaults to now; pass it in
 * tests to keep results deterministic.
 */
export function scoreCar(car, opts = {}) {
  car = car || {};
  const asOf = ymd(opts.asOf ?? new Date());

  const parts = {
    history: scoreHistory(car),
    price: scorePrice(car),
    mileage: scoreMileage(car, asOf),
    ownership: scoreOwnership(car, asOf),
    test: scoreTest(car, asOf),
    tires: scoreSimple(car.tires, TIRE_POINTS, 'tires'),
  };
  for (const [k, p] of Object.entries(parts)) p.weight = WEIGHTS[k];

  let rawMin = 0, rawMax = 0, rawKnown = 0;
  for (const p of Object.values(parts)) {
    rawMin += p.min;
    rawMax += p.max;
    if (p.min === p.max) rawKnown += p.weight;
  }
  // The categories add up to RAW_TOTAL (94); totals are shown out of 100.
  const scoreMin = scaleTo100(rawMin);
  const scoreMax = scaleTo100(rawMax);
  const coverage = scaleTo100(rawKnown);

  // Category view as in the spec: 5b "upfront condition" = test + tires.
  const categories = {
    history: parts.history,
    price: parts.price,
    mileage: parts.mileage,
    ownership: parts.ownership,
    condition: {
      min: parts.test.min + parts.tires.min,
      max: parts.test.max + parts.tires.max,
      weight: WEIGHTS.test + WEIGHTS.tires,
      missing: [...parts.test.missing, ...parts.tires.missing],
      notes: [],
    },
  };

  const db = dealBreakerStatus(car);
  let rating, ratingMax, confirmed;
  if (db.confirmed.length) {
    rating = ratingMax = 'AVOID';
    confirmed = true;
  } else {
    rating = band(scoreMin);
    ratingMax = band(scoreMax);
    confirmed = rating === ratingMax;
  }

  // "What to find out next": parts with uncertainty, widest first.
  const nextSteps = Object.entries(parts)
    .filter(([, p]) => p.max > p.min)
    .map(([part, p]) => ({ part, impact: p.max - p.min, fields: p.missing }))
    .sort((a, b) => b.impact - a.impact);

  const notes = Object.values(parts).flatMap((p) => p.notes);

  return {
    scoreMin,     // out of 100 (scaled from RAW_TOTAL)
    scoreMax,
    rawMin,       // raw points, out of RAW_TOTAL
    rawMax,
    rating,       // band of the worst case (or AVOID if a deal-breaker is confirmed)
    ratingMax,    // band of the best case
    confirmed,    // true when rating === ratingMax
    coverage,     // 0–100, share of points fully determined
    parts,
    categories,
    dealBreakers: db,
    warnings: warnings(car),
    notes,
    nextSteps,
  };
}
