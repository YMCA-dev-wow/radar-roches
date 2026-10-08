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
const CONE_ALERTE = 50, CONE_PRE = 10;
function analyser(pos, course, speed, W, opts) {
  const { seuil, smooth, useL3d, inclTest, antic, roches = [], affichage = true, preAlerte = false } = opts;
  const horizon = Math.max(40, speed * antic);                                   // distance d'alerte (m)
  const preH = preAlerte ? 2 * horizon : 0;                                      // distance de pré-alerte (m)
  const R = affichage ? Math.min(300, Math.max(120, horizon * 1.6, preH * 1.1)) : Math.max(horizon, preH); // rayon de lecture
  const mpp = mPerPx(pos.lat), [px, py] = toPx(pos.lat, pos.lon);
  const rp = Math.ceil(R / mpp);
  const cells = [];                                                              // [dx, dy, niveau] en mètres, est/sud positifs
  let best = null, pre = null;
  const consider = (dx, dy, lvl, d) => {
    let rel = Math.atan2(dx, -dy) * 180 / Math.PI - course; rel = ((rel + 540) % 360) - 180;
    if (preH && d > horizon && d <= preH && Math.abs(rel) <= CONE_PRE && (!pre || d < pre.d)) pre = { d, rel, lvl };
    const inCone = Math.abs(rel) <= CONE_ALERTE || d < 20;
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
  return { cells, zones, best, pre, horizon, preH, R };
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
  tintement(t); motif(0, 2, t + 1.0); motif(40, 2, t + 1.8); motif(-40, 2, t + 2.6); motif(0, 3, t + 3.4); gpsPerdu(t + 4.2);
}
// Joue l'alerte correspondant à la menace b, sinon la pré-alerte pre (appelé à chaque pas) ; armed = vitesse suffisante
let nextPre = 0;
function sonnerMenace(b, horizon, armed, pre) {
  const at = audio().currentTime;
  if (b && armed && !muted) {
    if (b.d < 10) { continu(true, b.lvl === 3 ? 1400 : 1100); return; }
    continu(false);
    const period = 0.18 + 1.1 * Math.min(1, b.d / horizon);
    if (at > nextBeep) { motif(b.rel, b.lvl, at); nextBeep = at + period; }
    return;
  }
  continu(false);
  if (pre && armed && !muted && at > nextPre) { tintement(at); nextPre = at + 3; } // rappel toutes les 3 s tant que le danger reste devant
}
// Niveau d'alerte pour la frise : 0 rien, 1 bips, 2 son continu (< 10 m), 3 contact (< 3 m)
function niveauAlerte(b, armed) {
  if (!b || !armed) return 0;
  return b.d < 3 ? 3 : b.d < 10 ? 2 : 1;
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
