// app.js — UI and state. All visible text comes from i18n.js via t().
import { scoreCar, ENUMS, DEAL_BREAKERS, num, RAW_TOTAL } from './scoring.js';
import { FIELDS, sanitizeCar, cleanValue, AD_KEYS } from './fields.js';
import { STRINGS } from './i18n.js';
import { buildSellerMessage, waNumber, sendWhatsApp } from './seller.js';
import { MAX_FILES, PDF_TYPE, MAX_FILE_BASE64 } from './extraction.js';
import { mergeUpload, undoUpload, setValue, seedAdValues } from './upload.js';
import { askedFields, replyHasContent } from './reply.js';
import { generateTitle } from './title.js';
import { verdict, nextStep } from './verdict.js';
import { summarize } from './summary.js';
import { formatPlate } from './format.js';
import { modelKey } from './modelnotes.js';
import { applyRegistry, comparisonRows, trustIssues, effectiveCar } from './govcompare.js';
import { quickCheck, resolveComparison, estimateKey, QUICK_CHECK_UNTIL, VERDICT_ORDER, VERDICT_TONE, VERDICT_QCLASS } from './quickcheck.js';

// ---------- storage (per-device conveniences only; D1 is the source of truth) ----------
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};

let lang = STRINGS[store.get('lang')] ? store.get('lang') : 'en';
const SORTS = ['max', 'min', 'date', 'quick'];
let sort = SORTS.includes(store.get('sort')) ? store.get('sort') : 'max';
let statusFilter = ENUMS.status.includes(store.get('status')) ? store.get('status') : '';
let cars = [];          // last list loaded from the API
let form = null;        // edit-screen state; survives a language switch
let carsLoaded = false; // `cars` holds every saved car (needed for price comparables)
let settings = { budgetCeiling: null };

const view = document.getElementById('view');
const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const $ = (id) => document.getElementById(id);

// ---------- i18n ----------
function t(key, vars) {
  let s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  return s;
}

function tIn(l, key, vars) {
  let s = STRINGS[l][key] ?? STRINGS.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  return s;
}

function applyLang() {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'he' ? 'rtl' : 'ltr';
  document.title = t('appTitle');
  $('brand').textContent = t('appTitle');
  $('langToggle').textContent = t('langToggle');
  $('logout').textContent = t('logout');
  $('addCar').textContent = t('addCarBtn');
  $('menuBtn').setAttribute('aria-label', t('menu.more'));
  $('menuExport').textContent = t('exportJson');
  $('menuImport').textContent = t('importJson');
  $('menuSettings').textContent = t('menu.settings');
  $('menuLang').textContent = t('langToggle');
  $('menuLogout').textContent = t('logout');
}

function toggleLang() {
  lang = lang === 'en' ? 'he' : 'en';
  store.set('lang', lang);
  applyLang();
  route();
}

// ---------- header menu ----------
function setMenu(open) {
  $('menuPop').hidden = !open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
}
$('menuBtn').addEventListener('click', (e) => { e.stopPropagation(); setMenu($('menuPop').hidden); });
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); form?.closeSheet?.(); } });
$('menuExport').addEventListener('click', () => { setMenu(false); exportJson(); });
$('menuImport').addEventListener('click', () => { setMenu(false); $('importFile').click(); });
$('menuSettings').addEventListener('click', () => { setMenu(false); location.hash = '#/settings'; });
$('menuLang').addEventListener('click', () => { setMenu(false); toggleLang(); });
$('langToggle').addEventListener('click', toggleLang);
$('importFile').addEventListener('change', importJson);

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

/** Inline SVG from a list of [tag, attrs] (no innerHTML). */
function svg(viewBox, cls, parts) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('aria-hidden', 'true');
  if (cls) el.setAttribute('class', cls);
  for (const [tag, attrs] of parts) {
    const p = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    el.append(p);
  }
  return el;
}
const ICON = {
  flag: () => svg('0 0 16 16', null, [['path', { d: 'M3 1.5v13M3 2.5h8.5l-2 3 2 3H3' }]]),
  alert: () => svg('0 0 16 16', null, [['path', { d: 'M8 1.5l7 12.5H1z' }], ['rect', { x: '7.25', y: '6', width: '1.5', height: '4.2', fill: '#fff' }], ['rect', { x: '7.25', y: '11.2', width: '1.5', height: '1.5', fill: '#fff' }]]),
  chev: () => svg('0 0 12 12', 'chev', [['path', { d: 'M4.5 2.5l3.5 3.5-3.5 3.5' }]]),
  upload: () => svg('0 0 24 24', null, [['path', { d: 'M12 15V4M7.5 8.5L12 4l4.5 4.5' }], ['path', { d: 'M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15' }]]),
  pen: () => svg('0 0 24 24', null, [['path', { d: 'M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16z' }], ['path', { d: 'M13.5 6.5l4 4' }]]),
};
// The flag icon is a filled pennant: fill it via CSS (.flag svg { fill }).
function flagIcon(label) {
  const el = svg('0 0 16 16', null, [['path', { d: 'M3 1.5h1.4v13H3zM4.4 2.2h8.1l-1.9 3.1 1.9 3.1H4.4z' }]]);
  const text = label || t('flag.title');
  return h('span.flag', { title: text, role: 'img', 'aria-label': text }, el);
}

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const ltr = (text) => h('bdi', { dir: 'ltr' }, text);

function toast(msg) {
  const el = $('toast');
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
  // Only 401 means the session is gone (cookie expired, or password/secret changed).
  if (res.status === 401) throw Object.assign(new Error(t('sessionExpired')), { status: 401 });
  // Anything else that isn't JSON (a platform 5xx page, a proxy) is not a session problem:
  // show the real status and a short snippet instead.
  if (!(res.headers.get('content-type') || '').includes('application/json')) {
    const snippet = (await res.text().catch(() => '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    throw Object.assign(new Error(`HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`), { status: res.status });
  }
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${data.error || data.detail || 'request failed'}`), { data, status: res.status });
  return data;
}

// ---------- routing ----------
function route() {
  const hash = location.hash || '#/';
  view.classList.remove('editing');
  document.body.classList.remove('sheet-open');
  if (hash === '#/new') return renderForm(null);
  if (hash === '#/settings') return renderSettings();
  const m = /^#\/edit\/([\w-]+)$/.exec(hash);
  if (m) return renderForm(m[1]);
  return renderList();
}
window.addEventListener('hashchange', () => {
  // Leaving the form: cancel its pending timers so nothing runs against a closed form.
  if (form) { clearTimeout(form.estTimer); clearTimeout(form.govTimer); }
  form = null;
  route();
});

// ---------- shared pieces ----------
/** The car's own title; cars without one fall back to make / model / trim / year. */
function carTitle(car) {
  return car.title || [car.make, car.model, car.trim, car.year].filter(Boolean).join(' ') || t('untitled');
}

function plateBadge(plate, size = '') {
  const digits = cleanValue('plate', plate);
  if (!digits) return h(`span.plate.none${size ? `.${size}` : ''}`, {}, h('span.plate-num', {}, t('plate.none')));
  return h(`span.plate${size ? `.${size}` : ''}`, { dir: 'ltr', 'aria-label': `${t('field.plate')} ${formatPlate(digits)}` },
    h('span.plate-il', { 'aria-hidden': 'true' }, 'IL'),
    h('span.plate-num', {}, formatPlate(digits)));
}

/** 0–100 bar: solid 0→min, lighter min→max, both in the best-case tone; ticks at 60/80. Never flips. */
function scoreBar(r, v) {
  const lo = Math.max(0, Math.min(100, r.scoreMin));
  const hi = Math.max(lo, Math.min(100, r.scoreMax));
  return h('div.bar', { dir: 'ltr', role: 'img', 'aria-label': `${r.scoreMin}–${r.scoreMax} / 100` },
    h(`div.solid.tone-${v.barTone}`, { style: `inset-inline-start:0;width:${lo}%` }),
    h(`div.range.tone-${v.barTone}`, { style: `inset-inline-start:${lo}%;width:${hi - lo}%` }),
    h('div.tick', { style: 'inset-inline-start:60%' }),
    h('div.tick', { style: 'inset-inline-start:80%' }));
}

function verdictLabel(v, short) {
  if (v.kind === 'TOO_EARLY') return t(short ? 'verdict.tooEarlyShort' : 'verdict.tooEarly');
  return t(`rating.${v.kind}`);
}

function verdictBadge(v, short = true) {
  const title = v.upTo ? t('verdict.possibly', { rating: t(`rating.${v.upTo}`) }) : null;
  return h(`span.badge.${v.tone}${v.provisional && v.kind !== 'TOO_EARLY' ? '.provisional' : ''}`, { title }, verdictLabel(v, short));
}

/** The API's quota/overload answer (HTTP 429 { error: 'ai_limit' }). */
const isAiLimit = (e) => e?.data?.error === 'ai_limit';

/** Loading placeholder for AI work: shimmer + label, or a static "Working…" with reduced motion. */
function skeleton(labelKey) {
  return h('div.skel', { role: 'status' },
    h('div.skel-block', { 'aria-hidden': 'true' }),
    h('span.skel-label.motion', {}, t(labelKey)),
    h('span.skel-label.still', {}, t('load.working')));
}
const spinner = () => h('span.spinner', { 'aria-hidden': 'true' });

const hasFlag = (r) => r.dealBreakers.confirmed.length > 0 || r.warnings.length > 0;

// ---------- quick check (stage 1) ----------
/** Quick check for a car against the other saved cars and its cached AI estimate. */
function quickFor(car, { estimate = car.priceEstimate, pending = false, snapshot = car.registry } = {}) {
  const scored = effectiveCar(car, snapshot?.fields);
  const comparison = resolveComparison(scored, { others: cars, estimate });
  const trust = trustIssues(car, snapshot);
  const qc = quickCheck(scored, { budget: settings.budgetCeiling, comparison: comparison.value ? comparison : null, pending, trust });
  return { qc, comparison, trust };
}

const reasonText = (r, l = lang) => tIn(l, r.key, r.vars);
const qcLabel = (qc) => t(`qc.verdict.${qc.verdict}`);
const qcLine = (qc) => (qc.reasons.length ? t('qc.line', { verdict: qcLabel(qc), reasons: qc.reasons.map((r) => reasonText(r)).join(', ') }) : qcLabel(qc));
const qcBadge = (qc) => h(`span.badge.${VERDICT_QCLASS[qc.verdict]}`, { title: qcLine(qc) }, qcLabel(qc));

/** Headline for a car: the quick check below 50% coverage, the full score from 50%. */
function headline(car, r, v, qc) {
  if (r.coverage < QUICK_CHECK_UNTIL) return { stage: 'quick', badge: qcBadge(qc) };
  return { stage: 'full', badge: verdictBadge(v) };
}

/** One sentence comparing the asking price with the comparison source. */
function comparisonText(car, cmp, est) {
  const price = num(car.askingPrice);
  if (price === null) return { text: t('cmp.noPrice') };
  if (!cmp.value) {
    const key = estimateKey(car);
    if (cmp.needsAi && est && est.key === key) {
      if (est.status === 'loading' || est.status === 'scheduled') return { text: t('cmp.loading'), muted: true };
      if (est.status === 'error') return { text: `${t('cmp.aiUnavailable')} ${t('cmp.none')}`, muted: true };
      if (est.status === 'limit') return { text: t('ai.limit'), muted: true };
      if (est.status === 'unknown') return { text: `${t('cmp.aiUnknown')} ${t('cmp.none')}`, muted: true };
    }
    return { text: t('cmp.none') };
  }
  const diff = price - cmp.value;
  const dir = Math.abs(diff) < 500 ? 'same' : diff < 0 ? 'below' : 'above';
  const vars = { diff: fmt.format(Math.abs(diff)), n: cmp.n, low: fmt.format(cmp.low ?? 0), high: fmt.format(cmp.high ?? 0) };
  if (cmp.source === 'saved') return { source: 'saved', text: `${t(`cmp.saved.${dir}`, vars)}${cmp.adjusted ? ` ${t('cmp.saved.adjusted')}` : ''}` };
  if (cmp.source === 'ai') return { source: 'ai', text: `${t('cmp.ai.range', vars)} ${t(`cmp.ai.${dir}`, vars)}`, muted: true };
  return { source: cmp.source, text: t(`cmp.manual.${dir}`, vars) };
}

/** Segmented control: a radio group styled as connected buttons. options: [[value, label]]. */
function seg(name, options, current, { small = false, label } = {}) {
  return h(`div.seg${small ? '.small' : ''}`, { role: 'radiogroup', 'aria-label': label },
    options.map(([v, l]) => h('label.seg-opt', {},
      h('input', { type: 'radio', name, value: v, checked: String(current ?? '') === String(v) }),
      h('span', {}, l))));
}

/** Select with the custom chevron wrapper. */
function select(name, options, value, onchange, label) {
  return h('span.select', {}, h('select', { name, onchange, value, 'aria-label': label },
    options.map(([v, l]) => h('option', { value: v }, l))));
}

/** Segments that don't fit on one line switch to a 2-column grid. Never horizontal scroll. */
function fitSegs(root = document) {
  root.querySelectorAll('.seg').forEach((s) => {
    s.classList.remove('wrap');
    if (s.scrollWidth > s.clientWidth + 1) s.classList.add('wrap');
  });
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => fitSegs(), 100); });
document.fonts?.ready.then(() => fitSegs());

// ---------- list view ----------
async function renderList() {
  const statusOptions = [['', t('allStatuses')], ...ENUMS.status.map((s) => [s, t(`status.${s}`)])];
  const onStatus = (value) => { statusFilter = value; store.set('status', statusFilter); renderList(); };
  const statusSeg = seg('statusFilter', statusOptions, statusFilter, { small: true, label: t('filterStatus') });
  statusSeg.addEventListener('input', (e) => onStatus(e.target.value));
  const controls = h('div.list-controls', {},
    h('label.ctl.ctl-sort', {}, h('span', {}, t('sort')),
      select('sort', SORTS.map((s) => [s, t(`sort.${s}`)]), sort, (e) => {
        sort = e.target.value; store.set('sort', sort); renderList();
      })),
    h('div.ctl.status-seg', {}, h('span', {}, t('filterStatus')), statusSeg),
    h('label.ctl.status-select', {}, h('span', {}, t('filterStatus')),
      select('statusFilterSelect', statusOptions, statusFilter, (e) => onStatus(e.target.value))),
  );
  const list = h('div.rows-wrap', {}, h('div.msg', {}, t('loading')));
  view.replaceChildren(controls, list);
  requestAnimationFrame(() => fitSegs(controls));

  try {
    // Always load every car: the quick check compares prices across all saved cars.
    cars = await api('GET', `/api/cars?${new URLSearchParams({ sort: sort === 'quick' ? 'max' : sort })}`);
    carsLoaded = true;
  } catch (e) {
    list.replaceChildren(h('div.msg.error', {}, t('loadError', { msg: e.message })));
    return;
  }
  let shown = statusFilter ? cars.filter((c) => c.status === statusFilter) : cars.slice();
  const rowsData = shown.map((car) => {
    const r = scoreCar(effectiveCar(car, car.registry?.fields)); // registry values win
    return { car, r, v: verdict(r), ...quickFor(car) };
  });
  if (sort === 'quick') {
    // Pursue, then Maybe, then Skip; ties keep the best-case order from the API.
    rowsData.sort((a, b) => VERDICT_ORDER[a.qc.verdict] - VERDICT_ORDER[b.qc.verdict]);
  }
  shown = rowsData;
  if (!shown.length) {
    list.replaceChildren(statusFilter
      ? h('div.empty', {}, h('p', {}, t('emptyFiltered')))
      : h('div.empty', {}, h('p', {}, t('emptyNew')), h('a.btn.primary', { href: '#/new' }, t('addCarBtn'))));
    return;
  }
  const head = h('div.row-head', { 'aria-hidden': 'true' },
    h('span', {}, t('col.plate')), h('span', {}, t('col.car')), h('span.end', {}, t('col.price')), h('span.end', {}, t('col.km')),
    h('span', {}, t('col.score')), h('span', {}, t('col.verdict')), h('span.end', {}, t('col.known')), h('span', {}, t('col.status')), h('span'));
  list.replaceChildren(h('div.rows', {}, head, ...shown.map(carRow)));
}

/** Muted line under the title: location · km per year. */
function rowSub(car, r) {
  const kpy = r.parts.mileage.kpy;
  const bits = [];
  if (car.location) bits.push(h('bdi', { dir: 'auto' }, car.location));
  if (car.sellerName) bits.push(h('bdi.sub-seller', { dir: 'auto' }, car.sellerName));
  if (kpy) {
    bits.push(h('span.sub-kpy', { title: kpy.estimated ? t('kpy.estimated') : null },
      ltrNums(t('kpy.value', { n: fmt.format(kpy.value) })), kpy.estimated ? ` (${t('kpy.estShort')})` : ''));
  }
  if (!bits.length) return null;
  return h('span.sub', {}, ...bits.flatMap((b, i) => (i ? [h('span.sep', { 'aria-hidden': 'true' }, ' · '), b] : [b])));
}

/** "≈ 18,400 km/yr" plus how it was worked out, for the form and the breakdown. */
function kpyText(kpy) {
  if (!kpy) return [];
  const how = kpy.estimated ? t('kpy.estimated') : kpy.toTest ? t('kpy.toTest') : null;
  return [h('span.kpy-n', {}, ltrNums(t('kpy.value', { n: fmt.format(kpy.value) }))), how ? h('span.kpy-how', {}, ` · ${how}`) : null].filter(Boolean);
}

function carRow({ car, r, v, qc, trust }) {
  const hl = headline(car, r, v, qc);
  const dash = h('span.muted', {}, '—');
  return h('a.row', { href: `#/edit/${car.id}` },
    h('div.l1', {},
      plateBadge(car.plate),
      h('span.title', {}, h('bdi', { dir: 'auto' }, carTitle(effectiveCar(car, car.registry?.fields))), rowSub(car, r)),
      hasFlag(r) || trust?.length ? flagIcon(trust?.length ? t('trust.banner') : null) : h('span.flag-slot', { 'aria-hidden': 'true' }),
      h('span.verdict-cell', {}, hl.badge, h('span.stage', {}, t(hl.stage === 'quick' ? 'stage.quickShort' : 'stage.fullShort')))),
    h('div.l2', {},
      scoreBar(r, v),
      h('span.cov', {}, ltr(`${r.coverage}%`)),
      h('span.price', {}, car.askingPrice !== null ? ltr(`₪${fmt.format(car.askingPrice)}`) : dash.cloneNode(true)),
      h('span.km', {}, car.currentKm !== null ? [ltr(fmt.format(car.currentKm)), ' ', h('span.unit', {}, t('unit.km'))] : dash.cloneNode(true)),
      h('span.status', {}, t(`status.${car.status}`))));
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
    if (!location.hash || location.hash === '#/') renderList(); else location.hash = '#/';
  } catch (err) {
    toast(t('importError', { msg: err.message }));
  }
}

// ---------- form view ----------
// Groups in rubric order. `cat` = the scoring category whose points range shows in the header.
const GROUPS = [
  { key: 'car', cat: null, fields: ['title:full', 'plate', 'make', 'model', 'trim', 'year', 'location', 'status:full', 'listingUrl', 'notes:full'] },
  { key: 'seller', cat: null, fields: ['sellerName', 'sellerPhone'] },
  { key: 'history', cat: 'history', fields: ['insuranceClaims:full', 'serviceHistory:full'] },
  { key: 'price', cat: 'price', fields: ['askingPrice', 'benchmark'] },
  { key: 'mileage', cat: 'mileage', fields: ['currentKm', 'firstRegistration', 'lastTestKm', 'lastTestDate'] },
  { key: 'ownership', cat: 'ownership', fields: ['originalOwnership:full', 'handCount', 'owners'] },
  { key: 'condition', cat: 'condition', fields: ['testExpiry', 'tires:full'] },
  { key: 'dealBreakers', cat: null, fields: ['dealBreakers'] },
];

const SEG_FIELDS = new Set(['insuranceClaims', 'serviceHistory', 'tires', 'originalOwnership', 'status']);
const ENUM_I18N = {
  originalOwnership: 'ownershipType',
  insuranceClaims: 'insuranceClaims',
  serviceHistory: 'serviceHistory',
  tires: 'tires',
  status: 'status',
  benchmarkSource: 'bench',
};
const UNITS = { askingPrice: '₪', benchmarkPrice: '₪', yad2Low: '₪', yad2High: '₪', currentKm: 'km', lastTestKm: 'km' };
const HINTS = { insuranceClaims: 'hint.insuranceClaims', serviceHistory: 'hint.serviceHistory', title: 'title.hint' };

function enumLabel(key, v) {
  const short = `segShort.${key}.${v}`;
  return STRINGS[lang][short] ? t(short) : t(`${ENUM_I18N[key]}.${v}`);
}

function emptyDraft() {
  return { status: 'considering', dealBreakers: Object.fromEntries(DEAL_BREAKERS.map((k) => [k, 'unknown'])), fieldSources: {} };
}

function defaultBenchmarkSource(d) {
  if (d.benchmarkSource) return d.benchmarkSource;
  return !num(d.benchmarkPrice) && num(d.yad2Low) && num(d.yad2High) ? 'yad2_comparables' : 'levi_yitzhak';
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
  const hasLevi = num(c.benchmarkPrice);
  const hasYad2 = num(c.yad2Low) && num(c.yad2High);
  c.benchmarkSource = hasLevi || hasYad2 ? defaultBenchmarkSource(c) : null;
  return sanitizeCar(c);
}

async function renderForm(id) {
  if (!form || form.id !== id) {
    if (!carsLoaded) {
      // Price comparables need every saved car, also when opening a car directly.
      view.replaceChildren(h('div.msg', {}, t('loading')));
      try { cars = await api('GET', '/api/cars'); carsLoaded = true; } catch { /* comparisons fall back */ }
    }
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
    form = { id, draft, sellerLang: 'he', notes: null, seller: { status: 'idle', text: '', version: 0 }, reply: { text: '', files: [], status: 'idle' }, asked: null, estimate: null, gov: null, govPlate: null, adIdentity: { ...(draft.registry?.ad || {}) } };
    if (draft.registry?.fields) form.gov = { status: 'done', fields: draft.registry.fields, stored: true };
    const ek = estimateKey(draft);
    if (draft.priceEstimate && ek && draft.priceEstimate.key === ek) {
      const pe = draft.priceEstimate;
      form.estimate = { key: ek, status: pe.low && pe.high ? 'done' : 'unknown', low: pe.low, high: pe.high };
    }
    const mk = modelKey(draft);
    if (draft.modelNotes && mk && draft.modelNotes.key === mk) {
      form.notes = { status: 'done', key: mk, items: draft.modelNotes.items || [] };
    }
  }
  const draft = form.draft;
  view.classList.add('editing');

  const panel = h('aside.panel', { 'aria-label': t('panel.title') });
  const backdrop = h('div.sheet-backdrop', { hidden: true, onclick: () => setSheet(false) });
  const sellerBox = h('section.panel-sec.seller');
  const govBox = h('div.gov-box');
  const shotStatus = h('div.start-status', { 'aria-live': 'polite' });
  const ownersBox = h('div.field.full.owners');
  const benchBox = h('div.field.full.bench');
  const pointsEls = {};
  const headPlate = h('span.head-plate', {}, plateBadge(draft.plate, 'lg'));
  const headTitle = h('h1.head-title', { dir: 'auto' }, draft.title?.trim() || t(id ? 'editCar' : 'newCar'));
  const kpyEl = h('span.kpy', { 'aria-live': 'polite' }); // read-only km/year next to the km field

  // ----- value display (conflicts) -----
  function displayValue(key, v) {
    if (v === null || v === undefined || v === '') return t('unknown');
    if (key.startsWith('dealBreakers.')) return t(`tri.${v}`);
    if (key === 'ownershipHistory') return v.map((o) => (o?.type ? t(`ownershipType.${o.type}`) : '?')).join(', ');
    if (ENUM_I18N[key]) return t(`${ENUM_I18N[key]}.${v}`);
    if (key === 'plate') return formatPlate(v);
    if (typeof v === 'number' && key !== 'year') return fmt.format(v);
    return String(v);
  }

  // ----- gov lookup: automatic, 600 ms after the plate becomes valid -----
  function scheduleGov() {
    clearTimeout(form.govTimer);
    const plate = cleanValue('plate', draft.plate);
    if (!plate || plate === form.govPlate) return;
    form.govTimer = setTimeout(() => form?.fetchGov(), 600);
  }

  async function fetchGov(force = false) {
    const plate = cleanValue('plate', draft.plate);
    if (!plate || (!force && plate === form.govPlate)) return;
    form.govPlate = plate;
    form.gov = { status: 'loading', fields: form.gov?.fields || null };
    renderGov();
    const session = form;
    try {
      const res = await api('GET', `/api/gov?plate=${plate}`);
      if (form !== session || cleanValue('plate', draft.plate) !== plate) return;
      if (!res.found) {
        form.gov = { status: res.failed?.length === 3 ? 'error' : 'notFound' };
      } else {
        // Identity fields take the registry value silently; compared fields keep
        // what the ad says and are shown side by side in "Ad vs. registry".
        const applied = applyRegistry(draft, res.fields);
        Object.assign(draft, applied.car);
        form.adIdentity = { ...form.adIdentity, ...applied.adIdentity };
          form.gov = { status: 'done', fields: res.fields, hints: res.hints, extra: res.extra, failed: res.failed };
        // Saved car: keep a snapshot so the list can score and flag it without a new lookup.
        if (id) api('POST', '/api/registry', { id, fields: res.fields, ad: form.adIdentity }).catch(() => {});
      }
    } catch {
      if (form !== session) return;
      form.gov = { status: 'error' };
    }
    renderForm(id); // filled inputs show their new values
  }

  function renderGov() {
    const g = form.gov || { status: 'idle' };
    const kids = [];
    if (g.status === 'error') kids.push(h('div.warn-text', {}, t('gov.failed')));
    if (g.status === 'notFound') kids.push(h('div.note', {}, t('gov.notFound')));
    if (g.status === 'done') {
      if (g.failed?.length) kids.push(h('div.note', {}, t('gov.partial', { list: g.failed.map((f) => t(`gov.ds.${f.dataset}`)).join(', ') })));
      for (const hint of g.hints || []) kids.push(h('div.note', {}, t(`gov.hint.${hint.code}`, hint)));
      const x = g.extra || {};
      if (x.colorChanged) kids.push(h('div.note', {}, t('gov.extra.colorChanged')));
      if (x.tiresChanged) kids.push(h('div.note', {}, t('gov.extra.tiresChanged')));
      if (x.personalImport) kids.push(h('div.note', {}, t('gov.extra.personalImport')));
    }
    govBox.replaceChildren(...kids);
    govBox.hidden = !kids.length;
    const busy = g.status === 'loading';
    const status = view.querySelector('.plate-status');
    if (status) status.replaceChildren(...(busy ? [spinner(), h('span', {}, t('gov.checking'))] : []));
    const refresh = view.querySelector('.gov-refresh');
    if (refresh) refresh.hidden = busy || !['done', 'notFound', 'error'].includes(g.status);
  }

  // ----- "Ad vs. registry": side-by-side comparison -----
  const vsBox = h('section.group.vs', { id: 'grp-vs', 'aria-labelledby': 'h-vs', hidden: true });
  const fmtDate = (d) => new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${d}T00:00:00Z`));

  function vsValue(key, v, side, row) {
    if (v === null || v === undefined || v === '') return h('span.muted', {}, '–');
    if (key === 'handCount') return Number(v) === 1 ? t('mm.handOne') : t('mm.hands', { n: v });
    if (key === 'originalOwnership') {
      // the registry only knows "lease", not which kind
      if (side === 'reg' && v === 'fleet_lease') return t('vs.leaseOrFleet');
      return t(`ownershipType.${v}`);
    }
    if (key === 'km') {
      const km = `${fmt.format(v)} ${t('unit.km')}`;
      if (side === 'reg') return ltrNums(row.regDate ? t('vs.kmAtTest', { km, date: fmtDate(row.regDate) }) : t('vs.kmAtLastTest', { km }));
      return ltr(km);
    }
    if (key === 'testExpiry') return fmtDate(v);
    return h('bdi', { dir: 'auto' }, String(v));
  }

  const STATUS_ICON = { match: '✓', neutral: '≠', suspicious: '⚠', unknown: '–' };

  function renderVs(rows) {
    vsBox.hidden = !rows.length;
    if (!rows.length) { vsBox.replaceChildren(); return; }
    // "Seller says" appears once a seller reply has been applied.
    const hasSeller = rows.some((r) => r.seller !== null && r.seller !== undefined);
    const bad = (row) => row.status === 'suspicious' || row.sellerStatus === 'suspicious';
    vsBox.replaceChildren(
      h('div.group-head', {}, h('h2', { id: 'h-vs' }, t('vs.title'))),
      h(`div.vs-table${hasSeller ? '.has-seller' : ''}`, { role: 'table', 'aria-labelledby': 'h-vs' },
        h('div.vs-row.vs-head', { role: 'row' },
          h('span', { role: 'columnheader' }, t('vs.field')),
          h('span', { role: 'columnheader' }, t('vs.ad')),
          h('span', { role: 'columnheader' }, t('vs.registry')),
          hasSeller ? h('span', { role: 'columnheader' }, t('vs.seller')) : null),
        rows.map((row) => {
          const tone = bad(row) ? 'suspicious' : row.status;
          const whys = [
            row.status === 'suspicious' ? [t('vs.ad'), t('vs.status.suspicious')] : null,
            row.sellerStatus === 'suspicious' ? [t('vs.seller'), t('vs.status.suspicious')] : null,
          ].filter(Boolean);
          return h(`div.vs-row.${tone}`, { role: 'row' },
            h('span.vs-field', { role: 'rowheader' },
              h(`span.vs-icon.${tone}`, { role: 'img', 'aria-label': t(`vs.status.${tone}`), title: t(`vs.status.${tone}`) }, STATUS_ICON[tone]),
              t(`vs.row.${row.key}`)),
            h('span.vs-val', { role: 'cell', 'data-label': t('vs.ad') }, vsValue(row.key, row.ad, 'ad', row)),
            h('span.vs-val', { role: 'cell', 'data-label': t('vs.registry') }, vsValue(row.key, row.reg, 'reg', row)),
            hasSeller ? h(`span.vs-val.seller${row.sellerStatus === 'suspicious' ? '.suspicious' : ''}`, { role: 'cell', 'data-label': t('vs.seller') },
              vsValue(row.key, row.seller, 'seller', row)) : null,
            ...whys.map(([who, why]) => h('span.vs-why', { role: 'cell' }, hasSeller ? `${who}: ${why}` : why)));
        })),
      h('p.vs-note', {}, t('vs.note'), hasSeller ? ` ${t('vs.noteSeller')}` : ''));
  }

  function trustValue(key, v) {
    if (key === 'km') return `${fmt.format(v)} ${t('unit.km')}`;
    if (key === 'handCount') return Number(v) === 1 ? t('mm.handOne') : t('mm.hands', { n: v });
    if (key === 'originalOwnership') return v === 'fleet_lease' ? t('vs.leaseOrFleet') : t(`ownershipType.${v}`);
    return displayValue(key, v);
  }

  // Shared by gov lookup, screenshot import and seller reply. stateKey: 'gov' | 'shot' | 'reply'.
  const SOURCE_OF = { gov: 'gov', shot: 'screenshot', reply: 'seller' };
  const fieldLabel = (key) => (key.startsWith('dealBreakers.') ? t(`db.${key.slice(13)}`) : t(`field.${key}`));
  function resolveConflict(stateKey, c, useTheirs) {
    if (useTheirs) Object.assign(draft, setValue(draft, c.key, c.gov, SOURCE_OF[stateKey]));
    form[stateKey].conflicts = form[stateKey].conflicts.filter((x) => x !== c);
    if (useTheirs) renderForm(id);
    else if (stateKey === 'gov') renderGov(); else if (stateKey === 'shot') renderShot(); else renderReply();
  }

  function conflictList(stateKey) {
    const st = form[stateKey];
    if (!st?.conflicts?.length) return [];
    const p = { gov: { title: 'gov.conflicts', theirs: 'gov.gov', use: 'gov.useGov' },
      shot: { title: 'shot.conflicts', theirs: 'shot.theirs', use: 'shot.useTheirs' },
      reply: { title: 'reply.conflicts', theirs: 'reply.theirs', use: 'reply.useTheirs' } }[stateKey];
    return [
      h('strong.small', {}, t(p.title)),
      ...st.conflicts.map((c) => h('div.conflict', {},
        h('div.conflict-label', {}, fieldLabel(c.key)),
        h('div.conflict-vals', {},
          h('span', {}, t('gov.yours'), ': ', h('bdi', { dir: 'auto' }, displayValue(c.key, c.mine))),
          h('span', {}, t(p.theirs), ': ', h('bdi', { dir: 'auto' }, displayValue(c.key, c.gov)))),
        h('div.conflict-actions', {},
          h('button.btn.small', { type: 'button', onclick: () => resolveConflict(stateKey, c, false) }, t('gov.useMine')),
          h('button.btn.small', { type: 'button', onclick: () => resolveConflict(stateKey, c, true) }, t(p.use))))),
    ];
  }

  /** "3 fields updated: km 85,000 → 87,200 …" with one Undo. null when nothing was updated. */
  function changeSummary(change, onUndo) {
    const upd = change?.updated || [];
    if (!upd.length) return null;
    const items = upd.slice(0, 3).map((u) => {
      const numeric = typeof u.from === 'number' && typeof u.to === 'number';
      const arrow = numeric || lang === 'en' ? '→' : '←'; // reads from → to in either direction
      return h('span.chg', {}, fieldLabel(u.key), ' ',
        h('bdi', { dir: numeric ? 'ltr' : 'auto' }, `${displayValue(u.key, u.from)} ${arrow} ${displayValue(u.key, u.to)}`));
    });
    const head = t(upd.length === 1 ? 'imp.updatedOne' : 'imp.updated', { n: upd.length, list: '' }).trim();
    return h('div.import-summary', { role: 'status' },
      h('span.import-text', {}, head, ' ', items.flatMap((x, i) => (i ? [', ', x] : [x])),
        upd.length > 3 ? [', ', t('imp.more', { n: upd.length - 3 })] : null),
      h('button.btn.small', { type: 'button', onclick: onUndo }, t('imp.undo')));
  }

  /** Undo the last import or applied reply (state = form.shot | form.reply). */
  function undoChange(state) {
    if (!state?.change) return;
    Object.assign(draft, undoUpload(draft, state.change.undo));
    state.change = null;
    toast(t('imp.undone'));
    renderForm(id);
  }

  // ----- screenshot / PDF import -----
  const shotInput = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true, onchange: importShots });

  const thumbOf = (f) => ({ url: isPdfFile(f) ? null : URL.createObjectURL(f), pdf: isPdfFile(f), name: f.name });
  const revokeThumbs = (thumbs) => { for (const th of thumbs || []) if (th.url) URL.revokeObjectURL(th.url); };

  async function importShots(e) {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const bad = checkFiles(files);
    if (bad) { form.shot = { status: 'error', message: bad }; renderShot(); return; }
    revokeThumbs(form.shot?.thumbs);
    runExtraction(files, files.map(thumbOf));
  }

  async function runExtraction(files, thumbs) {
    const session = form;
    form.shot = { status: 'loading', files, thumbs };
    renderShot();
    try {
      // Wrapped: map() would pass the index as the second argument.
      const images = await Promise.all(files.map((f) => fileToPayload(f)));
      const res = await api('POST', '/api/extract', { images });
      if (form !== session) return;
      // Adds to the car: fills empty fields, updates earlier screenshot/seller values,
      // never touches typed or registry values (those become conflicts).
      const m = mergeUpload(draft, res.fields, 'screenshot');
      Object.assign(draft, m.car);
      form.shot = { status: 'done', files, thumbs, filled: m.filled, conflicts: m.conflicts, change: { filled: m.filled, updated: m.updated, undo: m.undo }, noteUntil: Date.now() + 5000 };
      form.pulseKeys = [...m.filled, ...m.updated.map((u) => u.key)].filter((k) => !k.startsWith('dealBreakers.')); // pulse once after the re-render
    } catch (err) {
      if (form !== session) return;
      form.shot = { status: 'error', files, thumbs, message: isAiLimit(err) ? t('ai.limit') : err.fileError || t('shot.errorShort'), detail: err.message };
    }
    renderForm(id);
  }

  function renderShot() {
    const s = form.shot || { status: 'idle' };
    const loading = s.status === 'loading';
    const kids = [];
    if (s.thumbs?.length) {
      kids.push(h('div.thumbs', {}, s.thumbs.map((th, i) =>
        h(`div.thumb${loading ? '.shimmer' : ''}${th.pdf ? '.pdf' : ''}`, { title: th.name || null },
          th.pdf ? h('span.pdf-badge', {}, 'PDF') : h('img', { src: th.url, alt: t('shot.thumbAlt', { n: i + 1 }) })))));
    }
    if (loading) kids.push(h('div.reading', { role: 'status' }, spinner(), h('span', {}, t('shot.readingStatus'))));
    if (s.status === 'error') {
      kids.push(h('div.shot-error', {}, h('span.warn-text', { title: s.detail || null }, s.message),
        s.files?.length ? h('button.btn.small', { type: 'button', onclick: () => runExtraction(s.files, s.thumbs) }, t('shot.retry')) : null));
    }
    if (s.status === 'done') {
      const updated = s.change?.updated?.length || 0;
      const summary = changeSummary(s.change, () => undoChange(form.shot));
      if (summary) kids.push(summary);
      const left = s.noteUntil - Date.now();
      if (left > 0 && (s.filled.length || !(s.conflicts.length || updated))) {
        const note = h('div.note', {}, t(s.filled.length ? (s.filled.length === 1 ? 'shot.appliedOne' : 'shot.applied') : 'shot.none', { n: s.filled.length }));
        kids.push(note);
        setTimeout(() => { note.classList.add('fade'); setTimeout(() => note.remove(), 160); }, left);
      }
      kids.push(...conflictList('shot'));
    }
    shotStatus.replaceChildren(...kids);
    const upBtn = view.querySelector('.start-upload');
    if (upBtn) upBtn.disabled = loading;
  }

  // ----- seller reply: answers by hand, or paste / upload and apply -----
  const replyBox = h('section.group.reply', { id: 'grp-reply', 'aria-labelledby': 'h-reply' });
  const checklistEl = h('ul.asks');
  const replyInput = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true, onchange: addReplyFiles });
  const REPLY_ENUMS = ['insuranceClaims', 'serviceHistory', 'originalOwnership'];
  const REPLY_ORDER = ['plate', 'originalOwnership', 'handCount', 'testExpiry', 'trim', 'serviceHistory', 'insuranceClaims'];
  const filledValue = (key) => draft[key] !== null && draft[key] !== undefined && draft[key] !== '';

  /** An answer typed or picked by hand counts as the seller's. */
  function answerByHand(key, value) {
    draft.adValues = seedAdValues(draft); // keep what the ad said before the seller's answer lands
    const v = value === '' ? null : value;
    Object.assign(draft, setValue(draft, key, v, 'seller'));
    if (v === null) { const fs = { ...draft.fieldSources }; delete fs[key]; draft.fieldSources = fs; }
    renderForm(id);
  }

  function answerControl(key) {
    if (REPLY_ENUMS.includes(key)) {
      const sg = seg(`q-${key}`, FIELD_BY_KEY[key].arg.map((v) => [v, enumLabel(key, v)]), draft[key] ?? '', { small: true, label: fieldLabel(key) });
      sg.addEventListener('input', (e) => answerByHand(key, e.target.value));
      return sg;
    }
    const raw = draft[key] ?? '';
    const attrs = { name: `q-${key}`, type: 'text', autocomplete: 'off', value: String(raw), 'aria-label': fieldLabel(key) };
    if (key === 'plate') Object.assign(attrs, { inputmode: 'numeric', dir: 'ltr', value: raw ? formatPlate(raw) || raw : '' });
    else if (key === 'handCount') attrs.inputmode = 'numeric';
    else if (key === 'testExpiry') attrs.type = 'date';
    else attrs.dir = 'auto';
    const input = h('input', attrs);
    input.addEventListener('change', () => answerByHand(key, input.value));
    return input;
  }

  /** The questions from the sent message as a checklist; answered ones are ticked. */
  function renderChecklist() {
    const car = buildCar(draft);
    const live = askedFields(car, trustIssues(car, currentSnapshot()));
    // Keep answered questions on the list: remember every question seen (or the sent message's).
    form.asked = [...new Set([...(form.asked || []), ...live])];
    const items = form.asked.map((key) => {
      const done = filledValue(key);
      return h(`li.ask${done ? '.done' : ''}`, {},
        h('div.ask-head', {},
          h(`span.vs-icon.${done ? 'match' : 'unknown'}`, { 'aria-hidden': 'true' }, done ? '✓' : '–'),
          h('span.ask-name', {}, fieldLabel(key), srcTag(key)),
          h('span.ask-state', {}, t(done ? 'reply.answered' : 'reply.pending'))),
        answerControl(key));
    });
    checklistEl.replaceChildren(...(items.length ? items : [h('li.note', {}, t('reply.noQuestions'))]));
    fitSegs(checklistEl);
  }

  const previewItems = (res) => {
    const val = (k, v) => {
      if (k === 'plate') return formatPlate(v) || v;
      if (k === 'originalOwnership') return t(`ownershipType.${v}`);
      if (k === 'serviceHistory' || k === 'insuranceClaims') return enumLabel(k, v);
      if (k === 'testExpiry') return fmtDate(v);
      return String(v);
    };
    return [
      ...REPLY_ORDER.filter((k) => res.fields[k] !== null && res.fields[k] !== undefined)
        .map((k) => [t(`reply.short.${k}`), val(k, res.fields[k])]),
      ...DEAL_BREAKERS.filter((k) => res.dealBreakers[k]).map((k) => [t(`db.${k}`), t(`tri.${res.dealBreakers[k]}`)]),
    ];
  };

  function renderReply() {
    const r = form.reply;
    const loading = r.status === 'loading';
    const ta = h('textarea', { name: 'replyText', rows: 4, dir: 'auto', value: r.text, placeholder: t('reply.placeholder'), 'aria-label': t('reply.paste') });
    ta.addEventListener('input', () => { r.text = ta.value; });
    const chips = r.files.map((f, i) => h('span.file-chip', {},
      h('bdi', { dir: 'auto' }, f.name),
      h('button.chip-x', { type: 'button', 'aria-label': t('reply.removeFile', { name: f.name }), onclick: () => { r.files.splice(i, 1); renderReply(); } }, '×')));
    const out = [];
    if (r.status === 'error') out.push(h('div.warn-text', { title: r.detail || null }, r.message));
    if (loading) out.push(h('div.reading', { role: 'status' }, spinner(), h('span', {}, t('reply.reading'))));
    if (r.status === 'empty') out.push(h('div.note', {}, t('reply.empty')));
    if (r.status === 'done' && r.result) {
      const items = previewItems(r.result);
      out.push(h('div.reply-preview', {},
        h('strong.small', {}, t('reply.preview')),
        h('ul.preview', {}, items.map(([k, v]) => h('li', {}, h('span.preview-k', {}, k), ' ', h('bdi.preview-v', { dir: 'auto' }, v)))),
        r.result.notes ? h('p.note', {}, `${t('reply.notes')}: `, h('bdi', { dir: 'auto' }, r.result.notes)) : null,
        h('div.reply-actions', {},
          h('button.btn.primary', { type: 'button', onclick: applyReply }, t('reply.apply')),
          h('button.btn', { type: 'button', onclick: () => { form.reply = { ...r, status: 'idle', result: null }; renderReply(); } }, t('reply.discard')))));
    }
    if (r.status === 'applied') {
      out.push(h('div.note', {}, t('reply.applied', { n: r.appliedN })));
      const summary = changeSummary(r.change, () => undoChange(form.reply));
      if (summary) out.push(summary);
      out.push(...conflictList('reply'));
    }
    replyBox.replaceChildren(
      h('div.group-head', {}, h('h2', { id: 'h-reply' }, t('grp.reply'))),
      h('p.note', {}, t('reply.hint')),
      h('div.reply-block', {}, h('h3.reply-sub', {}, t('reply.questions')), checklistEl),
      h('div.reply-block', {},
        h('label.reply-sub', { for: 'replyText' }, t('reply.paste')),
        ta,
        h('div.reply-files', {}, ...chips,
          h('button.btn.small', { type: 'button', disabled: loading, onclick: () => replyInput.click() }, ICON.upload(), t('reply.addFiles'))),
        h('div.reply-actions', {}, h('button.btn.small.primary', { type: 'button', disabled: loading, onclick: parseReply }, t(loading ? 'reply.reading' : 'reply.read')))),
      ...out);
    ta.id = 'replyText';
    renderChecklist();
  }

  function addReplyFiles(e) {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const r = form.reply;
    const all = [...r.files, ...files];
    const bad = checkFiles(all);
    if (bad) { form.reply = { ...r, status: 'error', message: bad }; } else { form.reply = { ...r, files: all, status: r.status === 'error' ? 'idle' : r.status }; }
    renderReply();
  }

  async function parseReply() {
    const r = form.reply;
    const text = r.text.trim();
    if (!text && !r.files.length) { form.reply = { ...r, status: 'error', message: t('reply.needInput') }; renderReply(); return; }
    const session = form;
    form.reply = { ...r, status: 'loading' };
    renderReply();
    try {
      const car = buildCar(draft);
      const files = await Promise.all(r.files.map((f) => fileToPayload(f)));
      const res = await api('POST', '/api/parse-reply', {
        text, files: files.length ? files : undefined,
        sent: form.seller.text || '', // the questions that were in the sent message
        asked: form.asked?.length ? form.asked : askedFields(car, trustIssues(car, currentSnapshot())),
      });
      if (form !== session) return;
      form.reply = { ...form.reply, status: replyHasContent(res) ? 'done' : 'empty', result: res };
    } catch (err) {
      if (form !== session) return;
      form.reply = { ...form.reply, status: 'error', message: isAiLimit(err) ? t('ai.limit') : t('reply.error'), detail: err.message };
    }
    renderReply();
  }

  /** Apply the previewed answers: source 'seller', same merge rules as an upload. */
  function applyReply() {
    const r = form.reply;
    const res = r.result;
    if (!res) return;
    const fields = { ...res.fields, notes: res.notes ? `${t('grp.reply')}: ${res.notes}` : null };
    const m = mergeUpload(draft, fields, 'seller', { dealBreakers: res.dealBreakers });
    Object.assign(draft, m.car);
    form.reply = { text: '', files: [], status: 'applied', appliedN: m.filled.length + m.updated.length, conflicts: m.conflicts, change: { filled: m.filled, updated: m.updated, undo: m.undo } };
    form.pulseKeys = [...m.filled, ...m.updated.map((u) => u.key)].filter((k) => !k.startsWith('dealBreakers.'));
    renderForm(id);
  }

  // ----- fields -----
  function srcTag(key) {
    const src = draft.fieldSources?.[key];
    if (src === 'screenshot') return h('span.src-tag', {}, t('src.screenshotTag'));
    if (src === 'gov') return h('span.src-tag.gov', {}, t('src.govTag'));
    if (src === 'seller') return h('span.src-tag.seller', {}, t('src.sellerTag'));
    return null;
  }

  function wrapField(key, mod, control, extra) {
    const fromShot = draft.fieldSources?.[key] === 'screenshot';
    // A <label> wraps simple inputs (click focuses them); anything containing
    // buttons or radio groups is a <div> with aria-labelledby instead.
    const simple = control.tagName === 'INPUT' || control.tagName === 'TEXTAREA' || control.classList?.contains('unit-field');
    const labelId = `lbl-${key}`;
    if (!simple) {
      control.setAttribute('aria-labelledby', labelId);
      control.querySelector?.('input:not([type=radio])')?.setAttribute('aria-labelledby', labelId);
    }
    return h(`${simple ? 'label' : 'div'}.field${mod === 'full' ? '.full' : ''}${fromShot ? '.from-shot' : ''}`, { 'data-field': key },
      h('span.label', { id: labelId }, t(`field.${key}`), srcTag(key)),
      control,
      HINTS[key] ? h('span.hint', {}, t(HINTS[key])) : null,
      extra || null);
  }

  function textInput(key) {
    const f = FIELD_BY_KEY[key];
    const raw = draft[key] ?? '';
    const attrs = { name: key, value: String(raw), autocomplete: 'off', type: 'text' };
    if (f.type === 'int' || f.type === 'plate') attrs.inputmode = 'numeric';
    if (UNITS[key]) {
      attrs['data-num'] = '1';
      const n = num(raw);
      if (n !== null) attrs.value = fmt.format(n);
    }
    if (f.type === 'plate') attrs.value = raw ? formatPlate(raw) || raw : '';
    if (key === 'title') Object.assign(attrs, { dir: 'auto', maxlength: '120', placeholder: id ? '' : t('title.auto') });
    if (f.type === 'ym') Object.assign(attrs, { type: 'month', placeholder: 'YYYY-MM' });
    else if (f.type === 'date') attrs.type = 'date';
    else if (f.type === 'url') Object.assign(attrs, { type: 'url', inputmode: 'url', dir: 'ltr' });
    else if (f.type === 'phone') Object.assign(attrs, { type: 'tel', dir: 'ltr' });
    else if (f.type === 'text' && key !== 'title') attrs.dir = 'auto';
    const input = h('input', attrs);
    if (!UNITS[key]) return input;
    return h('span.unit-field', {}, input, h('span.unit', { 'aria-hidden': 'true' }, UNITS[key] === 'km' ? t('unit.km') : '₪'));
  }

  function fieldEl(spec) {
    const [key, mod] = spec.split(':');
    if (key === 'owners') return ownersBox;
    if (key === 'benchmark') return benchBox;
    if (key === 'dealBreakers') return dealBreakerControls();
    if (key === 'plate') {
      const input = textInput('plate');
      const refresh = h('button.btn.link.small.gov-refresh', { type: 'button', hidden: true, onclick: () => form.fetchGov(true) }, t('gov.refresh'));
      return wrapField('plate', 'full', h('span.plate-row', {}, input, h('span.plate-status', { 'aria-live': 'polite' }), refresh), govBox);
    }
    if (key === 'notes') {
      return wrapField(key, mod, h('textarea', { name: key, dir: 'auto', value: draft.notes ?? '', rows: 3 }));
    }
    const f = FIELD_BY_KEY[key];
    if (SEG_FIELDS.has(key)) {
      const opts = f.arg.map((v) => [v, enumLabel(key, v)]);
      if (key !== 'status') opts.push(['', t('unknown')]);
      return wrapField(key, mod, seg(key, opts, draft[key] ?? ''));
    }
    return wrapField(key, mod, textInput(key), key === 'currentKm' ? kpyEl : null);
  }

  function renderBenchmark() {
    const source = defaultBenchmarkSource(draft);
    const control = seg('benchmarkSource', ENUMS.benchmarkSource.map((v) => [v, t(`bench.${v}`)]), source);
    control.setAttribute('aria-label', t('bench.source'));
    const inputs = source === 'yad2_comparables'
      ? h('div.grid', {}, wrapField('yad2Low', '', textInput('yad2Low')), wrapField('yad2High', '', textInput('yad2High')))
      : h('div.grid', {}, wrapField('benchmarkPrice', '', textInput('benchmarkPrice')));
    benchBox.replaceChildren(h('span.label', {}, t('bench.source')), control, inputs, h('span.hint', {}, t('benchmarkHint')));
  }

  function renderOwners() {
    const hc = Math.min(num(draft.handCount) ?? 0, 6);
    const kids = [];
    for (let i = 1; i < hc; i++) {
      const v = draft.ownershipHistory?.[i]?.type ?? '';
      const opts = [...ENUMS.ownershipType.map((o) => [o, t(`ownershipType.${o}`)]), ['', t('unknown')]];
      kids.push(h('div.field', {}, h('span.label', {}, t('ownerN', { n: i + 1 })), seg(`owner-${i}`, opts, v, { label: t('ownerN', { n: i + 1 }) })));
    }
    ownersBox.replaceChildren(...kids);
    ownersBox.hidden = !kids.length;
    fitSegs(ownersBox);
  }

  function dealBreakerControls() {
    return h('div.full', {}, DEAL_BREAKERS.map((k) => {
      const control = seg(`db-${k}`, ENUMS.triState.map((v) => [v, t(`tri.${v}`)]), draft.dealBreakers?.[k] || 'unknown');
      control.setAttribute('aria-labelledby', `lbl-db-${k}`);
      return h('div.db-row', {}, h('span.label', { id: `lbl-db-${k}` }, t(`db.${k}`)), control);
    }));
  }

  const groupEls = GROUPS.map((g) => {
    const pts = h('span.pts');
    pointsEls[g.key] = pts;
    const body = g.key === 'dealBreakers' ? fieldEl('dealBreakers') : h('div.grid', {}, g.fields.map(fieldEl));
    return h('section.group', { id: `grp-${g.key}`, 'aria-labelledby': `h-${g.key}` },
      h('div.group-head', {}, h('h2', { id: `h-${g.key}` }, t(`grp.${g.key}`)), pts),
      body);
  });

  const saveButtons = [];
  const saveBtn = (cls = '') => {
    const b = h(`button.btn.primary${cls}`, { type: 'button', onclick: save }, t('save'));
    saveButtons.push(b);
    return b;
  };

  const formEl = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
    groupEls[0],
    vsBox,
    groupEls[1],
    replyBox,
    groupEls.slice(2),
    h('div.form-actions', {},
      saveBtn(),
      h('a.btn', { href: '#/' }, t('cancel')),
      id ? h('button.btn.danger', { type: 'button', onclick: () => deleteCar(id, () => { location.hash = '#/'; }) }, t('delete')) : null),
  );

  // 'input' fires for every control type (text, radio, date). Also handling
  // 'change' would re-render on blur, which swallowed taps right after typing.
  formEl.addEventListener('input', onEdit);
  // Thousands separators on blur; plate dashes on blur.
  formEl.addEventListener('focusout', (e) => {
    const el = e.target;
    if (el.dataset?.num) { const n = num(el.value); if (n !== null) el.value = fmt.format(n); }
    if (el.name === 'plate') { const p = cleanValue('plate', el.value); if (p) el.value = formatPlate(p); }
  });

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
      // Typing over an ad value restates what the ad said; a seller's value is not the ad's.
      if (AD_KEYS.includes(name) && draft.fieldSources?.[name] !== 'seller') {
        const ad = { ...(draft.adValues || {}) };
        if (String(e.target.value).trim()) ad[name] = e.target.value; else delete ad[name];
        draft.adValues = ad;
      }
      draft[name] = e.target.value;
      const fld = e.target.closest('.field');
      fld?.classList.remove('from-shot');
      fld?.querySelector(':scope > .label .src-tag')?.remove();
      draft.fieldSources = { ...draft.fieldSources, [name]: 'manual' };
    } else return;
    if (name === 'title') headTitle.textContent = draft.title?.trim() || t(id ? 'editCar' : 'newCar');
    if (name === 'handCount') renderOwners();
    if (name === 'benchmarkSource') { renderBenchmark(); fitSegs(benchBox); }
    if (name === 'plate') { headPlate.replaceChildren(plateBadge(draft.plate, 'lg')); scheduleGov(); }
    renderPanel();
  }

  // ----- model notes -----
  async function fetchNotes() {
    const car = buildCar(draft);
    const key = modelKey(car);
    if (!key) return;
    const session = form;
    form.notes = { status: 'loading', key };
    renderPanel();
    try {
      const res = await api('POST', '/api/model-notes', { id: id || undefined, make: car.make, model: car.model, year: car.year });
      if (form !== session) return;
      form.notes = { status: 'done', key, items: res.items };
    } catch (e) {
      if (form !== session) return;
      form.notes = { status: 'error', key, message: e.message, limit: isAiLimit(e) };
    }
    form.rerender();
  }

  // ----- AI price estimate (rough; only when <3 comparable saved cars) -----
  function scheduleEstimate(car, key) {
    clearTimeout(form.estTimer);
    form.estimate = { key, status: 'scheduled' };
    form.estTimer = setTimeout(() => fetchEstimate(car, key), 900);
  }

  async function fetchEstimate(car, key) {
    const session = form;
    if (!form || form.estimate?.key !== key || form.estimate.status !== 'scheduled') return;
    form.estimate = { key, status: 'loading' };
    form.rerender();
    try {
      const res = await api('POST', '/api/price-estimate', {
        id: id || undefined, make: car.make, model: car.model, trim: car.trim, year: car.year,
        km: car.currentKm, ownership: car.originalOwnership,
      });
      if (form !== session || form.estimate?.key !== key) return;
      form.estimate = { key, status: res.low && res.high ? 'done' : 'unknown', low: res.low, high: res.high };
    } catch (e) {
      if (form !== session || form.estimate?.key !== key) return;
      form.estimate = { key, status: isAiLimit(e) ? 'limit' : 'error', message: e.message };
    }
    form.rerender();
  }

  // ----- seller message: written by the AI, editable; template if the API fails -----
  async function writeMessage() {
    const car = buildCar(draft);
    const { qc, trust } = currentQuick(car);
    const session = form;
    form.asked = askedFields(car, trust); // the questions this message asks: the reply checklist
    form.seller = { ...form.seller, status: 'loading' };
    renderSeller(car, qc);
    let text;
    let status;
    let limit = false;
    try {
      const res = await api('POST', '/api/seller-message', {
        car, lang: form.sellerLang, reasons: qc.reasons.map((r) => reasonText(r, 'en')),
        trust: trust.map((i) => ({ code: i.code, ad: i.ad, gov: i.gov })),
      });
      text = res.message;
      status = 'done';
    } catch (e) {
      text = buildSellerMessage(car, form.sellerLang, { trust }) || '';
      status = 'fallback';
      limit = isAiLimit(e);
    }
    if (form !== session) return;
    form.seller = { status, text, limit, version: form.seller.version + 1 };
    form.rerender();
  }

  // Kept as one element so in-progress taps and typing survive panel re-renders.
  function renderSeller(car, qc) {
    const st = form.seller;
    const key = JSON.stringify([lang, form.sellerLang, st.status, st.version, car.sellerPhone, qc.verdict === 'SKIP']);
    if (sellerBox.dataset.key === key) return;
    sellerBox.dataset.key = key;
    const langSeg = seg('sellerLang', ['he', 'en'].map((l) => [l, t(`langName.${l}`)]), form.sellerLang, { small: true, label: t('seller.lang') });
    langSeg.addEventListener('input', (e) => {
      form.sellerLang = e.target.value;
      if (form.seller.text) writeMessage(); else { sellerBox.dataset.key = ''; renderSeller(buildCar(draft), qc); }
    });
    const kids = [h('div.seller-head', {}, h('h3', {}, t('seller.title')), langSeg)];
    if (qc.verdict === 'SKIP') kids.push(h('div.note', {}, t('seller.skipNote')));
    const loading = st.status === 'loading';
    if (loading) {
      kids.push(skeleton('load.message'));
      kids.push(h('div.seller-actions', {},
        h('button.btn.small', { type: 'button', disabled: true }, t(st.text ? 'seller.rewrite' : 'seller.write'))));
      sellerBox.replaceChildren(...kids);
      return;
    }
    if (!st.text) {
      kids.push(h('div.note', {}, t('seller.intro')));
      kids.push(h('div.seller-actions', {},
        h('button.btn.small.primary', { type: 'button', onclick: writeMessage }, t('seller.write'))));
      sellerBox.replaceChildren(...kids);
      return;
    }
    const text = h('textarea', { rows: 6, dir: form.sellerLang === 'he' ? 'rtl' : 'ltr', lang: form.sellerLang, value: st.text, 'aria-label': t('seller.title'), disabled: loading });
    const hasPhone = Boolean(waNumber(car.sellerPhone));
    const waBtn = h('button.btn.small.wa', {
      type: 'button', disabled: !hasPhone, title: hasPhone ? null : t('seller.noPhone'),
      onclick: () => {
        // Send exactly what's in the box now, then move the car along.
        if (!sendWhatsApp(buildCar(draft).sellerPhone, text.value)) return;
        if ((draft.status || 'considering') === 'considering') {
          const r = formEl.querySelector('input[name="status"][value="contacted"]');
          if (r) { r.checked = true; r.dispatchEvent(new Event('input', { bubbles: true })); } else { draft.status = 'contacted'; renderPanel(); }
        }
      },
    }, t('seller.whatsapp'));
    text.addEventListener('input', () => { form.seller.text = text.value; });
    if (st.status === 'fallback') kids.push(h('div.note', {}, t(st.limit ? 'seller.fallbackLimit' : 'seller.fallback')));
    kids.push(text, h('div.seller-actions', {},
      h('button.btn.small', { type: 'button', onclick: () => copyText(text.value, text) }, t('seller.copy')),
      waBtn,
      h('button.btn.small', { type: 'button', onclick: writeMessage, disabled: loading }, t(loading ? 'seller.writing' : 'seller.rewrite')),
      hasPhone ? null : h('span.note', {}, t('seller.noPhone'))));
    sellerBox.replaceChildren(...kids);
  }

  /** Quick check with the in-form AI estimate state. */
  function currentQuick(car) {
    const key = estimateKey(car);
    const est = form.estimate && form.estimate.key === key ? form.estimate : null;
    const pending = Boolean(est && (est.status === 'scheduled' || est.status === 'loading'));
    // buildCar() strips the id; keep it so the car isn't counted as its own comparable.
    return { ...quickFor({ ...car, id }, { estimate: est?.status === 'done' ? est : null, pending, snapshot: currentSnapshot() }), est, key };
  }

  /** Registry snapshot for this form: live lookup (or the stored one) + the ad's identity claims. */
  function currentSnapshot() {
    return form.gov?.fields ? { fields: form.gov.fields, ad: form.adIdentity } : null;
  }

  function quickSection(car, qc, comparison, est, asHeadline, head = null) {
    const cmpInfo = comparisonText(car, comparison, est);
    const joined = qc.reasons.map((r) => reasonText(r)).join(', ');
    const reasons = joined ? joined[0].toLocaleUpperCase(lang) + joined.slice(1) : ''; // sentence case
    const body = [
      asHeadline ? h('div.stage-label', {}, t('stage.quick')) : null,
      asHeadline ? h('div.verdict-main', {}, h(`span.verdict-word.${VERDICT_QCLASS[qc.verdict]}`, {}, qcLabel(qc))) : null,
      asHeadline && head ? head.step : null,
      asHeadline ? (reasons ? h('div.qc-reasons', {}, h('bdi', { dir: 'auto' }, reasons)) : null)
        : h('div.qc-reasons', {}, h('bdi', { dir: 'auto' }, qcLine(qc))),
      asHeadline && head ? head.actions : null,
      ...qc.notes.map((n) => h('div.qc-note', {}, t(n.key))),
      est && (est.status === 'loading' || est.status === 'scheduled') && num(car.askingPrice) !== null
        ? skeleton('load.estimate')
        : h(`div.cmp${cmpInfo.muted ? '.muted' : ''}`, {},
          cmpInfo.source ? h('span.cmp-src', {}, t(`cmp.source.${cmpInfo.source}`)) : h('span.cmp-src', {}, t('cmp.title')),
          ' ', ltrNums(cmpInfo.text)),
    ];
    return body;
  }

  /** Open / close the bottom sheet (phones). The page behind is dimmed and doesn't scroll. */
  function setSheet(open, rerender = true) {
    form.panelOpen = open;
    panel.classList.toggle('expanded', open);
    backdrop.hidden = !open;
    document.body.classList.toggle('sheet-open', open);
    const toggle = panel.querySelector('.panel-toggle');
    if (toggle && rerender) {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', t(open ? 'panel.close' : 'panel.open'));
    }
  }

  function focusField(key) {
    const el = formEl.querySelector(`[name="${key}"]`) || formEl.querySelector(`[data-field="${key}"] input`);
    if (!el) return;
    setSheet(false);
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }

  function disclose(stateKey, labelText, cls, content) {
    const open = Boolean(form[stateKey]);
    const btn = h(`button.disclose${cls ? `.${cls}` : ''}`, { type: 'button', 'aria-expanded': String(open) }, ICON.chev(), labelText);
    const body = h('div', { hidden: !open }, content);
    btn.addEventListener('click', () => {
      form[stateKey] = !form[stateKey];
      btn.setAttribute('aria-expanded', String(form[stateKey]));
      body.hidden = !form[stateKey];
    });
    return [btn, body];
  }

  // ----- next step + status actions -----
  const sentenceCase = (txt) => (txt ? txt[0].toLocaleUpperCase(lang) + txt.slice(1) : txt);

  function stepText(step) {
    if (step.key === 'next.maybe') return t('next.maybe', { item: t(`field.${step.field}`).toLocaleLowerCase(lang) });
    if (step.key === 'next.skip') {
      const why = step.reason ? sentenceCase(reasonText(step.reason)) : t('qc.verdict.SKIP');
      return t('next.skip', { reason: why });
    }
    return t(step.key);
  }

  /** Mark the car skipped / contacted: sets the status field (saved with the car). */
  function setStatus(value) {
    const radio = formEl.querySelector(`input[name="status"][value="${value}"]`);
    if (radio) { radio.checked = true; radio.dispatchEvent(new Event('input', { bubbles: true })); } else { draft.status = value; renderPanel(); }
    toast(t('act.done', { status: t(`status.${value}`) }));
  }

  /** Two clearly labelled buttons, separate from the verdict badge. */
  function statusActions() {
    const cur = draft.status || 'considering';
    const btn = (value, key) => h('button.btn.act', { type: 'button', disabled: cur === value, 'aria-pressed': String(cur === value), onclick: () => setStatus(value) },
      t(cur === value ? `${key}.on` : key));
    return h('div.actions', {}, btn('rejected', 'act.skip'), btn('contacted', 'act.contacted'));
  }

  // ----- score panel -----
  function renderPanel() {
    const car = buildCar(draft);
    const snapshot = currentSnapshot();
    const scored = effectiveCar(car, snapshot?.fields); // registry values win; km = max(ad, last test)
    const r = scoreCar(scored);
    const v = verdict(r);
    const s = summarize(scored, r);
    let cq = currentQuick(car);
    // Ask the AI for a rough price only when it would be used: asking price known,
    // no benchmark entered, fewer than 3 comparables, nothing cached for this key.
    if (cq.comparison.needsAi && !cq.comparison.value && num(car.askingPrice) !== null && cq.key && !cq.est) {
      scheduleEstimate(car, cq.key);
      cq = currentQuick(car); // now pending, so "no comparison" isn't flagged meanwhile
    }
    const { qc, comparison, est, trust } = cq;
    renderSeller(car, qc);
    renderVs(snapshot ? comparisonRows(car, snapshot.fields) : []);
    const quickStage = r.coverage < QUICK_CHECK_UNTIL;
    const kpy = r.parts.mileage.kpy;
    kpyEl.replaceChildren(...kpyText(kpy));
    kpyEl.hidden = !kpy;

    // Group headers: category points range, e.g. 18–25 / 25.
    for (const g of GROUPS) {
      if (!g.cat) continue;
      const c = r.categories[g.cat];
      pointsEls[g.key].replaceChildren(ltr(c.min === c.max ? `${c.max} / ${c.weight}` : `${c.min}–${c.max} / ${c.weight}`));
    }

    const sections = [];

    // Top missing items (for "Ask about …" and the "Find out next" tags).
    const missing = [];
    for (const step of r.nextSteps) for (const f of step.fields) if (!missing.includes(f)) missing.push(f);
    const step = nextStep({ stage: quickStage ? 'quick' : 'full', qc, v, missing });
    const head = { step: h('p.next-step', { class: step.kind }, h('span.next-label', {}, t('next.title')), ' ', h('bdi', { dir: 'auto' }, stepText(step))), actions: statusActions() };

    // 0. Seller trust: the ad makes the car look better than the registry.
    if (trust.length) {
      sections.push(h('section.panel-sec.trust', { role: 'alert' },
        h('h3', {}, ICON.alert(), t('trust.banner')),
        h('ul', {}, trust.map((m) => h('li', {}, h('bdi', { dir: 'auto' },
          t(`trust.${m.code}`, { ad: trustValue(m.key, m.ad), gov: trustValue(m.key, m.gov) }))))),
        h('div.trust-hint', {}, t('trust.bannerHint'))));
    }

    // 1. Directions: what was found, what to do. In --bad.
    const dirs = [
      ...r.dealBreakers.confirmed.map((k) => t(`dir.db.${k}`)),
      ...r.warnings.filter((w) => !(w === 'odometer_rollback' && trust.some((m) => m.code === 'odometer'))).map((w) => t(`dir.${w}`)),
    ];
    if (dirs.length) {
      sections.push(h('section.panel-sec.directions', { role: 'alert' },
        dirs.map((d) => h('p.direction', { style: 'margin:0' }, ICON.alert(), h('span', {}, d)))));
    }

    // Below 50% coverage: quick check is the headline, then the seller message (stage 2).
    if (quickStage) {
      sections.push(h('section.panel-sec.quick', {}, quickSection(car, qc, comparison, est, true, head)));
      sections.push(sellerBox);
    }

    // 2. Full-score verdict (headline from 50% coverage); range as secondary text.
    const word = h(`span.verdict-word.${v.tone}${quickStage ? '.secondary' : ''}`, {}, verdictLabel(v, false));
    sections.push(h(`section.panel-sec.verdict${quickStage ? '.full-later' : ''}`, {},
      quickStage ? h('div.stage-label', {}, t('stage.full')) : null,
      h('div.verdict-main', {}, word, v.upTo ? h('span.verdict-up', {}, t('verdict.possibly', { rating: t(`rating.${v.upTo}`) })) : null),
      quickStage ? null : head.step,
      v.kind === 'TOO_EARLY' ? h('div.verdict-sub', {}, ltrNums(t('verdict.pointsSoFar', { x: v.known.x, y: v.known.y }))) : null,
      h('div.verdict-sub', {}, ltrNums(t('verdict.range', { min: r.scoreMin, max: r.scoreMax, n: r.coverage }))),
      scoreBar(r, v),
      quickStage ? null : head.actions));

    // 3. Good signs / Watch out (+ known issues for this model).
    const key = modelKey(car);
    const notes = form.notes && form.notes.key === key ? form.notes : null;
    const issueItems = notes?.status === 'done' ? notes.items.map((i) => i[lang] || i.en) : [];
    const signs = [];
    if (s.good.length) {
      signs.push(h('div', {}, h('h4.good', {}, t('panel.goodSigns')),
        h('ul.good-list', {}, s.good.map((i) => h('li', {}, t(i.key, fmtVars(i.vars)))))));
    }
    // Registry mismatches come first in "Watch out" (the odometer one is already there as a warning).
    const watch = s.watch;
    if (watch.length || issueItems.length) {
      signs.push(h('div', {}, h('h4.watch', {}, t('panel.watchOut')),
        watch.length ? h('ul.watch-list', {}, watch.map((i) => h('li', {}, t(i.key, fmtVars(i.vars))))) : null,
        issueItems.length ? [h('div.issues-head', {}, t('panel.knownIssuesFrom')),
          h('ul.watch-list', {}, issueItems.map((txt) => h('li', {}, h('bdi', { dir: 'auto' }, txt))))] : null));
    }
    let issuesCtl = null;
    if (!notes || notes.status === 'error') {
      issuesCtl = h('div', {},
        h('button.btn.small', { type: 'button', onclick: fetchNotes, disabled: !key, title: key ? null : t('panel.knownIssuesNeedModel') }, t('panel.knownIssues')),
        !key ? h('div.note', {}, t('panel.knownIssuesNeedModel')) : null,
        notes?.status === 'error' ? h('div.warn-text', {}, notes.limit ? t('ai.limit') : t('panel.knownIssuesError', { msg: notes.message })) : null);
    } else if (notes.status === 'loading') {
      issuesCtl = h('div', {}, skeleton('load.notes'),
        h('button.btn.small', { type: 'button', disabled: true }, t('panel.knownIssues')));
    } else if (notes.status === 'done' && !notes.items.length) {
      issuesCtl = h('div.note', {}, t('panel.knownIssuesNone'));
    }
    sections.push(h('section.panel-sec.signs', {}, signs, issuesCtl));

    // 4. Find out next: top 3 missing items as tags.
    if (missing.length) {
      sections.push(h('section.panel-sec', {}, h('h3', {}, t('panel.findOut')),
        h('div.tags', {}, missing.slice(0, 3).map((f) => h('button.tag', { type: 'button', onclick: () => focusField(f) }, t(`field.${f}`))))));
    }

    // 5. Safety checks: one line, expandable.
    const open = r.dealBreakers.open.length;
    const checksLabel = open === 0 ? t('checks.allAnswered') : open === 1 ? t('checks.unknownOne') : t('checks.unknown', { n: open });
    const checkList = h('ul.check-list', {}, DEAL_BREAKERS.map((k) => {
      const val = car.dealBreakers[k];
      return h('li', {}, h('span', {}, t(`db.${k}`)), h(`span.v-${val}`, {}, t(`tri.${val}`)));
    }));
    sections.push(h('section.panel-sec', {}, disclose('checksOpen', checksLabel, open ? 'warn' : '', checkList)));

    // 6. Score breakdown (collapsed by default) + notes.
    const rows = Object.entries(r.parts).map(([k, p]) => h('tr', {},
      h('td', {}, t(`part.${k}`), k === 'mileage' && kpy ? h('div.kpy', {}, ...kpyText(kpy)) : null),
      h('td', {}, ltr(`${p.min === p.max ? p.min : `${p.min}–${p.max}`} / ${p.weight}`))));
    const breakdown = [h('table.breakdown', {}, h('tbody', {}, rows)), h('div.note', { style: 'margin-top:8px' }, ltrNums(t('breakdown.scaled', { raw: RAW_TOTAL }))), ...r.notes.map((n) => h('div.note', { style: 'margin-top:8px' }, t(`note.${n}`)))];
    sections.push(h('section.panel-sec', {}, disclose('breakdownOpen', t('breakdown'), '', breakdown)));

    // From 50%: the quick check is available collapsed, then the seller message.
    if (!quickStage) {
      sections.push(h('section.panel-sec', {}, disclose('qcOpen', `${t('stage.quick')}: ${qcLabel(qc)}`, '', quickSection(car, qc, comparison, est, false))));
      sections.push(sellerBox);
    }

    // Mobile bar (fixed bottom), one row: verdict badge + score range, then Save.
    // Tapping the verdict opens the bottom sheet (next step, summary, breakdown, status buttons).
    const toggle = h('button.panel-toggle', { type: 'button', 'aria-expanded': String(Boolean(form.panelOpen)), 'aria-label': t(form.panelOpen ? 'panel.close' : 'panel.open') },
      quickStage ? qcBadge(qc) : verdictBadge(v),
      h('span.range', {}, ltr(t('bar.range', { min: r.scoreMin, max: r.scoreMax }))),
      h('span.bar-chev', { 'aria-hidden': 'true' }, ICON.chev()));
    toggle.addEventListener('click', () => setSheet(!form.panelOpen));
    const mobileSave = saveButtons.find((b) => b.classList.contains('save-bar')) || saveBtn('.save-bar');
    setSheet(Boolean(form.panelOpen), false);
    // Keep the reader's place: on phones the sheet body scrolls, and it's rebuilt here.
    const prevScroll = panel.querySelector('.panel-body')?.scrollTop || 0;
    const body = h('div.panel-body', {}, sections);
    panel.replaceChildren(h('div.panel-summary', {}, toggle, mobileSave), body);
    if (!replyBox.contains(document.activeElement)) renderChecklist(); // ticks follow the fields
    if (prevScroll) body.scrollTop = prevScroll;
    fitSegs(sellerBox);
  }

  async function save() {
    for (const b of saveButtons) { b.disabled = true; b.textContent = t('saving'); }
    try {
      const car = buildCar(draft);
      const body = { ...car, fieldSources: draft.fieldSources };
      const saved = id ? await api('PUT', `/api/cars/${id}`, body) : await api('POST', '/api/cars', body);
      // Known issues fetched before the car had an id: store them now (no new LLM call).
      const key = modelKey(car);
      if (!id && saved?.id && form.notes?.status === 'done' && form.notes.key === key) {
        api('POST', '/api/model-notes', { id: saved.id, make: car.make, model: car.model, year: car.year, items: form.notes.items }).catch(() => {});
      }
      const ek = estimateKey(car);
      if (!id && saved?.id && form.estimate?.status === 'done' && form.estimate.key === ek) {
        api('POST', '/api/price-estimate', { id: saved.id, make: car.make, model: car.model, trim: car.trim, year: car.year,
          km: car.currentKm, ownership: car.originalOwnership, estimate: { low: form.estimate.low, high: form.estimate.high } }).catch(() => {});
      }
      if (!id && saved?.id && form.gov?.fields) api('POST', '/api/registry', { id: saved.id, fields: form.gov.fields, ad: form.adIdentity }).catch(() => {});
      carsLoaded = false; // the list reloads everything
      location.hash = '#/';
    } catch (e) {
      toast(t('saveError', { msg: e.message }));
      for (const b of saveButtons) { b.disabled = false; b.textContent = t('save'); }
    }
  }

  // ----- assemble -----
  renderBenchmark();
  renderOwners();
  const start = h('div.start', {},
    h('button.start-opt.start-upload', { type: 'button', onclick: () => shotInput.click() },
      h('strong', {}, ICON.upload(), t('start.upload')), h('span.muted', {}, t('start.uploadHint'))),
    h('button.start-opt', { type: 'button', onclick: () => focusField('plate') },
      h('strong', {}, ICON.pen(), t('start.manual')), h('span.muted', {}, t('start.manualHint'))));

  view.replaceChildren(
    h('div.edit-head', {},
      h('a.btn.link', { href: '#/', style: 'padding-inline:0' }, t('back')),
      headTitle,
      headPlate,
      h('span.spacer'),
      saveBtn('.save-top')),
    h('div.edit-layout', {},
      h('div.edit-main', {}, shotInput, start, shotStatus, formEl),
      backdrop,
      panel));
  // Async work (AI calls, registry) may finish after the form was rebuilt:
  // they redraw through these hooks, which always point at the current DOM.
  form.rerender = () => renderPanel();
  form.closeSheet = () => setSheet(false);
  form.fetchGov = (force) => fetchGov(force);
  renderGov();
  renderShot();
  renderReply();
  renderPanel();
  scheduleGov(); // plate already valid (typed earlier, extracted, or a saved car) → registry lookup
  requestAnimationFrame(() => fitSegs(view));
  if (form.pulseKeys?.length) {
    // Screenshot values just arrived: pulse each filled field once.
    for (const k of form.pulseKeys) formEl.querySelector(`[data-field="${k}"]`)?.classList.add('pulse');
    form.pulseKeys = null;
  }
}

// ---------- settings ----------
async function loadSettings() {
  try { settings = { budgetCeiling: null, ...(await api('GET', '/api/settings')) }; } catch { /* defaults */ }
}

function renderSettings() {
  const input = h('input', { type: 'text', inputmode: 'numeric', name: 'budgetCeiling', autocomplete: 'off',
    value: settings.budgetCeiling ? fmt.format(settings.budgetCeiling) : '' });
  input.addEventListener('blur', () => { const n = num(input.value); if (n !== null) input.value = fmt.format(n); });
  const saveB = h('button.btn.primary', { type: 'submit' }, t('save'));
  const formEl = h('form.settings', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    saveB.disabled = true;
    try {
      const res = await api('PUT', '/api/settings', { budgetCeiling: num(input.value) });
      settings = { ...settings, ...res, unavailable: false };
      toast(t('settings.saved'));
      location.hash = '#/';
    } catch (err) {
      toast(t('settings.error', { msg: err.message }));
      saveB.disabled = false;
    }
  } },
  h('label.field', {}, h('span.label', {}, t('settings.budget')),
    h('span.unit-field', {}, input, h('span.unit', { 'aria-hidden': 'true' }, '₪')),
    h('span.hint', {}, t('settings.budgetHint'))),
  settings.unavailable ? h('div.warn-text', {}, t('settings.unavailable')) : null,
  h('div.form-actions', {}, saveB, h('a.btn', { href: '#/' }, t('cancel'))));
  view.replaceChildren(
    h('div.edit-head', {}, h('a.btn.link', { href: '#/', style: 'padding-inline:0' }, t('back')), h('h1', {}, t('settings.title'))),
    h('div.settings-wrap', {}, formEl));
}

/** Wrap digit runs (scores, %, ranges) so they never reorder in RTL. */
function ltrNums(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/[\d][\d,.–%\s/]*[\d%]|\d/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(ltr(m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return h('span', {}, out);
}

function fmtVars(vars) {
  if (!vars) return vars;
  const out = {};
  for (const [k, v] of Object.entries(vars)) out[k] = typeof v === 'number' ? fmt.format(v) : v;
  return out;
}

const isPdfFile = (f) => f.type === PDF_TYPE || /\.pdf$/i.test(f.name || '');

/** An error message for a bad pick (too many, wrong type, too big), or null. Images and PDFs, mixed. */
function checkFiles(files) {
  if (files.length > MAX_FILES) return t('shot.tooMany', { n: MAX_FILES });
  if (files.some((f) => !isPdfFile(f) && !String(f.type).startsWith('image/'))) return t('shot.badType');
  if (files.some((f) => isPdfFile(f) && (f.size * 4) / 3 > MAX_FILE_BASE64)) return t('shot.tooLarge');
  return null;
}

/** One file → { mimeType, data(base64) }. Images are downscaled to JPEG; PDFs are sent as they are. */
async function fileToPayload(file) {
  try {
    if (!isPdfFile(file)) return await fileToJpeg(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { mimeType: PDF_TYPE, data: btoa(bin) };
  } catch (e) {
    throw Object.assign(e, { fileError: t('shot.readFailed') });
  }
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

// ---------- boot ----------
applyLang();
loadSettings().finally(route);
