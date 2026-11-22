// Service worker: file dell'app rete-prima (sempre rivalidati, riserva offline);
// tile del terreno AWS cache-prima (immutabili), con tetto al numero di voci.
const APP = 'ha-app-v1', DEM = 'ha-dem-v1', DEM_MAX = 900;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
async function trim() {
  const c = await caches.open(DEM), keys = await c.keys();
  for (let i = 0; i < keys.length - DEM_MAX; i++) await c.delete(keys[i]);
}
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (/elevation-tiles-prod/.test(u.href) && u.pathname.includes('/terrarium/')) {
    e.respondWith(caches.open(DEM).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) { c.put(e.request, r.clone()); trim(); }
      return r;
    }));
    return;
  }
  if (u.origin !== location.origin) return;
  const net = e.request.mode === 'navigate' ? fetch(e.request.url, { cache: 'no-cache' }) : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(net.then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(APP).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
