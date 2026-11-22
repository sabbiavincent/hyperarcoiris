// Pannello di assistenza GPS, estratto da hyperclouds (js/app.js, commit 24d2ac2) e reso indipendente.
// Una pagina web non può accendere la localizzazione né aprire le impostazioni: si spiegano i passaggi.

export function setupGps({ $, status, onPosition, host = 'sabbiavincent.github.io' }) {
  function locatePhone(auto, onFail) {
    if (!navigator.geolocation) { if (!auto) status('Geolocalizzazione non disponibile in questo browser.'); onFail?.(); return; }
    if (!auto) status('Richiesta posizione GPS…');
    navigator.geolocation.getCurrentPosition(
      (p) => onPosition({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => { if (!auto) gpsHelp(e); onFail?.(); },
      { enableHighAccuracy: true, timeout: auto ? 8000 : 15000, maximumAge: 60000 });
  }

  async function gpsHelp(err) {
    const ff = /firefox/i.test(navigator.userAgent);
    let perm = null;
    try { perm = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch {}
    const standalone = matchMedia('(display-mode: standalone)').matches;
    const site = standalone
      ? (ff ? ['Apri Firefox → ⋮ → Impostazioni → Autorizzazioni sito → Posizione.', `Consenti a ${host}.`, 'Riapri l\'app.']
            : ['Apri Chrome → ⋮ → Impostazioni → Impostazioni sito → Posizione.', `Tocca ${host} e scegli Consenti.`, 'Riapri l\'app.'])
      : ff
        ? ['Tocca il lucchetto accanto all\'indirizzo della pagina.', 'Alla voce Posizione scegli Consentito.', 'Ricarica la pagina.']
        : ['Tocca ⋮ in alto a destra.', 'Nella fila di icone in cima al menu tocca ⓘ.', 'Autorizzazioni → Posizione → Consenti.', 'Ricarica la pagina.',
           `Se Posizione non compare: ⋮ → Impostazioni → Impostazioni sito → Posizione; interruttore attivo; in Bloccati tocca ${host} → Consenti.`];
    const app = ['Impostazioni → App → ' + (ff ? 'Firefox' : 'Chrome') + ' → Autorizzazioni → Posizione.', 'Scegli Consenti solo mentre l\'app è in uso.'];
    const os = ['Scorri due volte dall\'alto dello schermo e tocca il riquadro Posizione.', 'In alternativa: Impostazioni → Posizione → Usa posizione su attivo.'];
    let title, steps;
    if (err.code === 1) {
      title = perm === 'denied' ? 'Il sito non ha il permesso di usare la posizione' : 'Il browser non ha il permesso di usare la posizione';
      steps = perm === 'denied' ? [...site, 'Se non basta:', ...app] : [...app, 'Poi, se richiesto, consenti anche al sito:', ...site];
    } else if (err.code === 2) {
      title = 'La localizzazione del telefono sembra spenta';
      steps = [...os, 'Se è già attiva, controlla i permessi:', ...app];
    } else {
      title = 'La posizione non è arrivata in tempo';
      steps = ['Riprova all\'aperto o vicino a una finestra.', 'Oppure inserisci le coordinate nel campo sotto la data.'];
    }
    $('gpsTitle').textContent = title;
    $('gpsSteps').replaceChildren(...steps.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
    $('gpsHelp').hidden = false;
    status(`GPS non disponibile: ${title.toLowerCase()}.`);
  }

  $('gpsRetry').onclick = () => { $('gpsHelp').hidden = true; locatePhone(false); };
  $('gpsClose').onclick = () => { $('gpsHelp').hidden = true; };
  $('gps').onclick = () => locatePhone(false);
  return { locatePhone };
}
