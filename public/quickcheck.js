// quickcheck.js — stage 1: "is this worth messaging the seller?" from what an
// ad usually shows (price, km, year, model, ownership). Pure functions.
// The full 100-point score (scoring.js) is untouched; it takes over as the
// headline once coverage reaches QUICK_CHECK_UNTIL.
//
// Unknown fields never count against the car.

import { num, ageMonthsRange, resolveBenchmark } from './scoring.js';

export const QUICK_CHECK_UNTIL = 50;   // coverage % below which the quick check is the headline
export const MIN_COMPARABLES = 3;      // saved cars needed for a "your saved cars" comparison
export const KM_PRICE_ADJUST = 0.15;   // ₪ per km of difference from the comparables' median km
export const PRICE_BAND = 5;           // % above/below the comparison that counts

export const VERDICT_ORDER = { PURSUE: 0, MAYBE: 1, NOT_ENOUGH: 2, SKIP: 3 };
export const VERDICT_TONE = { PURSUE: 'good', MAYBE: 'ok', SKIP: 'bad', NOT_ENOUGH: 'neutral' };
export const MIN_KNOWN = 2; // of: price comparison, km/year, ownership

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function ownerTypes(car) {
  const hist = Array.isArray(car.ownershipHistory) ? car.ownershipHistory.map((o) => (typeof o === 'string' ? o : o?.type)) : [];
  return { original: car.originalOwnership || hist[0] || null, all: [car.originalOwnership, ...hist].filter(Boolean) };
}

function handCount(car) {
  const hc = num(car.handCount);
  if (hc !== null) return Math.floor(hc);
  return Array.isArray(car.ownershipHistory) && car.ownershipHistory.length ? car.ownershipHistory.length : null;
}

function refOf(asOf) {
  const d = asOf instanceof Date ? asOf : new Date(asOf ?? Date.now());
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

/**
 * km per year as a range [best case, worst case] (rounded to whole km), or
 * null. A range happens when only the model year is known.
 */
export function kmPerYear(car, asOf) {
  const km = num(car.currentKm) ?? num(car.lastTestKm);
  const age = ageMonthsRange(car, refOf(asOf));
  if (km === null || !age) return null;
  return { low: Math.round((km * 12) / age.max), high: Math.round((km * 12) / age.min) };
}

// ---------- price comparison ----------

/** Other saved cars: same make and model, year ±1, with an asking price. */
export function findComparables(car, others) {
  const make = norm(car.make);
  const model = norm(car.model);
  const year = num(car.year);
  if (!make || !model || year === null) return [];
  return (others || []).filter((o) => o && o !== car && (!car.id || o.id !== car.id)
    && norm(o.make) === make && norm(o.model) === model
    && num(o.year) !== null && Math.abs(num(o.year) - year) <= 1
    && num(o.askingPrice) > 0);
}

/** Median asking price of ≥3 comparables, adjusted for this car's km. null if too few. */
export function savedComparison(car, others) {
  const comps = findComparables(car, others);
  if (comps.length < MIN_COMPARABLES) return null;
  const medianPrice = median(comps.map((c) => num(c.askingPrice)));
  const kms = comps.map((c) => num(c.currentKm)).filter((k) => k !== null);
  const medianKm = kms.length ? median(kms) : null;
  const km = num(car.currentKm);
  // More km than the typical comparable → expect a lower price, and vice versa.
  const adjustment = km !== null && medianKm !== null ? -KM_PRICE_ADJUST * (km - medianKm) : 0;
  return { source: 'saved', value: Math.round(medianPrice + adjustment), n: comps.length, medianPrice, medianKm, adjusted: adjustment !== 0 };
}

/** Cache key for the AI estimate: re-fetch only when make, model, year or km change. */
export function estimateKey(car) {
  const make = norm(car.make);
  const model = norm(car.model);
  const year = num(car.year);
  if (!make || !model || year === null) return null;
  const km = num(car.currentKm);
  return `${make}|${model}|${year}|${km ?? ''}`;
}

/**
 * Which price to compare against, first available wins:
 *   1. a benchmark entered for the full score (Levi Yitzhak, or a Yad2 range)
 *   2. your saved cars (≥ 3 comparables)
 *   3. the cached rough AI estimate for this make/model/year/km
 * Returns { source, value, … } or null. `needsAi` says whether an AI estimate
 * would be used if we had one.
 */
export function resolveComparison(car, { others = [], estimate = null } = {}) {
  const manual = resolveBenchmark(car);
  if (manual) return { source: manual.source === 'levi_yitzhak' ? 'levi' : 'yad2', value: manual.value, needsAi: false };
  const saved = savedComparison(car, others);
  if (saved) return { ...saved, needsAi: false };
  const key = estimateKey(car);
  if (estimate && key && estimate.key === key && num(estimate.low) > 0 && num(estimate.high) > 0) {
    return { source: 'ai', value: Math.round((estimate.low + estimate.high) / 2), low: estimate.low, high: estimate.high, needsAi: true };
  }
  return { source: null, value: null, needsAi: Boolean(key) };
}

// ---------- the quick check ----------

/**
 * car: a car (sanitized or raw). opts:
 *   budget      budget ceiling in ₪ (or null)
 *   comparison  result of resolveComparison (or null)
 *   pending     true while an AI estimate is being fetched (don't flag "no comparison" yet)
 *   trust       suspicious registry mismatches (govcompare.trustIssues): 1 → Maybe, 2+ → Skip
 *   asOf        date for car age
 * Returns { verdict, known, knownCount, skip, maybe, good, notes, reasons } where each reason is
 * { key, vars } (i18n keys under qc.skip / qc.maybe / qc.good).
 */
export function quickCheck(car, { budget = null, comparison = null, pending = false, trust = [], asOf } = {}) {
  const skip = [];
  const maybe = [];
  const good = [];
  const notes = [];
  const price = num(car.askingPrice);
  const { original, all } = ownerTypes(car);
  const hands = handCount(car);
  const age = ageMonthsRange(car, refOf(asOf));
  const km = num(car.currentKm) ?? num(car.lastTestKm);
  const kpy = kmPerYear(car, asOf);
  const db = car.dealBreakers || {};

  // ----- skip -----
  const b = num(budget);
  if (b && price !== null && price > b) skip.push({ key: 'qc.skip.overBudget' });
  if (all.some((t) => t === 'rental' || t === 'driving_school')) skip.push({ key: 'qc.skip.rental' });
  if (hands !== null && hands >= 3 && age && age.max < 60) skip.push({ key: 'qc.skip.manyHandsYoung' });
  if (km !== null && km > 130000) skip.push({ key: 'qc.skip.highTotalKm' });
  else if (kpy && kpy.low > 28000) skip.push({ key: 'qc.skip.highKmYear' });
  if (car.cabinFit === 'tight') skip.push({ key: 'qc.skip.cabinTight' });
  if (Object.values(db).includes('yes')) skip.push({ key: 'qc.skip.dealBreaker' });
  if ((trust?.length || 0) >= 2) skip.push({ key: 'qc.skip.registryMismatch' });

  // ----- maybe -----
  if (original === 'fleet_lease') maybe.push({ key: 'qc.maybe.fleet' });
  else if (hands === 2 && original === 'private_lease') maybe.push({ key: 'qc.maybe.exLease2nd' });
  if (!(km !== null && km > 130000) && kpy && kpy.low > 22000 && kpy.low <= 28000) maybe.push({ key: 'qc.maybe.kmYear' });
  if (car.cabinFit === 'adequate') maybe.push({ key: 'qc.maybe.cabinAdequate' });
  if (trust?.length === 1) maybe.push({ key: 'qc.maybe.registryMismatch' });

  // ----- price vs comparison -----
  const cmp = comparison && comparison.value ? comparison : null;
  if (price !== null) {
    if (cmp) {
      const vars = { source: cmp.source, model: car.model || '' };
      if (100 * price > (100 + PRICE_BAND) * cmp.value) maybe.push({ key: `qc.price.high.${cmp.source}`, vars });
      else if (100 * price <= (100 - PRICE_BAND) * cmp.value) good.push({ key: `qc.price.low.${cmp.source}`, vars });
    } else if (!pending) {
      maybe.push({ key: 'qc.maybe.noComparison' });
    }
  }

  // ----- good signs (don't change the verdict) -----
  if (hands === 1 && original === 'private') good.push({ key: 'qc.good.firstHandPrivate' });
  if (kpy && kpy.high < 15000 && !(km > 130000)) good.push({ key: 'qc.good.lowKm' });
  if (car.cabinFit === 'easy') good.push({ key: 'qc.good.cabinEasy' });

  if (!original) notes.push({ key: 'qc.note.askOwnership' });

  // How much do we actually know? Without at least 2 of these the verdict
  // would just reflect missing data, so say so (unless something already
  // rules the car out).
  const known = {
    price: price !== null && Boolean(cmp),
    kmPerYear: Boolean(kpy) || (km !== null && km > 130000),
    ownership: Boolean(original),
  };
  const knownCount = Object.values(known).filter(Boolean).length;

  let verdict;
  if (skip.length) verdict = 'SKIP';
  else if (knownCount < MIN_KNOWN) verdict = 'NOT_ENOUGH';
  else verdict = maybe.length >= 3 ? 'SKIP' : maybe.length ? 'MAYBE' : 'PURSUE';
  return { verdict, known, knownCount, skip, maybe, good, notes, reasons: [...skip, ...maybe, ...good].slice(0, 3) };
}
