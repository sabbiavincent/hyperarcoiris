// Geometria dell'arcobaleno: punto antisolare, raggi angolari (ottica geometrica di Descartes),
// archi in coordinate orizzontali, intersezione con l'orizzonte, finestre temporali.
// Angoli in gradi. Azimut: 0 = Nord, orario. Elevazioni apparenti (rifrazione inclusa).

import { sunPosition, SUN_SEMIDIAMETER } from './solar.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const norm360 = (x) => ((x % 360) + 360) % 360;

// ---- Indice di rifrazione dell'acqua rispetto all'aria ----
// Acqua (rispetto al vuoto): formulazione IAPWS 1997 (Harvey et al., J. Phys. Chem. Ref. Data 27, 761, 1998).
// Aria standard: Edlén 1966 (Metrologia 2, 71). Le gocce stanno in aria: conta il rapporto.
const IAPWS_A = [0.244257733, 9.74634476e-3, -3.73234996e-3, 2.68678472e-4, 1.58920570e-3, 2.45934259e-3,
  0.900704920, -1.66626219e-2];
const L_UV = 0.2292020, L_IR = 5.432937;
// densità dell'acqua liquida (kg/m³) a T °C, 0–40 °C (approssimazione di Kell, scarto < 0,05 kg/m³)
const waterDensity = (T) => (999.83952 + 16.945176 * T - 7.9870401e-3 * T ** 2 - 46.170461e-6 * T ** 3
  + 105.56302e-9 * T ** 4 - 280.54253e-12 * T ** 5) / (1 + 16.879850e-3 * T);
export function waterIndexVacuum(nm, T = 10) {
  const a = IAPWS_A, r = waterDensity(T) / 1000, Tb = (T + 273.15) / 273.15, L2 = (nm / 589) ** 2;
  const A = r * (a[0] + a[1] * r + a[2] * Tb + a[3] * L2 * Tb + a[4] / L2 + a[5] / (L2 - L_UV ** 2)
    + a[6] / (L2 - L_IR ** 2) + a[7] * r * r);
  return Math.sqrt((2 * A + 1) / (1 - A));
}
export function airIndex(nm) {
  const s2 = (1000 / nm) ** 2;
  return 1 + (8342.54 + 2406147 / (130 - s2) + 15998 / (38.9 - s2)) * 1e-8;
}
/** Indice dell'acqua relativo all'aria (temperatura delle gocce T in °C, default 10 °C). */
export const waterIndex = (nm, T = 10) => waterIndexVacuum(nm, T) / airIndex(nm);

// Estremi dello spettro visibile usati per le bande
export const LAMBDA_VIOLET = 400, LAMBDA_RED = 700;

/**
 * Raggio angolare (gradi, dal punto antisolare) dell'arco di ordine k (k riflessioni interne)
 * per una sfera di indice n, nel limite dell'ottica geometrica (deviazione minima di Descartes).
 * Validità: gocce ≳ 0,5 mm; per gocce più piccole la teoria di Airy sposta e allarga l'arco.
 */
export function descartesRadius(n, k = 1) {
  const cosI = Math.sqrt((n * n - 1) / (k * (k + 2)));
  const i = Math.acos(cosI), r = Math.asin(Math.sin(i) / n);
  const D = 2 * (i - r) + k * (Math.PI - 2 * r);          // deviazione totale
  // angolo tra il raggio emergente e la direzione antisolare
  let a = Math.abs(((D % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
  return a * R2D;
}

// Raggi delle bande (gradi). Bordo esterno/interno includono il semidiametro del disco solare.
function bow(k) {
  const red = descartesRadius(waterIndex(LAMBDA_RED), k), violet = descartesRadius(waterIndex(LAMBDA_VIOLET), k);
  const lo = Math.min(red, violet), hi = Math.max(red, violet);
  return { k, red, violet, inner: lo - SUN_SEMIDIAMETER, outer: hi + SUN_SEMIDIAMETER, mid: (red + violet) / 2 };
}
export const PRIMARY = bow(1);     // rosso fuori, violetto dentro
export const SECONDARY = bow(2);   // colori invertiti: rosso dentro

// ---- Vettori in coordinate orizzontali (x = Est, y = Nord, z = zenit) ----
export const toVec = (az, el) => {
  const a = az * D2R, e = el * D2R;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
};
export const toAzEl = (v) => ({
  az: norm360(Math.atan2(v[0], v[1]) * R2D),
  el: Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D,
});
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const angleBetween = (a, b) => {
  // atan2 di |a×b| e a·b: stabile anche per angoli piccoli
  const c = cross(a, b);
  return Math.atan2(Math.hypot(...c), dot(a, b)) * R2D;
};

/** Punto antisolare: azimut del Sole + 180°, elevazione opposta. */
export function antisolar(sun) {
  return { az: norm360(sun.az + 180), el: -sun.el };
}

/**
 * Punto dell'arco di raggio rho attorno all'antisolare (az, el), all'angolo di posizione theta:
 * theta = 0 sommità (verso lo zenit), theta > 0 verso azimut crescenti.
 */
export function bowPoint(anti, rho, theta) {
  const a = toVec(anti.az, anti.el);
  const e = anti.el * D2R;
  // u: direzione dello zenit proiettata sul piano ⟂ ad a (cioè "in alto" attorno all'antisolare)
  const u = [-Math.sin(e) * a[0] / Math.cos(e), -Math.sin(e) * a[1] / Math.cos(e), Math.cos(e)];
  const r = cross(a, u);  // verso azimut crescenti (orizzontale)
  const cr = Math.cos(rho * D2R), sr = Math.sin(rho * D2R), ct = Math.cos(theta * D2R), st = Math.sin(theta * D2R);
  return toAzEl([0, 1, 2].map((i) => cr * a[i] + sr * (ct * u[i] + st * r[i])));
}

/**
 * Angolo di posizione (gradi) a cui l'arco di raggio rho taglia l'orizzonte astronomico (el = 0),
 * con il Sole a elevazione h. cos θ = tan h / tan rho. null se l'arco è tutto sotto (h ≥ rho);
 * 180 se è tutto sopra (h ≤ −rho, non realizzabile di giorno).
 */
export function horizonTheta(h, rho) {
  const c = Math.tan(h * D2R) / Math.tan(rho * D2R);
  if (c >= 1) return null;
  if (c <= -1) return 180;
  return Math.acos(c) * R2D;
}

/** Semiampiezza azimutale (gradi) dell'arco sull'orizzonte: cos Δ = cos rho / cos h. */
export function horizonHalfWidth(h, rho) {
  if (h >= rho) return null;
  return Math.acos(Math.cos(rho * D2R) / Math.cos(h * D2R)) * R2D;
}

/** Elevazione della sommità dell'arco. */
export const bowTop = (h, rho) => rho - h;

/** Frazione della circonferenza completa dell'arco che sta sopra l'orizzonte astronomico. */
export function aboveHorizonFraction(h, rho) {
  const t = horizonTheta(h, rho);
  return t == null ? 0 : t / 180;
}

/**
 * Campionamento dell'arco visibile sopra un orizzonte qualsiasi: horizonFn(az) → elevazione dell'orizzonte.
 * Restituisce i punti [{theta, az, el, visible}] e la frazione visibile rispetto all'arco sopra
 * l'orizzonte astronomico (1 = nessun ostacolo).
 */
export function sampleBow(anti, rho, horizonFn = () => 0, stepDeg = 1) {
  const h = -anti.el;
  const tMax = horizonTheta(h, rho);
  if (tMax == null) return { points: [], visibleFraction: 0, astroFraction: 0 };
  const pts = [];
  let vis = 0, tot = 0;
  const n = Math.max(2, Math.ceil((2 * tMax) / stepDeg));
  for (let i = 0; i <= n; i++) {
    const theta = -tMax + (2 * tMax * i) / n;
    const p = bowPoint(anti, rho, theta);
    const visible = p.el >= horizonFn(p.az);
    pts.push({ theta, az: p.az, el: p.el, visible });
    if (i < n) { tot++; if (visible) vis++; }
  }
  return { points: pts, visibleFraction: tot ? vis / tot : 0, astroFraction: tMax / 180 };
}

/**
 * Intervalli [{start, end}] del giorno [t0, t1) in cui l'arco di raggio esterno rhoOuter è almeno in parte
 * sopra l'orizzonte astronomico e il Sole è sopra l'orizzonte (bordo superiore del disco > 0).
 * Campionamento al minuto e bisezione dei bordi (precisione ~1 s).
 */
export function bowWindows(t0, t1, lat, lon, rhoOuter) {
  const ok = (t) => {
    const p = sunPosition(t, lat, lon);
    return p.el + SUN_SEMIDIAMETER > 0 && p.el < rhoOuter;
  };
  const refine = (a, b, va) => {
    for (let i = 0; i < 20 && b - a > 1000; i++) {
      const m = (a + b) / 2;
      if (ok(m) === va) a = m; else b = m;
    }
    return Math.round((a + b) / 2);
  };
  const out = [];
  const step = 60000;
  let prev = ok(t0), start = prev ? t0 : null;
  for (let t = t0 + step; t <= t1; t += step) {
    const v = ok(t);
    if (v !== prev) {
      const edge = refine(t - step, t, prev);
      if (v) start = edge; else { out.push({ start, end: edge }); start = null; }
      prev = v;
    }
  }
  if (start != null) out.push({ start, end: t1 });
  return out;
}

/** Geometria completa all'istante t. */
export function geometryAt(t, lat, lon) {
  const sun = sunPosition(t, lat, lon);
  const anti = antisolar(sun);
  const h = sun.el;
  const mk = (B) => ({
    ...B,
    top: bowTop(h, B.outer),
    halfWidth: horizonHalfWidth(h, B.outer),
    possible: sun.el + SUN_SEMIDIAMETER > 0 && h < B.outer,
  });
  return { t, sun, anti, primary: mk(PRIMARY), secondary: mk(SECONDARY) };
}
