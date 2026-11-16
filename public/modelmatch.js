// modelmatch.js — match a make/model to models.json, and compare names that
// may be written in Hebrew or English. Pure.

const norm = (s) => String(s || '').toLowerCase().replace(/[\s'"׳״\-_.]/g, '');

/** Best models.json entry for make + model (+ trim), or null. Longest match string wins. */
export function matchModel(models, { make, model, trim }) {
  const hay = norm(`${make || ''} ${model || ''} ${trim || ''}`);
  if (!hay || !model) return null;
  let best = null;
  let bestLen = 0;
  for (const m of models || []) {
    for (const s of m.match || []) {
      const n = norm(s);
      if (n && n.length > bestLen && hay.includes(n)) { best = m; bestLen = n.length; }
    }
  }
  return best;
}

// Makes as written in Israeli registry data (Hebrew) and in ads (English).
const MAKES = {
  toyota: ['טויוטה'], hyundai: ['יונדאי'], kia: ['קיה'], skoda: ['סקודה'], mazda: ['מאזדה'], honda: ['הונדה'],
  nissan: ['ניסאן'], mitsubishi: ['מיצובישי'], suzuki: ['סוזוקי'], volkswagen: ['פולקסווגן', 'vw'], seat: ['סיאט'],
  chevrolet: ['שברולט'], peugeot: ['פיגו', "פיג'ו"], renault: ['רנו'], citroen: ['סיטרואן'], ford: ['פורד'],
  audi: ['אאודי'], bmw: ['במוו', 'ב.מ.וו'], mercedes: ['מרצדס', 'mercedesbenz', 'מרצדסבנץ'], subaru: ['סובארו'],
  lexus: ['לקסוס'], tesla: ['טסלה'], byd: ['ביוויד'], mg: ['אמג׳י', 'אמגי'], chery: ["צ'רי", 'צרי'], geely: ['גילי'],
  dacia: ['דאצ׳יה', 'דאציה'], opel: ['אופל'], volvo: ['וולוו'], jeep: ["ג'יפ", 'גיפ'], cupra: ['קופרה'],
};
const MAKE_INDEX = (() => {
  const idx = {};
  for (const [canon, aliases] of Object.entries(MAKES)) for (const a of [canon, ...aliases]) idx[norm(a)] = canon;
  return idx;
})();

/** Every name of `base` is a prefix of some name of `variant` (e.g. Corolla → Corolla Cross). */
function isBase(base, variant) {
  return base.match.every((x) => variant.match.some((y) => norm(y).startsWith(norm(x))));
}

const hasHebrew = (s) => /[֐-׿]/.test(String(s || ''));

/** Canonical make, or null when unknown. */
export function canonicalMake(s) {
  const n = norm(s);
  if (!n) return null;
  if (MAKE_INDEX[n]) return MAKE_INDEX[n];
  for (const [alias, canon] of Object.entries(MAKE_INDEX)) if (n.startsWith(alias) && alias.length >= 2) return canon;
  return null;
}

/**
 * Do two names refer to the same thing? Returns true / false, or null when we
 * can't tell (e.g. one is in Hebrew and the other in English and no table
 * links them). Callers flag a mismatch only on false.
 */
export function sameName(a, b, { kind, models = [], make } = {}) {
  if (!a || !b) return null;
  if (norm(a) === norm(b)) return true;
  if (kind === 'make') {
    const ca = canonicalMake(a);
    const cb = canonicalMake(b);
    if (ca && cb) return ca === cb;
  }
  if (kind === 'model') {
    const ma = matchModel(models, { make, model: a });
    const mb = matchModel(models, { make, model: b });
    if (ma && mb) {
      if (ma === mb) return true;
      // "Corolla" vs "Corolla Cross": the shorter name may just be an abbreviation.
      if (isBase(ma, mb) || isBase(mb, ma)) return null;
      return false;
    }
  }
  if (hasHebrew(a) !== hasHebrew(b)) return null; // different scripts: can't compare
  const na = norm(a);
  const nb = norm(b);
  return na.includes(nb) || nb.includes(na);
}
