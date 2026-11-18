// title.js — one unique, editable title per car. Pure.
//   auto: "<Model> <year> · <location> · ₪<price in k>"  e.g. "Corolla 2022 · Petah Tikva · ₪70k"
//   unique: if the title is taken, " (2)", " (3)" … is appended.

import { num } from './scoring.js';

/** 70000 → "70k", 72500 → "72.5k". */
export function priceK(price) {
  const n = num(price);
  if (n === null || n <= 0) return null;
  const k = Math.round(n / 100) / 10; // one decimal
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/** The automatic title, or null when the car has nothing to build one from. */
export function generateTitle(car) {
  const name = String(car?.model || car?.make || '').trim();
  const year = num(car?.year);
  const first = [name, year !== null ? String(Math.round(year)) : ''].filter(Boolean).join(' ');
  const k = priceK(car?.askingPrice);
  const parts = [first, String(car?.location || '').trim(), k ? `₪${k}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const SUFFIX = /\s+\(\d+\)$/;

/**
 * Make `title` unique among `taken` (titles of the OTHER cars, case-insensitive).
 * A trailing " (n)" the user typed is replaced rather than stacked.
 */
export function uniqueTitle(title, taken = []) {
  const base = String(title ?? '').trim();
  if (!base) return null;
  const used = new Set(taken.filter(Boolean).map(norm));
  if (!used.has(norm(base))) return base;
  const stem = base.replace(SUFFIX, '').trim() || base;
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})`;
    if (!used.has(norm(candidate))) return candidate;
  }
}

/** Title to store for a car: its own (made unique), else the automatic one (made unique). */
export function resolveTitle(car, taken = []) {
  return uniqueTitle(String(car?.title ?? '').trim() || generateTitle(car), taken);
}
