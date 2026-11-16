// format.js — small display helpers. Pure.

/** Israeli plate digits → '12-345-67' (7 digits) or '123-45-678' (8 digits). */
export function formatPlate(plate) {
  const d = String(plate ?? '').replace(/\D/g, '');
  if (d.length === 7) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  if (d.length === 8) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  return d;
}
