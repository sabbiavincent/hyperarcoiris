# hyper arcoiris

Web app personale: quando e dove si può vedere un arcobaleno, a qualsiasi ora del giorno, per la fotografia.
File statici, nessun server: funziona su GitHub Pages. Moduli verificati copiati da `hyperclouds` (vedi `PROVENIENZA.md`).

## Che cosa fa
0. Dove andare: punti entro 20 km (linea d'aria) da cui si vede un arcobaleno, oggi o domani, ordinabili per indice, vicinanza o altezza dell'arco; risposta sintetica in testa alla pagina.
1. Barra della giornata: possibilità geometrica (primario, solo secondario), occultamento da rilievo, indice euristico per classi.
2. Panorama antisolare con orizzonte reale e archi primario e secondario nelle posizioni esatte; cursore al minuto.
3. Mappa: direzione del Sole e antisolare, settore della pioggia utile, radar RainViewer, GPS con pannello di assistenza, coordinate manuali.
4. Registro delle osservazioni (anche negative) con i predittori calcolati, esportazione JSON/CSV.
5. Sezione «Che cosa è calcolato, che cosa è stimato, che cosa non si può determinare».

## Moduli
| File | Contenuto |
|---|---|
| `js/rainbow.js` | antisolare, raggi di Descartes (acqua IAPWS 1997 / aria Edlén 1966), archi, intersezione con l'orizzonte, finestre |
| `js/horizon360.js` | orizzonte reale su 360° fino a 100 km, linea di vista contro il terreno |
| `js/rainfield.js` | griglia polare Open-Meteo (217 punti, peso 217 per aggiornamento) |
| `js/radar.js` | RainViewer: frame osservati, tavolozza, copertura, moto, estrapolazione fino a 60 min |
| `js/likelihood.js` | indice euristico I = S × O × R |
| `js/zonescan.js` | ricerca nella zona: celle di 2 km, griglia meteo di 681 punti (oggi e domani in una richiesta), orizzonte per cella, ordinamenti |
| `js/log.js` | registro osservazioni |
| `js/gps.js` | pannello GPS (da hyperclouds) |

## Pubblicazione su GitHub Pages
1. Su https://github.com apri il repository `sabbiavincent/hyperarcoiris`.
2. **Settings** (scheda in alto) → menu a sinistra **Pages** → *Build and deployment* → *Source*: **Deploy from a branch** → *Branch*: **main**, cartella **/ (root)** → **Save**.
3. Dopo 1–2 minuti: `https://sabbiavincent.github.io/hyperarcoiris/`.
4. Sul telefono: Chrome → **⋮** → **Aggiungi a schermata Home**.

## Test
```
cd tests && npm install && npm test          # numerici: effemeridi, geometria, terreno, dati, radar, indice
npm install --no-save playwright              # solo per il test nel browser
cd .. && python3 -m http.server 8765 &
node tests/browser.e2e.mjs                    # Chrome, Pixel 7 emulato, GPS simulato, Open-Meteo simulato
node tests/browser.e2e.mjs --live             # idem con Open-Meteo reale
```
Per i test di Open-Meteo dal vivo nei test numerici: `LIVE_OPENMETEO=1 node data.test.mjs`.
