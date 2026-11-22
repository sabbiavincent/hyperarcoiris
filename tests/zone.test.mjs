// Ricerca nella zona (20 km): griglia, interpolazione, posizione dei punti consigliati rispetto alla pioggia.

import { regionGrid, snapshot, valueXY, zoneCells, cellHorizons, scanAt, scanDay, verdict, rankSpots, projector, ZONE_RADIUS, MIN_SEP, fetchRegion } from '../js/zonescan.js';
import { VARS, requestWeight, throttle, MINUTE_CAP, polarGrid } from '../js/rainfield.js';
import { polarFromRegion } from '../js/zonescan.js';
import { sunPosition, zonedDayStart } from '../js/solar.js';

let fails = 0, passes = 0;
const check = (name, ok, info = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${info}`); };
const C = { lat: 43.7765, lon: 11.248 };
const H = 3600000;
globalThis.localStorage = { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = v; } };

function synthRegion(fn) {
  const pts = regionGrid(C), t0 = zonedDayStart('2026-11-22', 'Europe/Rome') - 24 * H;
  const times = Array.from({ length: 96 }, (_, k) => t0 + k * H);
  const data = {};
  for (const v of VARS) data[v] = pts.map((p) => times.map((t) => fn(v, p, t)));
  return { center: C, model: 'sintetico', pts, times, data, hasProb: true };
}

// ---------- 1. Griglia e peso ----------
{
  const pts = regionGrid(C), cells = zoneCells(C);
  check('griglia meteo: 289 nodi a 5 km + 144 a 10 km = 433; peso 433 per oggi e domani (< 550 al minuto)', pts.length === 433 && requestWeight(pts.length, 4, VARS.length) === 433);
  check('celle osservatore di 2 km entro 20 km', cells.length > 300 && cells.every((c) => c.dist <= ZONE_RADIUS), `${cells.length} celle`);
  const P = projector(C), q = P.toXY(P.toLL(12345, -6789).lat, P.toLL(12345, -6789).lon);
  check('proiezione locale reversibile', Math.abs(q.x - 12345) < 1e-6 && Math.abs(q.y + 6789) < 1e-6);
}

// ---------- 2. Interpolazione bilineare esatta su un campo lineare (interno ed esterno) ----------
{
  const R = synthRegion((v, p) => (v === 'cloud_cover_low' ? 50 + p.x / 2000 - p.y / 4000 : 0));
  const s = snapshot(R, R.times[30]);
  const f = (x, y) => 50 + x / 2000 - y / 4000;
  const err = Math.max(...[[1234, -5678], [-39000, 39000], [55000, -20000], [-69000, 66000]].map(([x, y]) => Math.abs(valueXY(s, 'cloud_cover_low', x, y) - f(x, y))));
  check('bilineare esatta su campo lineare, dentro ±40 km e fino a ±70 km', err < 1e-3, `Δ=${err.toExponential(1)}`);
}

// ---------- 3. Scenario: banda di pioggia fissa a 10 km a est del centro, cielo sereno ----------
// Nel pomeriggio il Sole è a SO: l'arco si vede guardando a NE, quindi dai punti a OVEST della banda (1–20 km).
const t = zonedDayStart('2026-11-22', 'Europe/Rome') + 15 * H;
const band = (p) => p.x >= 8000 && p.x <= 12000;
const R = synthRegion((v, p) => (v === 'precipitation' ? (band(p) ? 2 : 0) : v === 'precipitation_probability' ? (band(p) ? 80 : 0) : v === 'temperature_2m' ? 10 : 0));
const cells = zoneCells(C);
{
  const sc = scanAt({ center: C, cells, region: R }, t);
  const good = cells.filter((c, k) => sc.I[k] >= 0.25), bad = cells.filter((c, k) => sc.I[k] === 0);
  const eastOfBand = cells.filter((c) => c.x > 16000);   // l'interpolazione a 4 km estende la banda fino a 16 km
  check('punti buoni in maggioranza a ovest della banda, nessuno oltre il suo bordo interpolato (16 km)', good.length > 20 && good.filter((c) => c.x < 8000).length > good.length / 2 && eastOfBand.every((c) => sc.I[cells.indexOf(c)] < 0.08),
    `${good.length} celle buone, x ${Math.min(...good.map((c) => c.x / 1000))}…${Math.max(...good.map((c) => c.x / 1000))} km`);
  check('fonte: modello', sc.src === 'modello sintetico' && bad.length > 0);
  const night = scanAt({ center: C, cells, region: R }, zonedDayStart('2026-11-22', 'Europe/Rome') + 22 * H);
  check('notte: indice zero ovunque', !night.possible && night.I.every((v) => v === 0));
}

// ---------- 4. Rilievo: un muro alto attorno a una cella toglie Sole e arco ----------
{
  const wallDem = { sample: (lat, lon) => { const P = projector(C), q = P.toXY(lat, lon); return Math.abs(q.x + 4000) < 1500 && Math.abs(q.y) < 1500 && Math.hypot(q.x + 4000, q.y) > 900 ? 3000 : 0; } };
  const cs = zoneCells(C); cellHorizons(wallDem, C, cs, 2);
  const k = cs.findIndex((c) => c.x === -4000 && c.y === 0);
  check('orizzonte di cella circondata da un muro alto: > 60°', Math.min(...cs[k].hor) > 60, `${Math.min(...cs[k].hor).toFixed(1)}°`);
  const sc = scanAt({ center: C, cells: cs, region: R }, t);
  check('cella murata: indice zero; cella vicina libera: probabile', sc.I[k] === 0 && sc.I[cs.findIndex((c) => c.x === -4000 && c.y === 6000)] >= 0.25);
}

// ---------- 5. Giornata, risposta sintetica, ordinamenti ----------
{
  const t0 = zonedDayStart('2026-11-22', 'Europe/Rome');
  const series = scanDay({ center: C, cells, region: R }, t0, t0 + 24 * H, 15);
  const v = verdict(series);
  check('risposta sintetica: probabile, una finestra diurna', v.cls.key === 'probabile' && v.windows.length === 1 && sunPosition(v.windows[0].start, C.lat, C.lon).el > -1,
    v.windows.map((w) => new Date(w.start).toISOString().slice(11, 16) + '–' + new Date(w.end).toISOString().slice(11, 16) + 'Z').join(', '));
  const bestI = rankSpots(cells, series, { mode: 'indice' });
  const near = rankSpots(cells, series, { mode: 'vicino' });
  const arco = rankSpots(cells, series, { mode: 'arco' });
  const sepOK = (L) => L.every((a, i) => L.every((b, j) => i === j || Math.hypot(a.cell.x - b.cell.x, a.cell.y - b.cell.y) >= MIN_SEP));
  check('5 punti per ordinamento, distanziati ≥ 4 km', [bestI, near, arco].every((L) => L.length === 5 && sepOK(L)));
  check('«più vicino»: distanze crescenti', near.every((p, i) => i === 0 || p.cell.dist >= near[i - 1].cell.dist), near.map((p) => (p.cell.dist / 1000).toFixed(1)).join(', ') + ' km');
  check('«arco più alto»: sommità non inferiore a quella dell\'ordinamento per indice', arco[0].top >= bestI[0].top - 1e-9, `${arco[0].top.toFixed(1)}° vs ${bestI[0].top.toFixed(1)}°`);
  check('direzione in cui guardare = antisolare', bestI.every((p) => Math.abs(((p.look - p.sun.az + 360) % 360) - 180) < 1e-9));
  const atNow = rankSpots(cells, series, { mode: 'indice', atT: t });
  check('ordinamento all\'istante del cursore', atNow.length > 0 && atNow.every((p) => Math.abs(p.t - t) <= 7.5 * 60000));
}

// ---------- 6. fetchRegion con risposta simulata ----------
{
  const fake = async (url) => {
    const q = new URL(url).searchParams, n = q.get('latitude').split(',').length;
    const times = [0, 1, 2].map((k) => 1763769600 + k * 3600);
    return { ok: true, status: 200, json: async () => Array.from({ length: n }, () => ({ hourly: { time: times, ...Object.fromEntries(VARS.map((v) => [v, times.map(() => 1)])) } })) };
  };
  const r = await fetchRegion(C, '2026-11-22', 'best_match', { fetchFn: fake, limit: false });
  check('fetchRegion: 433 punti in 3 richieste da ≤ 150, da ieri a dopodomani, contatore aggiornato', r.pts.length === 433 && r.data.precipitation.length === 433 && r.requests === 3 && r.dateFrom === '2026-11-21' && r.dateTo === '2026-11-24' && JSON.parse(localStorage.getItem('hc.calls')).n === 433);
}

{
  const R0 = synthRegion(() => 0), t0 = zonedDayStart('2026-11-22', 'Europe/Rome');
  const fakeRadar = { m: { size: 512 }, frames: [] };
  const noData = scanDay({ center: C, cells, region: null, radar: fakeRadar }, t0, t0 + 24 * H, 15);
  const v = verdict(noData);
  check('senza dati meteo: risposta «non disponibile», non «improbabile»', v.cls === null && v.unknown === true);
  const dry = verdict(scanDay({ center: C, cells, region: R0 }, t0, t0 + 24 * H, 15));
  check('con dati e senza pioggia: improbabile', dry.cls.key === 'improbabile' && dry.windows.length === 0);
}

// ---------- 7. Campo del punto ricavato dalla zona ----------
{
  const lin = (v, p) => (v === 'cloud_cover_low' ? 40 + p.x / 3000 + p.y / 5000 : v === 'precipitation_probability' ? null : 1);
  const Rl = synthRegion(lin);
  const obs = { lat: C.lat + 0.05, lon: C.lon - 0.08 };
  const f = polarFromRegion(Rl, obs), P = projector(C);
  let err = 0;
  f.pts.forEach((p, i) => { const q = P.toXY(p.lat, p.lon); if (Math.abs(q.x) < 69000 && Math.abs(q.y) < 69000) err = Math.max(err, Math.abs(f.data.cloud_cover_low[i][10] - (40 + q.x / 3000 + q.y / 5000))); });
  check('campo polare dalla zona: 217 punti, interpolazione esatta su campo lineare', f.pts.length === polarGrid(obs).length && err < 1e-6 && f.derived, `Δ=${err.toExponential(1)}`);
}

// ---------- 8. Limitatore al minuto ----------
{
  localStorage.setItem('ha.minute', JSON.stringify([[Date.now() - 59000, 500]]));
  let waited = null; const t0 = Date.now();
  await throttle(100, (s) => { waited = waited ?? s; });
  const dt = Date.now() - t0;
  check(`limitatore: 500 + 100 > ${MINUTE_CAP} → attesa fino all'uscita dalla finestra di 60 s`, waited != null && dt >= 900 && dt < 3000, `${dt} ms`);
  const t1 = Date.now(); await throttle(100); 
  check('limitatore: 100 + 100 ≤ 550 → nessuna attesa', Date.now() - t1 < 50);
}

console.log(`\n${passes} superati, ${fails} falliti`);
process.exit(fails ? 1 : 0);
