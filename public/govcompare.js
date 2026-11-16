// govcompare.js — compare registry (gov) data with what the ad or the user
// says, and decide which differences are suspicious. Pure.
//
// Only flags a mismatch when we're confident the two disagree. A mismatch is
// "suspicious" (seller trust) when the ad makes the car look better than the
// registry does:
//   fewerHands  fewer hands than registered
//   ownership   "private" when the registry says lease, fleet, rental or driving school
//   odometer    ad km lower than the last-test km
//   newerYear   a newer year than registered
//   higherTrim  a higher trim than registered (only when clearly higher)
// Everything else (other trim differences, test date off by a few weeks,
// more hands than registered, …) is a neutral conflict.

import { cleanValue, FIELDS } from './fields.js';
import { num } from './scoring.js';
import { sameName } from './modelmatch.js';

export const COMPARE_KEYS = ['make', 'model', 'year', 'trim', 'originalOwnership', 'handCount', 'testExpiry'];
export const TRUST_CODES = ['fewerHands', 'ownership', 'odometer', 'newerYear', 'higherTrim'];
// Registry fields kept per car (so the list can show trust flags without a new lookup).
export const SNAPSHOT_KEYS = [...COMPARE_KEYS, 'lastTestKm', 'lastTestDate'];

const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const LEASE = new Set(['private_lease', 'fleet_lease']);
const valueKey = (v) => JSON.stringify(v);
const norm = (s) => String(s || '').toLowerCase().replace(/[\s'"׳״\-_.&]/g, '');

// ---------- trim tiers (generic; only used to spot a clearly higher trim) ----------
const TRIM_TIERS = [
  ['base', 'basic', 'entry', 'standard', 'std', 'access', 'active', 'city', 'life', 'classic', 'בסיס', 'בסיסי'],
  ['comfort', 'ambition', 'style', 'elegance', 'design', 'inspire', 'intense', 'trend', 'קומפורט', 'סטייל', 'אלגנס'],
  ['premium', 'luxury', 'lux', 'prestige', 'executive', 'limited', 'platinum', 'signature', 'exclusive', 'top', 'full',
    'ultimate', 'supreme', 'laurinklement', 'lk', 'פרימיום', 'לוקסוס', 'יוקרה', 'טופ', 'פול', 'אקזקיוטיב'],
];

/** 1–3 for a recognised trim word, else null. */
export function trimTier(s) {
  const words = String(s || '').toLowerCase().split(/[\s/,+\-]+/).map(norm).filter(Boolean);
  let best = null;
  for (const w of words) {
    TRIM_TIERS.forEach((tier, i) => { if (tier.includes(w)) best = Math.max(best ?? 0, i + 1); });
  }
  return best;
}

/** True only when the ad's trim is clearly higher than the registry's. */
export function isHigherTrim(ad, reg) {
  const a = norm(ad);
  const r = norm(reg);
  if (!a || !r || a === r) return false;
  // "Sun Plus" / "Sun+" when the registry says "SUN"
  if (a === `${r}plus` || String(ad).trim().toLowerCase() === `${String(reg).trim().toLowerCase()}+`) return true;
  const ta = trimTier(ad);
  const tr = trimTier(reg);
  return ta !== null && tr !== null && ta > tr;
}

/**
 * car: the current car (form draft). gov: registry fields.
 * resolved: { [key]: valueKey(gov value) } for mismatches the user already
 * settled by keeping their own value.
 * Returns [{ key, mine, gov, suspicious: code | null, odometer? }].
 */
export function registryMismatches(car, gov, { models = [], resolved = {} } = {}) {
  if (!gov) return [];
  const out = [];
  for (const key of COMPARE_KEYS) {
    const f = FIELD[key];
    const mine = cleanValue(f.type, car[key], f.arg);
    const theirs = gov[key];
    if (mine === null || theirs === null || theirs === undefined) continue;
    if (resolved[key] === valueKey(theirs)) continue;
    let same;
    let suspicious = null;
    if (key === 'trim' && isHigherTrim(mine, theirs)) {
      same = false;
      suspicious = 'higherTrim';
    } else if (key === 'make' || key === 'model' || key === 'trim') {
      same = sameName(mine, theirs, { kind: key, models, make: car.make });
      if (same === null) continue; // can't tell: don't flag
    } else if (key === 'originalOwnership') {
      // The registry can't tell private lease from fleet lease.
      same = mine === theirs || (LEASE.has(mine) && LEASE.has(theirs));
      if (!same && mine === 'private') suspicious = 'ownership';
    } else if (key === 'testExpiry') {
      same = String(mine).slice(0, 7) === String(theirs).slice(0, 7); // ads often give only the month
    } else {
      same = num(mine) === num(theirs);
      if (!same && key === 'handCount' && num(mine) < num(theirs)) suspicious = 'fewerHands';
      if (!same && key === 'year' && num(mine) > num(theirs)) suspicious = 'newerYear';
    }
    if (!same) out.push({ key, mine, gov: theirs, suspicious });
  }
  const km = num(car.currentKm);
  const testKm = num(gov.lastTestKm);
  if (km !== null && testKm !== null && km < testKm && resolved.currentKm !== valueKey(testKm)) {
    out.push({ key: 'currentKm', mine: km, gov: testKm, odometer: true, suspicious: 'odometer' });
  }
  return out;
}

/** Only the suspicious mismatches: [{ code, key, ad, gov }]. */
export function trustIssues(car, gov, opts) {
  return registryMismatches(car, gov, opts)
    .filter((m) => m.suspicious)
    .map((m) => ({ code: m.suspicious, key: m.key, ad: m.mine, gov: m.gov }));
}

/** Clean a registry snapshot (from /api/gov) for storage: known keys, valid values only. */
export function cleanSnapshot(fields) {
  const out = {};
  for (const k of SNAPSHOT_KEYS) {
    const f = FIELD[k];
    const v = cleanValue(f.type, fields?.[k], f.arg);
    if (v !== null) out[k] = v;
  }
  return out;
}

export { valueKey };
