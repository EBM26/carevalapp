// upload.js — adding information to a car that may already have values:
// a later screenshot/PDF upload, or an applied seller reply. Pure.
//
// Rules (per field with a new, non-empty value):
//   empty                              → filled
//   same value                         → nothing
//   current source 'screenshot'/'seller', different  → updated (reported, undoable)
//   current source 'manual'/'gov'/unknown, different → kept; reported as a conflict
// So values you typed, and registry values, are never overwritten by an upload.
// The original ad values are kept in car.adValues and never replaced here.

import { FIELDS, cleanValue, AD_KEYS } from './fields.js';

const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const REPLACEABLE = new Set(['screenshot', 'seller']);
const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

function same(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a === b;
}

/** adValues with the car's current ad-side values added where none is stored yet. */
export function seedAdValues(car) {
  const out = { ...(car.adValues || {}) };
  for (const k of AD_KEYS) {
    if (out[k] !== undefined && out[k] !== null) continue;
    const src = car.fieldSources?.[k];
    if (src === 'gov' || src === 'seller') continue; // not the ad's claim
    const f = FIELD[k];
    const v = cleanValue(f.type, car[k], f.arg);
    if (v !== null) out[k] = v;
  }
  return out;
}

/**
 * car: the car/draft. fields: cleaned extraction ({ key: value|null }).
 * source: 'screenshot' | 'seller'. opts.dealBreakers: { structuralDamage: 'yes'|'no'|null, … }.
 * Returns { car, filled: [key], updated: [{ key, from, to }], conflicts: [{ key, mine, gov }], undo }.
 * `gov` in a conflict is the new value (the name the conflict UI already uses).
 */
export function mergeUpload(car, fields, source, { dealBreakers = {} } = {}) {
  const out = {
    ...car,
    fieldSources: { ...(car.fieldSources || {}) },
    dealBreakers: { ...(car.dealBreakers || {}) },
    adValues: seedAdValues(car),
  };
  const filled = [];
  const updated = [];
  const conflicts = [];
  const prev = { values: {}, sources: {}, dealBreakers: {}, adValues: car.adValues || {}, notes: car.notes ?? null };
  const remember = (key) => {
    if (key in prev.sources || key in prev.values) return;
    prev.values[key] = car[key] ?? null;
    prev.sources[key] = car.fieldSources?.[key];
  };

  for (const [key, theirs] of Object.entries(fields || {})) {
    if (isEmpty(theirs)) continue;
    const f = FIELD[key];
    if (!f) continue;
    if (key === 'notes') {
      // Never a conflict: add the new text below what is there.
      const mine = String(out.notes ?? '').trim();
      if (!mine) out.notes = theirs;
      else if (!mine.includes(String(theirs).trim())) out.notes = `${mine}\n\n${theirs}`;
      continue;
    }
    const mine = cleanValue(f.type, out[key], f.arg);
    if (mine === null) {
      remember(key);
      out[key] = theirs;
      out.fieldSources[key] = source;
      filled.push(key);
      if (source === 'screenshot' && AD_KEYS.includes(key) && out.adValues[key] === undefined) out.adValues[key] = theirs;
    } else if (!same(mine, theirs)) {
      if (REPLACEABLE.has(out.fieldSources[key])) {
        remember(key);
        out[key] = theirs;
        out.fieldSources[key] = source;
        updated.push({ key, from: mine, to: theirs });
      } else {
        conflicts.push({ key, mine, gov: theirs });
      }
    }
  }

  for (const [k, theirs] of Object.entries(dealBreakers || {})) {
    if (theirs !== 'yes' && theirs !== 'no') continue;
    const key = `dealBreakers.${k}`;
    const mine = out.dealBreakers[k] || 'unknown';
    if (mine === theirs) continue;
    if (!(k in prev.dealBreakers)) prev.dealBreakers[k] = { value: car.dealBreakers?.[k] || 'unknown', source: car.fieldSources?.[key] };
    if (mine === 'unknown') {
      out.dealBreakers[k] = theirs;
      out.fieldSources[key] = source;
      filled.push(key);
    } else if (REPLACEABLE.has(out.fieldSources[key])) {
      out.dealBreakers[k] = theirs;
      out.fieldSources[key] = source;
      updated.push({ key, from: mine, to: theirs });
    } else {
      delete prev.dealBreakers[k];
      conflicts.push({ key, mine, gov: theirs });
    }
  }
  return { car: out, filled, updated, conflicts, undo: prev };
}

/** Put back everything mergeUpload changed. */
export function undoUpload(car, undo) {
  const out = { ...car, fieldSources: { ...(car.fieldSources || {}) }, dealBreakers: { ...(car.dealBreakers || {}) } };
  for (const [key, v] of Object.entries(undo.values)) {
    out[key] = v;
    if (undo.sources[key] === undefined) delete out.fieldSources[key]; else out.fieldSources[key] = undo.sources[key];
  }
  for (const [k, { value, source }] of Object.entries(undo.dealBreakers)) {
    out.dealBreakers[k] = value;
    if (source === undefined) delete out.fieldSources[`dealBreakers.${k}`]; else out.fieldSources[`dealBreakers.${k}`] = source;
  }
  out.adValues = undo.adValues;
  out.notes = undo.notes;
  return out;
}

/** Set one value by field key ('dealBreakers.x' too) with a source. Used by conflict buttons and the question checklist. */
export function setValue(car, key, value, source) {
  const out = { ...car, fieldSources: { ...(car.fieldSources || {}), [key]: source } };
  if (key.startsWith('dealBreakers.')) out.dealBreakers = { ...(car.dealBreakers || {}), [key.slice(13)]: value };
  else out[key] = value;
  return out;
}
