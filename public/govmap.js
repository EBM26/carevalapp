// govmap.js — maps data.gov.il vehicle records to car fields. Pure; no I/O.
//
// Resource IDs and field names verified against the live CKAN API on 2026-11-16:
//   registry  053cea08-…  "מאגר מספרי רישוי של כלי רכב" (private & commercial)
//             tozeret_nm, kinuy_mishari, ramat_gimur, shnat_yitzur,
//             moed_aliya_lakvish ('YYYY-M', not always zero-padded),
//             tokef_dt, mivchan_acharon_dt, baalut (current owner type)
//   history   56063a99-…  "היסטוריית כלי רכב פרטיים (1)"
//             kilometer_test_aharon, shinui_mivne_ind (≈1% of cars),
//             shnui_zeva_ind, shinui_zmig_ind, rishum_rishon_dt, mkoriut_nm
//   ownership bb2355dc-…  "היסטוריית כלי רכב פרטיים (2)"
//             one row per ownership: baalut_dt (YYYYMM int), baalut
//             values seen: פרטי, חברה, השכרה, החכר (lease), סוחר (dealer)

import { FIELDS, cleanValue } from './fields.js';

export const GOV_RESOURCES = {
  registry: '053cea08-09bc-40ec-8f7a-156f0677aff3',
  history: '56063a99-8a3e-4ff4-912e-5966c0279bad',
  ownership: 'bb2355dc-9ec7-4f06-9c3f-3344672171da',
};

// Gov ownership type → our ownershipType. Lease (החכר/ליסינג) doesn't say
// private vs fleet; we assume fleet (the lower score) and flag it.
// A company owner (חברה) is treated as a fleet car.
function mapOwnerType(s) {
  const v = String(s || '').replace(/["'״׳]/g, '').trim();
  if (!v) return null;
  if (v === 'פרטי') return 'private';
  if (v === 'החכר' || v === 'ליסינג') return 'fleet_lease';
  if (v === 'חברה') return 'fleet_lease';
  if (v === 'השכרה') return 'rental';
  if (v.includes('נהיגה')) return 'driving_school';
  return null;
}
const isDealer = (s) => String(s || '').trim() === 'סוחר';
const isLease = (s) => ['החכר', 'ליסינג'].includes(String(s || '').trim());

// Manufacturer names carry the country ("סקודה צ'כיה", "טויוטה יפן"); drop it.
const COUNTRIES = ['יפן', 'גרמניה', "צ'כיה", 'צכיה', 'קוריאה', 'דרום קוריאה', 'ספרד', 'צרפת', 'איטליה', 'ארה"ב', 'ארהב',
  'אנגליה', 'בריטניה', 'סין', 'טורקיה', 'הודו', 'תאילנד', 'בלגיה', 'הונגריה', 'מקסיקו', 'שוודיה', 'רומניה',
  'סלובקיה', 'פולין', 'אוסטריה', 'הולנד', 'פורטוגל', 'דרום אפריקה', 'ברזיל', 'קנדה', 'טייוואן', 'מרוקו',
  'סלובניה', 'פינלנד', 'אינדונזיה', 'מלזיה', 'ארגנטינה', 'רוסיה', 'סרביה', 'אוזבקיסטן', 'וייטנאם'];
export function stripCountry(name) {
  let s = String(name || '').trim();
  for (const c of COUNTRIES.sort((a, b) => b.length - a.length)) {
    if (s.endsWith(` ${c}`)) { s = s.slice(0, -c.length - 1).trim(); break; }
  }
  return s || null;
}

/** 'YYYY-M' / 'YYYY-MM' / 'YYYY-MM-DD…' → 'YYYY-MM', else null. */
export function normYm(s) {
  const m = /^(\d{4})-(\d{1,2})/.exec(String(s || '').trim());
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
}
const normDate = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : null);
const ymdFromYyyymm = (n) => {
  const s = String(n || '');
  return /^\d{6}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-01` : null;
};

/**
 * registry: record or null; history: record or null;
 * ownership: array of records, or null if that dataset couldn't be fetched.
 * Returns { fields, hints, extra }. Fields are null when gov doesn't know.
 */
export function mapGov({ registry, history, ownership }) {
  const r = registry || {};
  const h = history || {};
  const fields = {
    make: stripCountry(r.tozeret_nm),
    model: String(r.kinuy_mishari || '').trim() || null,
    trim: String(r.ramat_gimur || '').trim() || null,
    year: Number.isInteger(r.shnat_yitzur) ? r.shnat_yitzur : null,
    firstRegistration: normYm(r.moed_aliya_lakvish) || normYm(h.rishum_rishon_dt),
    testExpiry: normDate(r.tokef_dt),
    lastTestDate: normDate(r.mivchan_acharon_dt),
    lastTestKm: h.kilometer_test_aharon > 0 ? h.kilometer_test_aharon : null,
    govStructuralChange: history ? h.shinui_mivne_ind === 1 : null,
    originalOwnership: null,
    handCount: null,
    ownershipHistory: null,
  };
  const hints = [];

  if (Array.isArray(ownership) && ownership.length) {
    const sorted = ownership.slice().sort((a, b) => (a.baalut_dt - b.baalut_dt) || (a._id - b._id));
    const owners = sorted.filter((o) => !isDealer(o.baalut));
    const dealers = sorted.length - owners.length;
    if (dealers) hints.push({ code: 'dealer_excluded', n: dealers });
    if (owners.length) {
      fields.handCount = owners.length;
      fields.ownershipHistory = owners.map((o) => {
        const e = { type: mapOwnerType(o.baalut) };
        const from = ymdFromYyyymm(o.baalut_dt);
        if (from) e.from = from;
        return e;
      });
      fields.originalOwnership = fields.ownershipHistory[0].type;
      if (owners.some((o) => isLease(o.baalut))) hints.push({ code: 'lease_type_unknown' });
      if (owners.some((o) => String(o.baalut).trim() === 'חברה')) hints.push({ code: 'company_owner' });
    }
  }

  // The history dataset's originality (mkoriut_nm) is more specific than the
  // first ownership row (a rental company shows up as חברה there).
  const orig = mapOwnerType(h.mkoriut_nm);
  if (orig) {
    fields.originalOwnership = orig;
    if (fields.ownershipHistory) fields.ownershipHistory[0] = { ...fields.ownershipHistory[0], type: orig };
    if (isLease(h.mkoriut_nm) && !hints.some((x) => x.code === 'lease_type_unknown')) hints.push({ code: 'lease_type_unknown' });
  }

  const extra = {
    colorChanged: history ? h.shnui_zeva_ind === 1 : null,
    tiresChanged: history ? h.shinui_zmig_ind === 1 : null,
    personalImport: String(h.mkoriut_nm || '').includes('יבוא אישי'),
    color: r.tzeva_rechev || null,
    fuel: r.sug_delek_nm || null,
    currentOwner: r.baalut || null,
  };
  return { fields, hints, extra };
}

// ---------- merging into a car ----------

const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const ownerTypes = (v) => JSON.stringify((v || []).map((o) => o?.type ?? null));

function same(key, a, b) {
  if (key === 'ownershipHistory') return ownerTypes(a) === ownerTypes(b);
  if (typeof a === 'string' && typeof b === 'string') return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a === b;
}

/**
 * Merge fields from gov or a screenshot into a car/draft. They fill only empty fields; where the
 * car already has a different value, it is reported as a conflict and left
 * untouched. govStructuralChange is gov-only and always taken.
 * Returns { car, filled: [key], conflicts: [{ key, mine, gov }] }.
 */
export function mergeFields(car, govFields, source) {
  const out = { ...car, fieldSources: { ...(car.fieldSources || {}) } };
  const filled = [];
  const conflicts = [];
  for (const [key, gov] of Object.entries(govFields)) {
    if (gov === null || gov === undefined) continue;
    const f = FIELD_BY_KEY[key];
    if (!f) continue;
    if (key === 'govStructuralChange') {
      out[key] = gov;
      out.fieldSources[key] = source;
      continue;
    }
    const mine = cleanValue(f.type, out[key], f.arg);
    if (mine === null) {
      out[key] = gov;
      out.fieldSources[key] = source;
      filled.push(key);
    } else if (!same(key, mine, gov)) {
      conflicts.push({ key, mine, gov });
    }
  }
  return { car: out, filled, conflicts };
}

export const mergeGov = (car, fields) => mergeFields(car, fields, 'gov');
