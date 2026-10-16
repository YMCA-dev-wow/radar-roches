// Service worker du radar : fonctionnement hors ligne.
// Tuiles Litto3D : cache dédié, « cache d'abord » (elles ne changent pas, et survivent aux mises à jour de l'appli).
// Pages, noyau et marée : réseau d'abord, cache en secours. Le marégraphe (autre domaine) passe toujours par le réseau.
const APP = 'radar-app-v4';
const TUILES = 'radar-tuiles';
const BASE = ['radar.html', 'rejeu.html', 'noyau.js', 'theme.css', 'nav.js', 'fonds.js', 'logo.svg', 'donnees/zones.json']; // les données de chaque zone se mettent en cache à la première lecture

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(APP).then(c => c.addAll(BASE)));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== APP && k !== TUILES).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (/\/donnees[^/]*\/tuiles\//.test(url.pathname)) { // tuiles de toutes les zones (donnees/, donnees_22/…)
    e.respondWith(caches.open(TUILES).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
  } else {
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copie = r.clone(); caches.open(APP).then(c => c.put(e.request, copie)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
