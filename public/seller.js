// seller.js — builds the WhatsApp message to the seller. Pure; no DOM.
// Asks only for what is missing, following the template in the spec. When
// both halves of a paired template question are missing, the original
// combined wording is used; otherwise only the missing half is asked.

import { SELLER, STRINGS } from './i18n.js';

const missing = (v) => v === null || v === undefined || v === '';

const fmtNum = (n) => new Intl.NumberFormat('en-US').format(n);

/** One polite question per suspicious registry mismatch (govcompare.trustIssues). */
export function trustQuestions(trust, lang = 'he') {
  const s = SELLER[lang] || SELLER.he;
  return (trust || []).filter((i) => s.trust[i.code]).map((i) => {
    let gov = i.gov;
    if (i.code === 'ownership') gov = (STRINGS[lang] || STRINGS.he)[`ownershipType.${i.gov}`] || i.gov;
    if (i.code === 'odometer') gov = fmtNum(i.gov);
    return s.trust[i.code].replace('{gov}', gov);
  });
}

/** Returns the message text, or null if there is nothing to ask. */
export function buildSellerMessage(car, lang = 'he', { trust = [] } = {}) {
  const s = SELLER[lang] || SELLER.he;
  const q = [];

  if (missing(car.plate)) q.push(s.plate); // unlocks the gov lookup
  q.push(...trustQuestions(trust, lang));
  if (missing(car.originalOwnership)) q.push(s.ownership);
  if (missing(car.trim)) q.push(s.trim);

  const reg = missing(car.firstRegistration);
  const test = missing(car.testExpiry);
  if (reg && test) q.push(s.regAndTest);
  else if (reg) q.push(s.reg);
  else if (test) q.push(s.test);

  const service = missing(car.serviceHistory);
  const slikah = missing(car.insuranceClaims);
  if (service && slikah) q.push(s.serviceAndSlikah);
  else if (service) q.push(s.service);
  else if (slikah) q.push(s.slikah);

  return q.length ? `${s.opener} ${q.join(' ')}` : null;
}

/** Israeli/international phone → wa.me digits (e.g. 050-1234567 → 972501234567), or null. */
export function waNumber(phone) {
  if (missing(phone)) return null;
  let d = String(phone).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `972${d.slice(1)}`;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** wa.me link with the message prefilled, or null without a usable phone. */
export function waLink(phone, text) {
  const n = waNumber(phone);
  if (!n) return null;
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/** whatsapp:// deep link for the desktop app, or null without a usable phone. */
export function waAppLink(phone, text) {
  const n = waNumber(phone);
  if (!n) return null;
  return `whatsapp://send?phone=${n}${text ? `&text=${encodeURIComponent(text)}` : ''}`;
}

/** Phones and tablets (incl. iPadOS, which reports itself as a Mac). */
export function isMobileDevice(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = nav.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
}

/**
 * Open WhatsApp with the message. Mobile: wa.me. Desktop: try the installed app,
 * and fall back to wa.me if the page didn't lose focus within ~1.5 s.
 * Must be called from a user gesture. Returns false without a usable phone.
 */
export function sendWhatsApp(phone, text) {
  const web = waLink(phone, text);
  if (!web) return false;
  const openWeb = () => {
    const w = window.open(web, '_blank'); // not 'noopener': that always returns null
    if (w) w.opener = null; else location.href = web;
  };
  if (isMobileDevice()) { openWeb(); return true; }
  let left = false;
  const onLeave = () => { left = true; };
  window.addEventListener('blur', onLeave, { once: true });
  document.addEventListener('visibilitychange', onLeave, { once: true });
  setTimeout(() => {
    window.removeEventListener('blur', onLeave);
    document.removeEventListener('visibilitychange', onLeave);
    if (!left && !document.hidden) openWeb();
  }, 1500);
  location.href = waAppLink(phone, text);
  return true;
}
