// GET /api/gov?plate=… — server-side lookup in data.gov.il (no CORS, no key).
// Queries the three datasets in parallel; returns mapped car fields plus a
// list of datasets that failed, so the UI can say which fields need manual entry.
import { cleanValue } from '../../public/fields.js';
import { GOV_RESOURCES, mapGov } from '../../public/govmap.js';
import { json, error } from '../_lib/cars.js';

const API = 'https://data.gov.il/api/3/action/datastore_search';

async function query(resourceId, plate, limit) {
  const url = new URL(API);
  url.searchParams.set('resource_id', resourceId);
  url.searchParams.set('filters', JSON.stringify({ mispar_rechev: Number(plate) }));
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; used-car-scorer)' },
    signal: AbortSignal.timeout(12000),
  });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) throw new Error(`blocked (HTTP ${res.status}, ${type.split(';')[0] || 'no content-type'})`);
  if (res.status === 429) throw new Error('rate limited (HTTP 429)');
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error(`HTTP ${res.status}`);
  return body.result.records;
}

export async function onRequestGet({ request }) {
  const plate = cleanValue('plate', new URL(request.url).searchParams.get('plate'));
  if (!plate) return error(400, 'Invalid plate');

  const names = ['registry', 'history', 'ownership'];
  const results = await Promise.allSettled([
    query(GOV_RESOURCES.registry, plate, 1),
    query(GOV_RESOURCES.history, plate, 1),
    query(GOV_RESOURCES.ownership, plate, 100),
  ]);

  const failed = [];
  const data = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') data[names[i]] = r.value;
    else failed.push({ dataset: names[i], reason: String(r.reason?.message || r.reason) });
  });

  if (failed.length === names.length) {
    return json({ error: 'gov_unavailable', failed }, 502);
  }

  const registry = data.registry?.[0] ?? null;
  const history = data.history?.[0] ?? null;
  const ownership = data.ownership ?? null;
  const found = Boolean(registry || history || ownership?.length);
  if (!found) return json({ plate, found: false, failed });

  return json({ plate, found: true, failed, ...mapGov({ registry, history, ownership }) });
}
