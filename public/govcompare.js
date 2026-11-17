// govcompare.js — the ad vs. the registry (gov data). Pure.
//
// Identity fields (make, model, year, first registration): the registry value
// fills or overwrites the car silently. If the ad said something different it
// is remembered only so a "better-looking" claim (a newer year) can count
// against seller trust.
//
// Compared fields (owners, original ownership, km, test date, trim) keep what
// the ad / the user said; the registry values are stored next to them (the
// car's registry snapshot) and shown side by side. Each row gets a status:
//   match       the two agree (for km: ad km at or above the last-test km)
//   neutral     they differ, but not in the car's favour
//   suspicious  the ad makes the car look better than the registry
//   unknown     one side is missing
//
// Scoring uses the registry value whenever it exists (effectiveCar).

import { cleanValue, FIELDS } from './fields.js';
import { num } from './scoring.js';
import { sameName } from './modelmatch.js';

export const IDENTITY_KEYS = ['make', 'model', 'year', 'firstRegistration'];
export const ROW_KEYS = ['handCount', 'originalOwnership', 'km', 'testExpiry', 'trim'];
export const TRUST_CODES = ['fewerHands', 'ownership', 'odometer', 'newerYear', 'higherTrim'];
// Registry-only facts copied into the car when it doesn't have them.
const REGISTRY_ONLY = ['lastTestKm', 'lastTestDate', 'govStructuralChange', 'ownershipHistory'];
// Registry fields kept per car (the snapshot).
export const SNAPSHOT_KEYS = [...IDENTITY_KEYS, 'trim', 'originalOwnership', 'handCount', 'testExpiry', 'lastTestKm', 'lastTestDate'];

const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const LEASE = new Set(['private_lease', 'fleet_lease']);
const NOT_PRIVATE = new Set(['private_lease', 'fleet_lease', 'rental', 'driving_school']);
const clean = (key, v) => cleanValue(FIELD[key].type, v, FIELD[key].arg);
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
  if (a === `${r}plus` || String(ad).trim().toLowerCase() === `${String(reg).trim().toLowerCase()}+`) return true;
  const ta = trimTier(ad);
  const tr = trimTier(reg);
  return ta !== null && tr !== null && ta > tr;
}

/** Trims match when one's words are all part of the other's ("Sun" ~ "SUN"; "LE" ≠ "XLE"). */
function sameTrim(a, b) {
  const words = (x) => String(x).toLowerCase().split(/[\s/,+\-]+/).map(norm).filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  return wa.every((w) => wb.includes(w)) || wb.every((w) => wa.includes(w));
}

/** What the ad (or the user) says for a field; values that came from the registry don't count. */
export function adValue(car, key) {
  if (car.fieldSources?.[key] === 'gov') return null;
  return clean(key, car[key]);
}

// ---------- applying registry data to the car ----------

/**
 * Registry data arrives: identity fields are overwritten silently, registry-only
 * facts fill gaps; compared fields are left alone. Returns { car, adIdentity }
 * where adIdentity holds the ad's own identity values that differed.
 */
export function applyRegistry(car, gov, { models = [] } = {}) {
  const out = { ...car, fieldSources: { ...(car.fieldSources || {}) } };
  const adIdentity = {};
  for (const key of IDENTITY_KEYS) {
    const theirs = clean(key, gov?.[key]);
    if (theirs === null) continue;
    const mine = adValue(car, key);
    if (mine !== null) {
      const same = key === 'make' || key === 'model'
        ? sameName(mine, theirs, { kind: key, models, make: car.make }) !== false
        : String(mine) === String(theirs);
      if (!same) adIdentity[key] = mine;
    }
    out[key] = theirs;
    out.fieldSources[key] = 'gov';
  }
  for (const key of REGISTRY_ONLY) {
    const v = gov?.[key];
    const empty = out[key] === null || out[key] === undefined || out[key] === '' || (Array.isArray(out[key]) && !out[key].length);
    if (v !== null && v !== undefined && empty) {
      out[key] = v;
      out.fieldSources[key] = 'gov';
    }
  }
  return { car: out, adIdentity };
}

// ---------- the side-by-side rows ----------

/**
 * car: the car (ad / manual values). reg: registry fields.
 * Returns [{ key, ad, reg, regDate?, status, code? }] in ROW_KEYS order.
 */
export function comparisonRows(car, reg, { models = [] } = {}) {
  if (!reg) return [];
  const rows = [];
  const row = (key, ad, regV, judge, extra = {}) => {
    const r = { key, ad, reg: regV, ...extra };
    if (ad === null || ad === undefined || regV === null || regV === undefined) r.status = 'unknown';
    else Object.assign(r, judge(ad, regV));
    rows.push(r);
  };
  row('handCount', adValue(car, 'handCount'), clean('handCount', reg.handCount), (a, g) => (
    a === g ? { status: 'match' } : a < g ? { status: 'suspicious', code: 'fewerHands' } : { status: 'neutral' }));
  row('originalOwnership', adValue(car, 'originalOwnership'), clean('originalOwnership', reg.originalOwnership), (a, g) => {
    if (a === g || (LEASE.has(a) && LEASE.has(g))) return { status: 'match' }; // the registry can't tell lease kinds apart
    if (a === 'private' && NOT_PRIVATE.has(g)) return { status: 'suspicious', code: 'ownership' };
    return { status: 'neutral' };
  });
  row('km', adValue(car, 'currentKm'), clean('lastTestKm', reg.lastTestKm), (a, g) => (
    a < g ? { status: 'suspicious', code: 'odometer' } : { status: 'match' }), { regDate: clean('lastTestDate', reg.lastTestDate) });
  row('testExpiry', adValue(car, 'testExpiry'), clean('testExpiry', reg.testExpiry), (a, g) => (
    // ads often give only the month
    a.slice(0, 7) === g.slice(0, 7) ? { status: 'match' } : { status: 'neutral' }));
  row('trim', adValue(car, 'trim'), clean('trim', reg.trim), (a, g) => {
    if (isHigherTrim(a, g)) return { status: 'suspicious', code: 'higherTrim' };
    return sameTrim(a, g) ? { status: 'match' } : { status: 'neutral' };
  });
  return rows;
}

/**
 * Seller-trust issues from the rows plus the ad's identity claims:
 * [{ code, key, ad, gov }]. A newer year in the ad also counts.
 */
export function trustIssues(car, snapshot, { models = [] } = {}) {
  const reg = snapshot?.fields;
  if (!reg) return [];
  const out = comparisonRows(car, reg, { models })
    .filter((r) => r.status === 'suspicious')
    .map((r) => ({ code: r.code, key: r.key, ad: r.ad, gov: r.reg }));
  const adYear = num(snapshot.ad?.year);
  const regYear = num(reg.year);
  if (adYear !== null && regYear !== null && adYear > regYear) out.unshift({ code: 'newerYear', key: 'year', ad: adYear, gov: regYear });
  return out;
}

// ---------- scoring input ----------

/**
 * The car as scored: registry values win wherever they exist; for km the
 * higher of ad km and last-test km. Lease kinds: the registry only knows
 * "lease", so a private/fleet lease the user chose is kept.
 */
export function effectiveCar(car, reg) {
  if (!reg) return car;
  const out = { ...car };
  for (const key of [...IDENTITY_KEYS, 'handCount', 'testExpiry', 'trim', 'lastTestKm', 'lastTestDate']) {
    const v = reg[key];
    if (v !== null && v !== undefined && v !== '') out[key] = v;
  }
  if (reg.originalOwnership) {
    out.originalOwnership = LEASE.has(reg.originalOwnership) && LEASE.has(car.originalOwnership)
      ? car.originalOwnership : reg.originalOwnership;
  }
  const adKm = num(car.currentKm);
  const testKm = num(reg.lastTestKm);
  if (adKm !== null && testKm !== null) out.currentKm = Math.max(adKm, testKm);
  return out;
}

// ---------- storage ----------

/** Clean a registry snapshot for storage: { fields, ad } with known keys and valid values only. */
export function cleanSnapshot(fields, ad = {}) {
  const f = {};
  for (const k of SNAPSHOT_KEYS) {
    const v = clean(k, fields?.[k]);
    if (v !== null) f[k] = v;
  }
  const a = {};
  for (const k of IDENTITY_KEYS) {
    const v = clean(k, ad?.[k]);
    if (v !== null) a[k] = v;
  }
  return { fields: f, ad: a };
}
