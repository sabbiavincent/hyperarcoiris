// Radar osservato (RainViewer, composito di riflettività, CORS aperto, ultime 2 h ogni 10 min, zoom ≤ 7)
// e nowcast sperimentale per avvezione (vettore di moto costante stimato dagli ultimi frame).
// Nessuna fonte gratuita e CORS fornisce previsioni radar: dal 2026 RainViewer non serve più il nowcast.

import { tileCoord } from './geodesy.js';
import { decodePng } from './dem.js';
import { UNIVERSAL_BLUE } from './radar-palette.js';

export const MAPS_URL = 'https://api.rainviewer.com/public/weather-maps.json';
export const Z = 7;
export const RAIN_DBZ = 15;          // ≈ 0,3 mm/h con Z = 200 R^1,6 (Marshall & Palmer 1948)
export const NO_ECHO = -32;
export const MAX_LEAD_MIN = 60;

const D2R = Math.PI / 180;

export const rainRate = (dbz) => (dbz <= NO_ECHO ? 0 : (10 ** (dbz / 10) / 200) ** (1 / 1.6));

/** Converte un'immagine RGBA della tavolozza Universal Blue in dBZ (NO_ECHO dove trasparente). */
export function rgbaToDbz(img) {
  const n = img.width * img.height, out = new Float32Array(n);
  const hex = (v) => v.toString(16).padStart(2, '0');
  const cache = new Map();
  let unknown = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4, a = img.data[o + 3];
    if (a === 0) { out[i] = NO_ECHO; continue; }
    const key = (img.data[o] << 24 | img.data[o + 1] << 16 | img.data[o + 2] << 8 | a) >>> 0;
    let v = cache.get(key);
    if (v === undefined) {
      v = UNIVERSAL_BLUE[hex(img.data[o]) + hex(img.data[o + 1]) + hex(img.data[o + 2]) + hex(a)];
      if (v === undefined) { v = NO_ECHO; unknown++; }
      cache.set(key, v);
    }
    out[i] = v;
  }
  return { dbz: out, unknown };
}

// ---- Geometria del mosaico 2×2 di tile z7 (512×512 px) centrato attorno all'osservatore ----
export function mosaicFor(obs) {
  const c = tileCoord(obs.lat, obs.lon, Z);
  const x0 = c.px < 128 ? c.x - 1 : c.x, y0 = c.py < 128 ? c.y - 1 : c.y;
  return { z: Z, x0, y0, size: 512 };
}
export function latLonToPx(m, lat, lon) {
  const n = 2 ** m.z * 256, la = Math.max(-85.05, Math.min(85.05, lat)) * D2R;
  const X = ((lon + 180) / 360) * n, Y = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n;
  return { px: X - m.x0 * 256, py: Y - m.y0 * 256 };
}
/** Lato di un pixel (m) alla latitudine lat. */
export const pixelSize = (m, lat) => (40075016.686 * Math.cos(lat * D2R)) / (2 ** m.z * 256);

export async function fetchFrames(fetchFn = fetch) {
  const r = await fetchFn(MAPS_URL);
  if (!r.ok) throw new Error(`RainViewer HTTP ${r.status}`);
  const j = await r.json();
  return { host: j.host, past: (j.radar?.past || []).map((f) => ({ t: f.time * 1000, path: f.path })), nowcast: j.radar?.nowcast || [] };
}

async function loadTile(url, fetchFn) {
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return decodePng(await r.arrayBuffer());
}

/** Griglia dBZ 512×512 di un frame (4 tile). */
export async function loadFrame(host, frame, m, fetchFn = fetch) {
  const grid = new Float32Array(m.size * m.size).fill(NO_ECHO);
  let unknown = 0;
  await Promise.all([0, 1].flatMap((dx) => [0, 1].map(async (dy) => {
    const img = await loadTile(`${host}${frame.path}/256/${m.z}/${m.x0 + dx}/${m.y0 + dy}/2/0_0.png`, fetchFn);
    const { dbz, unknown: u } = rgbaToDbz(img);
    unknown += u;
    for (let y = 0; y < 256; y++) grid.set(dbz.subarray(y * 256, y * 256 + 256), (dy * 256 + y) * m.size + dx * 256);
  })));
  return { t: frame.t, grid, unknown };
}

/** Maschera di copertura radar (true = coperto). */
export async function loadCoverage(host, m, fetchFn = fetch) {
  const mask = new Uint8Array(m.size * m.size);
  await Promise.all([0, 1].flatMap((dx) => [0, 1].map(async (dy) => {
    const img = await loadTile(`${host}/v2/coverage/0/256/${m.z}/${m.x0 + dx}/${m.y0 + dy}/0/0_0.png`, fetchFn);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const a = img.data[(y * 256 + x) * 4 + 3];
      mask[(dy * 256 + y) * m.size + dx * 256 + x] = a < 128 ? 1 : 0;   // trasparente = coperto
    }
  })));
  return mask;
}

/** dBZ bilineare nel punto (px, py) della griglia (NO_ECHO fuori). */
export function sampleGrid(grid, size, px, py) {
  const x = px - 0.5, y = py - 0.5, x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= size - 1 || y0 >= size - 1) return NO_ECHO;
  const a = x - x0, b = y - y0, g = (i, j) => grid[(y0 + j) * size + x0 + i];
  return (g(0, 0) * (1 - a) + g(1, 0) * a) * (1 - b) + (g(0, 1) * (1 - a) + g(1, 1) * a) * b;
}

// ---- Stima del moto (block matching con affinamento sub-pixel parabolico) ----
/**
 * Spostamento (px) che porta il campo A sul campo B: B(x) ≈ A(x − v).
 * Finestra centrata in (cx, cy) di semilato win, ricerca ±maxShift px.
 */
export function motionVector(A, B, size, { cx = size / 2, cy = size / 2, win = 96, maxShift = 12, minRain = 50 } = {}) {
  const thr = 5;
  const cost = (dx, dy) => {
    let s = 0, n = 0;
    for (let y = cy - win; y < cy + win; y += 2) for (let x = cx - win; x < cx + win; x += 2) {
      const xa = x - dx, ya = y - dy;
      if (xa < 0 || ya < 0 || xa >= size || ya >= size) continue;
      const a = A[ya * size + xa], b = B[y * size + x];
      if (a <= thr && b <= thr) continue;
      s += Math.abs(Math.max(a, 0) - Math.max(b, 0)); n++;
    }
    return n >= minRain ? s / n : Infinity;
  };
  let best = { dx: 0, dy: 0, c: Infinity };
  const C = new Map();
  for (let dy = -maxShift; dy <= maxShift; dy++) for (let dx = -maxShift; dx <= maxShift; dx++) {
    const c = cost(dx, dy); C.set(`${dx},${dy}`, c);
    if (c < best.c) best = { dx, dy, c };
  }
  if (!isFinite(best.c)) return null;
  const par = (cm, c0, cp) => { const den = cm - 2 * c0 + cp; return isFinite(den) && den > 0 ? 0.5 * (cm - cp) / den : 0; };
  const g = (dx, dy) => C.get(`${dx},${dy}`) ?? Infinity;
  const fx = par(g(best.dx - 1, best.dy), best.c, g(best.dx + 1, best.dy));
  const fy = par(g(best.dx, best.dy - 1), best.c, g(best.dx, best.dy + 1));
  return { vx: best.dx + Math.max(-0.5, Math.min(0.5, fx)), vy: best.dy + Math.max(-0.5, Math.min(0.5, fy)), cost: best.c };
}

/**
 * Radar per l'istante t: frame osservato più vicino se t ≤ ultimo frame (+5 min),
 * altrimenti estrapolazione semi-lagrangiana dall'ultimo frame con il vettore medio (px/ms).
 */
export function radarAt(state, t) {
  const fr = state.frames;
  if (!fr.length) return null;
  const last = fr[fr.length - 1];
  if (t <= last.t + 5 * 60000) {
    const f = fr.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    if (Math.abs(f.t - t) > 10 * 60000) return null;
    return { kind: 'osservato', t: f.t, sample: (px, py) => sampleGrid(f.grid, state.m.size, px, py) };
  }
  const lead = t - last.t;
  if (!state.motion || lead > MAX_LEAD_MIN * 60000) return null;
  const sx = state.motion.vx * lead, sy = state.motion.vy * lead;
  return { kind: 'estrapolato', t, lead, sample: (px, py) => sampleGrid(last.grid, state.m.size, px - sx, py - sy) };
}

/** Moto medio (px/ms) dagli ultimi n frame. */
export function meanMotion(frames, size, opts) {
  const vs = [];
  for (let i = Math.max(1, frames.length - 3); i < frames.length; i++) {
    const v = motionVector(frames[i - 1].grid, frames[i].grid, size, opts);
    if (v) vs.push({ vx: v.vx / (frames[i].t - frames[i - 1].t), vy: v.vy / (frames[i].t - frames[i - 1].t) });
  }
  if (!vs.length) return null;
  return { vx: vs.reduce((a, b) => a + b.vx, 0) / vs.length, vy: vs.reduce((a, b) => a + b.vy, 0) / vs.length, n: vs.length };
}

/** Indice di successo critico (CSI) a soglia thr tra due griglie, entro una finestra quadrata. */
export function csi(P, O, size, { cx = size / 2, cy = size / 2, win = 128, thr = RAIN_DBZ } = {}) {
  let h = 0, f = 0, m = 0;
  for (let y = cy - win; y < cy + win; y++) for (let x = cx - win; x < cx + win; x++) {
    const p = P[y * size + x] >= thr, o = O[y * size + x] >= thr;
    if (p && o) h++; else if (p) f++; else if (o) m++;
  }
  return h + f + m ? h / (h + f + m) : null;
}

/** Griglia estrapolata (per verifica a posteriori). */
export function advectGrid(grid, size, sx, sy) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[y * size + x] = sampleGrid(grid, size, x + 0.5 - sx, y + 0.5 - sy);
  return out;
}
