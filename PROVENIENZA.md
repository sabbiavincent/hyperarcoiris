# Provenienza dei moduli copiati

Origine: `sabbiavincent/hyperclouds`, commit `24d2ac2` (copia, il repository di origine non è stato modificato).

| File | Stato |
|---|---|
| `js/solar.js` | identico |
| `js/geodesy.js` | identico |
| `js/dem.js` | identico |
| `js/terrain.js` | identico |
| `js/weather.js` | identico (il contatore `hc.calls` in `localStorage` è condiviso con hyperclouds sullo stesso origin `sabbiavincent.github.io`: il limite Open-Meteo è per IP) |
| `js/coords.js` | identico |
| `calibration/` | identico |
| `tests/test.mjs` | test 5d reso condizionale finché `js/app.js` non esiste |
| `tests/package.json` | identico |

Il pannello di assistenza GPS (in hyperclouds dentro `js/app.js` e `index.html`) è estratto in `js/gps.js` di questo repository.

Verifica dopo la copia: `cd tests && npm install && node test.mjs` → 22 superati, 0 falliti.
