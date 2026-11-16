// seller.js — builds the WhatsApp message to the seller. Pure; no DOM.
// Asks only for what is missing, following the template in the spec. When
// both halves of a paired template question are missing, the original
// combined wording is used; otherwise only the missing half is asked.

import { SELLER } from './i18n.js';

const missing = (v) => v === null || v === undefined || v === '';

/** Returns the message text, or null if there is nothing to ask. */
export function buildSellerMessage(car, lang = 'he') {
  const s = SELLER[lang] || SELLER.he;
  const q = [];

  if (missing(car.plate)) q.push(s.plate); // unlocks the gov lookup
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
