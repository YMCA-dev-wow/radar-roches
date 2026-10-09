// Noyau commun au radar et au lecteur de traces : marée, relevé Litto3D, détection des dangers, sons, dessin du radar.
'use strict';

// =====================================================================
// Marée
// =====================================================================
// Références altimétriques maritimes (Shom) : NM, PMVE, BMVE au-dessus du zéro hydro local, et cote de ce zéro dans IGN69.
const PORTS = [
  { id: 'cast',    nom: 'Saint-Cast',  lon: -2.2433, nm: 6.64, pmve: 12.10, bmve: 1.60, zh: -6.264 },
  { id: 'briac',   nom: 'Saint-Briac', lon: -2.1685, nm: 6.68, pmve: 12.05, bmve: 1.50, zh: -6.219 },
  { id: 'malo',    nom: 'Saint-Malo',  lon: -2.0275, nm: 6.78, pmve: 12.20, bmve: 1.50, zh: -6.289 },
  { id: 'cancale', nom: 'Cancale',     lon: -1.8267, nm: 7.20, pmve: 13.05, bmve: 1.60, zh: -6.774 },
];
const MALO = PORTS[2];
let tide = null;          // { t0 (ms), step (ms), h: Int16Array (cm), info }
let surge = 0;            // effet météo (m), ajouté partout
let recal = null;         // { port, pts: [{te, dt, dh}] } recalage annuaire

// Hauteur prédite à Saint-Malo (m, zéro hydro de Saint-Malo)
function hMaloModel(t) {
  const x = (t - tide.t0) / tide.step, i = Math.floor(x);
  if (i < 0 || i + 1 >= tide.h.length) return NaN;
  return (tide.h[i] + (x - i) * (tide.h[i + 1] - tide.h[i])) / 100;
}
// Hauteur au port P (zéro hydro local) déduite de Saint-Malo : même forme, amplitude et niveau moyen du port
function mapPort(P, hMalo) {
  const k = (P.pmve - P.bmve) / (MALO.pmve - MALO.bmve);
  return P.nm + (hMalo - MALO.nm) * k;
}
function corrAt(t) { // décalage horaire et correction de hauteur interpolés entre les extrêmes saisis
  const p = recal.pts;
  if (t <= p[0].te) return p[0];
  if (t >= p[p.length - 1].te) return p[p.length - 1];
  for (let i = 0; i < p.length - 1; i++) if (t <= p[i + 1].te) {
    const f = (t - p[i].te) / (p[i + 1].te - p[i].te);
    return { dt: p[i].dt + f * (p[i + 1].dt - p[i].dt), dh: p[i].dh + f * (p[i + 1].dh - p[i].dh) };
  }
}
function hPortPredit(P, t) { // prédiction (sans météo) au port P, recalée sur l'annuaire si saisi
  if (recal && recal.port === P.id) { const c = corrAt(t); return mapPort(P, hMaloModel(t - c.dt)) + c.dh; }
  if (recal && recal.port === 'malo') { const c = corrAt(t); return mapPort(P, hMaloModel(t - c.dt) + c.dh); }
  return mapPort(P, hMaloModel(t));
}
// Niveau de l'eau exprimé dans le zéro hydro de Saint-Malo (même référence que les tuiles), à la longitude lon.
// hMaloFn permet de remplacer la prédiction de Saint-Malo (ex. hauteur mesurée pour rejouer une ancienne session).
function niveauEau(lon, t, hMaloFn) {
  const W = P => (hMaloFn ? mapPort(P, hMaloFn(t)) : hPortPredit(P, t)) + P.zh - MALO.zh;
  const add = hMaloFn ? 0 : surge;
  if (lon <= PORTS[0].lon) return W(PORTS[0]) + add;
  for (let i = 0; i < PORTS.length - 1; i++) {
    const a = PORTS[i], b = PORTS[i + 1];
    if (lon <= b.lon) { const f = (lon - a.lon) / (b.lon - a.lon); return W(a) + f * (W(b) - W(a)) + add; }
  }
  return W(PORTS[PORTS.length - 1]) + add;
}
// Extrême du modèle (PM = max, BM = min) le plus proche de t, cherché à ±3 h, pas 1 min
function extremeModele(P, t, type) {
  let best = null;
  for (let s = -180; s <= 180; s++) {
    const tt = t + s * 60000, h = mapPort(P, hMaloModel(tt));
    if (!best || (type === 'PM' ? h > best.h : h < best.h)) best = { t: tt, h };
  }
  return best;
}
// Mesures du marégraphe de Saint-Malo (REFMAR, Shom) entre deux dates (ms) : [{t, h}] ; tranches de 31 jours max
async function lireMaregraphe(debut, fin, pasMin = 10) {
  const iso = d => new Date(d).toISOString().slice(0, 19) + 'Z';
  const out = [];
  for (let a = debut; a < fin; a += 30 * 86400e3) {
    const b = Math.min(fin, a + 30 * 86400e3);
    const r = await fetch(`https://services.data.shom.fr/maregraphie/observation/json/410?sources=1&dtStart=${iso(a)}&dtEnd=${iso(b)}&interval=${pasMin}`);
    for (const m of (await r.json()).data) if (m.value != null) out.push({ t: Date.parse(m.timestamp.replace(/\//g, '-').replace(' ', 'T') + 'Z'), h: m.value });
  }
  return out;
}

// =====================================================================
// Données Litto3D (tuiles z16 : R = cote, G = relief)
// =====================================================================
let meta = null;
const tiles = new Map(); // 'x/y' -> Uint8ClampedArray | null | Promise
async function chargerDonnees() {
  const [m, tj, tb] = await Promise.all([
    fetch('donnees/meta.json').then(r => r.json()),
    fetch('donnees/maree/saint_malo.json').then(r => r.json()),
    fetch('donnees/maree/saint_malo.bin').then(r => r.arrayBuffer()),
  ]);
  meta = m; meta.set = new Set(m.tuiles.map(t => t[0] + '/' + t[1]));
  tide = { t0: Date.parse(tj.debut_utc), step: tj.pas_min * 60000, h: new Int16Array(tb), info: tj };
}
function loadTile(x, y) {
  const k = x + '/' + y;
  if (tiles.has(k)) return tiles.get(k) instanceof Promise ? tiles.get(k) : Promise.resolve();
  if (!meta.set.has(k)) { tiles.set(k, null); return Promise.resolve(); }
  const p = new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      tiles.set(k, g.getImageData(0, 0, 256, 256).data); res();
    };
    img.onerror = () => { tiles.set(k, null); res(); };
    img.src = 'donnees/tuiles/' + meta.zoom + '/' + k + '.png';
  });
  tiles.set(k, p);
  return p;
}
const WORLD = 256 * 2 ** 16;
const toPx = (lat, lon) => [(lon + 180) / 360 * WORLD, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * WORLD];
const mPerPx = lat => 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** 16;

// « Mes roches » : GeoJSON exporté par l'éditeur -> liste simplifiée
function lireMesRoches(gj) {
  return gj.features.map(ft => {
    const p = ft.properties || {}, g = ft.geometry;
    return g.type === 'Point'
      ? { kind: 'point', lat: g.coordinates[1], lon: g.coordinates[0], r: p.rayon || 0, z: p.z ?? 0, test: !!p.test, nom: p.nom || '' }
      : { kind: 'zone', ring: g.coordinates[0].map(c => [c[1], c[0]]), z: p.z ?? 0, test: !!p.test, nom: p.nom || '' };
  });
}

// =====================================================================
// Détection
// =====================================================================
// opts : { seuil, smooth, useL3d, inclTest, antic, roches, affichage, preAlerte }
// Renvoie la menace principale (alerte : cône ±50°, distance d'alerte), la pré-alerte (cône ±10°, jusqu'à 2× la distance
// d'alerte) et, si affichage, les cellules dangereuses autour de la position.
const CONE_ALERTE = 50, CONE_PRE = 10, VEILLE_MAX = 110; // veille latérale : jusqu'à 110° de part et d'autre du cap
function analyser(pos, course, speed, W, opts) {
  const { seuil, smooth, useL3d, inclTest, antic, roches = [], affichage = true, preAlerte = false, veille = false } = opts;
  const horizon = Math.max(40, speed * antic);                                   // distance d'alerte (m)
  const preH = preAlerte ? 2 * horizon : 0;                                      // distance de pré-alerte (m)
  const latH = veille ? 2 * horizon : 0;                                         // portée de la veille latérale (m)
  const R = affichage ? Math.min(300, Math.max(120, horizon * 1.6, preH * 1.1, latH * 1.1)) : Math.max(horizon, preH, latH); // rayon de lecture
  const mpp = mPerPx(pos.lat), [px, py] = toPx(pos.lat, pos.lon);
  const rp = Math.ceil(R / mpp);
  const cells = [];                                                              // [dx, dy, niveau] en mètres, est/sud positifs
  let best = null, pre = null, lat = null;
  const consider = (dx, dy, lvl, d) => {
    let rel = Math.atan2(dx, -dy) * 180 / Math.PI - course; rel = ((rel + 540) % 360) - 180;
    if (preH && d > horizon && d <= preH && Math.abs(rel) <= CONE_PRE && (!pre || d < pre.d)) pre = { d, rel, lvl };
    // veille : tout danger à portée (2× la distance d'alerte) jusqu'à 110°, sauf ce que couvrent déjà l'alerte et la pré-alerte
    const a = Math.abs(rel), couvert = (a <= CONE_ALERTE && d <= horizon) || (preH && a <= CONE_PRE);
    if (latH && d <= latH && a <= VEILLE_MAX && !couvert && (!lat || d < lat.d)) lat = { d, rel, lvl };
    const inCone = Math.abs(rel) <= CONE_ALERTE || (d < 20 && Math.abs(rel) <= 110); // proche : devant et côtés, pas derrière
    if (!inCone || d > horizon) return;
    const score = d / Math.max(0.35, Math.cos(Math.min(Math.abs(rel), 80) * Math.PI / 180)) - lvl * 3;
    if (!best || score < best.score) best = { d, rel, lvl, score };
  };
  if (useL3d && meta) {
    const tx0 = Math.floor((px - rp) / 256), tx1 = Math.floor((px + rp) / 256), ty0 = Math.floor((py - rp) / 256), ty1 = Math.floor((py + rp) / 256);
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      if (affichage) { loadTile(tx, ty); loadTile(tx - 1, ty); loadTile(tx + 1, ty); loadTile(tx, ty - 1); loadTile(tx, ty + 1); } // préchargement
      const d = tiles.get(tx + '/' + ty);
      if (!d || d instanceof Promise) continue;
      const u0 = Math.max(0, Math.floor(px - rp) - tx * 256), u1 = Math.min(255, Math.ceil(px + rp) - tx * 256);
      const v0 = Math.max(0, Math.floor(py - rp) - ty * 256), v1 = Math.min(255, Math.ceil(py + rp) - ty * 256);
      for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) {
        const i = (v * 256 + u) * 4, Rc = d[i];
        if (Rc === 0 || Rc === 255) continue;
        const rock = Rc === 254 || d[i + 1] * meta.pas_relief >= 0.30;
        if (!rock && !smooth) continue;
        const cote = Rc === 254 ? 99 : meta.cote_min + (Rc - 1) * meta.pas_cote, eau = W - cote;
        const lvl = eau < 0 ? 3 : eau < seuil ? 2 : eau < seuil + 1 ? 1 : 0;
        if (!lvl) continue;
        const dx = (tx * 256 + u + 0.5 - px) * mpp, dy = (ty * 256 + v + 0.5 - py) * mpp, dist = Math.hypot(dx, dy);
        if (dist > R) continue;
        if (affichage) cells.push(dx, dy, lvl);
        if (lvl >= 2) consider(dx, dy, lvl, dist);
      }
    }
  }
  // mes roches : points (avec rayon) et zones
  const kx = 111320 * Math.cos(pos.lat * Math.PI / 180), ky = 110540;
  const zones = [];
  for (const f of roches) {
    if (f.test && !inclTest) continue;
    const eau = W - f.z, lvl = eau < 0 ? 3 : eau < seuil ? 2 : eau < seuil + 1 ? 1 : 0;
    if (!lvl) continue;
    if (f.kind === 'point') {
      const dx = (f.lon - pos.lon) * kx, dy = -(f.lat - pos.lat) * ky, dc = Math.hypot(dx, dy), d = Math.max(0, dc - f.r);
      if (dc > R + f.r) continue;
      zones.push({ pts: null, dx, dy, r: f.r, lvl });
      if (lvl >= 2) { const s = dc > 0 ? d / dc : 0; consider(dx * s || dx, dy * s || dy, lvl, d); }
    } else {
      const pts = f.ring.map(([la, lo]) => [(lo - pos.lon) * kx, -(la - pos.lat) * ky]);
      const n = nearestOnPoly(pts);
      if (n.d > R) continue;
      zones.push({ pts, lvl });
      if (lvl >= 2) consider(n.x, n.y, lvl, n.d);
    }
  }
  return { cells, zones, best, pre, lat, horizon, preH, latH, R };
}
function nearestOnPoly(pts) { // point du polygone le plus proche de l'origine (0 si dedans)
  let inside = false, bd = Infinity, bx = 0, by = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x1, y1] = pts[j], [x2, y2] = pts[i];
    if ((y2 > 0) !== (y1 > 0) && 0 < (x1 - x2) * (0 - y2) / (y1 - y2) + x2) inside = !inside;
    const ex = x2 - x1, ey = y2 - y1, t = Math.max(0, Math.min(1, -(x1 * ex + y1 * ey) / (ex * ex + ey * ey || 1)));
    const qx = x1 + t * ex, qy = y1 + t * ey, d = Math.hypot(qx, qy);
    if (d < bd) { bd = d; bx = qx; by = qy; }
  }
  return inside ? { d: 0, x: 0, y: -1 } : { d: bd, x: bx, y: by };
}
function textePre(p) { return `Danger droit devant à ${Math.round(p.d)} m (pré-alerte)`; }
function texteMenace(b) {
  return `${b.lvl === 3 ? 'Roche émergée' : 'Haut-fond'} à ${Math.round(b.d)} m ${Math.abs(b.rel) < 15 ? 'devant' : b.rel > 0 ? 'à tribord' : 'à bâbord'}`;
}

// =====================================================================
// Son
// =====================================================================
let ac = null, muted = false, nextBeep = 0, contOsc = null;
function audio() { if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; }
function tone(f0, f1, t, dur, vol = 0.9, type = 'square') {
  const a = audio(), o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.setValueAtTime(vol, t + dur - 0.02); g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
function motif(rel, lvl, t) { // devant / tribord / bâbord ; plus aigu si émergé
  const up = lvl === 3 ? 300 : 0;
  if (Math.abs(rel) < 15) tone(700 + up, 700 + up, t, 0.14);
  else if (rel > 0) { tone(600 + up, 600 + up, t, 0.09); tone(1000 + up, 1000 + up, t + 0.12, 0.09); }
  else { tone(1000 + up, 1000 + up, t, 0.09); tone(600 + up, 600 + up, t + 0.12, 0.09); }
}
function continu(on, f = 1100) {
  if (on && !contOsc) {
    const a = audio(), o = a.createOscillator(), g = a.createGain();
    o.type = 'square'; o.frequency.value = f; g.gain.value = 0.9; o.connect(g).connect(a.destination); o.start();
    contOsc = { o, g };
  } else if (!on && contOsc) { contOsc.o.stop(); contOsc = null; }
}
function tintement(t) { tone(1760, 1760, t, 0.22, 0.8, 'triangle'); tone(1320, 1320, t + 0.24, 0.30, 0.8, 'triangle'); } // pré-alerte : doux, aigu, descendant
function gpsPerdu(t) { [0, 0.25, 0.5].forEach(s => tone(260, 260, t + s, 0.15)); }
function demoSons() {
  const t = audio().currentTime + 0.1;
  tintement(t); sonVeille('tribord', t + 0.6); motif(0, 2, t + 1.6); motif(40, 2, t + 1.8); motif(-40, 2, t + 2.6); motif(0, 3, t + 3.4); gpsPerdu(t + 4.2);
}
// Joue l'alerte correspondant à la menace b, sinon la pré-alerte pre (appelé à chaque pas) ; armed = vitesse suffisante.
// Bips désactivables ; pas de bip pendant que la voix parle, sauf sous 10 m où le son continu coupe la voix.
let nextPre = 0, bipsActifs = true;
const voixEnCours = () => 'speechSynthesis' in window && speechSynthesis.speaking;
function sonnerMenace(b, horizon, armed, pre) {
  const at = audio().currentTime;
  if (b && armed && !muted) {
    if (b.d < 10) {
      if (bipsActifs) { if (voixEnCours()) speechSynthesis.cancel(); continu(true, b.lvl === 3 ? 1400 : 1100); } else continu(false);
      return;
    }
    continu(false);
    if (!bipsActifs || voixEnCours()) return;
    const period = 0.18 + 1.1 * Math.min(1, b.d / horizon);
    if (at > nextBeep) { motif(b.rel, b.lvl, at); nextBeep = at + period; }
    return;
  }
  continu(false);
  if (pre && armed && !muted && bipsActifs && !voixEnCours() && at > nextPre) { tintement(at); nextPre = at + 3; } // rappel toutes les 3 s
}
// Niveau d'alerte pour la frise : 0 rien, 1 bips, 2 son continu (< 10 m), 3 contact (< 3 m)
function niveauAlerte(b, armed) {
  if (!b || !armed) return 0;
  return b.d < 3 ? 3 : b.d < 10 ? 2 : 1;
}

// =====================================================================
// Montre : notifications Android relayées par la Suunto app (texte seul, un seul son)
// =====================================================================
let surMontre = null; // rappel (titre, texte) pour l'aperçu à l'écran
async function montrePermission() {
  if (!('Notification' in window)) return 'absent';
  if (Notification.permission === 'default') await Notification.requestPermission();
  return Notification.permission;
}
async function notifier(titre, texte) {
  if (surMontre) surMontre(titre, texte);
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) { await reg.showNotification(titre, { body: texte, tag: 'radar', renotify: true }); return true; }
    new Notification(titre, { body: texte, tag: 'radar', renotify: true }); return true;
  } catch { return false; }
}
// Résumé pour l'écran de l'Ambit 3 (essais du 2026-10-09) : texte seul, retours à la ligne ignorés, police à chasse variable,
// pas de flèches Unicode, titre ≈ 13 caractères, corps ≈ 3 lignes de 14-16 caractères.
// Titre = danger droit devant ; corps = les autres dangers proches, par direction, du plus proche au plus loin.
let styleMontre = 'grille'; // 'grille' | 'mots' | 'heures' | 'fleches'
// Grille 3×3 (essai D validé sur l'Ambit 3) : chaque ligne est un « mot » sans espace, liée par des « _ », pour que la montre
// passe à la ligne entre les lignes. Haut = devant ; X = danger dans ce secteur de 45° ; centre = distance du plus proche.
const SECTEUR_CASE = [[0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0], [1, 0], [0, 0]];
function grilleAmbit(an, course) {
  const lim = Math.max(an.preH || 0, an.latH || 0, 2 * an.horizon), g = [['O', 'O', 'O'], ['O', '', 'O'], ['O', 'O', 'O']];
  let dmin = Infinity;
  const ajoute = (dx, dy) => {
    const d = Math.hypot(dx, dy); if (d > lim) return;
    let rel = Math.atan2(dx, -dy) * 180 / Math.PI - course; rel = ((rel + 540) % 360) - 180;
    const [r, c] = SECTEUR_CASE[((Math.round(rel / 45) % 8) + 8) % 8];
    g[r][c] = 'X'; dmin = Math.min(dmin, d);
  };
  const c = an.cells;
  for (let i = 0; i < c.length; i += 3) if (c[i + 2] >= 2) ajoute(c[i], c[i + 1]);
  for (const z of an.zones) if (z.lvl >= 2 && !z.pts) ajoute(z.dx, z.dy);
  if (!isFinite(dmin)) return null;
  const n = String(Math.round(dmin)), sep = n.length >= 3 ? '_' : '__';  // 3 chiffres : un seul « _ » pour tenir en largeur
  return {
    titre: an.pre ? 'Pré-alerte' : an.best ? 'Alerte' : 'Dangers',
    texte: [g[0].join('__'), [g[1][0], n, g[1][2]].join(sep), g[2].join('__')].join(' '),
    lignes: 3,
  };
}
const MOTS = ['Devant', 'Av. trib.', 'Tribord', 'Ar. trib.', 'Derrière', 'Ar. bâb.', 'Bâbord', 'Av. bâb.'];
const FLECHES = ['^', '^>', '>', 'v>', 'v', '<v', '<', '<^'];
function formatDirection(style, rel, d, titre) {
  const m = Math.round(d) + (titre ? ' m' : '');
  if (style === 'heures') { const h = ((Math.round(rel / 30) % 12) + 12) % 12 || 12; return `${h}h ${m}`; }
  const k = ((Math.round(rel / 45) % 8) + 8) % 8;
  return style === 'fleches' ? `${FLECHES[k]} ${m}` : `${MOTS[k]} ${m}`;
}
function resumeMontre(an, course, style = styleMontre) {
  if (!an) return null;
  if (style === 'grille') return grilleAmbit(an, course);
  const lim = an.preH || 2 * an.horizon, nb = style === 'heures' ? 12 : 8, pas = 360 / nb;
  const proches = new Array(nb).fill(null);               // danger le plus proche par secteur
  const ajoute = (dx, dy) => {
    const d = Math.hypot(dx, dy); if (d > lim) return;
    let rel = Math.atan2(dx, -dy) * 180 / Math.PI - course; rel = ((rel + 540) % 360) - 180;
    const k = ((Math.round(rel / pas) % nb) + nb) % nb;
    if (!proches[k] || d < proches[k].d) proches[k] = { d, rel };
  };
  const c = an.cells;
  for (let i = 0; i < c.length; i += 3) if (c[i + 2] >= 2) ajoute(c[i], c[i + 1]);
  for (const z of an.zones) if (z.lvl >= 2 && !z.pts) ajoute(z.dx, z.dy);
  const devant = an.pre || proches[0];
  const autres = proches.filter((p, k) => p && k !== 0).sort((x, y) => x.d - y.d).slice(0, 3);
  if (!devant && !autres.length) return null;
  return {
    titre: devant ? formatDirection(style, 0, devant.d, true) : 'Rien devant',
    texte: autres.length ? autres.map(p => formatDirection(style, p.rel, p.d, false)).join(', ') + ' m' : 'Rien autour',
  };
}
// Prochaine pleine ou basse mer (pas de 5 min, sur 13 h) ; niveau(t) donne la hauteur d'eau
function prochainExtreme(niveau, t) {
  let prev = niveau(t), dir = Math.sign(niveau(t + 300000) - prev);
  for (let s = 1; s <= 156; s++) {
    const tt = t + s * 300000, h = niveau(tt), d = Math.sign(h - prev);
    if (d && dir && d !== dir) return { type: dir > 0 ? 'PM' : 'BM', t: tt - 300000, h: prev };
    if (d) dir = d; prev = h;
  }
  return null;
}
const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
function texteMaree(niveau, t) {
  const W = niveau(t), dW = niveau(t + 600000) - W, sens = dW > 0.005 ? 'monte' : dW < -0.005 ? 'descend' : '(fixe)', e = prochainExtreme(niveau, t);
  return { titre: `Eau ${W.toFixed(1)} m`, sens, texte: [sens, e ? `${e.type} ${hhmm(e.t)} ${e.h.toFixed(1)} m` : ''].filter(Boolean).join(', ') };
}
// Relais pendant la navigation : démarrage, pré-alerte, pannes GPS, point marée toutes les 30 min
const relais = { actif: false, preVu: -1e15, lastPre: -1e15, lastMaree: 0, gpsOk: true };
function relaisDemarrer(t, niveau, seuil, extra = '') {
  Object.assign(relais, { preVu: -1e15, lastPre: -1e15, lastMaree: t, gpsOk: true });
  if (!relais.actif) return;
  const m = texteMaree(niveau, t);
  notifier('Radar actif', `${m.titre}, ${m.texte}, seuil ${seuil} m${extra}`);
}
function relaisPas(t, an, course, armed, niveau, gpsOk = true) {
  if (!relais.actif) return;
  if (!gpsOk && relais.gpsOk) notifier('GPS perdu', 'Plus de position : radar aveugle');
  if (gpsOk && !relais.gpsOk) notifier('GPS retrouvé', 'Radar de nouveau actif');
  relais.gpsOk = gpsOk;
  if (!gpsOk) return;
  if (an && an.pre && !an.best && armed) {
    const nouveau = t - relais.preVu > 10000;          // le danger avait disparu depuis 10 s
    if ((nouveau || t - relais.lastPre > 30000) && t - relais.lastPre > 15000) {
      const r = resumeMontre(an, course);
      notifier(r ? (styleMontre === 'grille' ? `${Math.round(an.pre.d)} m devant` : r.titre) : formatDirection(styleMontre, 0, an.pre.d, true), r ? r.texte : 'Rien autour');
      relais.lastPre = t;
    }
    relais.preVu = t;
  }
  if (t - relais.lastMaree >= 30 * 60000) { const m = texteMaree(niveau, t); notifier(m.titre, m.texte); relais.lastMaree = t; }
}
// Essais (série 2) : forcer une grille 3×3 alors que l'Ambit 3 ignore « \n ». Situation : danger devant (98 m) et à tribord avant.
// A, B : autres caractères de fin de ligne ; C, D : lignes de la grille rendues insécables et assez longues pour que
// la montre coupe entre elles ; E : mesure du nombre de caractères par ligne.
function testerMontre() {
  const essais = [
    ['98 m devant', 'O__X__X O__98__O O__O__O'],
    ['120 m devant', 'X__X__O X_120_O O__O__O'],
    ['Roches tribord', '60 m, veille latérale'],
  ];
  essais.forEach(([ti, tx], i) => setTimeout(() => notifier(ti, tx), i * 8000));
}

// =====================================================================
// Voix : annonce de la direction et de la distance (synthèse vocale du téléphone)
// =====================================================================
let voixActive = false, derniereVoix = { t: 0, cle: '' };
function parler(txt) {
  if (!('speechSynthesis' in window)) return false;
  const u = new SpeechSynthesisUtterance(txt); u.lang = 'fr-FR'; u.rate = 1.2; u.volume = 1;
  speechSynthesis.cancel(); speechSynthesis.speak(u); return true;
}
// Annonce à chaque nouvelle menace ou changement de côté, puis rappel toutes les 5 s avec la distance à jour
// Veille latérale : une annonce par côté quand des dangers y apparaissent (absents depuis 20 s), si aucune alerte n'est en cours
function nouvelleVeille(etat, an, armed, t) {
  if (!an || !an.lat || !armed) return null;
  const cote = an.lat.rel > 0 ? 'tribord' : 'bâbord', nouveau = t - (etat[cote] ?? -1e15) > 20000;
  etat[cote] = t;
  return nouveau && !an.best ? { cote, d: an.lat.d, lvl: an.lat.lvl } : null;
}
function sonVeille(cote, t) { // glissando doux et grave : montant = tribord, descendant = bâbord
  const [a, b] = cote === 'tribord' ? [380, 620] : [620, 380];
  tone(a, b, t, 0.35, 0.7, 'sine'); tone(a, b, t + 0.45, 0.35, 0.7, 'sine');
}
function annoncerVeille(v) {
  if (!v || muted) return;
  const d = v.d >= 30 ? Math.round(v.d / 10) * 10 : Math.round(v.d);
  if (voixActive) { if (!voixEnCours()) parler(`${v.lvl === 3 ? 'Roches' : 'Hauts-fonds'} à ${v.cote}, ${d} mètres`); }
  else if (bipsActifs) sonVeille(v.cote, audio().currentTime);
}
function texteVeille(l) { return `${l.lvl === 3 ? 'Roches' : 'Hauts-fonds'} à ${l.rel > 0 ? 'tribord' : 'bâbord'} à ${Math.round(l.d)} m (veille)`; }
function annoncer(b, pre, armed, now = Date.now()) {
  if (!voixActive || muted || !armed || !(b || pre)) { if (!(b || pre)) derniereVoix.cle = ''; return; }
  const m = b || pre, cote = !b || Math.abs(b.rel) < 15 ? 'devant' : b.rel > 0 ? 'à tribord' : 'à bâbord';
  const cle = (b ? 'A' : 'P') + cote;
  if (b && b.d < 10) return;                           // le son continu prend le relais
  if (cle === derniereVoix.cle && now - derniereVoix.t < 5000) return;
  const d = m.d >= 30 ? Math.round(m.d / 10) * 10 : Math.round(m.d);
  parler(`${m.lvl === 3 ? 'Roche' : 'Haut-fond'} ${cote}, ${d} mètres`);
  derniereVoix = { t: now, cle };
}

// =====================================================================
// Dessin du radar (cap vers le haut)
// =====================================================================
function drawRadar(cv, analysis, fix) {
  const ctx = cv.getContext('2d'), k = devicePixelRatio || 1, Wd = cv.width, Hd = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, Wd, Hd);
  if (!analysis || !fix) return;
  const cx = Wd / 2, cy = Hd * 0.62, R = analysis.R, sc = Math.min(Wd / 2, Hd * 0.6) / R;
  ctx.translate(cx, cy); ctx.rotate(-fix.course * Math.PI / 180);
  const COL = [null, '#ff9f0a', '#ff3b30', '#b0302a'];
  const s = Math.max(1.5, mPerPx(fix.lat) * sc + 0.5), c = analysis.cells;
  for (let i = 0; i < c.length; i += 3) { ctx.fillStyle = COL[c[i + 2]]; ctx.fillRect(c[i] * sc - s / 2, c[i + 1] * sc - s / 2, s, s); }
  for (const z of analysis.zones) {
    ctx.strokeStyle = COL[z.lvl]; ctx.fillStyle = COL[z.lvl] + '66'; ctx.lineWidth = 2 * k;
    ctx.beginPath();
    if (z.pts) z.pts.forEach(([x, y], i) => i ? ctx.lineTo(x * sc, y * sc) : ctx.moveTo(x * sc, y * sc));
    else ctx.arc(z.dx * sc, z.dy * sc, Math.max(4 * k, z.r * sc), 0, 2 * Math.PI);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.setTransform(1, 0, 0, 1, cx, cy);
  ctx.strokeStyle = '#2a3441'; ctx.lineWidth = k; ctx.fillStyle = '#8a96a6'; ctx.font = `${11 * k}px system-ui`;
  for (const r of [50, 100, 200]) if (r <= R) { ctx.beginPath(); ctx.arc(0, 0, r * sc, 0, 2 * Math.PI); ctx.stroke(); ctx.fillText(r + ' m', 4 * k, -r * sc - 3 * k); }
  const cone = (r, deg, fill, stroke) => {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, -Math.PI / 2 - deg * Math.PI / 180, -Math.PI / 2 + deg * Math.PI / 180); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1.5 * k; ctx.stroke();
  };
  const h = analysis.horizon * sc, a = CONE_ALERTE * Math.PI / 180;
  if (analysis.latH) for (const s of [1, -1]) { // secteurs de veille, de 10° (ou 0°) à 110° de chaque côté
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, analysis.latH * sc, -Math.PI / 2 + s * (analysis.preH ? CONE_PRE : 0) * Math.PI / 180, -Math.PI / 2 + s * VEILLE_MAX * Math.PI / 180, s < 0);
    ctx.closePath(); ctx.fillStyle = 'rgba(90,200,250,0.06)'; ctx.fill(); ctx.setLineDash([4 * k, 4 * k]); ctx.strokeStyle = 'rgba(90,200,250,0.5)'; ctx.lineWidth = k; ctx.stroke(); ctx.setLineDash([]);
  }
  if (analysis.preH) cone(analysis.preH * sc, CONE_PRE, 'rgba(255,214,10,0.10)', 'rgba(255,214,10,0.75)');
  cone(h, CONE_ALERTE, 'rgba(61,155,240,0.12)', 'rgba(61,155,240,0.6)');
  ctx.font = `bold ${12 * k}px system-ui`; ctx.textAlign = 'center';
  ctx.fillStyle = '#3d9bf0'; ctx.fillText(Math.round(analysis.horizon) + ' m', Math.sin(a) * h + 20 * k, -Math.cos(a) * h);
  if (analysis.preH) { ctx.fillStyle = '#ffd60a'; ctx.fillText(Math.round(analysis.preH) + ' m', 0, -analysis.preH * sc - 6 * k); }
  ctx.textAlign = 'left';
  const nr = -fix.course * Math.PI / 180, rr = Math.min(Wd / 2, Hd * 0.6) - 14 * k;
  ctx.fillStyle = '#e8edf3'; ctx.font = `bold ${14 * k}px system-ui`; ctx.textAlign = 'center'; ctx.fillText('N', Math.sin(nr) * rr, -Math.cos(nr) * rr + 5 * k); ctx.textAlign = 'left';
  ctx.fillStyle = '#3d9bf0'; ctx.beginPath(); ctx.moveTo(0, -14 * k); ctx.lineTo(8 * k, 10 * k); ctx.lineTo(0, 5 * k); ctx.lineTo(-8 * k, 10 * k); ctx.closePath(); ctx.fill();
}
