// Indice euristico di probabilità dell'arcobaleno (NON tarato su osservazioni: vedi «Cosa è calcolato»).
// I = S × R, se l'arco primario è geometricamente possibile e almeno in parte visibile.
// I = S × O × R.
//   S: probabilità che il disco solare sia libero lungo il raggio (modello dei varchi di hyperclouds, L = 50 km,
//      tarato con il Sole a 4–10°: a elevazioni maggiori è un'estrapolazione); zero se il Sole è dietro il terreno.
//      Il raggio solare che illumina le gocce (1–20 km dall'altra parte) è approssimato con quello dell'osservatore.
//   O: condizione (c), osservatore non sotto nubi spesse verso il Sole: O = 1 − c⁴, con c = copertura bassa/media
//      media entro 7 km verso il Sole (100 % → 0; 90 % → 0,34; 70 % → 0,76). Necessaria perché S, estrapolato,
//      dà ancora ~0,3 con copertura bassa totale e Sole a 15°.
//   R: per ogni direzione dell'arco visibile, massimo su 1–20 km (o fino al terreno) della probabilità di pioggia
//      liquida; R = massimo sulle direzioni. Radar osservato/estrapolato se disponibile, altrimenti modello.

import { sampleBow, PRIMARY, SECONDARY, antisolar } from './rainbow.js';
import { sunPosition, SUN_SEMIDIAMETER } from './solar.js';
import { bowAgainstTerrain, horizonAtAz } from './horizon360.js';
import { rayClear } from './weather.js';
import { cloudSnap, nearRings, valueOnRing } from './rainfield.js';
import { destination } from './geodesy.js';
import { radarAt, latLonToPx, RAIN_DBZ } from './radar.js';

export const MIN_PATH = 1000;    // m: pioggia più vicina di 1 km non forma un arco apprezzabile (e il DEM vicino è escluso)
export const MAX_PATH = 20000;   // m
export const CLASSES = [
  { min: 0.25, key: 'probabile', label: 'probabile' },
  { min: 0.08, key: 'possibile', label: 'possibile, con riserva' },
  { min: 0, key: 'improbabile', label: 'improbabile' },
];
export const classify = (I) => CLASSES.find((c) => I >= c.min);

/** Frazione liquida della precipitazione da T a 2 m: neve sotto 0,5 °C, mista fino a 2,5 °C (euristica). */
export const liquidFraction = (T) => (T == null ? 1 : Math.max(0, Math.min(1, (T - 0.5) / 2)));

/** Probabilità di pioggia liquida in una cella del modello. */
export function cellRain({ prob, mm, T }) {
  const p = prob != null ? prob / 100 : mm != null ? 1 - Math.exp(-mm / 0.2) : null;
  return p == null ? null : p * liquidFraction(T);
}

/** Probabilità di pioggia da riflettività radar. */
export const radarRain = (dbz) => (dbz >= RAIN_DBZ ? 1 : dbz >= 5 ? 0.3 : 0);

/**
 * Valutazione completa all'istante t.
 * ctx = { obs, h0, hc (horizon360), field (rainfield) | null, radar: {frames, m, motion, coverage} | null, step }
 */
export function evaluate(ctx, t) {
  const { obs, h0, hc, field, radar } = ctx;
  const sun = sunPosition(t, obs.lat, obs.lon);
  const anti = antisolar(sun);
  const sunUp = sun.el + SUN_SEMIDIAMETER > 0;
  const sunTerrain = hc ? horizonAtAz(hc, sun.az) : 0;
  const sunClearOfTerrain = sunUp && sun.el + SUN_SEMIDIAMETER > sunTerrain;
  const geo = {
    primary: sunUp && sun.el < PRIMARY.outer,
    secondary: sunUp && sun.el < SECONDARY.outer,
  };
  const out = { t, sun, anti, sunUp, sunTerrain, sunClearOfTerrain, geo, S: null, O: null, R: null, I: 0, cls: classify(0), source: null, dirs: [] };
  if (!geo.primary) { out.reason = sunUp ? 'Sole troppo alto' : 'Sole sotto l\'orizzonte'; return out; }

  // visibilità dell'arco contro il terreno
  const bow = sampleBow(anti, PRIMARY.mid, () => 0, ctx.step ?? 3);
  const bt = hc ? bowAgainstTerrain(hc, bow, MIN_PATH) : { points: bow.points.map((p) => ({ ...p, against: 'cielo', dHit: null })), skyFraction: 1, frontFraction: 0 };
  out.skyFraction = bt.skyFraction; out.frontFraction = bt.frontFraction; out.astroFraction = bow.astroFraction;
  out.bowPoints = bt.points;
  const usable = bt.points.filter((p) => p.el >= 0 && (p.against === 'cielo' || p.dHit >= MIN_PATH));
  if (!usable.length) { out.reason = 'arco interamente nascosto dal terreno'; return out; }
  out.possibleVisible = true;

  // S: Sole libero
  if (!sunClearOfTerrain) { out.S = 0; out.reason = 'Sole dietro il terreno'; }
  else if (field) {
    const snap = cloudSnap(field, sun.az, t);
    out.S = rayClear(snap, h0, Math.max(sun.el, 0.5)).P;
    const near = snap.filter((c) => c.d <= 7000).map((c) => Math.max(c.low ?? 0, c.mid ?? 0) / 100);
    out.O = 1 - (near.reduce((a, b) => a + b, 0) / near.length) ** 4;
  }

  // R: pioggia nel settore antisolare
  const rad = radar ? radarAt(radar, t) : null;
  out.source = rad ? `radar ${rad.kind}` : field ? `modello ${field.model}` : null;
  let R = null;
  for (const p of usable) {
    const dMax = Math.min(MAX_PATH, p.dHit ?? MAX_PATH);
    let pd = null;
    if (rad) {
      for (let d = MIN_PATH; d <= dMax; d += 1000) {
        const q = destination(obs.lat, obs.lon, d, p.az), px = latLonToPx(radar.m, q.lat, q.lon);
        const ix = Math.floor(px.px), iy = Math.floor(px.py);
        if (radar.coverage && !radar.coverage[iy * radar.m.size + ix]) continue;
        const v = radarRain(rad.sample(px.px, px.py));
        pd = pd == null ? v : Math.max(pd, v);
      }
    }
    if (pd == null && field) {
      for (const r of nearRings(field, MIN_PATH, dMax)) {
        const v = cellRain({
          prob: field.hasProb ? valueOnRing(field, r, 'precipitation_probability', p.az, t) : null,
          mm: valueOnRing(field, r, 'precipitation', p.az, t),
          T: valueOnRing(field, r, 'temperature_2m', p.az, t),
        });
        if (v != null) pd = pd == null ? v : Math.max(pd, v);
      }
    }
    out.dirs.push({ az: p.az, el: p.el, against: p.against, dMax, p: pd });
    if (pd != null) R = R == null ? pd : Math.max(R, pd);
  }
  out.R = R;
  if (out.S != null && R != null) out.I = out.S * (out.O ?? 1) * R;
  out.cls = classify(out.I);
  return out;
}

/** Serie della giornata [t0, t1) al passo stepMin (default 10 min). */
export function daySeries(ctx, t0, t1, stepMin = 10) {
  const out = [];
  for (let t = t0; t < t1; t += stepMin * 60000) out.push(evaluate(ctx, t));
  return out;
}
