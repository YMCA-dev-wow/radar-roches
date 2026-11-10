// Relief des zones publié en paquets (outils/preparer_site.py) : <dossier>/relief.json (index) et relief_N.pack (PNG des
// tuiles mis bout à bout). Une tuile = une requête « Range » sur son paquet (GitHub Pages les accepte, en-tête CORS ouvert).
// Sert au web (radar, rejeu, éditeur) et, dans l'appli, au relief d'une zone pas encore téléchargée (essais à terre, rejeu).
// Sans index (essais locaux sur le dossier de travail), les tuiles séparées <dossier>/tuiles/z/x/y.png sont lues.
// Web : chaque tuile lue est gardée dans le cache « radar-tuiles » sous son adresse de tuile (hors ligne).
'use strict';
const Relief = (() => {
  const SITE_R = 'https://ymca-dev-wow.github.io/radar-roches/';
  const appli = !!(window.androidBridge || (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()));
  const base = appli ? SITE_R : '';
  const index = new Map();
  function lireIndex(dossier) {
    if (!index.has(dossier)) index.set(dossier, fetch(base + dossier + '/relief.json').then(r => r.ok ? r.json() : null).catch(() => null));
    return index.get(dossier);
  }
  const cache = () => (!appli && 'caches' in window ? caches.open('radar-tuiles').catch(() => null) : Promise.resolve(null));
  // PNG de la tuile k ('x/y') de la zone (Blob), null si la zone n'a pas de tuile à cet endroit
  async function blob(dossier, zoom, k) {
    const cle = new URL(base + dossier + '/tuiles/' + zoom + '/' + k + '.png', location.href).href;
    const c = await cache();
    if (c) { const hit = await c.match(cle).catch(() => null); if (hit) return hit.blob(); }
    const idx = await lireIndex(dossier);
    let b;
    if (!idx) { // ancien format : une tuile par fichier
      const r = await fetch(cle); if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status);
      b = await r.blob();
    } else {
      const e = idx.tuiles[k]; if (!e) return null;
      const [p, debut, n] = e;
      const r = await fetch(base + dossier + '/' + idx.packs[p].nom, { headers: { Range: `bytes=${debut}-${debut + n - 1}` } });
      if (r.status === 206) b = await r.blob();
      else if (r.ok) b = (await r.blob()).slice(debut, debut + n);   // serveur qui ignore « Range » (paquet entier)
      else throw new Error('HTTP ' + r.status);
      b = new Blob([b], { type: 'image/png' });
    }
    if (c) c.put(cle, new Response(b, { headers: { 'Content-Type': 'image/png' } })).catch(() => {});
    return b;
  }
  // Pixels RVBA (Uint8ClampedArray 256×256×4) d'une tuile ; null si absente
  async function pixels(dossier, zoom, k) {
    const b = await blob(dossier, zoom, k);
    if (!b) return null;
    if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
      // fonctionne page cachée (écran éteint), contrairement à <img>
      const bmp = await createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const c = new OffscreenCanvas(256, 256), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
      return g.getImageData(0, 0, 256, 256).data;
    }
    const url = URL.createObjectURL(b);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, 256, 256).data;
    } finally { URL.revokeObjectURL(url); }
  }
  return { base, appli, lireIndex, blob, pixels };
})();
