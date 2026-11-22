// Ricerca nella zona: da quali punti entro 20 km dal centro si vede un arcobaleno, ora per ora.
// Celle osservatore di 2 km; campo meteo su griglia regolare (4 km fino a ±40 km, 8 km fino a ±72 km)
// in UNA richiesta Open-Meteo che copre anche il giorno dopo; orizzonte grossolano per cella (36 azimut, 15 km).

import { sunPosition, SUN_SEMIDIAMETER } from './solar.js';
import { elevationAngle, EARTH_R } from './geodesy.js';
import { antisolar, sampleBow, PRIMARY } from './rainbow.js';
import { rayClear } from './weather.js';
import { VARS, requestWeight, addCalls, valueAtPoint } from './rainfield.js';
import { cellRain, classify, radarRain } from './likelihood.js';
import { radarAt, latLonToPx } from './radar.js';

export const ZONE_RADIUS = 20000;
export const CELL = 2000;
export const INNER = { half: 40000, step: 4000 };
export const OUTER = { half: 72000, step: 8000 };
export const RAIN_D = [2000, 5000, 9000, 14000, 20000];
export const CLOUD_D = [0, 3000, 7000, 12000, 20000, 35000, 50000, 70000];
export const HORIZON_D = (() => { const a = []; for (let d = 500; d < 2000; d += 100) a.push(d); for (let d = 2000; d <= 15000; d += 250) a.push(d); return a; })();
export const MIN_SEP = 4000;   // distanza minima tra i punti consigliati

const D2R = Math.PI / 180;

// ---- proiezione locale (equirettangolare attorno al centro; errore < 0,1 % entro 70 km) ----
export function projector(c) {
  const ky = EARTH_R * D2R, kx = EARTH_R * D2R * Math.cos(c.lat * D2R);
  return {
    toLL: (x, y) => ({ lat: c.lat + y / ky, lon: c.lon + x / kx }),
    toXY: (lat, lon) => ({ x: (lon - c.lon) * kx, y: (lat - c.lat) * ky }),
  };
}

/** Punti della griglia meteo: quadrato interno a 4 km, poi quadrato esterno a 8 km senza i nodi interni. */
export function regionGrid(center) {
  const P = projector(center), pts = [];
  const nI = Math.round(INNER.half / INNER.step), nO = Math.round(OUTER.half / OUTER.step);
  for (let j = -nI; j <= nI; j++) for (let i = -nI; i <= nI; i++) pts.push({ g: 0, i, j, x: i * INNER.step, y: j * INNER.step, ...P.toLL(i * INNER.step, j * INNER.step) });
  for (let j = -nO; j <= nO; j++) for (let i = -nO; i <= nO; i++) {
    if (Math.abs(i * OUTER.step) <= INNER.half && Math.abs(j * OUTER.step) <= INNER.half) continue;
    pts.push({ g: 1, i, j, x: i * OUTER.step, y: j * OUTER.step, ...P.toLL(i * OUTER.step, j * OUTER.step) });
  }
  return pts;
}

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const shiftDate = (s, d) => { const x = new Date(s + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };

/** Campo della zona da dateStr−1 a dateStr+2 (oggi e domani in una richiesta, stesso peso). */
export const CHUNK = 170;   // punti per richiesta: oltre ~8 KB di URL il server risponde senza intestazioni CORS

export async function fetchRegion(center, dateStr, model = 'best_match', { fetchFn = fetch } = {}) {
  const pts = regionGrid(center);
  const url = (m, part) => {
    const q = new URLSearchParams({
      latitude: part.map((p) => p.lat.toFixed(3)).join(','), longitude: part.map((p) => p.lon.toFixed(3)).join(','),
      hourly: VARS.join(','), timeformat: 'unixtime', timezone: 'GMT', start_date: shiftDate(dateStr, -1), end_date: shiftDate(dateStr, 2),
    });
    if (m !== 'best_match') q.set('models', m);
    return `${FORECAST}?${q}`;
  };
  const get = async (m, part) => {
    addCalls(requestWeight(part.length, 4, VARS.length));
    const r = await fetchFn(url(m, part)).catch((e) => ({ ok: false, status: 0, json: async () => ({ reason: e.message }) }));
    const body = await r.json().catch(() => null);
    if (r.ok && !body?.error) return Array.isArray(body) ? body : [body];
    const reason = body?.reason || `HTTP ${r.status}`;
    const err = new Error(r.status === 429 || /limit/i.test(reason) ? `limite Open-Meteo superato (${reason})` : reason);
    err.limit = /limite/.test(err.message);
    throw err;
  };
  let arr = null, used = null, note = '';
  for (const m of model === 'best_match' ? [model] : [model, 'best_match']) {
    try {
      arr = [];
      for (let i = 0; i < pts.length; i += CHUNK) arr.push(...(await get(m, pts.slice(i, i + CHUNK))));
      used = m; break;
    } catch (e) {
      if (e.limit || m === 'best_match') throw e;
      note = `${m}: ${e.message}; ripiego su best_match`;
    }
  }
  const times = arr[0].hourly.time.map((t) => t * 1000);
  const data = {};
  for (const v of VARS) data[v] = arr.map((loc) => loc.hourly[v] || times.map(() => null));
  return { center, dateFrom: shiftDate(dateStr, -1), dateTo: shiftDate(dateStr, 2), model: used, note, pts, times, data,
    hasProb: data.precipitation_probability.some((r) => r.some((x) => x != null)), weight: requestWeight(pts.length, 4, VARS.length),
    requests: Math.ceil(pts.length / CHUNK) };
}

/** Istantanea del campo all'istante t: per ogni variabile due griglie regolari (interna, esterna). */
export function snapshot(region, t) {
  const nI = Math.round(INNER.half / INNER.step), nO = Math.round(OUTER.half / OUTER.step);
  const wI = 2 * nI + 1, wO = 2 * nO + 1;
  const snap = {};
  for (const v of VARS) snap[v] = { inner: new Float32Array(wI * wI).fill(NaN), outer: new Float32Array(wO * wO).fill(NaN) };
  region.pts.forEach((p, k) => {
    for (const v of VARS) {
      const val = valueAtPoint(region, k, v, t);
      if (val == null) continue;
      if (p.g === 0) snap[v].inner[(p.j + nI) * wI + p.i + nI] = val;
      else snap[v].outer[(p.j + nO) * wO + p.i + nO] = val;
    }
  });
  // i nodi esterni che cadono dentro il quadrato interno prendono il valore del nodo interno coincidente
  for (const v of VARS) for (let j = -nO; j <= nO; j++) for (let i = -nO; i <= nO; i++) {
    const x = i * OUTER.step, y = j * OUTER.step;
    if (Math.abs(x) > INNER.half || Math.abs(y) > INNER.half) continue;
    snap[v].outer[(j + nO) * wO + i + nO] = snap[v].inner[(y / INNER.step + nI) * wI + x / INNER.step + nI];
  }
  snap.nI = nI; snap.nO = nO; snap.wI = wI; snap.wO = wO;
  return snap;
}

function bilinear(arr, w, n, step, x, y) {
  const fx = x / step + n, fy = y / step + n;
  const i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= w - 1 || j >= w - 1) return NaN;
  const a = fx - i, b = fy - j, g = (di, dj) => arr[(j + dj) * w + i + di];
  return (g(0, 0) * (1 - a) + g(1, 0) * a) * (1 - b) + (g(0, 1) * (1 - a) + g(1, 1) * a) * b;
}
/** Valore della variabile v nel punto locale (x, y) in metri dal centro. */
export function valueXY(snap, v, x, y) {
  const s = snap[v];
  const r = Math.abs(x) <= INNER.half && Math.abs(y) <= INNER.half ? bilinear(s.inner, snap.wI, snap.nI, INNER.step, x, y) : NaN;
  if (!isNaN(r)) return r;
  const o = bilinear(s.outer, snap.wO, snap.nO, OUTER.step, x, y);
  return isNaN(o) ? null : o;
}

/** Celle osservatore (2 km) entro ZONE_RADIUS. */
export function zoneCells(center) {
  const P = projector(center), n = Math.round(ZONE_RADIUS / CELL), cells = [];
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const x = i * CELL, y = j * CELL;
    if (Math.hypot(x, y) > ZONE_RADIUS) continue;
    cells.push({ i, j, x, y, dist: Math.hypot(x, y), az: ((Math.atan2(x, y) / D2R) + 360) % 360, ...P.toLL(x, y) });
  }
  return cells;
}

/** DEM: punti da precaricare (z11) per gli orizzonti di tutte le celle. */
export function demPoints(center) {
  const P = projector(center), pts = [], half = ZONE_RADIUS + 16000;
  for (let y = -half; y <= half; y += 3000) for (let x = -half; x <= half; x += 3000) pts.push({ ...P.toLL(x, y), z: 11 });
  return pts;
}

/** Orizzonte grossolano per ogni cella: 36 azimut, fino a 15 km, curvatura e rifrazione incluse. */
export function cellHorizons(dem, center, cells, hag = 2) {
  const P = projector(center);
  for (const c of cells) {
    const g = dem.sample(c.lat, c.lon, 11);
    c.h0 = (g ?? 0) + hag;
    c.hor = new Float32Array(36);
    for (let k = 0; k < 36; k++) {
      const s = Math.sin(k * 10 * D2R), co = Math.cos(k * 10 * D2R);
      let m = -90;
      for (const d of HORIZON_D) {
        const p = P.toLL(c.x + d * s, c.y + d * co);
        const h = dem.sample(p.lat, p.lon, 11) ?? 0;
        const a = elevationAngle(d, c.h0, h);
        if (a > m) m = a;
      }
      c.hor[k] = m;
    }
  }
  return cells;
}
const horAt = (c, az) => {
  if (!c.hor) return 0;
  const f = (((az % 360) + 360) % 360) / 10, i = Math.floor(f) % 36, j = (i + 1) % 36, a = f - Math.floor(f);
  return c.hor[i] * (1 - a) + c.hor[j] * a;
};

/**
 * Indice per tutte le celle all'istante t. Il Sole è calcolato al centro (su 20 km l'errore è ≤ 0,2°).
 * ctx = { center, cells, region (opzionale), radar (opzionale) }. Restituisce { t, sun, I: Float32Array, src }.
 */
export function scanAt(ctx, t) {
  const { center, cells, region, radar } = ctx;
  const sun = sunPosition(t, center.lat, center.lon);
  const I = new Float32Array(cells.length).fill(NaN);
  const out = { t, sun, I, src: null, possible: false };
  if (sun.el + SUN_SEMIDIAMETER <= 0 || sun.el >= PRIMARY.outer) { I.fill(0); return out; }
  out.possible = true;
  const anti = antisolar(sun);
  const dirs = sampleBow(anti, PRIMARY.mid, () => 0, 6).points.filter((p) => p.el >= 0);
  const snap = region ? snapshot(region, t) : null;
  const rad = radar ? radarAt(radar, t) : null;
  out.src = rad ? `radar ${rad.kind}` : snap ? `modello ${region.model}` : null;
  if (!snap) return out;   // senza modello mancano S e O: il radar da solo non basta
  const P = projector(center);
  const ss = Math.sin(sun.az * D2R), sc = Math.cos(sun.az * D2R);
  const dv = dirs.map((p) => ({ el: p.el, az: p.az, s: Math.sin(p.az * D2R), c: Math.cos(p.az * D2R) }));
  cells.forEach((c, k) => {
    if (sun.el + SUN_SEMIDIAMETER <= horAt(c, sun.az)) { I[k] = 0; return; }
    // S e O dal campo del modello (anche quando la pioggia viene dal radar)
    let S = 1, O = 1;
    if (snap) {
      const col = CLOUD_D.map((d) => {
        const x = c.x + d * ss, y = c.y + d * sc;
        return { d, low: valueXY(snap, 'cloud_cover_low', x, y), mid: valueXY(snap, 'cloud_cover_mid', x, y), high: valueXY(snap, 'cloud_cover_high', x, y) };
      });
      S = rayClear(col, c.h0 ?? 0, Math.max(sun.el, 0.5)).P;
      const near = col.filter((q) => q.d <= 7000).map((q) => Math.max(q.low ?? 0, q.mid ?? 0) / 100);
      O = 1 - (near.reduce((a, b) => a + b, 0) / near.length) ** 4;
    } else return;
    let R = 0;
    for (const d of dv) {
      if (d.el <= horAt(c, d.az)) continue;
      for (const dd of RAIN_D) {
        const x = c.x + dd * d.s, y = c.y + dd * d.c;
        let p = null;
        if (rad) {
          const ll = P.toLL(x, y), px = latLonToPx(radar.m, ll.lat, ll.lon);
          const cov = !radar.coverage || radar.coverage[Math.floor(px.py) * radar.m.size + Math.floor(px.px)];
          if (cov) p = radarRain(rad.sample(px.px, px.py));
        }
        if (p == null) p = cellRain({ prob: region.hasProb ? valueXY(snap, 'precipitation_probability', x, y) : null, mm: valueXY(snap, 'precipitation', x, y), T: valueXY(snap, 'temperature_2m', x, y) }) ?? 0;
        if (p > R) R = p;
      }
    }
    I[k] = S * O * R;
  });
  return out;
}

/** Serie della giornata [t0, t1) al passo stepMin (default 15 min). */
export function scanDay(ctx, t0, t1, stepMin = 15) {
  const out = [];
  for (let t = t0; t < t1; t += stepMin * 60000) out.push(scanAt(ctx, t));
  return out;
}

/** Massimo sulla zona per ogni passo (per la barra della giornata e la risposta sintetica). */
export const zoneMax = (series) => series.map((s) => { let m = null; for (const v of s.I) if (!isNaN(v)) m = m == null ? v : Math.max(m, v); return { t: s.t, max: m, src: s.src, possible: s.possible }; });

/** Risposta sintetica: classe massima della giornata e finestre orarie con indice ≥ «possibile». */
export function verdict(series, stepMin = 15) {
  const zm = zoneMax(series);
  const known = zm.filter((z) => z.max != null && z.possible);
  if (!known.length) return { cls: zm.some((z) => z.possible) ? null : classify(0), windows: [], best: null, unknown: zm.some((z) => z.possible) };
  const best = known.reduce((a, b) => (b.max > a.max ? b : a));
  const windows = [];
  let cur = null;
  for (const z of zm) {
    const on = z.max != null && classify(z.max).key !== 'improbabile';
    if (on && !cur) cur = { start: z.t, end: z.t + stepMin * 60000, max: z.max };
    else if (on) { cur.end = z.t + stepMin * 60000; cur.max = Math.max(cur.max, z.max); }
    else if (cur) { windows.push(cur); cur = null; }
  }
  if (cur) windows.push(cur);
  return { cls: classify(best.max), windows, best };
}

/**
 * Punti consigliati. mode: 'indice' (massimo), 'vicino' (più vicino con indice ≥ minI), 'arco' (arco più alto, cioè
 * Sole più basso, con indice ≥ minI). atT: istante fissato (cursore) oppure null per l'intera giornata.
 */
export function rankSpots(cells, series, { mode = 'indice', atT = null, minI = 0.08, n = 5, stepMin = 15 } = {}) {
  const steps = atT == null ? series : [series.reduce((a, b) => (Math.abs(b.t - atT) < Math.abs(a.t - atT) ? b : a))];
  const cand = cells.map((c, k) => {
    let pick = null;
    for (const s of steps) {
      const I = s.I[k];
      if (isNaN(I) || I <= 0) continue;
      const top = PRIMARY.outer - s.sun.el;
      const better = !pick ? true
        : mode === 'arco' ? (I >= minI && (pick.I < minI || top > pick.top))
        : I > pick.I;
      if (better) pick = { I, t: s.t, top, sun: s.sun };
    }
    if (!pick) return null;
    // finestra contigua attorno all'istante scelto con indice ≥ minI
    const idx = series.findIndex((s) => s.t === pick.t);
    let a = idx, b = idx;
    while (a > 0 && series[a - 1].I[k] >= minI) a--;
    while (b < series.length - 1 && series[b + 1].I[k] >= minI) b++;
    return { cell: c, k, ...pick, look: (pick.sun.az + 180) % 360, from: series[a].t, to: series[b].t + stepMin * 60000 };
  }).filter(Boolean);
  const key = mode === 'vicino' ? (x) => (x.I >= minI ? x.cell.dist : Infinity) : mode === 'arco' ? (x) => (x.I >= minI ? -x.top : Infinity) : (x) => -x.I;
  cand.sort((p, q) => key(p) - key(q) || q.I - p.I);
  const out = [];
  for (const c of cand) {
    if (mode !== 'indice' && c.I < minI) break;
    if (out.every((o) => Math.hypot(o.cell.x - c.cell.x, o.cell.y - c.cell.y) >= MIN_SEP)) out.push(c);
    if (out.length >= n) break;
  }
  return out;
}
