import { zonedDayStart, formatLocal } from './solar.js';
import { destination } from './geodesy.js';
import { Dem, browserTileLoader } from './dem.js';
import { parseCoords } from './coords.js';
import { fetchMeta, callCount, DAILY_LIMIT } from './weather.js';
import { PRIMARY, SECONDARY, bowPoint, descartesRadius, waterIndex, horizonHalfWidth, bowWindows } from './rainbow.js';
import { prefetchCircle, horizonCircle, horizonAtAz } from './horizon360.js';
import { fetchField, MODELS } from './rainfield.js';
import { fetchFrames, loadFrame, loadCoverage, mosaicFor, latLonToPx, meanMotion, MAX_LEAD_MIN } from './radar.js';
import { evaluate, daySeries } from './likelihood.js';
import { setupGps } from './gps.js';
import * as Log from './log.js';
import * as Zone from './zonescan.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('ha.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ha.' + k, JSON.stringify(v)); } catch {} },
};

const dem = new Dem(browserTileLoader);
const hadObs = store.get('obs', null) != null;
const S = {
  obs: store.get('obs', { lat: 43.7629, lon: 11.2650 }),
  model: store.get('model', 'best_match'),
  hag: store.get('hag', 2),
  date: null, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, elev: null,
  h0: null, hc: null, hcKey: null, field: null, fieldKey: null, fieldTime: 0, fieldErr: null,
  radar: null, radarErr: null, series: [], minute: 720, loadId: 0, t0: 0,
  mapStyle: store.get('mapStyle', 'chiara'), radarOn: store.get('radarOn', true), ev: null,
  zone: { center: store.get('zoneCenter', null), cells: null, cellsKey: null, region: null, regionKey: null, series: [], err: null },
  rank: store.get('rank', 'indice'), scope: store.get('scope', 'giorno'),
};

// ---------- utilità ----------
const norm360 = (x) => ((x % 360) + 360) % 360;
const unwrap = (a, ref) => ref + ((((a - ref) % 360) + 540) % 360) - 180;
const fmtDeg = (x, d = 1) => (x == null || !isFinite(x) ? '—' : (x >= 0 ? '' : '−') + Math.abs(x).toFixed(d) + '°');
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const status = (s) => { $('status').textContent = s; };
// spiegazione del limite Open-Meteo raggiunto (per IP: con i dati mobili l'IP è spesso condiviso tra molti utenti)
const limitHint = (m) => /Daily/i.test(m) ? `${m} — limite giornaliero per indirizzo IP: con i dati mobili l'operatore condivide lo stesso IP tra molti utenti, che consumano anche il tuo limite; riprova con il Wi-Fi o domani.`
  : /Hourly/i.test(m) ? `${m} — limite orario per indirizzo IP; riprova più tardi o con un'altra rete.`
  : /Minutely/i.test(m) ? `${m} — limite al minuto; riprova tra un minuto.` : m;
const progress = (f) => { $('bar').style.width = `${Math.round(f * 100)}%`; if (f >= 1) setTimeout(() => ($('bar').style.width = '0'), 400); };
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const card = (az) => CARD[Math.round(norm360(az) / 45) % 8];
function showCalls() {
  const n = callCount(), el = $('calls');
  el.textContent = `Chiamate Open-Meteo oggi da questo dispositivo, condivise con hyperclouds (stima): ${n} su ${DAILY_LIMIT} (il limite è per rete). Un aggiornamento completo pesa 433 (zona; il punto ne è ricavato), 217 in più per un punto fuori zona.`;
  el.classList.toggle('warn', n > 0.8 * DAILY_LIMIT);
}
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}
const tAt = (minute) => S.t0 + minute * 60000;

// ---------- controlli ----------
MODELS.forEach((m) => $('model').add(new Option(m.label, m.id, false, m.id === S.model)));
$('hag').value = S.hag;
$('model').onchange = () => { S.model = $('model').value; store.set('model', S.model); S.fieldKey = null; S.zone.regionKey = null; load({ keepMeta: true }); };
$('date').onchange = () => { S.date = $('date').value; load({ keepMeta: true }); };
$('hag').onchange = () => { S.hag = Math.max(0, +$('hag').value || 0); store.set('hag', S.hag); S.hcKey = null; load({ keepMeta: true }); };
$('reload').onclick = () => { S.fieldKey = null; S.zone.regionKey = null; load({ keepMeta: true }); };
const shiftDay = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
$('todayBtn').onclick = () => { S.date = todayIn(S.tz); load({ keepMeta: true, toNow: true }); };
$('tomorrowBtn').onclick = () => { S.date = shiftDay(todayIn(S.tz), 1); load({ keepMeta: true }); };
$('rank').value = S.rank; $('scope').value = S.scope;
$('rank').onchange = () => { S.rank = $('rank').value; store.set('rank', S.rank); renderSpots(); };
$('scope').onchange = () => { S.scope = $('scope').value; store.set('scope', S.scope); renderSpots(); };
$('recenter').onclick = () => { S.zone.center = { ...S.obs }; store.set('zoneCenter', S.zone.center); loadZone(S.loadId); };
let raf = false;
const setMinute = (m) => {
  S.minute = Math.max(0, Math.min(1439, Math.round(m)));
  $('slider').value = S.minute;
  if (!raf) { raf = true; requestAnimationFrame(() => { raf = false; renderDynamic(); }); }
};
$('slider').oninput = () => setMinute(+$('slider').value);
document.querySelectorAll('.step button').forEach((b) => { b.onclick = () => setMinute(S.minute + +b.dataset.d); });
$('nowBtn').onclick = () => {
  const today = todayIn(S.tz);
  if (S.date !== today) { S.date = today; $('date').value = today; load({ keepMeta: true, toNow: true }); }
  else setMinute((Date.now() - S.t0) / 60000);
};
$('timeline').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  setMinute(((e.clientX - r.left) / r.width) * 1440);
});
const gps = setupGps({ $, status, onPosition: (p) => setObserver(p, true) });
$('coordForm').onsubmit = (e) => {
  e.preventDefault();
  const c = parseCoords($('coordIn').value);
  if (!c || Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180) return status('Coordinate non riconosciute: usa "43.7696, 11.2558" oppure "43°46\'10"N 11°15\'21"E".');
  $('coordIn').blur();
  setObserver(c, true);
};
$('radarBtn').onclick = () => { S.radarOn = !S.radarOn; store.set('radarOn', S.radarOn); updateRadarLayer(); };
window.addEventListener('resize', () => { renderTimeline(); renderDynamic(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (S.radar && Date.now() - S.radar.loaded > 10 * 60000 && S.date === todayIn(S.tz)) loadRadar(S.loadId);
  renderTimeline(); renderDynamic();
});

// ---------- mappa ----------
const MAP_STYLES = { chiara: 'https://tiles.openfreemap.org/styles/liberty', scura: 'https://tiles.openfreemap.org/styles/dark' };
const map = new maplibregl.Map({ container: 'map', style: MAP_STYLES[S.mapStyle], center: [S.obs.lon, S.obs.lat], zoom: 9.3, attributionControl: false });
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Radar © RainViewer' }), 'bottom-right');
map.once('idle', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
let mapReady = false;
const empty = { type: 'FeatureCollection', features: [] };
map.on('style.load', () => {
  for (const id of ['zoneHeat', 'zoneEdge', 'sector', 'sun', 'anti', 'obs', 'spots']) map.addSource(id, { type: 'geojson', data: empty });
  map.addLayer({ id: 'zoneHeat', type: 'fill', source: 'zoneHeat', paint: { 'fill-color': ['step', ['get', 'I'], '#39424f', 0.08, '#f5a524', 0.25, '#57d68d'], 'fill-opacity': ['case', ['<', ['get', 'I'], 0.02], 0, ['min', 0.6, ['+', 0.25, ['get', 'I']]]] } });
  map.addLayer({ id: 'zoneEdge', type: 'line', source: 'zoneEdge', paint: { 'line-color': '#c77dff', 'line-width': 1.2, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'sector', type: 'fill', source: 'sector', paint: { 'fill-color': '#7cc4ff', 'fill-opacity': 0.22 } });
  map.addLayer({ id: 'sectorEdge', type: 'line', source: 'sector', paint: { 'line-color': '#7cc4ff', 'line-width': 1, 'line-opacity': 0.7 } });
  map.addLayer({ id: 'sun', type: 'line', source: 'sun', paint: { 'line-color': '#f5a524', 'line-width': 2.5 } });
  map.addLayer({ id: 'anti', type: 'line', source: 'anti', paint: { 'line-color': '#c77dff', 'line-width': 2.5, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'obs', type: 'circle', source: 'obs', paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'spots', type: 'symbol', source: 'spots', layout: { 'text-field': ['get', 'n'], 'text-size': 13, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true }, paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 } });
  mapReady = true;
  updateRadarLayer();
  renderMap();
});
map.on('click', (e) => setObserver({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
$('mapStyle').onclick = () => {
  S.mapStyle = S.mapStyle === 'chiara' ? 'scura' : 'chiara'; store.set('mapStyle', S.mapStyle);
  mapReady = false; map.setStyle(MAP_STYLES[S.mapStyle]);
};

function lineFeature(az, d) {
  const a = destination(S.obs.lat, S.obs.lon, d, az);
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: [[S.obs.lon, S.obs.lat], [a.lon, a.lat]] } };
}
function renderMap() {
  if (!mapReady) return;
  map.getSource('obs').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [S.obs.lon, S.obs.lat] } });
  renderZoneMap();
  const ev = S.ev;
  if (!ev || !ev.sunUp) { for (const id of ['sector', 'sun', 'anti']) map.getSource(id).setData(empty); return; }
  map.getSource('sun').setData(lineFeature(ev.sun.az, 25000));
  map.getSource('anti').setData(lineFeature(ev.anti.az, 25000));
  const dirs = (ev.dirs || []).map((d) => ({ ...d, u: unwrap(d.az, ev.anti.az) })).sort((a, b) => a.u - b.u);
  if (dirs.length < 2) { map.getSource('sector').setData(empty); return; }
  const outer = dirs.map((d) => destination(S.obs.lat, S.obs.lon, d.dMax, d.u));
  const inner = dirs.slice().reverse().map((d) => destination(S.obs.lat, S.obs.lon, 1000, d.u));
  const ring = [...outer, ...inner, outer[0]].map((p) => [p.lon, p.lat]);
  map.getSource('sector').setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } });
}

function radarFrameFor(t) {
  const fr = S.radar?.frames;
  if (!fr?.length) return null;
  const f = fr.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  return Math.abs(f.t - t) <= 15 * 60000 ? f : fr[fr.length - 1];
}
let radarPath = null;
function updateRadarLayer() {
  $('radarBtn').style.color = S.radarOn ? 'var(--blue)' : 'var(--muted)';
  if (!mapReady) return;
  const f = S.radarOn && S.radar ? radarFrameFor(S.ev?.t ?? Date.now()) : null;
  const path = f ? f.path : null;
  if (path === radarPath && (!path || map.getLayer('radar'))) return;
  if (map.getLayer('radar')) map.removeLayer('radar');
  if (map.getSource('radar')) map.removeSource('radar');
  radarPath = path;
  if (!path) return;
  map.addSource('radar', { type: 'raster', tiles: [`${S.radar.host}${path}/256/{z}/{x}/{y}/2/1_0.png`], tileSize: 256, maxzoom: 7 });
  map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.6 } }, 'sector');
}

// ---------- osservatore e caricamento ----------
function setObserver(c, recenter = false) {
  S.obs = { lat: +c.lat.toFixed(5), lon: +c.lon.toFixed(5) };
  store.set('obs', S.obs);
  if (recenter) { S.zone.center = { ...S.obs }; store.set('zoneCenter', S.zone.center); }
  map.easeTo({ center: [S.obs.lon, S.obs.lat] });
  load({ recenter });
}

async function load({ keepMeta = false, toNow = false, recenter = false } = {}) {
  const id = ++S.loadId;
  $('coords').textContent = `${S.obs.lat.toFixed(4)}, ${S.obs.lon.toFixed(4)}`;
  if (!keepMeta || S.elev == null) {
    try { const m = await fetchMeta(S.obs.lat, S.obs.lon); if (id !== S.loadId) return; S.tz = m.tz; S.elev = m.elevation; }
    catch (e) { status(`Fuso orario e quota non disponibili (${e.message}): uso il fuso del dispositivo.`); }
  }
  if (!S.date) { S.date = todayIn(S.tz); toNow = true; }
  $('date').value = S.date;
  S.t0 = zonedDayStart(S.date, S.tz);
  if (toNow && S.date === todayIn(S.tz)) S.minute = Math.round((Date.now() - S.t0) / 60000);
  $('slider').value = S.minute;

  // terreno su 360°
  const key = `${S.obs.lat},${S.obs.lon},${S.hag}`;
  if (S.hcKey !== key) {
    S.hc = null;
    status('Terreno: scarico il modello digitale su 360° (100 km)…');
    await prefetchCircle(dem, S.obs, { onProgress: (a, b) => progress(a / b) });
    if (id !== S.loadId) return;
    const g = await dem.elevation(S.obs.lat, S.obs.lon, 13);
    S.h0 = (g ?? S.elev ?? 0) + S.hag;
    S.hc = horizonCircle(dem, S.obs, S.h0);
    S.hcKey = key;
    if (S.hc.missing) status(`Terreno incompleto: ${S.hc.missing} campioni senza dati (${dem.lastError || 'rete'}).`);
  }
  progress(1);
  recompute();
  if (!S.zone.center) { S.zone.center = { ...S.obs }; store.set('zoneCenter', S.zone.center); }
  // prima la zona: se il punto vi rientra, il suo campo si ricava da lì senza un'altra richiesta (limite di 600 al minuto)
  await Promise.all([loadZone(id).then(() => loadWeather(id)), S.date === todayIn(S.tz) ? loadRadar(id) : (S.radar = null)]);
}

// ---------- zona entro 20 km ----------
async function loadZone(id) {
  const Z = S.zone, c = Z.center;
  const ckey = `${c.lat},${c.lon},${S.hag}`;
  try {
    if (Z.cellsKey !== ckey) {
      Z.cells = null; Z.series = []; renderZone();
      $('zoneInfo').textContent = 'terreno della zona…';
      await dem.prefetch(Zone.demPoints(c));
      if (id !== S.loadId) return;
      Z.cells = Zone.cellHorizons(dem, c, Zone.zoneCells(c), S.hag);
      Z.cellsKey = ckey;
    }
    const inRange = Z.region && S.date > Z.region.dateFrom && S.date < Z.region.dateTo;
    const rkey = `${c.lat},${c.lon},${S.model}`;
    if (!(Z.regionKey === rkey && inRange && Date.now() - Z.regionTime < 3 * 3600000)) {
      $('zoneInfo').textContent = 'meteo della zona (433 punti)…';
      Z.region = await Zone.fetchRegion(c, S.date, S.model, { onWait: (s) => { $('zoneInfo').textContent = `attendo ${s} s (limite al minuto)…`; } });
      if (id !== S.loadId) return;
      Z.regionKey = rkey; Z.regionTime = Date.now(); Z.err = null;
      showCalls();
    }
  } catch (e) {
    if (id !== S.loadId) return;
    Z.err = limitHint(e.message); Z.region = Z.regionKey ? Z.region : null;
  }
  rescanZone();
}
function rescanZone() {
  const Z = S.zone;
  if (!Z.cells) return;
  const ok = Z.region && S.date > Z.region.dateFrom && S.date < Z.region.dateTo;
  Z.series = Zone.scanDay({ center: Z.center, cells: Z.cells, region: ok ? Z.region : null, radar: S.date === todayIn(S.tz) ? S.radar : null }, S.t0, S.t0 + 86400000, 15);
  renderZone();
}
const ZONE_WORD = { probabile: 'PROBABILI', possibile: 'POSSIBILI, con riserva', improbabile: 'IMPROBABILI' };
function renderZone() {
  const Z = S.zone, box = $('answer');
  const day = S.date === todayIn(S.tz) ? 'oggi' : S.date === shiftDay(todayIn(S.tz), 1) ? 'domani' : S.date;
  if (!Z.cells) { $('answerText').textContent = 'Calcolo in corso…'; box.className = 'panel'; return; }
  const v = Zone.verdict(Z.series);
  if (!v.cls || (!v.best && !v.unknown && !Z.series.some((x) => x.possible))) {
    if (v.cls) { $('answerText').textContent = `${day}: arcobaleno geometricamente impossibile (Sole sempre sotto l'orizzonte o troppo alto).`; box.className = 'panel'; }
    else $('answerText').textContent = `${day}: ` + (Z.err ? `meteo della zona non disponibile (${Z.err}).` : 'meteo della zona in caricamento…');
    box.className = 'panel';
  } else {
    const best = Zone.rankSpots(Z.cells, Z.series, { mode: 'indice', n: 1 })[0];
    const win = v.windows.map((w) => `${formatLocal(w.start, S.tz)}–${formatLocal(w.end, S.tz)}`).join(', ');
    $('answerText').textContent = `${day}: ${ZONE_WORD[v.cls.key]}` + (win ? ` · ${win}` : '') +
      (best && v.cls.key !== 'improbabile' ? `\nmigliore: ${(best.cell.dist / 1000).toFixed(0)} km ${card(best.cell.az)} alle ${formatLocal(best.t, S.tz)} (indice ${best.I.toFixed(2)})` : '');
    box.className = 'panel ' + v.cls.key;
  }
  const src = [...new Set(Z.series.map((s) => s.src).filter(Boolean))].join(', ');
  $('zoneInfo').textContent = `centro ${Z.center.lat.toFixed(3)}, ${Z.center.lon.toFixed(3)}${src ? ' · ' + src : ''}`;
  renderSpots();
  renderTimeline();
  renderZoneMap();
}
let spotList = [];
function renderSpots() {
  const Z = S.zone;
  if (!Z.cells || !Z.series.length) { $('spots').replaceChildren(); spotList = []; renderZoneMap(); return; }
  spotList = Zone.rankSpots(Z.cells, Z.series, { mode: S.rank, atT: S.scope === 'cursore' ? tAt(S.minute) : null });
  if (!spotList.length) { $('spots').textContent = 'Nessun punto con indice almeno «possibile».'; renderZoneMap(); return; }
  $('spots').replaceChildren(...spotList.map((p, i) => {
    const d = document.createElement('div');
    d.innerHTML = `<b>${i + 1}.</b> ${(p.cell.dist / 1000).toFixed(0)} km ${card(p.cell.az)} · <b>${formatLocal(p.t, S.tz)}</b> (finestra ${formatLocal(p.from, S.tz)}–${formatLocal(p.to, S.tz)}) · guarda a ${Math.round(p.look)}° ${card(p.look)} · sommità ${p.top.toFixed(0)}° · indice <b>${p.I.toFixed(2)}</b>`;
    d.onclick = () => {
      S.minute = Math.round((p.t - S.t0) / 60000); $('slider').value = S.minute;
      setObserver({ lat: p.cell.lat, lon: p.cell.lon });
    };
    return d;
  }));
  renderZoneMap();
}
function renderZoneMap() {
  if (!mapReady) return;
  const Z = S.zone;
  if (!Z.cells || !Z.center) { for (const id of ['zoneHeat', 'zoneEdge', 'spots']) map.getSource(id).setData(empty); return; }
  const P = Zone.projector(Z.center), h = Zone.CELL / 2;
  const step = Z.series.length ? Z.series.reduce((a, b) => (Math.abs(b.t - tAt(S.minute)) < Math.abs(a.t - tAt(S.minute)) ? b : a)) : null;
  map.getSource('zoneHeat').setData({ type: 'FeatureCollection', features: Z.cells.map((c, k) => {
    const q = [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([dx, dy]) => { const ll = P.toLL(c.x + dx, c.y + dy); return [ll.lon, ll.lat]; });
    const I = step ? step.I[k] : NaN;
    return { type: 'Feature', properties: { I: isNaN(I) ? 0 : I }, geometry: { type: 'Polygon', coordinates: [q] } };
  }) });
  const ring = []; for (let a = 0; a <= 360; a += 6) { const d = destination(Z.center.lat, Z.center.lon, Zone.ZONE_RADIUS, a); ring.push([d.lon, d.lat]); }
  map.getSource('zoneEdge').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring } });
  map.getSource('spots').setData({ type: 'FeatureCollection', features: spotList.map((p, i) => ({ type: 'Feature', properties: { n: String(i + 1) }, geometry: { type: 'Point', coordinates: [p.cell.lon, p.cell.lat] } })) });
}

async function loadWeather(id, force = false) {
  const key = `${S.obs.lat},${S.obs.lon},${S.date},${S.model}`;
  if (!force && S.fieldKey === key && Date.now() - S.fieldTime < 30 * 60000) return;
  const Z = S.zone;
  const inZone = Z.region && Z.center && S.date > Z.region.dateFrom && S.date < Z.region.dateTo &&
    Math.hypot(...Object.values(Zone.projector(Z.center).toXY(S.obs.lat, S.obs.lon))) <= 25000;
  if (inZone && !force) {
    S.field = Zone.polarFromRegion(Z.region, S.obs); S.fieldKey = key; S.fieldTime = Z.regionTime; S.fieldErr = null;
    status(`Meteo: previsione, modello ${S.field.model}, ${S.field.note}.`);
    recompute();
    return;
  }
  status('Meteo: griglia di 217 punti attorno a te (Open-Meteo)…');
  try {
    const f = await fetchField(S.obs, S.date, S.model, { onWait: (s) => status(`Attendo ${s} s: limite Open-Meteo di 600 chiamate al minuto…`) });
    if (id !== S.loadId) return;
    S.field = f; S.fieldKey = key; S.fieldTime = Date.now(); S.fieldErr = null;
    status(`Meteo: ${f.host}, modello ${f.model}${f.hasProb ? '' : ' (senza probabilità: si usa la quantità)'}${f.note ? ' · ' + f.note : ''}.`);
  } catch (e) {
    if (id !== S.loadId) return;
    S.field = null; S.fieldErr = limitHint(e.message);
    status(`Meteo non disponibile: ${limitHint(e.message)} Restano geometria e terreno.`);
  }
  showCalls();
  recompute();
}

async function loadRadar(id) {
  try {
    const fr = await fetchFrames();
    const m = mosaicFor(S.obs);
    const recent = fr.past.slice(-4);
    const frames = [];
    for (const f of recent) frames.push({ ...(await loadFrame(fr.host, f, m)), path: f.path });
    const coverage = await loadCoverage(fr.host, m).catch(() => null);
    if (id !== S.loadId) return;
    const c = latLonToPx(m, S.obs.lat, S.obs.lon);
    const motion = meanMotion(frames, m.size, { cx: Math.round(c.px), cy: Math.round(c.py), win: 120 });
    S.radar = { host: fr.host, m, frames, coverage, motion, loaded: Date.now() };
    S.radarErr = null;
    const age = Math.round((Date.now() - frames.at(-1).t) / 60000);
    const v = motion ? Math.hypot(motion.vx, motion.vy) * 3600000 * 0.88 : null;
    $('radarAge').textContent = `· radar di ${age} min fa${v != null ? `, moto ${v.toFixed(0)} km/h` : ''}`;
  } catch (e) {
    S.radar = null; S.radarErr = e.message;
    $('radarAge').textContent = `· radar non disponibile (${e.message})`;
  }
  updateRadarLayer();
  recompute();
  rescanZone();
}

const ctx = () => ({ obs: S.obs, h0: S.h0, hc: S.hc, field: S.field, radar: S.radar, step: 3 });

function recompute() {
  if (!S.hc) return;
  S.series = daySeries(ctx(), S.t0, S.t0 + 86400000, 10);
  const w = bowWindows(S.t0, S.t0 + 86400000, S.obs.lat, S.obs.lon, PRIMARY.outer);
  $('dayInfo').textContent = w.length ? 'primario possibile ' + w.map((x) => `${formatLocal(x.start, S.tz)}–${formatLocal(x.end, S.tz)}`).join(', ') : 'primario impossibile oggi';
  renderTimeline();
  renderDynamic();
}

// ---------- barra della giornata ----------
const CLS_COLOR = { probabile: '#57d68d', possibile: '#f5a524', improbabile: '#39424f' };
function renderTimeline() {
  const c = $('timeline');
  const { ctx: g, w, h } = setupCanvas(c);
  g.clearRect(0, 0, w, h);
  const x = (min) => (min / 1440) * w;
  const rows = [[2, 16], [20, 12], [34, 24], [62, 14]];
  g.fillStyle = '#0d121a'; for (const [y, hh] of rows) g.fillRect(0, y, w, hh);
  for (const e of S.series) {
    const m = (e.t - S.t0) / 60000, x0 = x(m), x1 = x(m + 10) + 0.5;
    if (e.geo.primary) g.fillStyle = '#3b4a63'; else if (e.geo.secondary) g.fillStyle = '#2a3346'; else continue;
    g.fillRect(x0, rows[0][0], x1 - x0, rows[0][1]);
    if (!e.sunClearOfTerrain || (e.geo.primary && !e.possibleVisible)) { g.fillStyle = '#5a2f33'; g.fillRect(x0, rows[1][0], x1 - x0, rows[1][1]); }
    else if (e.geo.primary) { g.fillStyle = '#26303f'; g.fillRect(x0, rows[1][0], x1 - x0, rows[1][1]); }
    if (e.geo.primary && e.I != null && e.cls) {
      g.fillStyle = CLS_COLOR[e.cls.key];
      const hh = Math.max(2, rows[2][1] * Math.min(1, e.I / 0.5));
      g.fillRect(x0, rows[2][0] + rows[2][1] - hh, x1 - x0, hh);
      if (e.source?.startsWith('radar')) { g.fillStyle = '#7cc4ff'; g.fillRect(x0, rows[2][0] + rows[2][1] - 2, x1 - x0, 2); }
    }
  }
  for (const z of Zone.zoneMax(S.zone.series)) {
    if (z.max == null || z.max < 0.02) continue;
    const m = (z.t - S.t0) / 60000;
    g.fillStyle = CLS_COLOR[z.max >= 0.25 ? 'probabile' : z.max >= 0.08 ? 'possibile' : 'improbabile'];
    const hh = Math.max(2, rows[3][1] * Math.min(1, z.max / 0.5));
    g.fillRect(x(m), rows[3][0] + rows[3][1] - hh, x(m + 15) - x(m) + 0.5, hh);
  }
  g.fillStyle = '#8b98a8'; g.font = '9px ui-monospace, monospace'; g.textAlign = 'center';
  for (let hr = 0; hr <= 24; hr += 3) { g.fillRect(x(hr * 60), 78, 1, 4); if (hr > 0 && hr < 24) g.fillText(String(hr), x(hr * 60), 92); }
  g.textAlign = 'left'; g.fillStyle = '#6b7788';
  g.fillText('geometria', 3, 13); g.fillText('rilievo', 3, 29); g.fillText('indice', 3, 46); g.fillText('zona', 3, 72);
  if (S.date === todayIn(S.tz)) { const n = (Date.now() - S.t0) / 60000; g.fillStyle = '#e6edf3'; g.fillRect(x(n), 0, 1, 78); }
  g.fillStyle = '#f5a524'; g.fillRect(x(S.minute) - 1, 0, 2, 80);
}

// ---------- istante corrente ----------
function renderDynamic() {
  if (!S.hc) return;
  const t = tAt(S.minute);
  const ev = evaluate(ctx(), t);
  S.ev = ev;
  $('tTime').textContent = formatLocal(t, S.tz);
  $('tSun').textContent = `${fmtDeg(ev.sun.az, 0)} ${fmtDeg(ev.sun.el)}`;
  $('tAnti').textContent = `${fmtDeg(ev.anti.az, 0)} ${card(ev.anti.az)}`;
  $('tTop').textContent = ev.geo.primary ? fmtDeg(PRIMARY.outer - ev.sun.el) : '—';
  const lines = [];
  if (!ev.sunUp) lines.push('Sole sotto l\'orizzonte: nessun arcobaleno.');
  else if (!ev.geo.primary) lines.push(`Sole a ${fmtDeg(ev.sun.el)}: il primario è sotto l'orizzonte (serve < ${PRIMARY.outer.toFixed(1)}°)` + (ev.geo.secondary ? '; il secondario sporgerebbe (rarissimo da solo).' : '.'));
  else {
    const hw = horizonHalfWidth(ev.sun.el, PRIMARY.outer);
    lines.push(`Geometria: primario possibile, sommità ${fmtDeg(PRIMARY.outer - ev.sun.el)}, base sull'orizzonte a ${fmtDeg(norm360(ev.anti.az - hw), 0)}–${fmtDeg(norm360(ev.anti.az + hw), 0)}${ev.geo.secondary ? `; secondario sommità ${fmtDeg(SECONDARY.outer - ev.sun.el)}` : ''}.`);
    lines.push(`Terreno: ${pct(ev.skyFraction)} dell'arco con cielo dietro, ${pct(ev.frontFraction)} davanti a rilievi${!ev.sunClearOfTerrain ? '; Sole dietro il rilievo (orizzonte ' + fmtDeg(ev.sunTerrain) + ')' : ''}.`);
    if (ev.S == null && !S.field) lines.push(`Meteo: ${S.fieldErr ? 'non disponibile (' + S.fieldErr + ')' : 'in caricamento'}.`);
    else lines.push(`Sole libero S ${pct(ev.S)} · cielo libero sopra di te O ${pct(ev.O)} · pioggia nel settore R ${pct(ev.R)} (${ev.source || '—'}).`);
    lines.push(ev.I == null ? 'Indice non calcolabile: mancano i dati meteo.' : `Indice ${ev.I.toFixed(2)}: ${ev.cls.label.toUpperCase()} (euristico, non tarato).`);
  }
  if (S.radar && t > S.radar.frames.at(-1).t + 5 * 60000 && t - S.radar.frames.at(-1).t <= MAX_LEAD_MIN * 60000 && S.radar.motion)
    lines.push(`Radar estrapolato a +${Math.round((t - S.radar.frames.at(-1).t) / 60000)} min (sperimentale).`);
  $('verdict').textContent = lines.join('\n');
  $('verdict').className = ev.geo.primary && ev.cls ? ev.cls.key : '';
  renderPano(ev);
  renderMap();
  updateRadarLayer();
  renderTimelineCursor();
}
let lastCursor = -1;
function renderTimelineCursor() { if (lastCursor !== S.minute) { lastCursor = S.minute; renderTimeline(); if (S.scope === 'cursore') renderSpots(); else renderZoneMap(); } }

// ---------- panorama ----------
const LAMBDAS = [400, 440, 480, 520, 560, 600, 640, 680, 700];
function wlColor(nm, a) {
  // approssimazione percettiva dello spettro (per il disegno; nessun contenuto fisico)
  const stops = [[400, [122, 77, 255]], [450, [60, 90, 255]], [490, [0, 190, 255]], [520, [40, 220, 90]], [570, [250, 240, 40]], [600, [255, 160, 30]], [650, [255, 60, 50]], [700, [220, 30, 40]]];
  let i = stops.findIndex((s) => s[0] >= nm); if (i <= 0) i = 1;
  const [l0, c0] = stops[i - 1], [l1, c1] = stops[i], f = Math.max(0, Math.min(1, (nm - l0) / (l1 - l0)));
  return `rgba(${c0.map((v, k) => Math.round(v + (c1[k] - v) * f)).join(',')},${a})`;
}
function renderPano(ev) {
  const c = $('pano');
  const { ctx: g, w, h } = setupCanvas(c);
  const ac = ev.anti.az, span = 70;
  const elMin = -6, elMax = Math.min(62, Math.max(14, (ev.geo.secondary ? SECONDARY.outer : PRIMARY.outer) - ev.sun.el + 4));
  const X = (az) => ((unwrap(az, ac) - (ac - span)) / (2 * span)) * w;
  const Y = (el) => h - 16 - ((el - elMin) / (elMax - elMin)) * (h - 22);
  const sky = g.createLinearGradient(0, Y(elMax), 0, Y(0));
  sky.addColorStop(0, '#0f1b2d'); sky.addColorStop(1, ev.sunUp ? '#2a3f5c' : '#0b0f14');
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  $('panoInfo').textContent = `${fmtDeg(norm360(ac - span), 0)}–${fmtDeg(norm360(ac + span), 0)}, centro antisolare ${fmtDeg(ac, 0)}`;

  const alpha = ev.geo.primary ? (ev.I == null ? 0.7 : 0.45 + 0.55 * Math.min(1, ev.I / 0.25)) : 0.25;
  const curve = (rho) => { const pts = []; for (let th = -180; th <= 180; th += 1) pts.push(bowPoint(ev.anti, rho, th)); return pts; };
  const path = (pts, move = true) => { pts.forEach((p, i) => (i === 0 && move ? g.moveTo(X(p.az), Y(p.el)) : g.lineTo(X(p.az), Y(p.el)))); };
  if (ev.sunUp) {
    // banda di Alexander: tra il bordo esterno del primario e quello interno del secondario
    const outerP = curve(PRIMARY.outer).filter((p) => p.el > elMin - 5), innerS = curve(SECONDARY.inner).filter((p) => p.el > elMin - 5);
    if (outerP.length > 2 && innerS.length > 2) {
      g.beginPath(); path(outerP); path(innerS.slice().reverse(), false); g.closePath();
      g.fillStyle = 'rgba(0,0,0,0.28)'; g.fill();
    }
    for (const [k, a] of [[2, alpha * 0.55], [1, alpha]]) {
      for (const nm of LAMBDAS) {
        const rho = descartesRadius(waterIndex(nm), k);
        const pts = curve(rho).filter((p) => p.el > elMin - 5);
        if (pts.length < 2) continue;
        g.beginPath(); path(pts);
        g.strokeStyle = wlColor(nm, a); g.lineWidth = Math.max(1.5, (Y(0) - Y(0.25 * (k === 1 ? 1 : 1.8)))); g.stroke();
      }
    }
  }
  // terreno reale
  g.beginPath(); g.moveTo(0, h);
  for (let px = 0; px <= w; px += 2) { const az = ac - span + (px / w) * 2 * span; g.lineTo(px, Y(Math.max(elMin, horizonAtAz(S.hc, az)))); }
  g.lineTo(w, h); g.closePath(); g.fillStyle = 'rgba(14,18,24,0.88)'; g.fill();
  g.strokeStyle = '#6b7788'; g.lineWidth = 1; g.stroke();
  g.setLineDash([3, 4]); g.strokeStyle = 'rgba(139,152,168,.5)'; g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(w, Y(0)); g.stroke(); g.setLineDash([]);
  // pioggia stimata per direzione
  for (const d of ev.dirs || []) {
    if (d.p == null) continue;
    g.fillStyle = `rgba(124,196,255,${0.15 + 0.85 * d.p})`;
    g.fillRect(X(d.az) - 3, h - 19, 6, 4);
  }
  // antisolare e assi
  g.fillStyle = '#c77dff'; g.font = '10px ui-monospace, monospace'; g.textAlign = 'center';
  const ya = Y(Math.max(elMin + 0.5, ev.anti.el));
  g.beginPath(); g.arc(X(ac), ya, 3, 0, 2 * Math.PI); g.fill();
  if (ev.anti.el < elMin) g.fillText(`antisolare ${fmtDeg(ev.anti.el)} ↓`, X(ac), ya - 6);
  g.fillStyle = '#8b98a8';
  for (let a = Math.ceil((ac - span) / 10) * 10; a <= ac + span; a += 10) {
    const xx = X(a); g.fillRect(xx, h - 8, 1, 3);
    const n = norm360(a);
    g.fillText(n % 45 === 0 ? card(n) : String(n), xx, h - 1);
  }
  g.textAlign = 'left';
  for (let e = 0; e <= elMax; e += 10) if (e > 0) g.fillText(`${e}°`, 2, Y(e) + 3);
}

// ---------- registro ----------
let logList = Log.load();
const toLocalInput = (ms) => { const d = new Date(ms + new Date(ms).getTimezoneOffset() * -60000); return d.toISOString().slice(0, 16); };
$('lgT').value = toLocalInput(Date.now());
$('lgUseSlider').onclick = () => { $('lgT').value = toLocalInput(tAt(S.minute)); };
$('logForm').onsubmit = (e) => {
  e.preventDefault();
  const t = Date.parse($('lgT').value);
  if (isNaN(t)) { $('lgMsg').textContent = 'istante non valido'; return; }
  const ev = S.hc ? evaluate(ctx(), t) : null;
  const entry = Log.makeEntry({
    t, lat: S.obs.lat, lon: S.obs.lon, esito: document.querySelector('input[name=esito]:checked').value,
    primario: $('lgP').checked, secondario: $('lgS').checked, completezza: $('lgC').value, qualita: $('lgQ').value, note: $('lgN').value,
  }, ev, { modello: S.field?.model ?? null });
  const errs = Log.validate(entry);
  if (errs.length) { $('lgMsg').textContent = 'campi non validi: ' + errs.join(', '); return; }
  logList = Log.merge(logList, [entry]).list; Log.save(logList);
  $('lgMsg').textContent = `salvata (indice ${entry.I ?? '—'})`; $('lgN').value = '';
  renderLog();
};
function renderLog() {
  const box = $('logList');
  box.replaceChildren(...logList.slice().reverse().map((e) => {
    const d = document.createElement('div');
    const txt = document.createElement('span');
    txt.textContent = `${e.t.slice(0, 16).replace('T', ' ')}Z ${e.esito === 'visto' ? '✓' : '✗'} ${e.primario ? 'I' : ''}${e.secondario ? 'II' : ''} I=${e.I ?? '—'} ${e.classe ?? ''} ${e.note ? '· ' + e.note : ''}`;
    const del = document.createElement('button'); del.textContent = 'elimina';
    del.onclick = () => { if (confirm('Eliminare questa osservazione?')) { logList = logList.filter((x) => x.id !== e.id); Log.save(logList); renderLog(); } };
    d.append(txt, del); return d;
  }));
  const s = Log.summary(logList), keys = Object.keys(s);
  $('logSum').innerHTML = keys.length ? `<table class="sum"><tr><th>classe indice</th><th>visti</th><th>non visti</th></tr>${keys.map((k) => `<tr><td>${k}</td><td>${s[k].visti}</td><td>${s[k].non}</td></tr>`).join('')}</table>` : '';
}
const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
$('lgJson').onclick = () => download(`arcoiris-registro-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(logList, null, 1), 'application/json');
$('lgCsv').onclick = () => download(`arcoiris-registro-${new Date().toISOString().slice(0, 10)}.csv`, Log.toCSV(logList), 'text/csv');
$('lgImport').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const inc = JSON.parse(await f.text());
    const r = Log.merge(logList, Array.isArray(inc) ? inc : []);
    logList = r.list; Log.save(logList); renderLog();
    $('lgMsg').textContent = `importate ${r.added}, scartate ${r.skipped}`;
  } catch (err) { $('lgMsg').textContent = `file non valido (${err.message})`; }
  e.target.value = '';
};
renderLog();

// ---------- avvio ----------
showCalls();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
// primo avvio: si attende il GPS (o il suo rifiuto) prima di scaricare, per non pagare due volte la zona
if (hadObs) load({ toNow: true });
else gps.locatePhone(true, () => load({ toNow: true }));
setInterval(() => { if (!document.hidden && S.radar && S.date === todayIn(S.tz) && Date.now() - S.radar.loaded > 10 * 60000) loadRadar(S.loadId); }, 60000);
