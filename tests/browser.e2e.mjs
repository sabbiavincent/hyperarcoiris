// Test nel browser (Chrome) con emulazione di un telefono Pixel 7 e GPS simulato.
// Uso: dalla radice del repository `python3 -m http.server 8765`, poi `node tests/browser.e2e.mjs [--live]`.
// Senza --live le risposte di Open-Meteo sono simulate (campo deterministico); terreno, mappa e radar sono reali.

import { chromium, devices } from 'playwright';
import fs from 'fs';

const LIVE = process.argv.includes('--live');
const BASE = process.env.BASE || 'http://127.0.0.1:8765/';
const SHOTS = process.env.SHOTS || '/tmp/shots';
fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0, passes = 0;
const check = (name, ok, info = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${info}`); };

const GPS = { latitude: 43.7765, longitude: 11.2480 };   // Firenze, stazione di Santa Maria Novella

function mockOpenMeteo(route) {
  const u = new URL(route.request().url());
  const q = u.searchParams;
  if (q.get('daily')) return route.fulfill({ json: { timezone: 'Europe/Rome', elevation: 50, daily: { sunrise: ['2026-11-22T07:20'], sunset: ['2026-11-22T16:48'] } } });
  const lats = q.get('latitude').split(','), lons = q.get('longitude').split(',');
  const start = Date.parse(q.get('start_date') + 'T00:00:00Z') / 1000;
  const time = Array.from({ length: 72 }, (_, k) => start + k * 3600);
  const oLat = +lats[0], oLon = +lons[0];
  const loc = (i) => {
    // pioggia a est dell'osservatore (dove sta l'antisolare nel pomeriggio), cielo sgombro altrove
    const east = +lons[i] > oLon + 0.02 && Math.abs(+lats[i] - oLat) < 0.25;
    return { hourly: { time,
      precipitation: time.map(() => (east ? 1.5 : 0)), showers: time.map(() => (east ? 1.5 : 0)),
      precipitation_probability: time.map(() => (east ? 70 : 5)),
      cloud_cover_low: time.map(() => (east ? 60 : 10)), cloud_cover_mid: time.map(() => 0), cloud_cover_high: time.map(() => 10),
      temperature_2m: time.map(() => 11) } };
  };
  return route.fulfill({ json: lats.map((_, i) => loc(i)) });
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });

// ---------- 1. Telefono con GPS consentito ----------
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: GPS, permissions: ['geolocation'], locale: 'it-IT', timezoneId: 'Europe/Rome' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|403|429/.test(m.text())) errors.push(m.text()); });
  if (!LIVE) await page.route('https://api.open-meteo.com/**', mockOpenMeteo);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('verdict').textContent.length > 5, null, { timeout: 90000 });
  await page.waitForFunction(() => /Meteo:|Meteo non/.test(document.getElementById('status').textContent), null, { timeout: 90000 });
  const coords = await page.textContent('#coords');
  check('GPS automatico al primo avvio: osservatore = posizione simulata', coords.startsWith('43.7765, 11.2480'), coords);
  check('barra della giornata con fasce di possibilità geometrica', /primario possibile/.test(await page.textContent('#dayInfo')), await page.textContent('#dayInfo'));

  // ore 15:00 locali: Sole basso a SO, antisolare a NE, pioggia simulata a est
  await page.evaluate(() => { const s = document.getElementById('slider'); s.value = 900; s.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(400);
  const v = await page.textContent('#verdict');
  check('cursore al minuto: ora mostrata 15:00', (await page.textContent('#tTime')) === '15:00');
  check('verdetto con geometria, terreno e indice', /Geometria: primario possibile/.test(v) && /Indice/.test(v), v.replace(/\n/g, ' | '));
  if (!LIVE) check('scenario simulato (pioggia a est, Sole libero): probabile', /PROBABILE/.test(v) && !/POSSIBILE/.test(v.replace('PROBABILE', '')));
  await page.click('.step button[data-d="1"]');
  await page.waitForTimeout(300);
  check('pulsante +1′', (await page.textContent('#tTime')) === '15:01');
  await page.screenshot({ path: `${SHOTS}/1-telefono-15h.png`, fullPage: true });

  // registro: salva, elenca, esporta CSV
  await page.click('#logBox summary');
  await page.click('#lgUseSlider');
  await page.fill('#lgN', 'prova automatica');
  await page.click('#logForm button[type=submit]');
  const list = await page.textContent('#logList');
  check('registro: voce salvata con indice e note', /prova automatica/.test(list) && (LIVE || /I=0\.\d+/.test(list)), list.slice(0, 90));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#lgCsv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check('esportazione CSV con intestazione e una riga', csv.split('\n')[0].startsWith('id,schema,') && csv.trim().split('\n').length === 2);
  await page.screenshot({ path: `${SHOTS}/2-registro.png`, fullPage: true });

  // coordinate manuali
  await page.fill('#coordIn', `43°46'10.6"N 11°15'20.9"E`);
  await page.click('#coordForm button[type=submit]');
  await page.waitForFunction(() => document.getElementById('coords').textContent.startsWith('43.7696'), null, { timeout: 20000 });
  check('coordinate sessagesimali manuali', true, await page.textContent('#coords'));
  const ov = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check('nessuno scorrimento orizzontale su 412 px', ov[0] <= ov[1], ov.join(' ≤ '));
  check('nessun errore JavaScript', errors.length === 0, errors.slice(0, 3).join(' / '));
  const calls = await page.evaluate(() => JSON.parse(localStorage.getItem('hc.calls') || 'null'));
  check('contatore Open-Meteo condiviso aggiornato', calls && calls.n >= 217, JSON.stringify(calls));
  await ctx.close();
}

// ---------- 2. Telefono con permesso di posizione negato: pannello di assistenza ----------
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'it-IT', timezoneId: 'Europe/Rome' });
  const page = await ctx.newPage();
  if (!LIVE) await page.route('https://api.open-meteo.com/**', mockOpenMeteo);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.click('#gps');
  await page.waitForSelector('#gpsHelp:not([hidden])', { timeout: 20000 });
  const steps = await page.$$eval('#gpsSteps li', (l) => l.map((x) => x.textContent));
  check('GPS negato: pannello con passaggi per Chrome Android', steps.length >= 3 && /Chrome|⋮/.test(steps.join(' ')), `${await page.textContent('#gpsTitle')} (${steps.length} passaggi)`);
  await page.screenshot({ path: `${SHOTS}/3-gps-negato.png` });
  await ctx.close();
}

await browser.close();
console.log(`\n${passes} superati, ${fails} falliti`);
process.exit(fails ? 1 : 0);
