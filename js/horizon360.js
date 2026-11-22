// Orizzonte reale su tutto il giro (360°) fino a maxDist, per il settore antisolare e per il Sole.
// Stessa geometria di terrain.js (curvatura, rifrazione k, campo vicino escluso), distanza massima
// parametrica: oltre ~100 km il rilievo appenninico sottende < 1° e il costo in tile triplica.

import { destination, elevationAngle, rayAltitude, DEFAULT_K } from './geodesy.js';
import { MIN_DIST } from './terrain.js';

export const DEFAULT_MAX = 100000;

export function schedule(maxDist = DEFAULT_MAX) {
  const out = [];
  let d = MIN_DIST;
  while (d <= maxDist) {
    const z = d < 15000 ? 12 : d < 60000 ? 11 : 10;
    out.push({ d, z });
    d += d < 5000 ? 50 : d < 20000 ? 100 : d < 80000 ? 250 : 500;
  }
  return out;
}

function points(obs, step, maxDist) {
  const sch = schedule(maxDist), pts = [];
  for (let az = 0; az < 360 - 1e-9; az += step) for (const s of sch) pts.push({ az, ...s, ...destination(obs.lat, obs.lon, s.d, az) });
  return pts;
}

export function prefetchCircle(dem, obs, { step = 1, maxDist = DEFAULT_MAX, onProgress } = {}) {
  return dem.prefetch(points(obs, step, maxDist), onProgress);
}

/**
 * Profilo d'orizzonte circolare. Per ogni azimut (passo `step`) conserva i campioni {d, h, ang}
 * per poter calcolare dove una linea di vista incontra il terreno.
 */
export function horizonCircle(dem, obs, h0, { step = 1, maxDist = DEFAULT_MAX, k = DEFAULT_K } = {}) {
  const sch = schedule(maxDist);
  const n = Math.round(360 / step);
  const horizon = new Float64Array(n), rays = [];
  let missing = 0;
  for (let i = 0; i < n; i++) {
    const az = i * step;
    let max = -90;
    const s = sch.map(({ d, z }) => {
      const p = destination(obs.lat, obs.lon, d, az);
      let h = dem.sample(p.lat, p.lon, z);
      if (h == null) { missing++; h = 0; }
      const ang = elevationAngle(d, h0, h, k);
      if (ang > max) max = ang;
      return { d, h, ang };
    });
    horizon[i] = max;
    rays.push(s);
  }
  return { obs, h0, step, maxDist, k, horizon, rays, missing };
}

const idx = (hc, az) => (((az % 360) + 360) % 360) / hc.step;

/** Elevazione dell'orizzonte all'azimut az (interpolazione lineare circolare). */
export function horizonAtAz(hc, az) {
  const n = hc.horizon.length, f = idx(hc, az), i = Math.floor(f) % n, j = (i + 1) % n, t = f - Math.floor(f);
  return hc.horizon[i] * (1 - t) + hc.horizon[j] * t;
}

/**
 * Distanza (m) a cui la linea di vista (az, el apparente) incontra il terreno; null se passa sopra
 * tutto il profilo fino a maxDist (sfondo di cielo).
 */
export function terrainHitDistance(hc, az, el) {
  const n = hc.horizon.length, i = Math.round(idx(hc, az)) % n;
  if (el > hc.horizon[i]) return null;
  for (const s of hc.rays[i]) if (s.h >= rayAltitude(s.d, hc.h0, el, hc.k)) return s.d;
  return null;
}

/**
 * Arco campionato (output di sampleBow) confrontato con il terreno reale.
 * Per ogni punto: sfondo 'cielo' o 'terreno', distanza dHit del terreno sulla linea di vista.
 * Un tratto davanti al terreno è visibile solo se la pioggia sta più vicina di dHit.
 */
export function bowAgainstTerrain(hc, bowSample, minRainPath = 1000) {
  const pts = bowSample.points.map((p) => {
    const horizon = horizonAtAz(hc, p.az);
    const dHit = p.el > horizon ? null : terrainHitDistance(hc, p.az, p.el);
    return { ...p, horizon, against: dHit == null ? 'cielo' : 'terreno', dHit };
  });
  const segs = Math.max(1, pts.length - 1);
  let sky = 0, front = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i].against === 'cielo') sky++;
    else if (pts[i].dHit >= minRainPath) front++;
  }
  return {
    points: pts,
    skyFraction: pts.length > 1 ? sky / segs : 0,          // frazione dell'arco (sopra l'orizzonte astronomico) con cielo dietro
    frontFraction: pts.length > 1 ? front / segs : 0,      // davanti al terreno con almeno minRainPath di aria per la pioggia
    astroFraction: bowSample.astroFraction,                // frazione della circonferenza sopra l'orizzonte astronomico
  };
}

/** Il Sole è sopra il terreno reale (bordo superiore del disco)? */
export function sunAboveTerrain(hc, sun, semidiameter = 0.2666) {
  return sun.el + semidiameter > horizonAtAz(hc, sun.az);
}
