// govcompare.js — compare registry (gov) data with what the ad or the user
// says. Pure. Only flags a mismatch when we're confident the two disagree.

import { cleanValue, FIELDS } from './fields.js';
import { num } from './scoring.js';
import { sameName } from './modelmatch.js';

export const COMPARE_KEYS = ['make', 'model', 'year', 'trim', 'originalOwnership', 'handCount', 'testExpiry'];

const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const LEASE = new Set(['private_lease', 'fleet_lease']);
const valueKey = (v) => JSON.stringify(v);

/**
 * car: the current car (form draft). gov: fields from /api/gov.
 * resolved: { [key]: valueKey(gov value) } for mismatches the user already
 * settled by keeping their own value.
 * Returns [{ key, mine, gov }] plus an odometer entry when the ad km is below
 * the registry's last-test km.
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
    if (key === 'make' || key === 'model' || key === 'trim') {
      same = sameName(mine, theirs, { kind: key, models, make: car.make });
      if (same === null) continue; // can't tell: don't flag
    } else if (key === 'originalOwnership') {
      // The registry can't tell private lease from fleet lease.
      same = mine === theirs || (LEASE.has(mine) && LEASE.has(theirs));
    } else if (key === 'testExpiry') {
      same = String(mine).slice(0, 7) === String(theirs).slice(0, 7); // ads often give only the month
    } else {
      same = num(mine) === num(theirs);
    }
    if (!same) out.push({ key, mine, gov: theirs });
  }
  const km = num(car.currentKm);
  const testKm = num(gov.lastTestKm);
  if (km !== null && testKm !== null && km < testKm) out.push({ key: 'currentKm', mine: km, gov: testKm, odometer: true });
  return out;
}

export { valueKey };
