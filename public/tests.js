// tests.js — test cases for scoring.js. Runs in the browser (tests.html) and
// in Node (`node scripts/run-tests.js`). All tests pin asOf so results are
// deterministic regardless of today's date.

import { scoreCar, band, num, ENUMS, DEAL_BREAKERS, WEIGHTS, RAW_TOTAL, scaleTo100, carKm, kmPerYear as kpyOf } from './scoring.js';
import { FIELDS, sanitizeCar } from './fields.js';
import { STRINGS, SELLER } from './i18n.js';
import { configError, passwordMatches, createSession, verifySession, SESSION_SECONDS } from './auth.js';
import { verdict, knownPoints } from './verdict.js';
import { summarize } from './summary.js';
import { formatPlate } from './format.js';
import { sameName, canonicalMake } from './modelmatch.js';
import { applyRegistry, comparisonRows, trustIssues, effectiveCar, isHigherTrim, trimTier, cleanSnapshot, adValue } from './govcompare.js';
import { trustQuestions } from './seller.js';
import { quickCheck, findComparables, savedComparison, resolveComparison, estimateKey, kmPerYear, KM_PRICE_ADJUST } from './quickcheck.js';
import { normalizeEstimate, estimatePrompt, ESTIMATE_SCHEMA } from './priceestimate.js';
import { sellerMissing, sellerTopics, sellerPrompt, normalizeMessage, cleanTrust } from './sellermsg.js';
import { modelKey, normalizeNotes, NOTES_SCHEMA, buildGeminiNotesRequest, buildAnthropicNotesRequest, notesPrompt } from './modelnotes.js';
import { buildSellerMessage, waNumber, waLink } from './seller.js';
import { mapGov, mergeGov, mergeFields, stripCountry, normYm } from './govmap.js';
import { normalizeExtraction, validateImages, buildGeminiRequest, buildAnthropicRequest, parseGeminiResponse, parseAnthropicResponse, EXTRACT_SCHEMA } from './extraction.js';

const AS_OF = '2026-11-16';
const S = (car) => scoreCar(car, { asOf: AS_OF });

const tests = [];
const test = (group, name, fn) => tests.push({ group, name, fn });

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label ? label + ': ' : ''}expected ${e}, got ${a}`);
}
const range = (r) => [r.min, r.max];

// A car where every field is known and best-case. Used as a base for overrides.
const PERFECT = {
  insuranceClaims: 'none', serviceHistory: 'full',
  askingPrice: 90000, benchmarkPrice: 100000, benchmarkSource: 'levi_yitzhak',
  firstRegistration: '2024-11', currentKm: 20000,          // 24 months → 10,000 km/yr
  originalOwnership: 'private', handCount: 1,
  testExpiry: '2027-10-01', tires: 'good',
  dealBreakers: { structuralDamage: 'no', totalLoss: 'no', lien: 'no', sellerRefuses: 'no' },
};

// ---------------- Category 1: History & maintenance ----------------

for (const [claims, pts] of [['none', 30], ['cosmetic', 20], ['moderate', 10], ['major', 0]]) {
  test('1 History', `claims ${claims} + service full → ${pts}`, () =>
    eq(range(S({ insuranceClaims: claims, serviceHistory: 'full' }).parts.history), [pts, pts]));
}
for (const [svc, pts] of [['full', 30], ['mostly', 20], ['missing_1_2_years', 10], ['none', 0]]) {
  test('1 History', `service ${svc} + claims none → ${pts}`, () =>
    eq(range(S({ insuranceClaims: 'none', serviceHistory: svc }).parts.history), [pts, pts]));
}
test('1 History', 'min-of-two: cosmetic(20) + missing 1–2 yrs(10) → 10', () =>
  eq(range(S({ insuranceClaims: 'cosmetic', serviceHistory: 'missing_1_2_years' }).parts.history), [10, 10]));
test('1 History', 'min-of-two: moderate(10) + full(30) → 10', () =>
  eq(range(S({ insuranceClaims: 'moderate', serviceHistory: 'full' }).parts.history), [10, 10]));
test('1 History', 'min-of-two: none(30) + mostly(20) → 20', () =>
  eq(range(S({ insuranceClaims: 'none', serviceHistory: 'mostly' }).parts.history), [20, 20]));
test('1 History', 'claims none, service unknown → [0, 30] (spec example)', () =>
  eq(range(S({ insuranceClaims: 'none' }).parts.history), [0, 30]));
test('1 History', 'claims cosmetic, service unknown → [0, 20] (partial narrows max)', () =>
  eq(range(S({ insuranceClaims: 'cosmetic' }).parts.history), [0, 20]));
test('1 History', 'claims major, service unknown → [0, 0] (fully determined)', () => {
  const r = S({ insuranceClaims: 'major' });
  eq(range(r.parts.history), [0, 0]);
  eq(r.parts.history.min === r.parts.history.max, true);
});
test('1 History', 'both unknown → [0, 30]', () => eq(range(S({}).parts.history), [0, 30]));

// ---------------- Category 2: Price vs. benchmark ----------------

const price = (asking, bench) =>
  range(S({ askingPrice: asking, benchmarkPrice: bench, benchmarkSource: 'levi_yitzhak' }).parts.price);

test('2 Price', 'd = −6% → 25', () => eq(price(94000, 100000), [25, 25]));
test('2 Price', 'd = −5% exactly → 25', () => eq(price(95000, 100000), [25, 25]));
test('2 Price', 'd just above −5% → 18', () => eq(price(95001, 100000), [18, 18]));
test('2 Price', 'd = 0 → 18', () => eq(price(100000, 100000), [18, 18]));
test('2 Price', 'd = +5% exactly → 18', () => eq(price(105000, 100000), [18, 18]));
test('2 Price', 'd just above +5% → 8', () => eq(price(105001, 100000), [8, 8]));
test('2 Price', 'd = +10% exactly → 8', () => eq(price(110000, 100000), [8, 8]));
test('2 Price', 'd just above +10% → 0', () => eq(price(110001, 100000), [0, 0]));
test('2 Price', 'float-unsafe boundary: 82,935 vs 87,300 is exactly −5% → 25', () =>
  eq(price(82935, 87300), [25, 25]));
test('2 Price', 'float-unsafe boundary: 91,665 vs 87,300 is exactly +5% → 18', () =>
  eq(price(91665, 87300), [18, 18]));
test('2 Price', 'Yad2 range midpoint used, confidence LOW', () => {
  const r = S({ askingPrice: 95000, yad2Low: 90000, yad2High: 110000 });
  eq(range(r.parts.price), [25, 25]);
  eq(r.parts.price.benchmark.value, 100000);
  eq(r.notes.includes('price_confidence_low'), true);
});
test('2 Price', 'Levi Yitzhak wins over Yad2 range; normal confidence', () => {
  const r = S({ askingPrice: 100000, benchmarkPrice: 100000, benchmarkSource: 'levi_yitzhak', yad2Low: 50000, yad2High: 60000 });
  eq(range(r.parts.price), [18, 18]);
  eq(r.notes.includes('price_confidence_low'), false);
});
test('2 Price', 'asking unknown → [0, 25]', () =>
  eq(range(S({ benchmarkPrice: 100000 }).parts.price), [0, 25]));
test('2 Price', 'benchmark unknown → [0, 25]', () =>
  eq(range(S({ askingPrice: 100000 }).parts.price), [0, 25]));

// ---------------- Category 3: Mileage & age ----------------
// firstRegistration 2025-11 with asOf Nov 2026 = 12 months, so km = km/year.

const mil = (km, fr = '2025-11') => range(S({ currentKm: km, firstRegistration: fr }).parts.mileage);

test('3 Mileage', '14,999 km/yr → 20', () => eq(mil(14999), [20, 20]));
test('3 Mileage', '15,000 km/yr → 14', () => eq(mil(15000), [14, 14]));
test('3 Mileage', '22,000 km/yr → 14', () => eq(mil(22000), [14, 14]));
test('3 Mileage', '22,001 km/yr → 7', () => eq(mil(22001), [7, 7]));
test('3 Mileage', '28,000 km/yr → 7', () => eq(mil(28000), [7, 7]));
test('3 Mileage', '28,001 km/yr → 0', () => eq(mil(28001), [0, 0]));
test('3 Mileage', '22,000.4 km/yr rounds to 22,000 → 14', () => eq(mil(22000.4), [14, 14]));
test('3 Mileage', 'total 130,000 km over 10 yrs (13,000/yr) → 20', () => eq(mil(130000, '2016-11'), [20, 20]));
test('3 Mileage', 'total 130,001 km → 0 even at 13,000/yr', () => eq(mil(130001, '2016-11'), [0, 0]));
test('3 Mileage', 'months precision: 30,000 km over 18 months = 20,000/yr → 14', () =>
  eq(mil(30000, '2025-05'), [14, 14]));
test('3 Mileage', 'currentKm unknown → uses lastTestKm and notes it', () => {
  const r = S({ lastTestKm: 14000, firstRegistration: '2025-11' });
  eq(range(r.parts.mileage), [20, 20]);
  eq(r.notes.includes('km_from_last_test'), true);
});
test('3 Mileage', 'lastTestKm with lastTestDate: age measured to test date', () => {
  // 2024-11 → 2025-11 = 12 months; 16,000 km → 16,000/yr → 14
  // (measuring to today, 24 months, would give 8,000/yr → 20)
  const r = S({ lastTestKm: 16000, lastTestDate: '2025-11-01', firstRegistration: '2024-11' });
  eq(range(r.parts.mileage), [14, 14]);
});
test('3 Mileage', 'only model year known → estimated from July 1 of that year', () => {
  // 2024-07 → 2026-11 = 28 months; 30,000 km → 12,857/yr → 20
  const r = S({ currentKm: 30000, year: 2024 });
  eq(range(r.parts.mileage), [20, 20]);
  eq(r.parts.mileage.kmPerYear, 12857);
  eq(r.notes.includes('km_year_estimated'), true);
});
test('3 Mileage', 'ad km below last-test km → the higher (last-test) km is scored', () => {
  // 2025-11 → 12 months. Ad 14,000 (→ 20) but test 16,000 → 16,000/yr → 14
  const r = S({ currentKm: 14000, lastTestKm: 16000, firstRegistration: '2025-11' });
  eq(range(r.parts.mileage), [14, 14]);
  eq(r.parts.mileage.kmPerYear, 16000);
});
test('3 Mileage', 'km unknown → [0, 20]', () => eq(range(S({ firstRegistration: '2022-01' }).parts.mileage), [0, 20]));
test('3 Mileage', 'km known, age unknown → [0, 20]', () => eq(range(S({ currentKm: 50000 }).parts.mileage), [0, 20]));

// ---------------- Category 4: Ownership & hand count ----------------
// Default firstRegistration 2023-01 → 46 months old (under 5 years).

const own = (o, fr = '2023-01') => range(S({ ...o, firstRegistration: fr }).parts.ownership);

test('4 Ownership', '1st hand private → 15', () => eq(own({ originalOwnership: 'private', handCount: 1 }), [15, 15]));
test('4 Ownership', '1st hand private lease → 11', () => eq(own({ originalOwnership: 'private_lease', handCount: 1 }), [11, 11]));
test('4 Ownership', '1st hand fleet lease → 6', () => eq(own({ originalOwnership: 'fleet_lease', handCount: 1 }), [6, 6]));
test('4 Ownership', '1st hand rental → 0', () => eq(own({ originalOwnership: 'rental', handCount: 1 }), [0, 0]));
test('4 Ownership', '1st hand driving school → 0', () => eq(own({ originalOwnership: 'driving_school', handCount: 1 }), [0, 0]));
test('4 Ownership', '2nd hand, all private → 11', () =>
  eq(own({ handCount: 2, ownershipHistory: ['private', 'private'] }), [11, 11]));
test('4 Ownership', '2nd hand ex-private-lease → 6', () =>
  eq(own({ handCount: 2, ownershipHistory: ['private_lease', 'private'] }), [6, 6]));
test('4 Ownership', '2nd hand ex-fleet-lease → 6', () =>
  eq(own({ handCount: 2, ownershipHistory: ['fleet_lease', 'private'] }), [6, 6]));
test('4 Ownership', '2nd hand, rental in history → 0', () =>
  eq(own({ handCount: 2, ownershipHistory: ['private', 'rental'] }), [0, 0]));
test('4 Ownership', 'other combination (private → fleet lease) → 6 + review flag', () => {
  const r = S({ firstRegistration: '2023-01', handCount: 2, ownershipHistory: ['private', 'fleet_lease'] });
  eq(range(r.parts.ownership), [6, 6]);
  eq(r.notes.includes('ownership_review'), true);
});
test('4 Ownership', '3 hands, under 5 years (59 months) → 0', () =>
  eq(own({ handCount: 3, ownershipHistory: ['private', 'private', 'private'] }, '2021-12'), [0, 0]));
test('4 Ownership', '3 hands, exactly 5 years (60 months) → 6 (other, review)', () =>
  eq(own({ handCount: 3, ownershipHistory: ['private', 'private', 'private'] }, '2021-11'), [6, 6]));
test('4 Ownership', 'everything unknown → [0, 15]', () => eq(range(S({}).parts.ownership), [0, 15]));
test('4 Ownership', 'original private, hand count unknown → [0, 15]', () =>
  eq(own({ originalOwnership: 'private' }), [0, 15]));
test('4 Ownership', '2 hands, original private, 2nd owner unknown → [0, 11]', () =>
  eq(own({ originalOwnership: 'private', handCount: 2 }), [0, 11]));
test('4 Ownership', '1 hand, type unknown → [0, 15]', () => eq(own({ handCount: 1 }), [0, 15]));

// ---------------- km per year (one shared function) ----------------

test('km/year', 'from the registry first-registration date', () =>
  eq(kpyOf({ currentKm: 36000, firstRegistration: '2024-11', year: 2023 }, AS_OF),
    { value: 18000, km: 36000, months: 24, from: 'registration', estimated: false, toTest: false }));
test('km/year', 'model-year fallback assumes July 1, marked estimated', () => {
  // 2023-07 → 2026-11 = 40 months; 60,000 km → 18,000/yr
  const k = kpyOf({ currentKm: 60000, year: 2023 }, AS_OF);
  eq([k.value, k.months, k.from, k.estimated], [18000, 40, 'year', true]);
});
test('km/year', 'only the last-test km → divided by the time up to the test date', () => {
  // 2023-01 → test 2025-01 = 24 months; 40,000 km → 20,000/yr (to today it would be 10,435)
  const k = kpyOf({ lastTestKm: 40000, lastTestDate: '2025-01-20', firstRegistration: '2023-01' }, AS_OF);
  eq([k.value, k.months, k.toTest], [20000, 24, true]);
});
test('km/year', 'last-test km without a test date → up to today', () =>
  eq(kpyOf({ lastTestKm: 46000, firstRegistration: '2023-01' }, AS_OF).value, 12000));
test('km/year', 'uses the higher of ad km and last-test km', () => {
  eq(carKm({ currentKm: 50000, lastTestKm: 60000 }), 60000);
  eq(carKm({ currentKm: 70000, lastTestKm: 60000 }), 70000);
  eq(kpyOf({ currentKm: 50000, lastTestKm: 60000, lastTestDate: '2025-01-20', firstRegistration: '2023-11' }, AS_OF).value, 20000);
});
test('km/year', 'no km or no age → null', () => {
  eq(kpyOf({ year: 2022 }, AS_OF), null);
  eq(kpyOf({ currentKm: 50000 }, AS_OF), null);
});
test('km/year', 'scoring, quick check and the seller topics use the same value', () => {
  const car = { currentKm: 75000, year: 2023, originalOwnership: 'private' }; // 40 months → 22,500/yr
  eq(S(car).parts.mileage.kmPerYear, 22500);
  eq(range(S(car).parts.mileage), [7, 7]);
  eq(quickCheck(car, { asOf: AS_OF }).maybe.map((r) => r.key), ['qc.maybe.kmYear']);
  eq(sellerTopics(car, { asOf: AS_OF }).includes('highKm'), true);
});

// ---------------- Location ----------------

test('Location', 'free-text field: kept, trimmed, stored in its own column, not scored', () => {
  const car = sanitizeCar({ ...PERFECT, location: '  Tel Aviv  ' });
  eq(car.location, 'Tel Aviv');
  eq(FIELDS.find((f) => f.key === 'location').col, 'location');
  eq(S(car).scoreMin, S(PERFECT).scoreMin, 'no score change');
  eq(sanitizeCar({ location: '   ' }).location, null);
});
test('Location', 'screenshot extraction reads the city', () => {
  eq('location' in EXTRACT_SCHEMA.properties && EXTRACT_SCHEMA.required.includes('location'), true);
  eq(normalizeExtraction({ location: ' פתח תקווה ' }).location, 'פתח תקווה');
  eq(normalizeExtraction({}).location, null);
});
test('Location', 'has EN and HE labels', () => eq([STRINGS.en['field.location'], STRINGS.he['field.location']], ['Location', 'מיקום']));

// ---------------- Cabin fit is gone ----------------

test('No cabin fit', 'not a field, a weight, an enum or a string', () => {
  eq(FIELDS.some((f) => f.key === 'cabinFit'), false, 'field');
  eq('cabin' in WEIGHTS || 'cabinFit' in ENUMS, false, 'weight/enum');
  eq(Object.keys(STRINGS.en).filter((k) => /cabin/i.test(k)), [], 'strings');
  eq(JSON.stringify(STRINGS).match(/stroller|car seats|עגלה/gi), null, 'text');
});
test('No cabin fit', 'a stored cabin_fit value is ignored everywhere', () => {
  const car = { ...PERFECT, cabinFit: 'tight' };
  eq(sanitizeCar(car).cabinFit, undefined, 'sanitize drops it');
  eq(S(car).scoreMin, 100, 'score');
  eq('cabin' in S(car).parts, false, 'parts');
  eq(quickCheck(car, { asOf: AS_OF }).skip, [], 'quick check');
  eq(summarize(car, S(car), { asOf: AS_OF }).watch, [], 'summary');
  eq(/cabin|stroller/i.test(sellerPrompt(car, { reasons: [] })), false, 'seller prompt');
});

// ---------------- Totals scaled to 100 ----------------

test('Scaling', 'categories total 94 raw points, shown out of 100', () => {
  eq(RAW_TOTAL, 94);
  eq([94, 47, 0, 56, 75].map(scaleTo100), [100, 50, 0, 60, 80]);
});
test('Scaling', 'perfect raw 94 → 100; categories keep their own maximums', () => {
  const r = S(PERFECT);
  eq([r.rawMin, r.scoreMin], [94, 100]);
  eq([r.parts.price.max, r.parts.price.weight, r.parts.mileage.weight], [25, 25, 20]);
});
test('Scaling', 'raw 47 → 50 (history 30 + mileage 14 + test 2 + tires 1)', () => {
  const r = S({ insuranceClaims: 'none', serviceHistory: 'full', currentKm: 15000, firstRegistration: '2025-11',
    askingPrice: 200000, benchmarkPrice: 100000, originalOwnership: 'rental', handCount: 1, testExpiry: '2027-10-01', tires: 'ok' });
  eq([r.rawMin, r.rawMax, r.scoreMin, r.scoreMax, r.coverage], [47, 47, 50, 50, 100]);
  eq(r.rating, 'AVOID');
});
test('Scaling', 'the 60/80 thresholds apply to the scaled total', () => {
  // service mostly (20) + price at benchmark (18) + mileage 20 + ownership 15 + test 1 + tires 1 = raw 75 → 80
  const s80 = S({ ...PERFECT, serviceHistory: 'mostly', askingPrice: 100000, tires: 'ok', testExpiry: '2027-03-01' });
  eq([s80.rawMin, s80.scoreMin, s80.rating], [75, 80, 'STRONG_BUY']);
  // same with tires worn: raw 74 → 79 → OK
  const s79 = S({ ...PERFECT, serviceHistory: 'mostly', askingPrice: 100000, tires: 'worn', testExpiry: '2027-03-01' });
  eq([s79.rawMin, s79.scoreMin, s79.rating], [74, 79, 'OK']);
});

// ---------------- Category 5b: Upfront condition ----------------
// asOf 2026-11-16: +6 months = 2027-05-16, +3 months = 2027-02-16.

const tst = (exp) => range(S({ testExpiry: exp }).parts.test);
test('5b Condition', 'test exactly 6 months left → 2', () => eq(tst('2027-05-16'), [2, 2]));
test('5b Condition', 'test 1 day short of 6 months → 1', () => eq(tst('2027-05-15'), [1, 1]));
test('5b Condition', 'test exactly 3 months left → 1', () => eq(tst('2027-02-16'), [1, 1]));
test('5b Condition', 'test 1 day short of 3 months → 0', () => eq(tst('2027-02-15'), [0, 0]));
test('5b Condition', 'test expired → 0', () => eq(tst('2026-01-01'), [0, 0]));
test('5b Condition', 'test unknown → [0, 2]', () => eq(range(S({}).parts.test), [0, 2]));
for (const [t, pts] of [['good', 2], ['ok', 1], ['worn', 0]]) {
  test('5b Condition', `tires ${t} → ${pts}`, () => eq(range(S({ tires: t }).parts.tires), [pts, pts]));
}
test('5b Condition', 'category total = test + tires', () =>
  eq(range(S({ testExpiry: '2027-03-01', tires: 'good' }).categories.condition), [3, 3]));

// ---------------- Ratings & totals ----------------

test('Ratings', 'band edges: 100/80 STRONG_BUY, 79/60 OK, 59/0 AVOID', () =>
  eq([100, 80, 79, 60, 59, 0].map(band), ['STRONG_BUY', 'STRONG_BUY', 'OK', 'OK', 'AVOID', 'AVOID']));

test('Ratings', 'fully unknown car → [0, 100], coverage 0, provisional', () => {
  const r = S({});
  eq([r.scoreMin, r.scoreMax], [0, 100]);
  eq(r.coverage, 0);
  eq([r.rating, r.ratingMax, r.confirmed], ['AVOID', 'STRONG_BUY', false]);
  eq(r.dealBreakers.open.length, 4, 'all deal-breakers open');
});

test('Ratings', 'perfect car → [100, 100] STRONG_BUY confirmed, coverage 100', () => {
  const r = S(PERFECT);
  eq([r.scoreMin, r.scoreMax, r.rating, r.confirmed, r.coverage], [100, 100, 'STRONG_BUY', true, 100]);
  eq(r.nextSteps, []);
});

for (const k of ['structuralDamage', 'totalLoss', 'lien', 'sellerRefuses']) {
  test('Deal-breakers', `${k} = yes → AVOID even at 100 points`, () => {
    const r = S({ ...PERFECT, dealBreakers: { ...PERFECT.dealBreakers, [k]: 'yes' } });
    eq([r.scoreMin, r.scoreMax], [100, 100]);
    eq([r.rating, r.ratingMax, r.confirmed], ['AVOID', 'AVOID', true]);
    eq(r.dealBreakers.confirmed, [k]);
  });
}
test('Deal-breakers', 'unknown deal-breaker is an open flag, not a pass or a fail', () => {
  const r = S({ ...PERFECT, dealBreakers: { ...PERFECT.dealBreakers, lien: 'unknown' } });
  eq(r.rating, 'STRONG_BUY');
  eq(r.dealBreakers, { confirmed: [], open: ['lien'] });
});

test('Warnings', 'ad km below last-test km → odometer_rollback, no score change', () => {
  const base = S(PERFECT);
  const r = S({ ...PERFECT, lastTestKm: 25000 });
  eq(r.warnings, ['odometer_rollback']);
  eq([r.scoreMin, r.scoreMax], [base.scoreMin, base.scoreMax]);
});
test('Warnings', 'gov structural-change flag → structural_change warning', () =>
  eq(S({ govStructuralChange: true }).warnings, ['structural_change']));

test('Inputs', 'numbers as strings with commas/₪ are parsed', () =>
  eq([num('85,000'), num('₪ 92,500'), num(''), num('abc'), num(-5)], [85000, 92500, null, null, null]));

// ---------------- Worked example from the spec ----------------
/*
  2022 Corolla sedan, first registered Jan 2022, 86,000 km, scored Nov 2026,
  1st hand private lease, everything else unknown.

  1 History    claims ?, service ?          → [0, 30]
  2 Price      asking ?, benchmark ?        → [0, 25]
  3 Mileage    Jan 2022 → Nov 2026 = 58 months = 4.833 yrs
               86,000 / 4.833 = 17,793 km/yr (15,000–22,000 band); total < 130k
                                            → [14, 14]
  4 Ownership  1 hand, private lease        → [11, 11]
               (car is < 5 yrs old, but only 1 hand, so the 0-rule doesn't apply)
  5b Condition test ? [0, 2] + tires ? [0, 2] → [0, 4]
  ─────────────────────────────────────────────────────
  Raw    min = 0 + 0 + 14 + 11 + 0  = 25  of 94
         max = 30 + 25 + 14 + 11 + 4 = 84
  Scaled ×100/94: 25 → 27, 84 → 89
  Rating: 27 → AVOID, 89 → STRONG BUY → provisional "27–89: AVOID → possibly STRONG BUY"
  Coverage: mileage 20 + ownership 15 = 35 of 94 → 37%
  Find out next: history (30), price (25), test (2), tires (2)
  Deal-breakers: all 4 open.
*/
test('Example', '2022 Corolla, private lease, 86k km → [27, 89], coverage 37%', () => {
  const r = S({
    make: 'Toyota', model: 'Corolla', trim: 'sedan', year: 2022,
    firstRegistration: '2022-01', currentKm: 86000,
    originalOwnership: 'private_lease', handCount: 1,
  });
  eq(range(r.parts.history), [0, 30], 'history');
  eq(range(r.parts.price), [0, 25], 'price');
  eq(range(r.parts.mileage), [14, 14], 'mileage');
  eq(Math.round(r.parts.mileage.kmPerYear), 17793, 'km/yr');
  eq(range(r.parts.ownership), [11, 11], 'ownership');
  eq(range(r.categories.condition), [0, 4], 'condition');
  eq([r.rawMin, r.rawMax], [25, 84], 'raw');
  eq([r.scoreMin, r.scoreMax], [27, 89], 'total');
  eq([r.rating, r.ratingMax, r.confirmed], ['AVOID', 'STRONG_BUY', false], 'rating');
  eq(r.coverage, 37, 'coverage');
  eq(r.nextSteps.map((s) => [s.part, s.impact]), [['history', 30], ['price', 25], ['test', 2], ['tires', 2]], 'next steps');
  eq(r.dealBreakers.open.length, 4, 'open deal-breakers');
});

// ---------------- i18n & fields ----------------

test('i18n', 'English and Hebrew have exactly the same keys', () => {
  const en = Object.keys(STRINGS.en).sort();
  const he = Object.keys(STRINGS.he).sort();
  eq(en.filter((k) => !he.includes(k)), [], 'missing in he');
  eq(he.filter((k) => !en.includes(k)), [], 'missing in en');
});
test('i18n', 'every code the scorer/form can produce has a string', () => {
  const need = [
    ...['STRONG_BUY', 'OK', 'AVOID'].map((r) => `rating.${r}`),
    ...Object.keys(WEIGHTS).map((p) => `part.${p}`),
    ...DEAL_BREAKERS.map((k) => `db.${k}`),
    ...ENUMS.triState.map((v) => `tri.${v}`),
    ...ENUMS.ownershipType.map((v) => `ownershipType.${v}`),
    ...['insuranceClaims', 'serviceHistory', 'tires', 'status'].flatMap((e) => ENUMS[e].map((v) => `${e}.${v}`)),
    ...['odometer_rollback', 'structural_change'].map((w) => `warn.${w}`),
    ...['price_confidence_low', 'km_from_last_test', 'ownership_review'].map((n) => `note.${n}`),
    ...FIELDS.filter((f) => !['benchmarkSource', 'govStructuralChange'].includes(f.key)).map((f) => `field.${f.key}`),
  ];
  eq(need.filter((k) => !(k in STRINGS.en)), [], 'missing keys');
});

test('Fields', 'sanitizeCar cleans bad input to null and defaults', () => {
  const c = sanitizeCar({
    plate: '12-345-67', currentKm: '86,000', year: 'abc', firstRegistration: '2022-13',
    testExpiry: '2027-02-30', insuranceClaims: 'bogus', listingUrl: 'javascript:alert(1)',
    dealBreakers: { lien: 'yes', totalLoss: 'maybe' }, fieldSources: { currentKm: 'gov', hacked: 'manual', plate: 'nope' },
  });
  eq([c.plate, c.currentKm, c.year, c.firstRegistration, c.testExpiry, c.insuranceClaims, c.listingUrl, c.status],
    ['1234567', 86000, null, null, null, null, null, 'considering']);
  eq(c.dealBreakers, { structuralDamage: 'unknown', totalLoss: 'unknown', lien: 'yes', sellerRefuses: 'unknown' });
  eq(c.fieldSources, { currentKm: 'gov' });
});

// ---------------- Seller message ----------------

const TEMPLATE = 'היי, אשמח לכמה פרטים יבשים לפני שמגיע לראות: מה המקוריות של הרכב (פרטי / ליסינג / השכרה)? איזו רמת גימור בדיוק? מתי תאריך עלייה לכביש ועד מתי הטסט? יש היסטוריית טיפולים מלאה ודו"ח סליקה נקי מתאונות?';

test('Seller', 'plate known, all template fields missing → exactly the spec template', () =>
  eq(buildSellerMessage({ plate: '1234567' }), TEMPLATE));
test('Seller', 'plate missing → plate question added right after the opener', () => {
  const m = buildSellerMessage({});
  eq(m.startsWith(`${SELLER.he.opener} ${SELLER.he.plate} ${SELLER.he.ownership}`), true);
});
test('Seller', 'everything known → null (nothing to ask)', () =>
  eq(buildSellerMessage({
    plate: '1234567', originalOwnership: 'private', trim: 'Sun', firstRegistration: '2022-01',
    testExpiry: '2027-01-01', serviceHistory: 'full', insuranceClaims: 'none',
  }), null));
test('Seller', 'only test missing → asks only "until when is the test"', () =>
  eq(buildSellerMessage({
    plate: '1234567', originalOwnership: 'private', trim: 'Sun', firstRegistration: '2022-01',
    serviceHistory: 'full', insuranceClaims: 'none',
  }), `${SELLER.he.opener} ${SELLER.he.test}`));
test('Seller', 'only Slikah missing → asks only for the Slikah report', () =>
  eq(buildSellerMessage({
    plate: '1234567', originalOwnership: 'private', trim: 'Sun', firstRegistration: '2022-01',
    testExpiry: '2027-01-01', serviceHistory: 'full',
  }), `${SELLER.he.opener} ${SELLER.he.slikah}`));
test('Seller', 'model year alone does not count as known registration date', () =>
  eq(buildSellerMessage({ plate: '1', year: 2022, originalOwnership: 'private', trim: 'x', testExpiry: '2027-01-01', serviceHistory: 'full', insuranceClaims: 'none' }),
    `${SELLER.he.opener} ${SELLER.he.reg}`));
test('Seller', 'English option uses the English wording', () =>
  eq(buildSellerMessage({ plate: '1234567', trim: 'x', originalOwnership: 'private', firstRegistration: '2022-01', testExpiry: '2027-01-01' }, 'en'),
    `${SELLER.en.opener} ${SELLER.en.serviceAndSlikah}`));
test('Seller', 'he and en message tables have the same keys', () =>
  eq(Object.keys(SELLER.he).sort(), Object.keys(SELLER.en).sort()));
test('Seller', 'wa.me number from Israeli formats', () =>
  eq(['050-123-4567', '+972 50 123 4567', '00972501234567', '972501234567', '123', ''].map(waNumber),
    ['972501234567', '972501234567', '972501234567', '972501234567', null, null]));
test('Seller', 'wa.me link has the message URL-encoded', () =>
  eq(waLink('050-1234567', 'היי? a&b'), `https://wa.me/972501234567?text=${encodeURIComponent('היי? a&b')}`));
test('Seller', 'no phone → no link', () => eq(waLink(null, 'x'), null));

// ---------------- Gov data mapping ----------------
// Fixtures are real records fetched from data.gov.il on 2026-11-16.

const OCTAVIA = {
  registry: { mispar_rechev: 36181801, tozeret_nm: "סקודה צ'כיה", ramat_gimur: 'RS', shnat_yitzur: 2017, mivchan_acharon_dt: '2025-12-08',
    tokef_dt: '2026-12-04', baalut: 'פרטי', tzeva_rechev: 'אדום', sug_delek_nm: 'בנזין', moed_aliya_lakvish: '2017-12', kinuy_mishari: 'OCTAVIA' },
  history: { mispar_rechev: 36181801, kilometer_test_aharon: 114529, shinui_mivne_ind: 1, gapam_ind: 0, shnui_zeva_ind: 1,
    shinui_zmig_ind: 0, rishum_rishon_dt: '2017-12-05', mkoriut_nm: '' },
  ownership: [
    [201712, 'חברה'], [201805, 'פרטי'], [201912, 'פרטי'], [202001, 'סוחר'], [202001, 'פרטי'],
    [202007, 'פרטי'], [202102, 'פרטי'], [202210, 'סוחר'], [202302, 'פרטי'],
  ].map(([d, b], i) => ({ _id: i + 1, mispar_rechev: 36181801, baalut_dt: d, baalut: b })),
};
const A3 = {
  registry: { tozeret_nm: 'אאודי גרמניה', ramat_gimur: 'ADV TAC PREM', shnat_yitzur: 2023, mivchan_acharon_dt: '2026-05-11',
    tokef_dt: '2027-04-22', baalut: 'פרטי', moed_aliya_lakvish: '2023-4', kinuy_mishari: 'A3 SEDAN' },
  history: { kilometer_test_aharon: 47831, shinui_mivne_ind: 1, shnui_zeva_ind: 1, shinui_zmig_ind: 0, rishum_rishon_dt: '2023-04-23', mkoriut_nm: '' },
  ownership: [{ _id: 2, baalut_dt: 202502, baalut: 'פרטי' }, { _id: 1, baalut_dt: 202304, baalut: 'פרטי' }],
};

test('Gov', 'Octavia: registry + history fields mapped', () => {
  const { fields: f } = mapGov(OCTAVIA);
  eq([f.make, f.model, f.trim, f.year, f.firstRegistration, f.testExpiry, f.lastTestDate, f.lastTestKm, f.govStructuralChange],
    ['סקודה', 'OCTAVIA', 'RS', 2017, '2017-12', '2026-12-04', '2025-12-08', 114529, true]);
});
test('Gov', 'Octavia: dealer rows excluded → 7 hands, original = company (fleet)', () => {
  const { fields: f, hints } = mapGov(OCTAVIA);
  eq(f.handCount, 7);
  eq(f.originalOwnership, 'fleet_lease');
  eq(f.ownershipHistory.map((o) => o.type), ['fleet_lease', 'private', 'private', 'private', 'private', 'private', 'private']);
  eq(f.ownershipHistory[0].from, '2017-12-01');
  eq(hints, [{ code: 'dealer_excluded', n: 2 }, { code: 'company_owner' }]);
});
test('Gov', 'A3: unpadded month "2023-4" → "2023-04"; owners sorted by date', () => {
  const { fields: f } = mapGov(A3);
  eq([f.make, f.firstRegistration, f.handCount, f.originalOwnership], ['אאודי', '2023-04', 2, 'private']);
  eq(f.ownershipHistory.map((o) => o.from), ['2023-04-01', '2025-02-01']);
});
test('Gov', 'originality (mkoriut_nm) overrides first owner: rental company → rental', () => {
  const { fields: f } = mapGov({ ...A3, history: { ...A3.history, mkoriut_nm: 'השכרה' }, ownership: [{ _id: 1, baalut_dt: 202304, baalut: 'חברה' }] });
  eq([f.originalOwnership, f.ownershipHistory[0].type], ['rental', 'rental']);
});
test('Gov', 'driving school originality (with stray quote in source data)', () =>
  eq(mapGov({ history: { mkoriut_nm: 'ביס לנהיגה"' } }).fields.originalOwnership, 'driving_school'));
test('Gov', 'lease (החכר) → fleet lease, flagged as assumed', () => {
  const g = mapGov({ ownership: [{ _id: 1, baalut_dt: 202001, baalut: 'החכר' }] });
  eq(g.fields.originalOwnership, 'fleet_lease');
  eq(g.hints.map((h) => h.code), ['lease_type_unknown']);
});
test('Gov', 'ownership dataset failed (null) → ownership fields stay unknown', () => {
  const { fields: f } = mapGov({ ...A3, ownership: null });
  eq([f.handCount, f.originalOwnership, f.ownershipHistory], [null, null, null]);
});
test('Gov', 'history missing → structural flag unknown, not false', () =>
  eq(mapGov({ registry: A3.registry, history: null, ownership: [] }).fields.govStructuralChange, null));
test('Gov', 'stripCountry / normYm helpers', () => {
  eq([stripCountry('טויוטה יפן'), stripCountry('מרצדס בנץ גרמניה'), stripCountry('BYD')], ['טויוטה', 'מרצדס בנץ', 'BYD']);
  eq([normYm('2023-4'), normYm('2017-12'), normYm('2023-13'), normYm('')], ['2023-04', '2017-12', null, null]);
});
test('Gov', 'gov fields + structural flag feed scoring: warning appears, km/yr from test date', () => {
  const car = mergeGov({ currentKm: 100000 }, mapGov(OCTAVIA).fields).car;
  const r = S(car);
  eq(r.warnings, ['odometer_rollback', 'structural_change']);
});

test('Merge', 'gov fills only empty fields and marks them as gov-sourced', () => {
  const { car, filled, conflicts } = mergeGov({ make: 'סקודה', currentKm: '120,000', fieldSources: { make: 'manual' } }, mapGov(OCTAVIA).fields);
  eq(filled.includes('make'), false);
  eq(filled.includes('trim') && filled.includes('lastTestKm') && filled.includes('handCount'), true);
  eq(conflicts, []);
  eq([car.fieldSources.make, car.fieldSources.trim, car.trim], ['manual', 'gov', 'RS']);
});
test('Merge', 'differing values are reported as conflicts and not overwritten', () => {
  const { car, conflicts } = mergeGov({ year: '2018', model: 'octavia', handCount: '2' }, mapGov(OCTAVIA).fields);
  eq(conflicts.map((c) => [c.key, c.mine, c.gov]), [['year', 2018, 2017], ['handCount', 2, 7]]);
  eq([car.year, car.handCount], ['2018', '2']);
});
test('Merge', 'same value in different case is not a conflict', () =>
  eq(mergeGov({ model: 'Octavia' }, { model: 'OCTAVIA' }).conflicts, []));
test('Merge', 'structural flag is always taken from gov (no conflict)', () =>
  eq(mergeGov({ govStructuralChange: false }, { govStructuralChange: true }).car.govStructuralChange, true));

// ---------------- Screenshot extraction ----------------

const MODEL_OUT = {
  plate: '12-345-67', make: 'טויוטה', model: 'קורולה', trim: 'Sun', year: 2022, firstRegistration: '2022-1',
  currentKm: '86,000', askingPrice: 98000, handCount: 1, originalOwnership: 'private_lease', testExpiry: '2027-03',
  tires: 'excellent', sellerPhone: '050-1234567', notes: 'ללא תאונות, טיפולים בסוכנות',
  insuranceClaims: 'none', // not in schema: must be dropped
};
test('Extract', 'model output is cleaned into car fields', () => {
  const f = normalizeExtraction(MODEL_OUT);
  eq([f.plate, f.make, f.model, f.year, f.firstRegistration, f.currentKm, f.askingPrice, f.handCount, f.originalOwnership, f.sellerPhone],
    ['1234567', 'טויוטה', 'קורולה', 2022, '2022-01', 86000, 98000, 1, 'private_lease', '0501234567']);
});
test('Extract', 'month-only test date → 1st of month (worst case); invalid enum → null', () => {
  const f = normalizeExtraction(MODEL_OUT);
  eq([f.testExpiry, f.tires], ['2027-03-01', null]);
});
test('Extract', 'seller claims about accidents/service never fill scored fields', () => {
  const f = normalizeExtraction(MODEL_OUT);
  eq(['insuranceClaims' in f, 'serviceHistory' in f, f.notes], [false, false, 'ללא תאונות, טיפולים בסוכנות']);
});
test('Extract', 'implausible numbers and garbage → null', () => {
  const f = normalizeExtraction({ year: 1800, handCount: 0, plate: '12', currentKm: 'lots' });
  eq([f.year, f.handCount, f.plate, f.currentKm], [null, null, null, null]);
  eq(normalizeExtraction(null).make, null);
});
test('Extract', 'schema requires every field and allows null', () => {
  eq(EXTRACT_SCHEMA.required.length, Object.keys(EXTRACT_SCHEMA.properties).length);
  eq(Object.values(EXTRACT_SCHEMA.properties).every((p) => p.type.includes('null')), true);
});
test('Extract', 'image validation', () => {
  const ok = { mimeType: 'image/jpeg', data: 'QUJD'.repeat(40) };
  eq([validateImages([ok]), validateImages([]), validateImages([{ ...ok, mimeType: 'image/gif' }]),
    validateImages([{ ...ok, data: 'not base64!' }]), validateImages(Array(7).fill(ok)), validateImages([{ ...ok, data: 'QUJD' }])],
  [null, 'No images', 'Unsupported image type', 'Image data must be base64', 'At most 6 images', 'Image is empty']);
});
test('Extract', 'Gemini request: images inline, JSON schema output', () => {
  const r = buildGeminiRequest([{ mimeType: 'image/png', data: 'QUJD' }]);
  eq(r.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'QUJD' } });
  eq([r.generationConfig.responseMimeType, r.generationConfig.responseJsonSchema === EXTRACT_SCHEMA], ['application/json', true]);
});
test('Extract', 'Anthropic request: forced tool call with the schema', () => {
  const r = buildAnthropicRequest([{ mimeType: 'image/png', data: 'QUJD' }], 'm');
  eq([r.model, r.tool_choice, r.tools[0].input_schema === EXTRACT_SCHEMA, r.messages[0].content[0].source.media_type],
    ['m', { type: 'tool', name: 'record_listing' }, true, 'image/png']);
});
test('Extract', 'parse Gemini response (also tolerates a ```json fence)', () => {
  eq(parseGeminiResponse({ candidates: [{ content: { parts: [{ text: '{"make":"Kia"}' }] } }] }), { make: 'Kia' });
  eq(parseGeminiResponse({ candidates: [{ content: { parts: [{ text: '```json\n{"make":"Kia"}\n```' }] } }] }), { make: 'Kia' });
});
test('Extract', 'parse Gemini errors: blocked / empty', () => {
  let m1 = '', m2 = '';
  try { parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }); } catch (e) { m1 = e.message; }
  try { parseGeminiResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }); } catch (e) { m2 = e.message; }
  eq([m1.includes('SAFETY'), m2.includes('MAX_TOKENS')], [true, true]);
});
test('Extract', 'parse Anthropic tool_use response', () =>
  eq(parseAnthropicResponse({ content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'record_listing', input: { make: 'Kia' } }] }), { make: 'Kia' }));
test('Extract', 'screenshot values merge like gov: fill empty, conflict otherwise, source = screenshot', () => {
  const { car, filled, conflicts } = mergeFields({ make: 'Toyota', fieldSources: {} }, normalizeExtraction(MODEL_OUT), 'screenshot');
  eq(conflicts.map((c) => c.key), ['make']);
  eq([filled.includes('model'), car.fieldSources.model, car.make], [true, 'screenshot', 'Toyota']);
});

// ---------------- Auth (password + signed session) ----------------
// These tests are async; the runner awaits them.

const ENV = { APP_PASSWORD: 'correct horse battery', SESSION_SECRET: 'x'.repeat(40) };
const NOW = 1_800_000_000;

test('Auth', 'config: missing or short secrets fail closed', () =>
  eq([configError({}), configError({ APP_PASSWORD: 'p' }), configError({ APP_PASSWORD: 'p', SESSION_SECRET: 'short' }), configError(ENV)],
    ['APP_PASSWORD is not set', 'SESSION_SECRET is not set', 'SESSION_SECRET must be at least 32 characters', null]));
test('Auth', 'password check: right / wrong / empty / prefix', async () =>
  eq(await Promise.all(['correct horse battery', 'wrong', '', 'correct horse', null].map((p) => passwordMatches(p, ENV))),
    [true, false, false, false, false]));
test('Auth', 'session token: contains no password, verifies, valid for 30 days', async () => {
  const tok = await createSession(ENV, NOW);
  eq(tok.includes('horse'), false);
  eq(tok.startsWith(`v1.${NOW + SESSION_SECONDS}.`), true);
  eq(await verifySession(tok, ENV, NOW + 1), true);
  eq(await verifySession(tok, ENV, NOW + SESSION_SECONDS - 1), true);
});
test('Auth', 'session token: expired → invalid', async () =>
  eq(await verifySession(await createSession(ENV, NOW), ENV, NOW + SESSION_SECONDS), false));
test('Auth', 'session token: tampered expiry or signature → invalid', async () => {
  const tok = await createSession(ENV, NOW);
  const [v, exp, sig] = tok.split('.');
  const flipped = sig.slice(0, -2) + (sig.at(-2) === 'A' ? 'B' : 'A') + sig.at(-1);
  eq(await verifySession(`${v}.${Number(exp) + 86400}.${sig}`, ENV, NOW), false);
  eq(await verifySession(`${v}.${exp}.${flipped}`, ENV, NOW), false);
  eq(await verifySession('garbage', ENV, NOW), false);
  eq(await verifySession(null, ENV, NOW), false);
});
test('Auth', 'changing SESSION_SECRET or APP_PASSWORD logs everyone out', async () => {
  const tok = await createSession(ENV, NOW);
  eq(await verifySession(tok, { ...ENV, SESSION_SECRET: 'y'.repeat(40) }, NOW), false);
  eq(await verifySession(tok, { ...ENV, APP_PASSWORD: 'new password' }, NOW), false);
});
test('Auth', 'token with an expiry beyond 30 days (forged far future) → invalid', async () => {
  const later = await createSession(ENV, NOW + 10 * SESSION_SECONDS);
  eq(await verifySession(later, ENV, NOW), false);
});

// ---------------- Verdict (presentation of the score) ----------------

const COROLLA = { make: 'Toyota', model: 'Corolla', year: 2022, firstRegistration: '2022-01', currentKm: 86000,
  originalOwnership: 'private_lease', handCount: 1 };

test('Verdict', 'Corolla example (37% known) → too early, 25 of 35 points so far', () => {
  const v = verdict(S(COROLLA));
  // known parts: mileage 14/20 + ownership 11/15 = 25 of 35 (raw category points)
  eq([v.kind, v.known], ['TOO_EARLY', { x: 25, y: 35 }]);
});
test('Verdict', 'fully unknown car → too early, 0 of 0', () => eq([verdict(S({})).kind, verdict(S({})).known], ['TOO_EARLY', { x: 0, y: 0 }]));
test('Verdict', 'confirmed deal-breaker → avoid even at 100 and even when coverage is low', () => {
  eq(verdict(S({ ...PERFECT, dealBreakers: { ...PERFECT.dealBreakers, lien: 'yes' } })).kind, 'AVOID');
  eq(verdict(S({ dealBreakers: { lien: 'yes' } })).kind, 'AVOID');
});
test('Verdict', 'best case under 60 → avoid', () => {
  // claims major (0), price way above (0), worn tires, ex-rental → max well below 60
  const r = S({ insuranceClaims: 'major', askingPrice: 200000, benchmarkPrice: 100000, tires: 'worn',
    originalOwnership: 'rental', handCount: 1, firstRegistration: '2025-11', currentKm: 40000 });
  eq(r.scoreMax < 60, true);
  eq([verdict(r).kind, verdict(r).reason], ['AVOID', 'lowMax']);
});
test('Verdict', '≥50% known, min under 60 but max ≥ 60 → OK (not avoid), possibly strong buy', () => {
  // history unknown (0–30); price +8% (8 pts) → raw 47–77 of 94 → 50–82, 64 of 94 = 68% known
  const r = S({ ...PERFECT, insuranceClaims: null, serviceHistory: null, askingPrice: 108000 });
  eq([r.coverage, r.scoreMin, r.scoreMax], [68, 50, 82]);
  const v = verdict(r);
  eq([v.kind, v.provisional, v.upTo, v.barTone], ['OK', true, 'STRONG_BUY', 'good']);
});
test('Verdict', 'perfect car → strong buy, confirmed', () => {
  const v = verdict(S(PERFECT));
  eq([v.kind, v.provisional, v.upTo, v.tone], ['STRONG_BUY', false, null, 'good']);
});
test('Verdict', 'knownPoints counts parts that are settled even with inputs missing', () =>
  eq(knownPoints(S({ insuranceClaims: 'major' })), { x: 0, y: 30 }));

// ---------------- Summary (good signs / watch out) ----------------

const sum = (car) => summarize(car, S(car), { asOf: AS_OF });
const keys = (list) => list.map((i) => i.key.split('.').pop());

test('Summary', 'good signs: 1st hand private, below benchmark, low km', () => {
  const s = sum({ ...PERFECT });
  eq(keys(s.good), ['firstHandPrivate', 'belowBenchmark', 'lowKm']);
  eq([s.good[1].vars.n, s.good[2].vars.km], [10, 10000]);
  eq(s.watch, []);
});
test('Summary', 'at most 3 items each, in priority order', () => {
  const s = sum({ ...PERFECT, tires: 'good' });
  eq(s.good.length, 3);
  const w = sum({ currentKm: 140000, lastTestKm: 150000, govStructuralChange: true, insuranceClaims: 'major', tires: 'worn' }).watch;
  eq(keys(w), ['odometer', 'structural', 'claimsMajor']);
});
test('Summary', 'ex-rental beats ex-fleet; fleet shown when no rental', () => {
  eq(keys(sum({ originalOwnership: 'fleet_lease', handCount: 2, ownershipHistory: [{ type: 'fleet_lease' }, { type: 'rental' }] }).watch), ['exRental']);
  eq(keys(sum({ originalOwnership: 'fleet_lease', handCount: 1 }).watch), ['exFleet']);
});
test('Summary', 'price above benchmark, high km/year, test soon, expired test', () => {
  eq(keys(sum({ askingPrice: 112000, benchmarkPrice: 100000 }).watch), ['aboveBenchmark']);
  eq(sum({ askingPrice: 112000, benchmarkPrice: 100000 }).watch[0].vars.n, 12);
  eq(keys(sum({ firstRegistration: '2025-11', currentKm: 30000 }).watch), ['highKm']);
  eq(keys(sum({ testExpiry: '2027-01-10' }).watch), ['testSoon']);
  eq(keys(sum({ testExpiry: '2026-10-01' }).watch), ['testExpired']);
});
test('Summary', 'worn tires, many hands, service gaps', () => {
  eq(keys(sum({ tires: 'worn' }).watch), ['wornTires']);
  eq(keys(sum({ handCount: 4, serviceHistory: 'none' }).watch), ['manyHands', 'serviceGaps']);
});
test('Summary', 'empty car → both lists empty', () => eq(sum({}), { good: [], watch: [] }));
test('Summary', 'every summary key has EN and HE strings', () => {
  const all = ['firstHandPrivate', 'belowBenchmark', 'lowKm', 'cleanHistory', 'tiresGood'].map((k) => `sum.good.${k}`)
    .concat(['odometer', 'structural', 'claimsMajor', 'claimsModerate', 'exRental', 'exFleet', 'aboveBenchmark', 'highTotalKm',
      'highKm', 'testExpired', 'testSoon', 'manyHands', 'wornTires', 'serviceGaps'].map((k) => `sum.watch.${k}`));
  eq(all.filter((k) => !STRINGS.en[k] || !STRINGS.he[k]), []);
});

// ---------------- Plate format & model notes ----------------

test('Format', 'plate: 7 digits → 12-345-67, 8 digits → 123-45-678', () =>
  eq([formatPlate('1234567'), formatPlate('12345678'), formatPlate('36-181-801'), formatPlate(''), formatPlate(null)],
    ['12-345-67', '123-45-678', '361-81-801', '', '']));
test('Model notes', 'cache key normalises case/space; needs make and model', () => {
  eq(modelKey({ make: ' Toyota ', model: 'Corolla  Cross', year: 2022 }), 'toyota|corolla cross|2022');
  eq(modelKey({ make: 'Toyota', model: 'Corolla', year: '2022' }), modelKey({ make: 'toyota', model: 'COROLLA', year: 2022 }));
  eq([modelKey({ make: 'Toyota' }), modelKey({ make: 'Kia', model: 'Niro' })], [null, 'kia|niro|']);
});
test('Model notes', 'output cleaned: max 3, both languages required, trimmed', () =>
  eq(normalizeNotes({ items: [{ en: ' CVT judder ', he: 'רעידות בגיר' }, { en: 'x', he: '' }, { en: 'a', he: 'א' }, { en: 'b', he: 'ב' }, { en: 'c', he: 'ג' }] }),
    [{ en: 'CVT judder', he: 'רעידות בגיר' }, { en: 'a', he: 'א' }, { en: 'b', he: 'ב' }]));
test('Model notes', 'garbage output → empty list', () => eq([normalizeNotes(null), normalizeNotes({ items: 'no' })], [[], []]));
test('Model notes', 'requests use the schema (max 3 items) and name the car', () => {
  const p = notesPrompt({ make: 'Kia', model: 'Niro', year: 2020 });
  eq([p.includes('2020 Kia Niro'), NOTES_SCHEMA.properties.items.maxItems], [true, 3]);
  eq(buildGeminiNotesRequest(p).generationConfig.responseJsonSchema === NOTES_SCHEMA, true);
  eq(buildAnthropicNotesRequest(p, 'm').tool_choice, { type: 'tool', name: 'record_issues' });
});

// ---------------- Quick check ----------------
// asOf Nov 2026. firstRegistration 2025-11 → 12 months old, so km = km/year.

const QC = (car, opts = {}) => quickCheck(car, { asOf: AS_OF, ...opts });
const qk = (list) => list.map((i) => i.key.replace(/^qc\.\w+\./, ''));
const CMP100 = { source: 'saved', value: 100000 };

test('Quick check', 'empty car → Not enough info (bug fix: was Pursue), with "ask about ownership" note', () => {
  const q = QC({});
  eq([q.verdict, q.knownCount, q.skip, q.maybe, qk(q.notes)], ['NOT_ENOUGH', 0, [], [], ['askOwnership']]);
});
// Enough info for a real verdict: ownership + km/year known (2 of 3).
const KNOWN2 = { originalOwnership: 'private', handCount: 1, currentKm: 10000, firstRegistration: '2025-11' };
test('Not enough info', 'fewer than 2 of (price comparison, km/year, ownership) → Not enough info', () => {
  eq(QC({ originalOwnership: 'private', handCount: 1 }).verdict, 'NOT_ENOUGH', 'ownership only');
  eq(QC({ currentKm: 10000, firstRegistration: '2025-11' }).verdict, 'NOT_ENOUGH', 'km/year only');
  eq(QC({ askingPrice: 95000 }, { comparison: CMP100 }).verdict, 'NOT_ENOUGH', 'price comparison only');
  eq(QC({ tires: 'good', year: 2022, make: 'Toyota' }).verdict, 'NOT_ENOUGH', 'other fields don\'t count');
});
test('Not enough info', 'exactly 2 known → a real verdict', () => {
  eq(QC(KNOWN2).verdict, 'PURSUE');
  eq(QC({ originalOwnership: 'private', handCount: 1, askingPrice: 95000 }, { comparison: CMP100 }).verdict, 'PURSUE');
  eq(QC({ currentKm: 10000, firstRegistration: '2025-11', askingPrice: 95000 }, { comparison: CMP100 }).knownCount, 2);
});
test('Not enough info', 'price without a comparison, or a pending estimate, doesn\'t count as known', () => {
  eq(QC({ originalOwnership: 'private', askingPrice: 95000 }).verdict, 'NOT_ENOUGH');
  eq(QC({ originalOwnership: 'private', askingPrice: 95000 }, { pending: true }).verdict, 'NOT_ENOUGH');
});
test('Not enough info', 'a definite Skip reason still shows Skip', () => {
  eq(QC({ originalOwnership: 'rental' }).verdict, 'SKIP');
  eq(QC({ dealBreakers: { lien: 'yes' } }).verdict, 'SKIP');
  eq(QC({ currentKm: 140000 }).verdict, 'SKIP');
});
test('Not enough info', 'has EN/HE strings and sorts between Maybe and Skip', () => {
  eq([Boolean(STRINGS.en['qc.verdict.NOT_ENOUGH']), Boolean(STRINGS.he['qc.verdict.NOT_ENOUGH'])], [true, true]);
});
test('Quick check', 'skip: over budget (strictly above the ceiling)', () => {
  eq(qk(QC({ askingPrice: 120001 }, { budget: 120000, comparison: CMP100 }).skip), ['overBudget']);
  eq(QC({ askingPrice: 120000 }, { budget: 120000, comparison: { source: 'saved', value: 120000 } }).skip, []);
  eq(QC({ askingPrice: 999999 }, { budget: null, comparison: CMP100 }).skip.length, 0);
});
test('Quick check', 'skip: original rental or driving school (also later in history)', () => {
  eq(qk(QC({ originalOwnership: 'rental' }).skip), ['rental']);
  eq(qk(QC({ originalOwnership: 'driving_school' }).skip), ['rental']);
  eq(qk(QC({ originalOwnership: 'private', handCount: 2, ownershipHistory: [{ type: 'private' }, { type: 'rental' }] }).skip), ['rental']);
});
test('Quick check', 'skip: 3+ hands at age 4.9 yrs, but not at 5.1 yrs', () => {
  // 2022-01 → 58 months (4.8–4.9 yrs); 2021-10 → 61 months (5.1 yrs)
  eq(qk(QC({ handCount: 3, firstRegistration: '2022-01' }).skip), ['manyHandsYoung']);
  eq(QC({ handCount: 3, firstRegistration: '2021-10' }).skip, []);
  eq(QC({ handCount: 2, firstRegistration: '2024-01' }).skip, []);
  eq(QC({ handCount: 4 }).skip, [], 'age unknown → not counted');
});
test('Quick check', 'km/year boundaries: 28,000 maybe, 28,001 skip; 22,000 nothing, 22,001 maybe', () => {
  const kmq = (km) => QC({ currentKm: km, firstRegistration: '2025-11' });
  eq([qk(kmq(28000).maybe), kmq(28000).skip], [['kmYear'], []]);
  eq(qk(kmq(28001).skip), ['highKmYear']);
  eq([kmq(22000).maybe, kmq(22000).skip], [[], []]);
  eq(qk(kmq(22001).maybe), ['kmYear']);
});
test('Quick check', 'total km: 130,000 ok, 130,001 skip (even at low km/year)', () => {
  eq(QC({ currentKm: 130000, firstRegistration: '2016-11' }).skip, []);
  eq(qk(QC({ currentKm: 130001, firstRegistration: '2016-11' }).skip), ['highTotalKm']);
});
test('Quick check', 'model year only: km/year estimated from July 1 of that year', () => {
  // 2024-07 → 2026-11 = 28 months; 30,000 km → 12,857 km/yr → low km
  eq(kmPerYear({ year: 2024, currentKm: 30000 }, AS_OF).value, 12857);
  const q = QC({ year: 2024, currentKm: 30000 });
  eq([q.maybe, qk(q.good)], [[], ['lowKm']]);
});
test('Quick check', 'confirmed deal-breaker → skip; unknown deal-breakers don\'t count', () => {
  eq(qk(QC({ dealBreakers: { lien: 'yes' } }).skip), ['dealBreaker']);
  eq(QC({ dealBreakers: { lien: 'unknown', totalLoss: 'no' } }).skip, []);
});
test('Quick check', 'maybe: fleet lease, or 2nd hand ex-lease; 1st hand private lease is neither', () => {
  eq(qk(QC({ originalOwnership: 'fleet_lease', handCount: 1 }).maybe), ['fleet']);
  eq(qk(QC({ originalOwnership: 'private_lease', handCount: 2 }).maybe), ['exLease2nd']);
  eq(QC({ originalOwnership: 'private_lease', handCount: 1 }).maybe, []);
});
test('Quick check', 'price vs comparison: the 5% threshold both ways', () => {
  const p = (price) => QC({ askingPrice: price }, { comparison: CMP100 });
  eq(p(105000).maybe, [], 'exactly +5% is fine');
  eq(qk(p(105001).maybe), ['high.saved']);
  eq(p(95001).good, [], 'just under −5% is not a good sign');
  eq(qk(p(95000).good), ['low.saved']);
});
test('Quick check', 'no comparison → maybe; but not while an estimate is pending, and not without a price', () => {
  eq(qk(QC({ askingPrice: 90000 }).maybe), ['noComparison']);
  eq(QC({ askingPrice: 90000 }, { pending: true }).maybe, []);
  eq(QC({}).maybe, []);
});
test('Quick check', 'good signs: 1st hand private, low km (<15,000/yr)', () => {
  const q = QC({ originalOwnership: 'private', handCount: 1, currentKm: 14999, firstRegistration: '2025-11' });
  eq(qk(q.good), ['firstHandPrivate', 'lowKm']);
  eq(QC({ currentKm: 15000, firstRegistration: '2025-11' }).good, []);
});
test('Quick check', 'verdict: any skip → Skip; 3 maybes → Skip; 1–2 maybes → Maybe; none → Pursue', () => {
  eq(QC({ ...KNOWN2, originalOwnership: 'rental' }).verdict, 'SKIP');
  eq(QC({ ...KNOWN2, currentKm: 25000 }).verdict, 'MAYBE');
  eq(QC({ ...KNOWN2, currentKm: 25000, originalOwnership: 'fleet_lease' }).verdict, 'MAYBE');
  eq(QC({ ...KNOWN2, currentKm: 25000, originalOwnership: 'fleet_lease', askingPrice: 90000 }).verdict, 'SKIP');
  eq(QC(KNOWN2).verdict, 'PURSUE');
});
test('Quick check', 'reasons: max 3, skip first, then maybe, then good', () => {
  const q = QC({ dealBreakers: { lien: 'yes' }, originalOwnership: 'fleet_lease', askingPrice: 90000, currentKm: 5000, firstRegistration: '2025-11' });
  eq(q.reasons.map((r) => r.key), ['qc.skip.dealBreaker', 'qc.maybe.fleet', 'qc.maybe.noComparison']);
  const g = QC({ originalOwnership: 'private', handCount: 1, currentKm: 5000, firstRegistration: '2025-11', askingPrice: 80000 }, { comparison: CMP100 });
  eq(g.reasons.map((r) => r.key), ['qc.price.low.saved', 'qc.good.firstHandPrivate', 'qc.good.lowKm']);
});

test('Quick check', 'every reason, note and source the quick check can produce has EN and HE text', () => {
  const keys = ['overBudget', 'rental', 'manyHandsYoung', 'highKmYear', 'highTotalKm', 'dealBreaker'].map((k) => `qc.skip.${k}`)
    .concat(['fleet', 'exLease2nd', 'kmYear', 'noComparison'].map((k) => `qc.maybe.${k}`))
    .concat(['firstHandPrivate', 'lowKm'].map((k) => `qc.good.${k}`), ['qc.note.askOwnership'])
    .concat(['saved', 'ai', 'levi', 'yad2'].flatMap((s) => [`qc.price.high.${s}`, `qc.price.low.${s}`, `cmp.source.${s}`]))
    .concat(['PURSUE', 'MAYBE', 'SKIP'].map((v) => `qc.verdict.${v}`), ['sort.quick', 'stage.quick', 'stage.full']);
  eq(keys.filter((k) => !STRINGS.en[k] || !STRINGS.he[k]), []);
});

// ---------------- Price comparison ----------------

const corolla = (id, year, price, km) => ({ id, make: 'Toyota', model: 'Corolla', year, askingPrice: price, currentKm: km });
const SAVED = [
  corolla('a', 2021, 90000, 80000), corolla('b', 2022, 100000, 60000), corolla('c', 2023, 110000, 40000),
  corolla('d', 2024, 150000, 10000),          // year +2: out
  { id: 'e', make: 'toyota', model: 'COROLLA', year: 2022, askingPrice: 96000, currentKm: 70000 },   // case-insensitive: in
  corolla('f', 2022, null, 50000),            // no price: out
  { id: 'g', make: 'Toyota', model: 'Yaris', year: 2022, askingPrice: 70000 }, // other model: out
];
const ME = corolla('me', 2022, 95000, 86000);

test('Comparables', 'same make/model, year ±1, with a price; excludes the car itself', () =>
  eq(findComparables(ME, [...SAVED, ME]).map((c) => c.id).sort(), ['a', 'b', 'c', 'e']));
test('Comparables', 'fewer than 3 → no saved comparison', () =>
  eq(savedComparison(ME, SAVED.filter((c) => ['a', 'b', 'd'].includes(c.id))), null));
test('Comparables', 'median of prices, adjusted by ₪0.15 per km from the median km', () => {
  // prices 90k,96k,100k,110k → median 98,000; km 40k,60k,70k,80k → median 65,000
  // this car has 86,000 km: 21,000 more → 98,000 − 0.15 × 21,000 = 94,850
  const c = savedComparison(ME, SAVED);
  eq([c.n, c.medianPrice, c.medianKm, c.value, c.adjusted, KM_PRICE_ADJUST], [4, 98000, 65000, 94850, true, 0.15]);
});
test('Comparables', 'no km on this car → plain median', () =>
  eq(savedComparison({ ...ME, currentKm: null }, SAVED).value, 98000));
test('Comparables', 'Levi Yitzhak overrides saved cars and AI', () => {
  const c = resolveComparison({ ...ME, benchmarkPrice: 101000, benchmarkSource: 'levi_yitzhak' }, { others: SAVED });
  eq([c.source, c.value], ['levi', 101000]);
});
test('Comparables', 'AI estimate used only when <3 comparables and the cache key matches', () => {
  const lone = corolla('x', 2019, 70000, 120000);
  const est = { key: estimateKey(lone), low: 66000, high: 74000 };
  const c = resolveComparison(lone, { others: SAVED, estimate: est });
  eq([c.source, c.value, c.low, c.high], ['ai', 70000, 66000, 74000]);
  // km changed → stale cache → not used, but an AI estimate is needed
  const stale = resolveComparison({ ...lone, currentKm: 125000 }, { others: SAVED, estimate: est });
  eq([stale.source, stale.needsAi], [null, true]);
  // saved cars available → no AI needed
  eq(resolveComparison(ME, { others: SAVED, estimate: est }).source, 'saved');
});
test('Comparables', 'estimate key changes only with make, model, year or km', () => {
  eq(estimateKey({ make: 'Kia', model: 'Niro', year: 2020, currentKm: 50000, trim: 'EX' }), estimateKey({ make: 'kia', model: 'niro', year: 2020, currentKm: 50000, trim: 'LX', askingPrice: 1 }));
  eq(estimateKey({ make: 'Kia', model: 'Niro' }), null);
});
test('Estimate', 'AI range cleaned: swapped, absurd or missing → handled', () => {
  eq(normalizeEstimate({ low: 100000, high: 90000 }), { low: 90000, high: 100000 });
  eq(normalizeEstimate({ low: 10, high: 90000 }), { low: null, high: null });
  eq(normalizeEstimate({ low: 20000, high: 900000 }), { low: null, high: null });
  eq(normalizeEstimate(null), { low: null, high: null });
  eq([estimatePrompt({ make: 'Kia', model: 'Niro', year: 2020, km: 50000, ownership: 'private' }).includes('2020 Kia Niro'), ESTIMATE_SCHEMA.required], [true, ['low', 'high']]);
});

// ---------------- Seller message (AI) ----------------

test('Seller AI', 'missing details: plate first, then Slikah, service, test, ownership, trim', () => {
  eq(sellerMissing({}), ['plate', 'slikah', 'serviceHistory', 'testExpiry', 'originalOwnership', 'trim']);
  eq(sellerMissing({ plate: '1234567', trim: 'Sun', insuranceClaims: 'none' }), ['serviceHistory', 'testExpiry', 'originalOwnership']);
});
test('Seller AI', 'car-specific topics: high km, hybrid, ex-lease, 2nd+ hand (max 2)', () => {
  eq(sellerTopics({ model: 'Corolla Hybrid', handCount: 2 }, { asOf: AS_OF }), ['hybrid', 'whySelling']);
  eq(sellerTopics({ currentKm: 30000, firstRegistration: '2025-11', originalOwnership: 'fleet_lease', handCount: 3 }, { asOf: AS_OF }), ['highKm', 'leaseRecords']);
  eq(sellerTopics({}, { asOf: AS_OF }), []);
});
test('Seller AI', 'prompt: language, max 6 questions, no scores/app, background not to be quoted', () => {
  const p = sellerPrompt({ make: 'Toyota', model: 'Corolla', year: 2022 }, { lang: 'he', reasons: ['low km'], asOf: AS_OF });
  eq([p.includes('Israeli Hebrew'), p.includes('at most 6'), p.includes('Never mention scores'), p.includes('Do not mention it: low km')], [true, true, true, true]);
  eq(sellerPrompt({}, { lang: 'en' }).includes('natural, friendly English'), true);
});
test('Seller AI', 'message cleaned; empty → null (template fallback)', () => {
  eq(normalizeMessage({ message: '  היי!\n\n\n\nמה המספר?  ' }), 'היי!\n\nמה המספר?');
  eq([normalizeMessage({ message: '' }), normalizeMessage(null)], [null, null]);
});

// ---------------- Names & registry comparison ----------------

test('Names', 'make/model names across Hebrew and English', () => {
  eq([canonicalMake('סקודה צ׳כיה'), canonicalMake('Skoda'), canonicalMake('VW')], ['skoda', 'skoda', 'volkswagen']);
  eq(sameName('Toyota', 'טויוטה', { kind: 'make' }), true);
  eq(sameName('Kia', 'טויוטה', { kind: 'make' }), false);
  eq(sameName('Corolla', 'COROLLA', { kind: 'model' }), true);
  eq(sameName('קורולה', 'COROLLA', { kind: 'model' }), null, 'different scripts: can\'t tell');
  eq(sameName('i20', 'COROLLA', { kind: 'model' }), false);
  eq(sameName('סאן', 'SUN', { kind: 'trim' }), null, 'different scripts, no table: can\'t tell');
  eq(sameName('Sun', 'SUN PLUS', { kind: 'trim' }), true);
});

// ---------------- Ad vs. registry ----------------

const REG = { make: 'טויוטה', model: 'COROLLA', year: 2021, firstRegistration: '2021-03', trim: 'ACTIVE', originalOwnership: 'fleet_lease',
  handCount: 3, testExpiry: '2027-03-14', lastTestKm: 90000, lastTestDate: '2026-01-10' };
const rowsOf = (car, reg = REG) => Object.fromEntries(comparisonRows(car, reg).map((r) => [r.key, r]));
const status = (car, key, reg) => rowsOf(car, reg)[key].status;
const codes = (car, ad = {}, reg = REG) => trustIssues(car, { fields: reg, ad }).map((i) => i.code);

test('Registry', 'identity fields: registry overwrites silently; differing ad values are remembered', () => {
  const { car, adIdentity } = applyRegistry({ make: 'Toyota', model: 'Corolla', year: 2022, firstRegistration: '2022-01',
    fieldSources: { year: 'screenshot' } }, REG);
  eq([car.make, car.model, car.year, car.firstRegistration, car.fieldSources.year], ['טויוטה', 'COROLLA', 2021, '2021-03', 'gov']);
  eq(adIdentity, { year: 2022, firstRegistration: '2022-01' }, 'Toyota/טויוטה and Corolla/COROLLA are the same');
});
test('Registry', 'compared fields keep the ad value; registry-only facts fill gaps', () => {
  const { car } = applyRegistry({ handCount: 1, originalOwnership: 'private', trim: 'Premium', testExpiry: '2027-01-01', currentKm: 80000 }, REG);
  eq([car.handCount, car.originalOwnership, car.trim, car.testExpiry, car.currentKm], [1, 'private', 'Premium', '2027-01-01', 80000]);
  eq([car.lastTestKm, car.lastTestDate, car.fieldSources.lastTestKm], [90000, '2026-01-10', 'gov']);
  eq(applyRegistry({ lastTestKm: 50000 }, REG).car.lastTestKm, 50000, 'an existing value is not overwritten');
});
test('Registry', 'rows: Field | Ad says | Registry says for owners, ownership, km (+ test date), test, trim', () => {
  const rows = comparisonRows({ handCount: 3, originalOwnership: 'fleet_lease', currentKm: 95000, testExpiry: '2027-03-01', trim: 'Active' }, REG);
  eq(rows.map((r) => [r.key, r.ad, r.reg, r.status]), [
    ['handCount', 3, 3, 'match'], ['originalOwnership', 'fleet_lease', 'fleet_lease', 'match'], ['km', 95000, 90000, 'match'],
    ['testExpiry', '2027-03-01', '2027-03-14', 'match'], ['trim', 'Active', 'ACTIVE', 'match']]);
  eq(rows[2].regDate, '2026-01-10');
});
test('Registry', 'unknown on either side → "–" status', () => {
  eq(status({}, 'handCount'), 'unknown');
  eq(status({ handCount: 2 }, 'handCount', { ...REG, handCount: null }), 'unknown');
  eq(comparisonRows({ handCount: 2 }, null), []);
});
test('Registry', 'values that came from the registry don\'t count as "ad says"', () => {
  const car = { handCount: 3, fieldSources: { handCount: 'gov' } };
  eq([adValue(car, 'handCount'), status(car, 'handCount')], [null, 'unknown']);
});

test('Trust', 'suspicious: fewer hands than registered', () => {
  eq([status({ handCount: 1 }, 'handCount'), codes({ handCount: 1 })], ['suspicious', ['fewerHands']]);
});
test('Trust', 'suspicious: "private" when the registry says lease, fleet, rental or driving school', () => {
  for (const reg of ['fleet_lease', 'private_lease', 'rental', 'driving_school']) {
    eq(codes({ originalOwnership: 'private' }, {}, { ...REG, originalOwnership: reg }), ['ownership'], reg);
  }
});
test('Trust', 'suspicious: ad km below the last-test km', () => {
  eq([status({ currentKm: 85000 }, 'km'), codes({ currentKm: 85000 })], ['suspicious', ['odometer']]);
});
test('Trust', 'suspicious: a newer year in the ad (identity claim)', () => {
  eq(codes({}, { year: 2022 }), ['newerYear']);
  eq(codes({}, { year: 2020 }), [], 'older year: not suspicious');
});
test('Trust', 'suspicious: a clearly higher trim ("Plus" added or a higher tier word, EN/HE)', () => {
  eq(codes({ trim: 'Premium' }), ['higherTrim']);
  eq(codes({ trim: 'Sun Plus' }, {}, { ...REG, trim: 'SUN' }), ['higherTrim']);
  eq(codes({ trim: 'פרימיום' }), ['higherTrim']);
  eq([trimTier('ACTIVE'), trimTier('Style'), trimTier('Executive'), trimTier('XLE')], [1, 2, 3, null]);
});
test('Trust', 'neutral (≠, no trust flag): more hands, other ownership differences, lower/unknown trim, test date off', () => {
  eq([status({ handCount: 4 }, 'handCount'), codes({ handCount: 4 })], ['neutral', []]);
  eq([status({ originalOwnership: 'rental' }, 'originalOwnership', { ...REG, originalOwnership: 'private' }),
    codes({ originalOwnership: 'rental' }, {}, { ...REG, originalOwnership: 'private' })], ['neutral', []]);
  eq([status({ trim: 'Base' }, 'trim', { ...REG, trim: 'PREMIUM' }), codes({ trim: 'Base' }, {}, { ...REG, trim: 'PREMIUM' })], ['neutral', []]);
  eq([status({ trim: 'XLE' }, 'trim', { ...REG, trim: 'LE' }), isHigherTrim('XLE', 'LE')], ['neutral', false]);
  eq([status({ testExpiry: '2027-04-02' }, 'testExpiry'), codes({ testExpiry: '2027-04-02' })], ['neutral', []]);
});
test('Trust', 'not suspicious at all: ad km above the last test, lease kinds, same month', () => {
  eq(status({ currentKm: 95000 }, 'km'), 'match');
  eq(status({ originalOwnership: 'private_lease' }, 'originalOwnership'), 'match');
  eq(status({ testExpiry: '2027-03-01' }, 'testExpiry'), 'match');
});
test('Trust', 'several at once', () => {
  eq(codes({ handCount: 1, originalOwnership: 'private', currentKm: 80000, trim: 'Luxury' }, { year: 2022 }).slice().sort(),
    ['fewerHands', 'higherTrim', 'newerYear', 'odometer', 'ownership']);
});
test('Trust', 'quick check: 1 suspicious mismatch → Maybe reason; 2 or more → Skip', () => {
  const one = [{ code: 'fewerHands' }];
  const two = [{ code: 'fewerHands' }, { code: 'odometer' }];
  eq(qk(QC(KNOWN2, { trust: one }).maybe), ['registryMismatch']);
  eq(QC(KNOWN2, { trust: one }).verdict, 'MAYBE');
  eq([qk(QC(KNOWN2, { trust: two }).skip), QC(KNOWN2, { trust: two }).verdict], [['registryMismatch'], 'SKIP']);
  eq(QC(KNOWN2, { trust: [] }).verdict, 'PURSUE');
});
test('Trust', 'seller template: one polite question per suspicious mismatch, after the plate', () => {
  const trust = [{ code: 'fewerHands', ad: 1, gov: 2 }, { code: 'ownership', ad: 'private', gov: 'rental' }, { code: 'odometer', ad: 80000, gov: 90000 }];
  eq(trustQuestions(trust, 'en'), [
    'The registry shows 2 owners so far. Can you clarify?',
    'The registry lists the car as Rental originally. Can you clarify?',
    'At the last test the car had 90,000 km, more than in the ad. Can you clarify?']);
  const msg = buildSellerMessage({}, 'he', { trust: trust.slice(0, 1) });
  eq(msg.indexOf(SELLER.he.plate) < msg.indexOf('ברישום מופיעים 2 בעלים'), true);
  eq(buildSellerMessage({ plate: '1234567', originalOwnership: 'private', trim: 'x', firstRegistration: '2022-01', testExpiry: '2027-01-01', serviceHistory: 'full', insuranceClaims: 'none' }, 'en', { trust: trust.slice(0, 1) }),
    `${SELLER.en.opener} The registry shows 2 owners so far. Can you clarify?`);
  eq(Object.keys(SELLER.he.trust).sort(), Object.keys(SELLER.en.trust).sort());
});
test('Trust', 'AI prompt: plate first, then one line per suspicious mismatch; bad items dropped', () => {
  const p = sellerPrompt({ make: 'Toyota' }, { trust: [{ code: 'fewerHands', ad: 1, gov: 2 }, { code: 'bogus', ad: 1, gov: 2 }] });
  eq([p.includes('registry shows 2 owners so far, while the ad says hand 1'), p.includes('bogus')], [true, false]);
  eq(p.indexOf('license plate') < p.indexOf('registry shows 2 owners'), true);
  eq(cleanTrust([{ code: 'odometer', ad: 1, gov: 'x'.repeat(99) }, { code: 'nope' }, null]), [{ code: 'odometer', ad: '1', gov: 'x'.repeat(40) }]);
});
test('Trust', 'registry snapshot keeps known, valid fields only; EN/HE strings exist', () => {
  eq(cleanSnapshot({ make: 'טויוטה', year: 2021, lastTestKm: '90,000', handCount: 'x', bogus: 1 }, { year: '2022', bogus: 1 }),
    { fields: { make: 'טויוטה', year: 2021, lastTestKm: 90000 }, ad: { year: 2022 } });
  const keys = ['trust.banner', 'qc.maybe.registryMismatch', 'qc.skip.registryMismatch', 'vs.title', 'vs.ad', 'vs.registry', 'vs.note',
    ...['fewerHands', 'ownership', 'odometer', 'newerYear', 'higherTrim'].map((c) => `trust.${c}`),
    ...['handCount', 'originalOwnership', 'km', 'testExpiry', 'trim'].map((k) => `vs.row.${k}`),
    ...['match', 'neutral', 'suspicious', 'unknown'].map((k) => `vs.status.${k}`)];
  eq(keys.filter((k) => !STRINGS.en[k] || !STRINGS.he[k]), []);
});

// ---------------- Scoring uses the registry ----------------

test('Registry scoring', 'registry values win: hands, test date, identity; km = higher of ad and last test', () => {
  const car = { make: 'Toyota', model: 'Corolla', year: 2022, firstRegistration: '2022-01', handCount: 1, originalOwnership: 'private',
    testExpiry: '2027-10-01', currentKm: 80000 };
  const eff = effectiveCar(car, REG);
  eq([eff.handCount, eff.testExpiry, eff.year, eff.firstRegistration, eff.currentKm, eff.originalOwnership],
    [3, '2027-03-14', 2021, '2021-03', 90000, 'fleet_lease']);
  eq(effectiveCar({ ...car, currentKm: 120000 }, REG).currentKm, 120000, 'ad km higher → ad km');
  eq(effectiveCar(car, null), car, 'no registry → unchanged');
});
test('Registry scoring', 'lease kind: the user\'s private/fleet choice is kept when the registry only says lease', () => {
  eq(effectiveCar({ originalOwnership: 'private_lease' }, REG).originalOwnership, 'private_lease');
  eq(effectiveCar({ originalOwnership: 'private' }, REG).originalOwnership, 'fleet_lease');
});
test('Registry scoring', 'the score changes with the registry: 3 registered owners on a young car → ownership 0', () => {
  const car = { firstRegistration: '2023-01', handCount: 1, originalOwnership: 'private' };
  eq(range(S(car).parts.ownership), [15, 15], 'ad alone: 1st hand private');
  eq(range(S(effectiveCar(car, { ...REG, firstRegistration: '2023-01', originalOwnership: 'private' })).parts.ownership), [0, 0], 'registry: 3 hands under 5 yrs');
});
test('Registry scoring', 'km: max(ad, last test) feeds km/year; unknown ad km keeps the last-test fallback', () => {
  const car = { firstRegistration: '2025-11', currentKm: 10000 };
  eq(range(S(car).parts.mileage), [20, 20]);
  eq(range(S(effectiveCar(car, { lastTestKm: 25000 })).parts.mileage), [7, 7], '25,000 km in a year');
  const noKm = S(effectiveCar({ firstRegistration: '2025-11' }, { lastTestKm: 14000 }));
  eq([range(noKm.parts.mileage), noKm.notes.includes('km_from_last_test')], [[20, 20], true]);
});

// ---------------- runner ----------------

export async function runAll() {
  const results = [];
  for (const { group, name, fn } of tests) {
    try { await fn(); results.push({ group, name, pass: true }); }
    catch (e) { results.push({ group, name, pass: false, error: e.message }); }
  }
  return results;
}
