// summary.js — short "Good signs" / "Watch out" lists from a car's data. Pure.
// Each item is { key, vars } where key is an i18n key under sum.good.* /
// sum.watch.*. Rules are listed in priority order; at most 3 per list.

import { num, carKm } from './scoring.js';

export const MAX_ITEMS = 3;

const round100 = (n) => Math.round(n / 100) * 100;

function ownerTypes(car) {
  const hist = Array.isArray(car.ownershipHistory) ? car.ownershipHistory.map((o) => (typeof o === 'string' ? o : o?.type)) : [];
  return [car.originalOwnership, ...hist].filter(Boolean);
}

function ymd(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

/**
 * car: a sanitized car; r: scoreCar(car, { asOf }) result.
 * Returns { good: [{key, vars}], watch: [{key, vars}] }.
 */
export function summarize(car, r, { asOf = new Date() } = {}) {
  const good = [];
  const watch = [];
  const kpy = r.parts.mileage.kmPerYear;
  const dev = r.parts.price.deviation;
  const types = ownerTypes(car);
  const hands = num(car.handCount);
  const km = carKm(car);

  // ----- good signs -----
  if (hands === 1 && car.originalOwnership === 'private') good.push({ key: 'sum.good.firstHandPrivate' });
  if (typeof dev === 'number' && dev <= -0.05) good.push({ key: 'sum.good.belowBenchmark', vars: { n: Math.round(-dev * 100) } });
  if (typeof kpy === 'number' && kpy < 15000) good.push({ key: 'sum.good.lowKm', vars: { km: round100(kpy) } });
  if (car.insuranceClaims === 'none' && car.serviceHistory === 'full') good.push({ key: 'sum.good.cleanHistory' });
  if (car.tires === 'good') good.push({ key: 'sum.good.tiresGood' });

  // ----- watch out -----
  if (r.warnings.includes('odometer_rollback')) watch.push({ key: 'sum.watch.odometer' });
  if (r.warnings.includes('structural_change')) watch.push({ key: 'sum.watch.structural' });
  if (car.insuranceClaims === 'major') watch.push({ key: 'sum.watch.claimsMajor' });
  else if (car.insuranceClaims === 'moderate') watch.push({ key: 'sum.watch.claimsModerate' });
  if (types.some((t) => t === 'rental' || t === 'driving_school')) watch.push({ key: 'sum.watch.exRental' });
  else if (types.includes('fleet_lease')) watch.push({ key: 'sum.watch.exFleet' });
  if (typeof dev === 'number' && dev > 0.05) watch.push({ key: 'sum.watch.aboveBenchmark', vars: { n: Math.round(dev * 100) } });
  if (km !== null && km > 130000) watch.push({ key: 'sum.watch.highTotalKm' });
  else if (typeof kpy === 'number' && kpy > 22000) watch.push({ key: 'sum.watch.highKm', vars: { km: round100(kpy) } });
  if (car.testExpiry) {
    if (car.testExpiry < ymd(asOf)) watch.push({ key: 'sum.watch.testExpired' });
    else if (r.parts.test.max === 0) watch.push({ key: 'sum.watch.testSoon' });
  }
  if (hands !== null && hands >= 3) watch.push({ key: 'sum.watch.manyHands', vars: { n: hands } });
  if (car.tires === 'worn') watch.push({ key: 'sum.watch.wornTires' });
  if (car.serviceHistory === 'missing_1_2_years' || car.serviceHistory === 'none') watch.push({ key: 'sum.watch.serviceGaps' });

  return { good: good.slice(0, MAX_ITEMS), watch: watch.slice(0, MAX_ITEMS) };
}
