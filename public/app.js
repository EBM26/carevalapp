// app.js — UI and state. All visible text comes from i18n.js via t().
import { scoreCar, ENUMS, DEAL_BREAKERS, num } from './scoring.js';
import { FIELDS, sanitizeCar, cleanValue } from './fields.js';
import { STRINGS } from './i18n.js';
import { buildSellerMessage, waLink } from './seller.js';
import { mergeGov, mergeFields } from './govmap.js';
import { MAX_IMAGES } from './extraction.js';

// ---------- storage (per-device conveniences only; D1 is the source of truth) ----------
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};

let lang = STRINGS[store.get('lang')] ? store.get('lang') : 'en';
let sort = ['max', 'min', 'date'].includes(store.get('sort')) ? store.get('sort') : 'max';
let statusFilter = ENUMS.status.includes(store.get('status')) ? store.get('status') : '';
let cars = [];          // last list loaded from the API
let models = [];        // cabin-fit table
let form = null;        // { id, draft } while editing; survives a language switch

const view = document.getElementById('view');
const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

// ---------- i18n ----------
function t(key, vars) {
  let s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  return s;
}

function applyLang() {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'he' ? 'rtl' : 'ltr';
  document.title = t('appTitle');
  document.getElementById('brand').textContent = t('appTitle');
  document.getElementById('langToggle').textContent = t('langToggle');
}

document.getElementById('langToggle').addEventListener('click', () => {
  lang = lang === 'en' ? 'he' : 'en';
  store.set('lang', lang);
  applyLang();
  route();
});

// ---------- DOM helpers ----------
/** h('div.a.b', {attr, onclick}, ...children). Text children are always text nodes (no innerHTML). */
function h(tag, props, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(' ');
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = `${el.className} ${v}`.trim();
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  if (value !== undefined) el.value = value;
  return el;
}

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nb = (v) => h('bdi', { dir: 'ltr' }, fmt.format(v));
const money = (v) => h('bdi', { dir: 'ltr' }, `₪${fmt.format(v)}`);

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  // Behind Cloudflare Access an expired session returns a login page, not JSON.
  if (!(res.headers.get('content-type') || '').includes('application/json')) throw new Error(t('sessionExpired'));
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

// ---------- routing ----------
function route() {
  const hash = location.hash || '#/';
  if (hash === '#/new') return renderForm(null);
  const m = /^#\/edit\/([\w-]+)$/.exec(hash);
  if (m) return renderForm(m[1]);
  return renderList();
}
window.addEventListener('hashchange', () => { form = null; route(); });

// ---------- shared score rendering ----------
function carTitle(car) {
  return [car.year, car.make, car.model, car.trim].filter(Boolean).join(' ') || t('untitled');
}

function scoreBlock(r) {
  const range = r.scoreMin === r.scoreMax
    ? nb(r.scoreMin)
    : h('bdi', { dir: 'ltr' }, `${fmt.format(r.scoreMin)}–${fmt.format(r.scoreMax)}`);
  const lo = Math.max(0, Math.min(100, r.scoreMin));
  const hi = Math.max(lo, Math.min(100, r.scoreMax));
  return [
    h('div.score-row', {},
      h('span.score-num', {}, range),
      h(`span.badge.${r.rating}${r.confirmed ? '' : '.provisional'}`, { title: t(r.confirmed ? 'confirmed' : 'provisional') }, t(`rating.${r.rating}`)),
      r.confirmed ? null : h('span.possibly', {}, t('possibly', { rating: t(`rating.${r.ratingMax}`) })),
      h('span.coverage', {}, t('coverage', { n: r.coverage })),
    ),
    h('div.bar', { role: 'img', 'aria-label': `${r.scoreMin}–${r.scoreMax} / 100` },
      // Solid = points guaranteed (0 → min); light = still possible (min → max).
      h(`div.fill.${r.rating}`, { style: `inset-inline-start:0;width:${lo}%` }),
      h(`div.fill.range.${r.ratingMax}`, { style: `inset-inline-start:${lo}%;width:${hi - lo}%` }),
      h('div.tick', { style: 'inset-inline-start:60%' }),
      h('div.tick', { style: 'inset-inline-start:80%' }),
    ),
  ];
}

function flagsBlock(r, compact) {
  const items = [
    ...r.dealBreakers.confirmed.map((k) => h('div.warn', {}, t('dealBreakerHit', { name: t(`db.${k}`) }))),
    ...r.warnings.map((w) => h('div.warn', {}, t(`warn.${w}`))),
  ];
  const open = r.dealBreakers.open;
  if (open.length) {
    if (compact) items.push(h('div.open-flag', {}, t('openFlagsCount', { n: open.length })));
    else items.push(...open.map((k) => h('div.open-flag', {}, t(`db.${k}`))));
  }
  if (!compact) items.push(...r.notes.map((n) => h('div.note', {}, t(`note.${n}`))));
  return items.length ? h('div.flags', {}, items) : null;
}

// ---------- list view ----------
function selectEl(name, options, value, onchange) {
  return h('select', { name, onchange, value },
    options.map(([v, label]) => h('option', { value: v }, label)));
}

async function renderList() {
  const toolbar = h('div.toolbar', {},
    h('label', {}, t('sort'),
      selectEl('sort', ['max', 'min', 'date'].map((s) => [s, t(`sort.${s}`)]), sort, (e) => {
        sort = e.target.value; store.set('sort', sort); renderList();
      })),
    h('label', {}, t('filterStatus'),
      selectEl('status', [['', t('allStatuses')], ...ENUMS.status.map((s) => [s, t(`status.${s}`)])], statusFilter, (e) => {
        statusFilter = e.target.value; store.set('status', statusFilter); renderList();
      })),
    h('div.actions', {},
      h('button.btn.small', { type: 'button', onclick: exportJson }, t('exportJson')),
      h('button.btn.small', { type: 'button', onclick: () => fileInput.click() }, t('importJson')),
    ),
  );
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importJson });
  const list = h('div.cards', {}, h('div.msg', {}, t('loading')));
  const fab = h('a.btn.primary.fab', { href: '#/new' }, t('addCar'));
  view.replaceChildren(toolbar, fileInput, list, fab);

  try {
    const qs = new URLSearchParams({ sort });
    if (statusFilter) qs.set('status', statusFilter);
    cars = await api('GET', `/api/cars?${qs}`);
  } catch (e) {
    list.replaceChildren(h('div.msg.error', {}, t('loadError', { msg: e.message })));
    return;
  }
  if (!cars.length) {
    list.replaceChildren(h('div.msg', {}, t(statusFilter ? 'emptyFiltered' : 'empty')));
    return;
  }
  list.replaceChildren(...cars.map(carCard));
}

function carCard(car) {
  const r = scoreCar(car);
  const open = () => { location.hash = `#/edit/${car.id}`; };
  const meta = [
    car.askingPrice !== null ? money(car.askingPrice) : null,
    car.currentKm !== null ? h('span', {}, nb(car.currentKm), ' ', t('unit.km')) : null,
    car.plate ? h('bdi', { dir: 'ltr' }, car.plate) : null,
  ].filter(Boolean);
  return h('article.card', { tabindex: 0, onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
    h('div.card-head', {},
      h('div.card-title', {}, h('bdi', { dir: 'auto' }, carTitle(car))),
      h('span.chip', {}, t(`status.${car.status}`)),
    ),
    meta.length ? h('div.card-meta', {}, meta.map((m) => h('span', {}, m))) : null,
    scoreBlock(r),
    flagsBlock(r, true),
    h('div', {},
      h('button.btn.small.danger', { type: 'button', onclick: (e) => { e.stopPropagation(); deleteCar(car.id, renderList); } }, t('delete'))),
  );
}

async function deleteCar(id, after) {
  if (!confirm(t('deleteConfirm'))) return;
  try {
    await api('DELETE', `/api/cars/${id}`);
    after();
  } catch (e) {
    toast(t('deleteError', { msg: e.message }));
  }
}

async function exportJson() {
  try {
    const all = await api('GET', '/api/cars?sort=date');
    const payload = { app: 'used-car-scorer', version: 1, exportedAt: new Date().toISOString(), cars: all };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `cars-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    toast(t('loadError', { msg: e.message }));
  }
}

async function importJson(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data?.cars;
    if (!Array.isArray(list)) throw new Error('no "cars" array');
    if (!confirm(t('importConfirm', { n: list.length }))) return;
    const res = await api('POST', '/api/cars', list);
    toast(t('importDone', { n: res.imported }));
    renderList();
  } catch (err) {
    toast(t('importError', { msg: err.message }));
  }
}

// ---------- cabin-fit suggestion ----------
const norm = (s) => String(s || '').toLowerCase().replace(/[\s'"׳״\-_.]/g, '');

function suggestFit(car) {
  const hay = norm(`${car.make || ''} ${car.model || ''} ${car.trim || ''}`);
  if (!hay) return null;
  let best = null;
  let bestLen = 0;
  for (const m of models) {
    for (const s of m.match) {
      const n = norm(s);
      if (n.length > bestLen && hay.includes(n)) { best = m; bestLen = n.length; }
    }
  }
  return best;
}

async function loadModels() {
  try {
    const res = await fetch('models.json');
    models = (await res.json()).models || [];
  } catch { models = []; }
}

// ---------- form view ----------
const SECTIONS = [
  ['listing', ['plate', 'govFetch', 'make', 'model', 'trim', 'year', 'status', 'listingUrl:full', 'sellerPhone']],
  ['price', ['askingPrice', 'benchmarkPrice', 'yad2Low', 'yad2High', 'hint:benchmarkHint']],
  ['mileage', ['firstRegistration', 'currentKm', 'lastTestKm', 'lastTestDate']],
  ['ownership', ['originalOwnership', 'handCount', 'owners']],
  ['history', ['insuranceClaims', 'serviceHistory']],
  ['condition', ['testExpiry', 'tires', 'cabinFit']],
  ['dealBreakers', ['dealBreakers']],
  ['notes', ['notes:full']],
];

const ENUM_I18N = {
  benchmarkSource: null,
  originalOwnership: 'ownershipType',
  insuranceClaims: 'insuranceClaims',
  serviceHistory: 'serviceHistory',
  cabinFit: 'cabinFit',
  tires: 'tires',
  status: 'status',
};

function emptyDraft() {
  return { status: 'considering', dealBreakers: Object.fromEntries(DEAL_BREAKERS.map((k) => [k, 'unknown'])), fieldSources: {} };
}

/** Turn the raw form draft into a clean car object, ready for scoring or saving. */
function buildCar(draft) {
  const c = { ...draft };
  const hc = num(c.handCount);
  let hist = Array.isArray(c.ownershipHistory) ? c.ownershipHistory.slice() : [];
  if (hc !== null && hc >= 1) {
    hist = Array.from({ length: Math.min(Math.floor(hc), 20) }, (_, i) => hist[i] || { type: null });
  }
  if (hist.length) hist[0] = { ...hist[0], type: c.originalOwnership || hist[0].type || null };
  c.ownershipHistory = hist.length > 1 ? hist : null;
  c.benchmarkSource = num(c.benchmarkPrice) ? 'levi_yitzhak'
    : num(c.yad2Low) && num(c.yad2High) ? 'yad2_comparables' : null;
  return sanitizeCar(c);
}

async function renderForm(id) {
  if (!form || form.id !== id) {
    let draft = emptyDraft();
    if (id) {
      let car = cars.find((c) => c.id === id);
      if (!car) {
        view.replaceChildren(h('div.msg', {}, t('loading')));
        try { cars = await api('GET', '/api/cars'); } catch (e) {
          view.replaceChildren(h('div.msg.error', {}, t('loadError', { msg: e.message })));
          return;
        }
        car = cars.find((c) => c.id === id);
        if (!car) { location.hash = '#/'; return; }
      }
      draft = structuredClone(car);
    }
    // Seller message language defaults to Hebrew regardless of the UI language.
    form = { id, draft, sellerLang: 'he' };
  }
  const draft = form.draft;

  // Compact score strip stays pinned while scrolling; the details scroll with the form.
  const panel = h('section.score-panel', { 'aria-live': 'polite' });
  const details = h('section.score-details');
  const sellerBox = h('section.seller');
  const govBox = h('div.gov.full');

  // ----- gov lookup -----
  function displayValue(key, v) {
    if (v === null || v === undefined || v === '') return t('unknown');
    if (key === 'ownershipHistory') return v.map((o) => (o?.type ? t(`ownershipType.${o.type}`) : '?')).join(' → ');
    const prefix = ENUM_I18N[key];
    if (prefix) return t(`${prefix}.${v}`);
    if (typeof v === 'number' && key !== 'year') return fmt.format(v);
    return String(v);
  }

  async function fetchGov() {
    const plate = cleanValue('plate', draft.plate);
    if (!plate) { form.gov = { status: 'error', message: t('gov.needPlate') }; renderGov(); return; }
    form.gov = { status: 'loading' };
    renderGov();
    const session = form;
    try {
      const res = await api('GET', `/api/gov?plate=${plate}`);
      if (form !== session) return; // user left the form while the lookup ran
      if (!res.found) {
        form.gov = { status: 'notFound', failed: res.failed };
      } else {
        const m = mergeGov(draft, res.fields);
        Object.assign(draft, m.car);
        form.gov = { status: 'done', filled: m.filled, conflicts: m.conflicts, hints: res.hints, extra: res.extra, failed: res.failed };
      }
    } catch (e) {
      if (form !== session) return;
      const failed = e.data?.failed;
      form.gov = { status: 'error', message: failed ? t('gov.unavailable', { msg: failed.map((f) => f.reason).join('; ') }) : e.message };
    }
    // Re-render the whole form so filled inputs show their new values.
    renderForm(id);
  }

  // Shared by gov lookup and screenshot import. stateKey: 'gov' | 'shot'.
  const SOURCE_OF = { gov: 'gov', shot: 'screenshot' };
  function resolveConflict(stateKey, c, useTheirs) {
    if (useTheirs) {
      draft[c.key] = c.gov;
      draft.fieldSources = { ...draft.fieldSources, [c.key]: SOURCE_OF[stateKey] };
    }
    form[stateKey].conflicts = form[stateKey].conflicts.filter((x) => x !== c);
    if (useTheirs) renderForm(id); else (stateKey === 'gov' ? renderGov() : renderShot());
  }

  function conflictList(stateKey) {
    const st = form[stateKey];
    if (!st?.conflicts?.length) return [];
    const p = stateKey === 'gov' ? { title: 'gov.conflicts', theirs: 'gov.gov', use: 'gov.useGov' }
      : { title: 'shot.conflicts', theirs: 'shot.theirs', use: 'shot.useTheirs' };
    return [
      h('strong', {}, t(p.title)),
      ...st.conflicts.map((c) => h('div.conflict', {},
        h('div.conflict-label', {}, t(`field.${c.key}`)),
        h('div.conflict-vals', {},
          h('span', {}, t('gov.yours'), ': ', h('bdi', { dir: 'auto' }, displayValue(c.key, c.mine))),
          h('span', {}, t(p.theirs), ': ', h('bdi', { dir: 'auto' }, displayValue(c.key, c.gov)))),
        h('div.conflict-actions', {},
          h('button.btn.small', { type: 'button', onclick: () => resolveConflict(stateKey, c, false) }, t('gov.useMine')),
          h('button.btn.small', { type: 'button', onclick: () => resolveConflict(stateKey, c, true) }, t(p.use))))),
    ];
  }

  function renderGov() {
    const g = form.gov || { status: 'idle' };
    const btn = h('button.btn.small', { type: 'button', onclick: fetchGov, disabled: g.status === 'loading' },
      t(g.status === 'loading' ? 'gov.loading' : 'gov.fetch'));
    const kids = [btn];
    const failedNote = g.failed?.length
      ? h('div.warn-soft', {}, t('gov.partial', { list: g.failed.map((f) => t(`gov.ds.${f.dataset}`)).join(', ') }))
      : null;
    if (g.status === 'error') kids.push(h('div.warn-soft', {}, g.message));
    if (g.status === 'notFound') kids.push(h('div.note', {}, t('gov.notFound')), failedNote);
    if (g.status === 'done') {
      kids.push(h('div.note', {}, t('gov.applied', { n: g.filled.length })), failedNote);
      for (const hint of g.hints || []) kids.push(h('div.note', {}, t(`gov.hint.${hint.code}`, hint)));
      const x = g.extra || {};
      if (x.colorChanged) kids.push(h('div.note', {}, t('gov.extra.colorChanged')));
      if (x.tiresChanged) kids.push(h('div.note', {}, t('gov.extra.tiresChanged')));
      if (x.personalImport) kids.push(h('div.note', {}, t('gov.extra.personalImport')));
      kids.push(...conflictList('gov'));
    }
    govBox.replaceChildren(...kids.filter(Boolean));
  }

  // ----- screenshot import -----
  const shotBox = h('section.shot');
  const shotInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: importShots });

  async function importShots(e) {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    if (files.length > MAX_IMAGES) { form.shot = { status: 'error', message: t('shot.tooMany', { n: MAX_IMAGES }) }; renderShot(); return; }
    const session = form;
    form.shot = { status: 'loading', n: files.length };
    renderShot();
    try {
      // Wrapped: map() would pass the index as fileToJpeg's maxSide argument.
      const images = await Promise.all(files.map((f) => fileToJpeg(f)));
      const res = await api('POST', '/api/extract', { images });
      if (form !== session) return;
      const m = mergeFields(draft, res.fields, 'screenshot');
      Object.assign(draft, m.car);
      form.shot = { status: 'done', filled: m.filled, conflicts: m.conflicts };
    } catch (err) {
      if (form !== session) return;
      form.shot = { status: 'error', message: t('shot.error', { msg: err.message }) };
    }
    renderForm(id);
  }

  function renderShot() {
    const s = form.shot || { status: 'idle' };
    const kids = [
      shotInput,
      h('button.btn.primary.shot-btn', { type: 'button', disabled: s.status === 'loading', onclick: () => shotInput.click() },
        s.status === 'loading' ? t('shot.reading', { n: s.n }) : t('shot.import')),
    ];
    if (s.status === 'idle') kids.push(h('div.note', {}, t('shot.hint')));
    if (s.status === 'error') kids.push(h('div.warn-soft', {}, s.message));
    if (s.status === 'done') {
      kids.push(h('div.note', {}, t(s.filled.length || s.conflicts.length ? 'shot.applied' : 'shot.none', { n: s.filled.length })));
      kids.push(...conflictList('shot'));
    }
    shotBox.replaceChildren(...kids);
  }

  const ownersBox = h('div.grid.full', { style: 'grid-column:1/-1' });
  const suggestBox = h('div.suggest');

  const fieldEl = (spec) => {
    const [key, mod] = spec.split(':');
    if (key === 'hint') return h('div.hint', {}, t(mod));
    if (key === 'owners') return ownersBox;
    if (key === 'govFetch') return govBox;
    if (key === 'dealBreakers') return dealBreakerControls(draft);
    const f = FIELD_BY_KEY[key];
    const val = draft[key] ?? '';
    let input;
    if (f.type === 'enum') {
      const prefix = ENUM_I18N[key];
      const opts = key === 'status' ? [] : [['', t('unknown')]];
      input = selectEl(key, [...opts, ...f.arg.map((v) => [v, t(`${prefix}.${v}`)])], val);
    } else if (key === 'notes') {
      input = h('textarea', { name: key, dir: 'auto', value: val });
    } else {
      const attrs = { name: key, dir: 'auto', value: String(val), autocomplete: 'off' };
      if (f.type === 'int' || f.type === 'plate') Object.assign(attrs, { type: 'text', inputmode: 'numeric' });
      else if (f.type === 'ym') Object.assign(attrs, { type: 'month', placeholder: 'YYYY-MM' });
      else if (f.type === 'date') attrs.type = 'date';
      else if (f.type === 'url') Object.assign(attrs, { type: 'url', inputmode: 'url' });
      else if (f.type === 'phone') attrs.type = 'tel';
      else attrs.type = 'text';
      input = h('input', attrs);
    }
    const src = draft.fieldSources?.[key];
    const badge = src === 'screenshot' || src === 'gov' ? h(`span.src-badge.${src}`, {}, t(`src.${src}`)) : null;
    return h(`label.field${mod === 'full' ? '.full' : ''}${src === 'screenshot' ? '.from-shot' : ''}`, {},
      h('span', {}, t(`field.${key}`), badge), input,
      key === 'cabinFit' ? suggestBox : null);
  };

  const formEl = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
    SECTIONS.map(([sec, keys]) =>
      h('fieldset', {}, h('legend', {}, t(`sec.${sec}`)),
        sec === 'dealBreakers' ? fieldEl('dealBreakers') : h('div.grid', {}, keys.map(fieldEl)))),
    h('div.form-actions', {},
      h('button.btn.primary', { type: 'submit' }, t('save')),
      h('a.btn', { href: '#/' }, t('cancel')),
      id ? h('button.btn.danger', { type: 'button', onclick: () => deleteCar(id, () => { location.hash = '#/'; }) }, t('delete')) : null,
    ),
  );

  // 'input' fires for every control type (text, select, radio, date). Also
  // handling 'change' would re-render on blur, which swallowed taps on
  // buttons in the panel right after typing.
  formEl.addEventListener('input', onEdit);

  function onEdit(e) {
    const name = e.target.name;
    if (!name) return;
    let ownerIdx;
    if (name.startsWith('db-')) {
      const k = name.slice(3);
      draft.dealBreakers = { ...draft.dealBreakers, [k]: e.target.value };
      draft.fieldSources = { ...draft.fieldSources, [`dealBreakers.${k}`]: 'manual' };
    } else if ((ownerIdx = /^owner-(\d+)$/.exec(name))) {
      const i = +ownerIdx[1];
      const hist = Array.isArray(draft.ownershipHistory) ? draft.ownershipHistory.slice() : [];
      while (hist.length <= i) hist.push({ type: null });
      hist[i] = { ...hist[i], type: e.target.value || null };
      draft.ownershipHistory = hist;
      draft.fieldSources = { ...draft.fieldSources, ownershipHistory: 'manual' };
    } else if (name in FIELD_BY_KEY) {
      draft[name] = e.target.value;
      const lbl = e.target.closest('label.field');
      lbl?.classList.remove('from-shot');
      lbl?.querySelector('.src-badge')?.remove();
      draft.fieldSources = { ...draft.fieldSources, [name]: 'manual' };
    } else return;
    if (name === 'handCount') renderOwners();
    if (['make', 'model', 'trim', 'cabinFit'].includes(name)) renderSuggest();
    renderPanel();
  }

  function renderOwners() {
    const hc = Math.min(num(draft.handCount) ?? 0, 6);
    const kids = [];
    for (let i = 1; i < hc; i++) {
      const v = draft.ownershipHistory?.[i]?.type ?? '';
      kids.push(h('label.field', {}, h('span', {}, t('ownerN', { n: i + 1 })),
        selectEl(`owner-${i}`, [['', t('unknown')], ...ENUMS.ownershipType.map((o) => [o, t(`ownershipType.${o}`)])], v)));
    }
    ownersBox.replaceChildren(...kids);
    ownersBox.hidden = !kids.length;
  }

  function renderSuggest() {
    const s = suggestFit(draft);
    if (!s || s.fit === draft.cabinFit) { suggestBox.replaceChildren(); return; }
    suggestBox.replaceChildren(
      h('span', {}, t('cabinSuggest', { fit: t(`cabinFit.${s.fit}`) }), ' (', h('bdi', {}, s.name), ')'),
      h('button.btn.small', {
        type: 'button',
        onclick: () => {
          draft.cabinFit = s.fit;
          draft.fieldSources = { ...draft.fieldSources, cabinFit: 'manual' };
          formEl.querySelector('[name="cabinFit"]').value = s.fit;
          renderSuggest();
          renderPanel();
        },
      }, t('apply')),
    );
  }

  function renderSeller(car) {
    const msg = buildSellerMessage(car, form.sellerLang);
    const key = JSON.stringify([lang, form.sellerLang, msg, car.sellerPhone]);
    if (sellerBox.dataset.key === key) return; // unchanged: keep DOM (and any in-progress tap) intact
    sellerBox.dataset.key = key;
    const langSelect = selectEl('sellerLang', ['he', 'en'].map((l) => [l, t(`langName.${l}`)]), form.sellerLang, (e) => {
      form.sellerLang = e.target.value;
      renderSeller(buildCar(draft));
    });
    langSelect.setAttribute('aria-label', t('seller.lang'));
    const head = h('div.seller-head', {}, h('strong', {}, t('seller.title')), langSelect);
    if (!msg) {
      sellerBox.replaceChildren(head, h('div.note', {}, t('seller.nothing')));
      return;
    }
    const text = h('textarea', {
      readonly: true, rows: 4, dir: form.sellerLang === 'he' ? 'rtl' : 'ltr',
      lang: form.sellerLang, value: msg,
    });
    const link = waLink(car.sellerPhone, msg);
    sellerBox.replaceChildren(
      head,
      text,
      h('div.seller-actions', {},
        h('button.btn.small', { type: 'button', onclick: () => copyText(msg, text) }, t('seller.copy')),
        link
          ? h('a.btn.small.wa', { href: link, target: '_blank', rel: 'noopener' }, t('seller.whatsapp'))
          : h('span.note', {}, t('seller.noPhone')),
      ),
    );
  }

  function renderPanel() {
    const car = buildCar(draft);
    renderSeller(car);
    const r = scoreCar(car);
    const next = r.nextSteps.length ? h('div', {},
      h('strong', {}, t('nextSteps')),
      h('ol.next-steps', {}, r.nextSteps.map((s) => h('li', {},
        t('nextStepItem', { part: t(`part.${s.part}`), n: s.impact }),
        s.fields.length ? h('span.note', {}, t('missing', { fields: s.fields.map((f) => t(`field.${f}`)).join(', ') })) : null,
      )))) : null;
    const rows = Object.entries(r.parts).map(([k, p]) => h('tr', {},
      h('td', {}, t(`part.${k}`)),
      h('td', {}, h('bdi', { dir: 'ltr' }, p.min === p.max ? `${p.min}` : `${p.min}–${p.max}`, ` / ${p.weight}`))));
    panel.replaceChildren(...scoreBlock(r));
    details.replaceChildren(
      flagsBlock(r, false),
      next,
      h('details.more', { open: form.breakdownOpen, ontoggle: (e) => { form.breakdownOpen = e.target.open; } },
        h('summary', {}, t('breakdown')), h('table.breakdown', {}, h('tbody', {}, rows))),
    );
  }

  async function save() {
    const btn = formEl.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = t('saving');
    try {
      const body = { ...buildCar(draft), fieldSources: draft.fieldSources };
      if (id) await api('PUT', `/api/cars/${id}`, body);
      else await api('POST', '/api/cars', body);
      location.hash = '#/';
    } catch (e) {
      toast(t('saveError', { msg: e.message }));
      btn.disabled = false;
      btn.textContent = t('save');
    }
  }

  renderOwners();
  renderSuggest();
  renderGov();
  renderShot();
  renderPanel();
  view.replaceChildren(
    h('div.form-head', {}, h('h1', {}, t(id ? 'editCar' : 'newCar')), h('a.btn.ghost', { href: '#/' }, t('back'))),
    panel,
    shotBox,
    details,
    sellerBox,
    formEl,
  );
}

/** Downscale and re-encode an image file → { mimeType, data(base64) }. Keeps uploads small. */
async function fileToJpeg(file, maxSide = 2000, quality = 0.82) {
  let src;
  let w;
  let hgt;
  try {
    src = await createImageBitmap(file);
    w = src.width; hgt = src.height;
  } catch {
    src = new Image();
    const url = URL.createObjectURL(file);
    src.src = url;
    await src.decode();
    URL.revokeObjectURL(url);
    w = src.naturalWidth; hgt = src.naturalHeight;
  }
  const scale = Math.min(1, maxSide / Math.max(w, hgt));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(hgt * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return { mimeType: 'image/jpeg', data: canvas.toDataURL('image/jpeg', quality).split(',')[1] };
}

async function copyText(text, textarea) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('seller.copied'));
  } catch {
    // Older browsers / non-secure contexts: select the text and use execCommand.
    textarea.select();
    const ok = document.execCommand && document.execCommand('copy');
    toast(t(ok ? 'seller.copied' : 'seller.copyFailed'));
  }
}

function dealBreakerControls(draft) {
  return h('div', {}, DEAL_BREAKERS.map((k) => {
    const cur = draft.dealBreakers?.[k] || 'unknown';
    return h('div.tri-row', { role: 'radiogroup', 'aria-label': t(`db.${k}`) },
      h('div.tri-label', {}, t(`db.${k}`)),
      h('div.seg', {}, ENUMS.triState.map((v) =>
        h(`label.${v}`, {},
          h('input', { type: 'radio', name: `db-${k}`, value: v, checked: v === cur }),
          t(`tri.${v}`)))));
  }));
}

// ---------- boot ----------
applyLang();
loadModels().then(() => { if (form) route(); });
route();
