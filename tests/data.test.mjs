// Fasi 3, 4 e 8: griglia Open-Meteo, radar RainViewer, nowcast per avvezione, indice euristico.
// Parte sintetica (sempre) + parte dal vivo (saltata se la rete o i limiti non lo consentono).

import { polarGrid, requestWeight, buildQuery, fetchField, valueAtPoint, cloudSnap, VARS } from '../js/rainfield.js';
import { rgbaToDbz, motionVector, radarAt, fetchFrames, loadFrame, loadCoverage, mosaicFor, latLonToPx, pixelSize, meanMotion, csi, advectGrid, rainRate, RAIN_DBZ, NO_ECHO } from '../js/radar.js';
import { UNIVERSAL_BLUE } from '../js/radar-palette.js';
import { evaluate, cellRain, liquidFraction } from '../js/likelihood.js';
import { horizonCircle } from '../js/horizon360.js';
import { sunPosition } from '../js/solar.js';

let fails = 0, passes = 0;
const check = (name, ok, info = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${info}`); };
const skip = (name, why) => console.log(`SKIP ${name}: ${why}`);
const obs = { lat: 43.7629, lon: 11.265 };

// ---------- 1. Griglia polare e peso delle richieste ----------
{
  const pts = polarGrid(obs);
  const w = requestWeight(pts.length, 3, VARS.length);
  const url = `https://api.open-meteo.com/v1/forecast?${buildQuery(pts, '2026-11-22', 'best_match')}`;
  check('griglia: 1 + 4×36 + 4×18 = 217 punti, peso 217 per aggiornamento', pts.length === 217 && w === 217, `URL ${url.length} caratteri`);
  check('peso secondo la formula Open-Meteo', requestWeight(10, 15, 11) === 40 && requestWeight(1, 1, 10) === 1);
  check('30 aggiornamenti al giorno restano sotto 10 000', 30 * w < 10000, `${30 * w}`);
}

// ---------- 2. Accesso ai valori (sintetico) ----------
const H = 3600000, T0 = Date.UTC(2026, 10, 22, 0);
function synthField({ rain = () => 0, prob = null, low = () => 0, T = () => 10 } = {}) {
  const pts = polarGrid(obs), times = Array.from({ length: 72 }, (_, k) => T0 - 24 * H + k * H);
  const data = {};
  for (const v of VARS) data[v] = pts.map(() => times.map(() => 0));
  pts.forEach((p, i) => times.forEach((t, k) => {
    data.precipitation[i][k] = rain(p, t);
    data.precipitation_probability[i][k] = prob ? prob(p, t) : null;
    data.cloud_cover_low[i][k] = low(p, t);
    data.temperature_2m[i][k] = T(p, t);
  }));
  return { obs, model: 'sintetico', pts, times, data, hasProb: !!prob };
}
{
  const f = synthField({ rain: (p, t) => (t - T0) / H, low: (p, t) => (t - T0) / H * 10 });
  check('precipitazione: valore dell\'ora che termina dopo t', valueAtPoint(f, 0, 'precipitation', T0 + 2.5 * H) === 3);
  check('nubi: interpolazione lineare nel tempo', Math.abs(valueAtPoint(f, 0, 'cloud_cover_low', T0 + 2.5 * H) - 25) < 1e-9);
  const g = synthField({ low: (p) => (p.d === 0 ? 0 : p.az) });
  const s = cloudSnap(g, 15, T0);
  check('nubi in azimut: interpolazione tra 10° e 20° sugli anelli vicini; anelli lontani ogni 20°', s[0].low === 0 && s[1].low === 15 && s[5].low === 15,
    s.map((c) => `${c.d / 1000}km:${c.low}`).join(' '));
}

// ---------- 3. fetchField con risposte simulate e ripiego di modello ----------
{
  const pts = polarGrid(obs);
  const fake = (fail) => async (url) => {
    const m = new URL(url).searchParams.get('models');
    if (fail && m) return { ok: false, status: 400, json: async () => ({ error: true, reason: 'No data is available for this location' }) };
    const times = [0, 1, 2].map((k) => (T0 / 1000) + k * 3600);
    const loc = { hourly: { time: times, ...Object.fromEntries(VARS.map((v) => [v, times.map(() => (v === 'precipitation_probability' && m ? null : 1))])) } };
    return { ok: true, status: 200, json: async () => pts.map(() => loc) };
  };
  globalThis.localStorage = { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = v; } };
  const a = await fetchField(obs, '2026-11-22', 'icon_d2', { fetchFn: fake(false) });
  const b = await fetchField(obs, '2026-11-22', 'icon_d2', { fetchFn: fake(true) });
  check('modello deterministico: nessuna probabilità; ripiego su best_match se fuori dominio', a.model === 'icon_d2' && !a.hasProb && b.model === 'best_match' && b.hasProb && /ripiego/.test(b.note));
  check('contatore condiviso hc.calls aggiornato (3 richieste × 217)', JSON.parse(localStorage.getItem('hc.calls')).n === 651);
}

// ---------- 4. Radar: tavolozza e moto ----------
{
  const entries = Object.entries(UNIVERSAL_BLUE);
  const img = { width: entries.length, height: 1, data: new Uint8ClampedArray(entries.length * 4) };
  entries.forEach(([hex], i) => { for (let k = 0; k < 4; k++) img.data[i * 4 + k] = parseInt(hex.slice(2 * k, 2 * k + 2), 16); });
  const { dbz, unknown } = rgbaToDbz(img);
  check('tavolozza Universal Blue invertita esattamente', unknown === 0 && entries.every(([, v], i) => dbz[i] === v), `${entries.length} colori`);
  check('Marshall–Palmer: 23 dBZ ≈ 1 mm/h, soglia 15 dBZ ≈ 0,3 mm/h', Math.abs(rainRate(23) - 1) < 0.05 && Math.abs(rainRate(RAIN_DBZ) - 0.31) < 0.03,
    `${rainRate(23).toFixed(2)}, ${rainRate(RAIN_DBZ).toFixed(2)} mm/h`);

  const size = 512, blob = (sx, sy) => {
    const g = new Float32Array(size * size).fill(NO_ECHO);
    const cells = [[230, 250, 18, 45], [290, 220, 25, 38], [260, 300, 12, 50], [200, 280, 20, 30]];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let v = NO_ECHO;
      for (const [cx, cy, r, a] of cells) { const q = ((x - cx - sx) ** 2 + (y - cy - sy) ** 2) / (r * r); if (q < 4) v = Math.max(v, a * Math.exp(-q)); }
      g[y * size + x] = v;
    }
    return g;
  };
  const A = blob(0, 0), B = blob(5.3, -2.7);
  const v = motionVector(A, B, size);
  check('moto stimato su campo sintetico traslato di (5,3; −2,7) px', v && Math.abs(v.vx - 5.3) < 0.35 && Math.abs(v.vy + 2.7) < 0.35, v ? `(${v.vx.toFixed(2)}; ${v.vy.toFixed(2)})` : 'nullo');
  const st = { m: { size }, frames: [{ t: 0, grid: A }, { t: 600000, grid: B }] };
  st.motion = meanMotion(st.frames, size);
  const r30 = radarAt(st, 600000 + 30 * 60000), r90 = radarAt(st, 600000 + 90 * 60000), r0 = radarAt(st, 590000);
  const truth = blob(5.3 * 4, -2.7 * 4);
  const pred = advectGrid(B, size, st.motion.vx * 1800000, st.motion.vy * 1800000);
  check('estrapolazione a +30 min: CSI ≥ 0,8 sul campo sintetico; oltre 60 min rifiutata', r30?.kind === 'estrapolato' && r90 === null && r0?.kind === 'osservato' && csi(pred, truth, size) >= 0.8,
    `CSI ${csi(pred, truth, size).toFixed(2)}`);
}

// ---------- 5. Indice euristico su scenari sintetici ----------
{
  const flat = horizonCircle({ sample: () => 0 }, obs, 50, { maxDist: 25000 });
  const t = Date.UTC(2026, 10, 22, 14, 0);    // Sole basso a SO, antisolare a NE
  const sun = sunPosition(t, obs.lat, obs.lon), anti = (sun.az + 180) % 360;
  const near = (az, c) => Math.abs(((az - c + 540) % 360) - 180) < 50;
  const ctx = (fopts) => ({ obs, h0: 50, hc: flat, field: synthField(fopts), radar: null });
  const showerAnti = { rain: (p) => (p.d > 0 && p.d <= 20000 && near(p.az, anti) ? 2 : 0) };
  const e1 = evaluate(ctx(showerAnti), t);
  const e2 = evaluate(ctx({}), t);
  const e3 = evaluate(ctx({ ...showerAnti, low: () => 100 }), t);
  const e4 = evaluate(ctx({ ...showerAnti, T: () => -2 }), t);
  const e5 = evaluate(ctx({ rain: (p) => (p.d > 0 && near(p.az, sun.az) ? 2 : 0) }), t);
  check('sereno + rovescio nel settore antisolare → probabile', e1.cls.key === 'probabile' && e1.S === 1, `S=${e1.S?.toFixed(2)} R=${e1.R?.toFixed(2)} I=${e1.I.toFixed(2)}`);
  check('nessuna pioggia → I = 0', e2.I === 0);
  check('coperto basso verso il Sole → improbabile (O = 0)', e3.cls.key === 'improbabile' && e3.O === 0, `S=${e3.S?.toFixed(3)} O=${e3.O}`);
  const e3b = evaluate(ctx({ ...showerAnti, low: () => 70 }), t);
  check('copertura bassa 70 %: O ≈ 0,76', Math.abs(e3b.O - 0.76) < 0.01, `S=${e3b.S.toFixed(2)} I=${e3b.I.toFixed(2)}`);
  check('neve (T = −2 °C) → I = 0', e4.I === 0 && liquidFraction(-2) === 0 && liquidFraction(1.5) === 0.5);
  check('pioggia solo dal lato del Sole → I = 0', e5.I === 0);
  const wall = horizonCircle({ sample: () => 0 }, obs, 50, { maxDist: 25000 });
  wall.horizon.fill(60);                                   // terreno ovunque sopra l'arco
  for (const r of wall.rays) for (const s of r) s.h = s.d >= 2000 && s.d <= 2500 ? 5000 : 0;
  const e6 = evaluate({ obs, h0: 50, hc: wall, field: synthField({ rain: (p) => (p.d >= 3000 && near(p.az, anti) ? 2 : 0) }) }, t);
  check('pioggia oltre un rilievo a 2 km (dietro il terreno) → nessun contributo', !e6.R && !e6.I, `R=${e6.R}`);
  const night = evaluate(ctx(showerAnti), Date.UTC(2026, 10, 22, 22));
  check('notte: geometricamente impossibile', !night.geo.primary && night.I === 0, night.reason);
  const nofield = evaluate({ obs, h0: 50, hc: flat, field: null }, t);
  check('senza dati meteo: indice non calcolato (null), non zero', nofield.I === null && nofield.cls === null);
  check('probabilità da ensemble preferita alla quantità', cellRain({ prob: 40, mm: 5, T: 10 }) === 0.4 && Math.abs(cellRain({ prob: null, mm: 0.2, T: 10 }) - (1 - Math.exp(-1))) < 1e-12);
}

// ---------- 6. Dal vivo: RainViewer ----------
try {
  const fr = await fetchFrames();
  const m = mosaicFor(obs);
  const pos = latLonToPx(m, obs.lat, obs.lon);
  check('RainViewer: frame passati presenti, nowcast assente (servizio sospeso nel 2026)', fr.past.length >= 6 && fr.nowcast.length === 0, `${fr.past.length} frame, ultimo ${new Date(fr.past.at(-1).t).toISOString().slice(11, 16)} UTC`);
  check('mosaico 2×2: osservatore ad almeno 128 px dai bordi; pixel ≈ 0,88 km', pos.px >= 128 && pos.px <= 384 && pos.py >= 128 && pos.py <= 384 && Math.abs(pixelSize(m, obs.lat) - 880) < 20,
    `(${pos.px.toFixed(0)}, ${pos.py.toFixed(0)}) px, ${pixelSize(m, obs.lat).toFixed(0)} m`);
  const frames = [];
  for (const f of fr.past.slice(-6)) frames.push(await loadFrame(fr.host, f, m));
  const cov = await loadCoverage(fr.host, m);
  check('frame decodificati senza colori ignoti; Firenze coperta dal radar', frames.every((f) => f.unknown === 0) && cov[Math.floor(pos.py) * 512 + Math.floor(pos.px)] === 1);
  // Verifica a posteriori: dai frame fino a t−30 min si prevede t, confronto con la persistenza.
  const wet = frames.at(-1).grid.reduce((a, v) => a + (v >= RAIN_DBZ ? 1 : 0), 0);
  if (wet < 300) skip('verifica a posteriori del nowcast', `troppa poca pioggia nel mosaico (${wet} px ≥ ${RAIN_DBZ} dBZ)`);
  else {
    const hist = frames.slice(0, 3), mo = meanMotion(hist, 512, { cx: Math.round(pos.px), cy: Math.round(pos.py), win: 120 });
    const lead = frames.at(-1).t - hist.at(-1).t;
    const pred = mo ? advectGrid(hist.at(-1).grid, 512, mo.vx * lead, mo.vy * lead) : hist.at(-1).grid;
    const cAdv = csi(pred, frames.at(-1).grid, 512, { cx: Math.round(pos.px), cy: Math.round(pos.py) });
    const cPer = csi(hist.at(-1).grid, frames.at(-1).grid, 512, { cx: Math.round(pos.px), cy: Math.round(pos.py) });
    check(`nowcast a +${lead / 60000} min non peggiore della persistenza (CSI)`, cAdv != null && cAdv >= cPer - 0.02, `avvezione ${cAdv?.toFixed(2)}, persistenza ${cPer?.toFixed(2)}`);
  }
} catch (e) { skip('RainViewer dal vivo', e.message); }

// ---------- 7. Dal vivo: Open-Meteo (una richiesta, peso 217) ----------
if (process.env.LIVE_OPENMETEO) {
  try {
    const f = await fetchField(obs, new Date().toISOString().slice(0, 10), 'best_match');
    check('Open-Meteo dal vivo: 217 punti, probabilità presente con best_match', f.pts.length === 217 && f.data.precipitation.length === 217 && f.hasProb, f.note);
  } catch (e) { skip('Open-Meteo dal vivo', e.message); }
} else skip('Open-Meteo dal vivo', 'impostare LIVE_OPENMETEO=1 (l\'IP condiviso di questo ambiente ha già esaurito il limite giornaliero)');

console.log(`\n${passes} superati, ${fails} falliti`);
process.exit(fails ? 1 : 0);
