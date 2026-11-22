// Campo meteorologico su griglia polare attorno all'osservatore (Open-Meteo), in UNA richiesta.
// La stessa griglia serve al settore antisolare (pioggia, 3–20 km) e al raggio solare (nubi, fino a 120 km):
// l'azimut antisolare ruota di ~15°/h, quindi per la giornata intera serve tutto il giro.

import { destination } from './geodesy.js';

export const NEAR = [3000, 7000, 12000, 20000];   // m, passo azimutale NEAR_STEP
export const NEAR_STEP = 10;
export const FAR = [35000, 50000, 80000, 120000]; // m, passo azimutale FAR_STEP (solo nubi per il raggio solare)
export const FAR_STEP = 20;
export const VARS = ['precipitation', 'showers', 'precipitation_probability', 'cloud_cover_low', 'cloud_cover_mid',
  'cloud_cover_high', 'temperature_2m'];

export const MODELS = [
  { id: 'best_match', label: 'Automatico (con probabilità di pioggia da ensemble)' },
  { id: 'italia_meteo_arpae_icon_2i', label: 'ItaliaMeteo ICON-2I 2,2 km (senza probabilità)' },
  { id: 'icon_d2', label: 'DWD ICON-D2 2,2 km (senza probabilità)' },
];

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const HISTORICAL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';

export function polarGrid(obs) {
  const pts = [{ ring: -1, d: 0, az: 0, lat: obs.lat, lon: obs.lon }];
  NEAR.forEach((d, ring) => { for (let az = 0; az < 360; az += NEAR_STEP) pts.push({ ring, d, az, ...destination(obs.lat, obs.lon, d, az) }); });
  FAR.forEach((d, j) => { for (let az = 0; az < 360; az += FAR_STEP) pts.push({ ring: NEAR.length + j, d, az, ...destination(obs.lat, obs.lon, d, az) }); });
  return pts;
}

/** Peso di una richiesta secondo Open-Meteo: punti × ⌈giorni/14⌉ × ⌈variabili/10⌉. */
export const requestWeight = (nPts, days, nVars) => nPts * Math.ceil(days / 14) * Math.ceil(nVars / 10);

// Contatore condiviso con hyperclouds (stessa chiave, stesso origin): il limite è per IP.
const utcDay = () => new Date().toISOString().slice(0, 10);
export function addCalls(w) {
  try {
    const c = JSON.parse(localStorage.getItem('hc.calls') || 'null');
    const n = c && c.day === utcDay() ? c.n : 0;
    localStorage.setItem('hc.calls', JSON.stringify({ day: utcDay(), n: n + w }));
  } catch {}
}

const shiftDate = (s, days) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

export function buildQuery(pts, dateStr, model) {
  const q = new URLSearchParams({
    latitude: pts.map((p) => p.lat.toFixed(4)).join(','),
    longitude: pts.map((p) => p.lon.toFixed(4)).join(','),
    hourly: VARS.join(','), timeformat: 'unixtime', timezone: 'GMT',
    start_date: shiftDate(dateStr, -1), end_date: shiftDate(dateStr, 1),
  });
  if (model !== 'best_match') q.set('models', model);
  return q;
}

async function getJson(url, fetchFn) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
  let r;
  try { r = await fetchFn(url, { signal: ctl.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'Open-Meteo non risponde (30 s)' : `rete: ${e.message}`); }
  finally { clearTimeout(timer); }
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.error) {
    if (r.status === 429 || /limit/i.test(j?.reason || '')) throw new Error(`limite Open-Meteo superato (${j?.reason || r.status})`);
    throw new Error(j?.reason || `HTTP ${r.status}`);
  }
  return j;
}

/**
 * Scarica il campo per il giorno locale dateStr (±1 giorno UTC). Se il modello scelto non copre tutti i punti
 * (fuori dominio), ripiega su best_match per l'intera griglia e lo segnala.
 */
export async function fetchField(obs, dateStr, model = 'best_match', { fetchFn = fetch, now = Date.now() } = {}) {
  const pts = polarGrid(obs);
  const ageDays = (now - Date.parse(dateStr + 'T00:00:00Z')) / 86400000;
  const host = ageDays > 60 ? HISTORICAL : FORECAST;
  const tries = model === 'best_match' ? [model] : [model, 'best_match'];
  let j = null, used = null, note = '', lastErr;
  for (const m of tries) {
    const q = buildQuery(pts, dateStr, m);
    try {
      addCalls(requestWeight(pts.length, 3, VARS.length));
      j = await getJson(`${host}?${q}`, fetchFn);
      used = m; break;
    } catch (e) {
      lastErr = e;
      if (/limite/.test(e.message)) throw e;
      note = `${m}: ${e.message}; ripiego su best_match`;
    }
  }
  if (!j) throw lastErr;
  const arr = Array.isArray(j) ? j : [j];
  const times = arr[0].hourly.time.map((t) => t * 1000);
  const data = {};
  for (const v of VARS) data[v] = arr.map((loc) => loc.hourly[v] || times.map(() => null));
  const hasProb = data.precipitation_probability.some((row) => row.some((x) => x != null));
  return { obs, dateStr, model: used, note, host: host === HISTORICAL ? 'archivio previsioni' : 'previsione', pts, times, data, hasProb };
}

// ---- Accesso ai valori ----

// Le grandezze cumulate (precipitazione) in Open-Meteo sono la somma dell'ora che TERMINA all'istante indicato.
const CUMULATED = new Set(['precipitation', 'showers']);

export function valueAtPoint(field, i, v, t) {
  const ts = field.times, row = field.data[v][i];
  if (CUMULATED.has(v) || v === 'precipitation_probability') {
    const k = ts.findIndex((x) => x >= t);
    return k < 0 ? null : row[k];
  }
  let k = ts.findIndex((x) => x > t);
  if (k <= 0) return row[k === 0 ? 0 : ts.length - 1];
  const a = (t - ts[k - 1]) / (ts[k] - ts[k - 1]), v0 = row[k - 1], v1 = row[k];
  if (v0 == null || v1 == null) return v0 ?? v1;
  return v0 * (1 - a) + v1 * a;
}

const ringIndex = (field) => {
  if (field._rings) return field._rings;
  const rings = new Map();
  field.pts.forEach((p, i) => { if (p.ring >= 0) { if (!rings.has(p.ring)) rings.set(p.ring, { d: p.d, step: 0, idx: [] }); rings.get(p.ring).idx.push(i); } });
  for (const r of rings.values()) r.step = 360 / r.idx.length;
  field._rings = [...rings.values()].sort((a, b) => a.d - b.d);
  return field._rings;
};

/** Valore sull'anello di distanza ringD all'azimut az (interpolazione lineare in azimut). */
export function valueOnRing(field, ring, v, az, t) {
  const f = ((((az % 360) + 360) % 360) / ring.step), i = Math.floor(f) % ring.idx.length, j = (i + 1) % ring.idx.length, a = f - Math.floor(f);
  const v0 = valueAtPoint(field, ring.idx[i], v, t), v1 = valueAtPoint(field, ring.idx[j], v, t);
  if (v0 == null || v1 == null) return v0 ?? v1;
  return v0 * (1 - a) + v1 * a;
}

export const rings = ringIndex;

/** Colonne di nubi lungo l'azimut az, nel formato di weather.js (rayClear/coverAt): [{d, low, mid, high}]. */
export function cloudSnap(field, az, t) {
  const col = (i) => ({ d: 0, low: valueAtPoint(field, i, 'cloud_cover_low', t), mid: valueAtPoint(field, i, 'cloud_cover_mid', t), high: valueAtPoint(field, i, 'cloud_cover_high', t) });
  const out = [col(0)];
  for (const r of ringIndex(field)) out.push({ d: r.d, low: valueOnRing(field, r, 'cloud_cover_low', az, t), mid: valueOnRing(field, r, 'cloud_cover_mid', az, t), high: valueOnRing(field, r, 'cloud_cover_high', az, t) });
  return out;
}

/** Anelli entro dMax (per la pioggia nel settore antisolare). */
export const nearRings = (field, dMin, dMax) => ringIndex(field).filter((r) => r.d >= dMin && r.d <= dMax);
