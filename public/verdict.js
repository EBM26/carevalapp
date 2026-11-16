// verdict.js — what to tell the user, given a scoreCar() result. Pure.
// Presentation logic only; the scores themselves come from scoring.js.
//
//   1. A confirmed deal-breaker → AVOID.
//   2. Best case (max) < 60 → AVOID (it can't get out of the AVOID band).
//   3. Coverage < 50% → TOO_EARLY, with "X of Y points so far".
//   4. Otherwise the worst-case rating, floored at OK (AVOID is only shown
//      under 1–2), plus "possibly <best case>" when the best case is higher.

import { band } from './scoring.js';

/** Points scored and points available in the fully known parts. */
export function knownPoints(r) {
  let x = 0;
  let y = 0;
  for (const p of Object.values(r.parts)) {
    if (p.min === p.max) { x += p.min; y += p.weight; }
  }
  return { x, y };
}

const TONE = { STRONG_BUY: 'good', OK: 'ok', AVOID: 'bad' };

export function verdict(r) {
  const known = knownPoints(r);
  // The bar is drawn in the colour of the best case.
  const barTone = r.dealBreakers.confirmed.length ? 'bad' : TONE[band(r.scoreMax)];
  if (r.dealBreakers.confirmed.length) {
    return { kind: 'AVOID', tone: 'bad', reason: 'dealBreaker', provisional: false, upTo: null, known, barTone };
  }
  if (r.scoreMax < 60) {
    return { kind: 'AVOID', tone: 'bad', reason: 'lowMax', provisional: false, upTo: null, known, barTone };
  }
  if (r.coverage < 50) {
    return { kind: 'TOO_EARLY', tone: 'neutral', reason: 'coverage', provisional: true, upTo: null, known, barTone };
  }
  const lo = band(Math.max(r.scoreMin, 60));
  const hi = band(r.scoreMax);
  return { kind: lo, tone: TONE[lo], reason: null, provisional: lo !== hi, upTo: lo !== hi ? hi : null, known, barTone };
}
