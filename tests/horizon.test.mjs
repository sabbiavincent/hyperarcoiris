// Fase 2: orizzonte circolare e arco contro il terreno. DEM sintetici con soluzione analitica + caso reale.

import { PNG } from 'pngjs';
import { horizonCircle, horizonAtAz, terrainHitDistance, bowAgainstTerrain, prefetchCircle, sunAboveTerrain } from '../js/horizon360.js';
import { sampleBow, PRIMARY } from '../js/rainbow.js';
import { elevationAngle, EARTH_R } from '../js/geodesy.js';
import { Dem, TERRARIUM_URL } from '../js/dem.js';

let fails = 0, passes = 0;
const check = (name, ok, info = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${info}`); };
const D2R = Math.PI / 180;
const obs = { lat: 43.7629, lon: 11.265 };

// distanza e azimut dall'osservatore (sfera)
function distAz(lat, lon) {
  const p1 = obs.lat * D2R, p2 = lat * D2R, dl = (lon - obs.lon) * D2R;
  const d = 2 * EARTH_R * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2));
  const az = (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / D2R + 360) % 360;
  return { d, az };
}
const synth = (fn) => ({ sample: (lat, lon) => { const { d, az } = distAz(lat, lon); return fn(d, az); } });

// ---------- 1. Pianura al livello del mare ----------
{
  const hc = horizonCircle(synth(() => 0), obs, 0, { maxDist: 30000 });
  const ref = elevationAngle(500, 0, 0);
  const err = Math.max(...hc.horizon.map((h) => Math.abs(h - ref)));
  check('pianura: orizzonte = depressione del primo campione (500 m)', err < 1e-9, `${ref.toFixed(5)}°`);
  check('pianura: nessuna linea di vista a el ≥ 0 incontra il terreno', terrainHitDistance(hc, 123, 0) === null);
}

// ---------- 2. Muro circolare alto 500 m tra 5,0 e 5,2 km ----------
{
  const hc = horizonCircle(synth((d) => (d >= 4990 && d <= 5210 ? 500 : 0)), obs, 0, { maxDist: 30000 });
  const ref = elevationAngle(4990, 0, 500);
  const err = Math.max(...hc.horizon.map((h) => Math.abs(h - ref)));
  check('muro: orizzonte = angolo del bordo vicino del muro', err < 0.02, `${hc.horizon[0].toFixed(3)}° vs ${ref.toFixed(3)}°`);
  const dHit = terrainHitDistance(hc, 77, 2);
  check('muro: linea di vista a 2° incontra il terreno a ~5 km; a 6° no', Math.abs(dHit - 5000) <= 100 && terrainHitDistance(hc, 77, 6) === null, `${dHit} m`);
  check('interpolazione circolare attraverso 0°', Math.abs(horizonAtAz(hc, 359.5) - ref) < 0.02);
}

// ---------- 3. Arco con metà sfondo bloccata da una parete alta (azimut > 180°) ----------
{
  const hc = horizonCircle(synth((d, az) => (az > 180 && d >= 3000 && d <= 3200 ? 20000 : 0)), obs, 0, { maxDist: 20000 });
  const bow = sampleBow({ az: 180, el: -10 }, PRIMARY.mid, () => 0, 0.5);
  const r = bowAgainstTerrain(hc, bow);
  check('metà arco davanti alla parete: cielo ≈ 0,5, davanti al terreno ≈ 0,5', Math.abs(r.skyFraction - 0.5) < 0.02 && Math.abs(r.frontFraction - 0.5) < 0.02,
    `cielo ${r.skyFraction.toFixed(3)}, terreno ${r.frontFraction.toFixed(3)}`);
  const close = bowAgainstTerrain(hc, bow, 5000);
  check('parete a 3 km con cammino minimo di pioggia 5 km: tratto davanti al terreno escluso', close.frontFraction === 0);
  check('Sole dietro la parete non è sopra il terreno', !sunAboveTerrain(hc, { az: 250, el: 30 }) && sunAboveTerrain(hc, { az: 100, el: 1 }));
}

// ---------- 4. Caso reale: Firenze, settore di Monte Morello (NNO) ----------
{
  const loader = async (z, x, y) => {
    const r = await fetch(TERRARIUM_URL(z, x, y));
    if (!r.ok) throw new Error(r.status);
    const p = PNG.sync.read(Buffer.from(await r.arrayBuffer()));
    return { width: p.width, height: p.height, data: p.data };
  };
  const dem = new Dem(loader, { concurrency: 16 });
  const t0 = Date.now();
  await prefetchCircle(dem, obs, { maxDist: 100000 });
  const h0 = (await dem.elevation(obs.lat, obs.lon, 13)) + 2;
  const hc = horizonCircle(dem, obs, h0, { maxDist: 100000 });
  let best = { h: -90 };
  for (let az = 340; az <= 359; az++) if (hc.horizon[az] > best.h) {
    const ray = hc.rays[az], pk = ray.reduce((a, b) => (b.ang > a.ang ? b : a));
    best = { h: hc.horizon[az], az, d: pk.d, z: pk.h };
  }
  check('360° fino a 100 km senza tile mancanti', hc.missing === 0, `${dem.tiles.size} tile, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check('settore NNO: massimo su Monte Morello (quota 800–950 m, 10–15 km)', best.z > 800 && best.z < 950 && best.d > 10000 && best.d < 15000,
    `az ${best.az}°, ${best.h.toFixed(2)}°, ${(best.d / 1000).toFixed(1)} km, ${best.z.toFixed(0)} m`);
}

console.log(`\n${passes} superati, ${fails} falliti`);
process.exit(fails ? 1 : 0);
