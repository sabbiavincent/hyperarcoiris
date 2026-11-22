// Test numerici della geometria dell'arcobaleno.
// Riferimenti indipendenti: tracciamento vettoriale 2D dei raggi in una sfera (Snell in forma vettoriale),
// formule chiuse di trigonometria sferica, effemeridi di astronomy-engine.

import * as Astro from 'astronomy-engine';
import {
  descartesRadius, waterIndex, PRIMARY, SECONDARY, antisolar, bowPoint, toVec, angleBetween,
  horizonTheta, horizonHalfWidth, bowTop, aboveHorizonFraction, sampleBow, bowWindows, geometryAt,
} from '../js/rainbow.js';
import { sunPosition, zonedDayStart, formatLocal, SUN_SEMIDIAMETER } from '../js/solar.js';

let fails = 0, passes = 0;
const check = (name, ok, info = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${info}`); };
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// ---------- 1. Raggio di Descartes vs tracciamento dei raggi ----------
// Raggio incidente lungo +x, parametro d'impatto b; si segue il raggio dentro un cerchio unitario
// con rifrazione vettoriale e k riflessioni interne; si cerca l'estremo della deviazione al variare di b.
function traceAngle(n, k, b) {
  const refract = (d, nrm, eta) => {           // d e nrm unitari, nrm opposta a d
    const c = -(d[0] * nrm[0] + d[1] * nrm[1]);
    const s2 = eta * eta * (1 - c * c);
    if (s2 > 1) return null;
    const f = eta * c - Math.sqrt(1 - s2);
    return [eta * d[0] + f * nrm[0], eta * d[1] + f * nrm[1]];
  };
  const reflect = (d, nrm) => {
    const c = d[0] * nrm[0] + d[1] * nrm[1];
    return [d[0] - 2 * c * nrm[0], d[1] - 2 * c * nrm[1]];
  };
  const hit = (p, d) => {                        // seconda intersezione con il cerchio unitario
    const pd = p[0] * d[0] + p[1] * d[1];
    const t = -2 * pd;
    return [p[0] + t * d[0], p[1] + t * d[1]];
  };
  let p = [-Math.sqrt(1 - b * b), b], d = [1, 0];
  d = refract(d, [p[0], p[1]], 1 / n);
  for (let j = 0; j < k; j++) { p = hit(p, d); d = reflect(d, [p[0], p[1]]); }
  p = hit(p, d);
  d = refract(d, [-p[0], -p[1]], n);
  // angolo tra il raggio uscente e la direzione antisolare (−x per un osservatore che guarda le gocce)
  return Math.acos(Math.max(-1, Math.min(1, -d[0]))) * R2D;
}
{
  let maxErr = 0;
  for (const n of [1.331, 1.333, 1.339]) {
    for (const k of [1, 2]) {
      let ext = k === 1 ? -Infinity : Infinity;   // primario: massimo angolo dall'antisolare; secondario: minimo
      for (let i = 1; i < 200000; i++) {
        const a = traceAngle(n, k, i / 200000);
        ext = k === 1 ? Math.max(ext, a) : Math.min(ext, a);
      }
      maxErr = Math.max(maxErr, Math.abs(ext - descartesRadius(n, k)));
    }
  }
  check('raggio di Descartes = estremo del tracciamento dei raggi (|Δ| < 0,001°)', maxErr < 1e-3, `Δ=${maxErr.toExponential(2)}°`);
}

// ---------- 2. Indice dell'acqua (IAPWS 1997 / Edlén) vs righe di Fraunhofer a 20 °C, e bande ----------
{
  // Valori di riferimento rispetto all'aria, 20 °C: C 656,28 nm 1,33115; D 589,29 nm 1,33299; F 486,13 nm 1,33712
  const ref = [[656.28, 1.33115], [589.29, 1.33299], [486.13, 1.33712]];
  const err = Math.max(...ref.map(([l, n]) => Math.abs(waterIndex(l, 20) - n)));
  check('indice dell\'acqua alle righe C, D, F (|Δ| < 2e-5)', err < 2e-5, `Δ=${err.toExponential(1)}`);
  check('primario: rosso 700 nm ≈ 42,4° (valore della specifica)', Math.abs(PRIMARY.red - 42.4) < 0.05, `${PRIMARY.red.toFixed(2)}°`);
  check('primario: violetto 400 nm ≈ 40,6° (valore della specifica)', Math.abs(PRIMARY.violet - 40.6) < 0.1, `${PRIMARY.violet.toFixed(2)}°`);
  check('bande allargate dal disco solare (±0,267°)', Math.abs(PRIMARY.outer - PRIMARY.red - SUN_SEMIDIAMETER) < 1e-12 && Math.abs(PRIMARY.violet - PRIMARY.inner - SUN_SEMIDIAMETER) < 1e-12,
    `primario ${PRIMARY.inner.toFixed(2)}–${PRIMARY.outer.toFixed(2)}°`);
  check('secondario tra 50° e 54°, colori invertiti', SECONDARY.red > 50 && SECONDARY.violet < 54 && SECONDARY.red < SECONDARY.violet && PRIMARY.red > PRIMARY.violet,
    `rosso ${SECONDARY.red.toFixed(2)}°, violetto ${SECONDARY.violet.toFixed(2)}°`);
  check('banda di Alexander tra il bordo esterno del primario e quello interno del secondario', PRIMARY.outer < SECONDARY.inner,
    `${PRIMARY.outer.toFixed(2)}°–${SECONDARY.inner.toFixed(2)}°`);
  const dndT = (waterIndex(589.29, 21) - waterIndex(589.29, 19)) / 2;
  const shift = descartesRadius(waterIndex(550, 30)) - descartesRadius(waterIndex(550, 0));
  check('dn/dT a 20 °C ≈ −1,0e-4 K⁻¹ (letteratura); spostamento dell\'arco tra 0 e 30 °C', dndT < -0.8e-4 && dndT > -1.2e-4,
    `dn/dT=${dndT.toExponential(2)} K⁻¹, Δrho(0→30 °C)=${shift.toFixed(2)}°`);
}

// ---------- 3. Punto antisolare ----------
{
  const a = antisolar({ az: 250, el: 12.5 }), b = antisolar({ az: 100, el: 3 });
  check('antisolare = az + 180°, el opposta', a.az === 70 && a.el === -12.5 && b.az === 280 && b.el === -3);
  const s = toVec(250, 12.5), x = toVec(a.az, a.el);
  check('antisolare diametralmente opposto (180°)', Math.abs(angleBetween(s, x) - 180) < 1e-9);
}

// ---------- 4. Arco: ogni punto a distanza angolare rho dall'antisolare ----------
{
  let maxErr = 0, n = 0;
  for (let i = 0; i < 2000; i++) {
    const anti = { az: (i * 137.508) % 360, el: -((i * 7.3) % 60) };
    const rho = i % 2 ? 42 : 51, theta = (i * 53.7) % 360 - 180;
    const p = bowPoint(anti, rho, theta);
    maxErr = Math.max(maxErr, Math.abs(angleBetween(toVec(anti.az, anti.el), toVec(p.az, p.el)) - rho));
    n++;
  }
  check('distanza angolare punto-antisolare = rho (|Δ| < 1e-9°)', maxErr < 1e-9, `Δ=${maxErr.toExponential(2)}° su ${n} casi`);
  const anti = { az: 70, el: -20 };
  const top = bowPoint(anti, 42, 0), right = bowPoint(anti, 42, 30), left = bowPoint(anti, 42, -30);
  check('sommità sulla verticale dell\'antisolare a el = rho − h', Math.abs(top.az - 70) < 1e-9 && Math.abs(top.el - 22) < 1e-9, `${top.el.toFixed(6)}°`);
  check('theta > 0 verso azimut crescenti, simmetria destra/sinistra',
    right.az > 70 && left.az < 70 && Math.abs((right.az - 70) - (70 - left.az)) < 1e-9 && Math.abs(right.el - left.el) < 1e-9);
}

// ---------- 5. Intersezione con l'orizzonte ----------
{
  const cases = [[0, 42], [20, 37.74], [30, 30.89]];
  for (const [h, ref] of cases) {
    const dz = horizonHalfWidth(h, 42);
    check(`semiampiezza sull'orizzonte, h = ${h}°: ${ref}°`, Math.abs(dz - ref) < 0.01, `${dz.toFixed(3)}°`);
  }
  let maxEl = 0, maxAz = 0;
  for (let h = 0; h < 42; h += 0.7) {
    const anti = { az: 123, el: -h }, th = horizonTheta(h, 42);
    for (const s of [-1, 1]) {
      const p = bowPoint(anti, 42, s * th);
      maxEl = Math.max(maxEl, Math.abs(p.el));
      maxAz = Math.max(maxAz, Math.abs(Math.abs(p.az - 123) - horizonHalfWidth(h, 42)));
    }
  }
  check('punti a ±θ_h hanno el = 0 e |Δaz| = Δ (formule indipendenti)', maxEl < 1e-9 && maxAz < 1e-9, `el ${maxEl.toExponential(1)}°, az ${maxAz.toExponential(1)}°`);
  check('h ≥ rho: arco interamente sotto l\'orizzonte', horizonTheta(42, 42) === null && horizonHalfWidth(45, 42) === null && aboveHorizonFraction(50, 42) === 0);
  check('h = 0: metà circonferenza sopra l\'orizzonte', Math.abs(aboveHorizonFraction(0, 42) - 0.5) < 1e-12);
  check('h = 41,9°: sommità a 0,1°', Math.abs(bowTop(41.9, 42) - 0.1) < 1e-12);
  const s = sampleBow({ az: 90, el: -10 }, 42, (az) => (az > 90 ? 90 : 0), 0.5);
  check('frazione visibile con metà dell\'arco dietro un muro ≈ 0,5', Math.abs(s.visibleFraction - 0.5) < 0.01, `${s.visibleFraction.toFixed(3)}`);
}

// ---------- 6. Finestre temporali a Firenze ----------
{
  const lat = 43.7629, lon = 11.265, tz = 'Europe/Rome';
  const day = (ds) => { const t0 = zonedDayStart(ds, tz); return [t0, t0 + 86400000]; };
  const obs = new Astro.Observer(lat, lon, 0);
  const riseSet = (t0) => [
    Astro.SearchRiseSet(Astro.Body.Sun, obs, +1, new Date(t0), 1).date.getTime(),
    Astro.SearchRiseSet(Astro.Body.Sun, obs, -1, new Date(t0), 1).date.getTime(),
  ];
  {
    const [t0, t1] = day('2026-12-21');
    const w = bowWindows(t0, t1, lat, lon, PRIMARY.outer), [rs, ss] = riseSet(t0);
    const ok = w.length === 1 && Math.abs(w[0].start - rs) < 120000 && Math.abs(w[0].end - ss) < 120000;
    check('21/12: primario possibile da alba a tramonto', ok, w.map((x) => `${formatLocal(x.start, tz)}–${formatLocal(x.end, tz)}`).join(', '));
  }
  {
    const [t0, t1] = day('2026-06-21');
    const w = bowWindows(t0, t1, lat, lon, PRIMARY.outer);
    const noon = w.length === 2 && w[0].end < w[1].start;
    const elAtEdges = w.length === 2 ? [w[0].end, w[1].start].map((t) => sunPosition(t, lat, lon).el) : [];
    check('21/06: primario escluso attorno a mezzogiorno, bordi a el = 42,4°', noon && elAtEdges.every((e) => Math.abs(e - PRIMARY.outer) < 0.01),
      w.map((x) => `${formatLocal(x.start, tz)}–${formatLocal(x.end, tz)}`).join(', '));
  }
  // Giorni di transizione: da lì in poi (o fino a lì) il primario è possibile tutto il giorno.
  // Verifica: l'elevazione massima del giorno di transizione coincide con il bordo esterno.
  const maxElOf = (d) => { const [t0] = day(d); let m = -90; for (let t = t0 + 9 * 3600000; t < t0 + 15 * 3600000; t += 30000) m = Math.max(m, sunPosition(t, lat, lon).el); return m; };
  const flags = [];
  for (let k = 0; k < 365; k++) { const d = new Date(Date.UTC(2026, 0, 1 + k)).toISOString().slice(0, 10); flags.push([d, maxElOf(d)]); }
  const iS = flags.findIndex((x, i) => i > 0 && x[1] >= PRIMARY.outer && flags[i - 1][1] < PRIMARY.outer);
  const iA = flags.findIndex((x, i) => i > 0 && x[1] < PRIMARY.outer && flags[i - 1][1] >= PRIMARY.outer);
  const okS = flags[iS - 1][1] < PRIMARY.outer && flags[iS][1] - flags[iS - 1][1] < 0.5, okA = flags[iA][1] < PRIMARY.outer;
  check('Firenze: primario possibile tutto il giorno fino al ' + flags[iS - 1][0] + ' e dal ' + flags[iA][0], okS && okA,
    `el max ${flags[iS - 1][1].toFixed(2)}° → ${flags[iS][1].toFixed(2)}°; ${flags[iA - 1][1].toFixed(2)}° → ${flags[iA][1].toFixed(2)}° (soglia ${PRIMARY.outer.toFixed(2)}°)`);
}

// ---------- 7. geometryAt ----------
{
  const t = Date.UTC(2026, 10, 22, 13, 0);
  const g = geometryAt(t, 43.7629, 11.265);
  check('geometryAt: antisolare coerente, primario possibile a novembre', Math.abs(((g.anti.az - g.sun.az + 360) % 360) - 180) < 1e-9 && g.primary.possible,
    `Sole az ${g.sun.az.toFixed(1)}° el ${g.sun.el.toFixed(1)}°, sommità primario ${g.primary.top.toFixed(1)}°, Δ ±${g.primary.halfWidth.toFixed(1)}°`);
}

console.log(`\n${passes} superati, ${fails} falliti`);
process.exit(fails ? 1 : 0);
