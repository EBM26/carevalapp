// tests.js — test cases for scoring.js. Runs in the browser (tests.html) and
// in Node (`node scripts/run-tests.js`). All tests pin asOf so results are
// deterministic regardless of today's date.

import { scoreCar, band, num, ENUMS, DEAL_BREAKERS, WEIGHTS } from './scoring.js';
import { FIELDS, sanitizeCar } from './fields.js';
import { STRINGS, SELLER } from './i18n.js';
import { buildSellerMessage, waNumber, waLink } from './seller.js';

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
  cabinFit: 'easy', testExpiry: '2027-10-01', tires: 'good',
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
test('3 Mileage', 'only model year known → range over Jan–Dec registration', () => {
  // 2024: age 23 months (Dec 2024) to 34 months (Jan 2024).
  // 30,000 km → 15,652/yr (14) .. 10,588/yr (20)
  eq(range(S({ currentKm: 30000, year: 2024 }).parts.mileage), [14, 20]);
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

// ---------------- Category 5a: Cabin fit ----------------

for (const [fit, pts] of [['easy', 6], ['adequate', 3], ['tight', 0]]) {
  test('5a Cabin', `${fit} → ${pts}`, () => eq(range(S({ cabinFit: fit }).parts.cabin), [pts, pts]));
}
test('5a Cabin', 'unknown → [0, 6]', () => eq(range(S({}).parts.cabin), [0, 6]));

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
  1st hand private lease, cabin easy, everything else unknown.

  1 History    claims ?, service ?          → [0, 30]
  2 Price      asking ?, benchmark ?        → [0, 25]
  3 Mileage    Jan 2022 → Nov 2026 = 58 months = 4.833 yrs
               86,000 / 4.833 = 17,793 km/yr (15,000–22,000 band); total < 130k
                                            → [14, 14]
  4 Ownership  1 hand, private lease        → [11, 11]
               (car is < 5 yrs old, but only 1 hand, so the 0-rule doesn't apply)
  5a Cabin     easy                         → [6, 6]
  5b Condition test ? [0, 2] + tires ? [0, 2] → [0, 4]
  ─────────────────────────────────────────────────────
  Total  min = 0 + 0 + 14 + 11 + 6 + 0  = 31
         max = 30 + 25 + 14 + 11 + 6 + 4 = 90
  Rating: 31 → AVOID, 90 → STRONG BUY → provisional "31–90: AVOID → possibly STRONG BUY"
  Coverage: mileage 20 + ownership 15 + cabin 6 = 41%
  Find out next: history (30), price (25), test (2), tires (2)
  Deal-breakers: all 4 open.
*/
test('Example', '2022 Corolla, private lease, 86k km → [31, 90], coverage 41%', () => {
  const r = S({
    make: 'Toyota', model: 'Corolla', trim: 'sedan', year: 2022,
    firstRegistration: '2022-01', currentKm: 86000,
    originalOwnership: 'private_lease', handCount: 1, cabinFit: 'easy',
  });
  eq(range(r.parts.history), [0, 30], 'history');
  eq(range(r.parts.price), [0, 25], 'price');
  eq(range(r.parts.mileage), [14, 14], 'mileage');
  eq(Math.round(r.parts.mileage.kmPerYear), 17793, 'km/yr');
  eq(range(r.parts.ownership), [11, 11], 'ownership');
  eq(range(r.parts.cabin), [6, 6], 'cabin');
  eq(range(r.categories.condition), [0, 4], 'condition');
  eq([r.scoreMin, r.scoreMax], [31, 90], 'total');
  eq([r.rating, r.ratingMax, r.confirmed], ['AVOID', 'STRONG_BUY', false], 'rating');
  eq(r.coverage, 41, 'coverage');
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
    ...['insuranceClaims', 'serviceHistory', 'cabinFit', 'tires', 'status'].flatMap((e) => ENUMS[e].map((v) => `${e}.${v}`)),
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

// ---------------- runner ----------------

export function runAll() {
  return tests.map(({ group, name, fn }) => {
    try { fn(); return { group, name, pass: true }; }
    catch (e) { return { group, name, pass: false, error: e.message }; }
  });
}
