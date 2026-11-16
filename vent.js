// Vent d'une séance : prévision AROME HD (Météo-France, via Open-Meteo, au quart d'heure) ou valeurs saisies à la main
// (relevés Holfuy, WindsUp, anémo perso…), et ce qu'on en tire : vent à l'instant, VMG, allures, virements et empannages.
// Stockage par séance dans localStorage « radar.vent.<id> » :
//   { arome: { lat, lon, t0, t1, pts: [[t, v, raf, dir]] }, saisi: { type: 'unique'|'heures', pts: [[t, v, raf, dir]], source }, mode: 'arome'|'saisi' }
// v, raf en m/s ; dir en degrés, d'où vient le vent ; t en ms.
'use strict';
const Vent = (() => {
  const lire = id => { try { return JSON.parse(localStorage.getItem('radar.vent.' + id)) || {}; } catch { return {}; } };
  const ecrire = (id, o) => { try { localStorage.setItem('radar.vent.' + id, JSON.stringify(o)); } catch {} };
  const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  const cardinal = d => POINTS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
  // direction saisie : « 225 », « 225° », « SO », « sw »… → degrés (null si illisible)
  function lireDir(s) {
    s = String(s || '').trim().toUpperCase().replace('°', '').replace(/W/g, 'O');
    if (!s) return null;
    if (/^\d+([.,]\d+)?$/.test(s)) return (parseFloat(s.replace(',', '.')) % 360 + 360) % 360;
    const i = POINTS.indexOf(s); return i < 0 ? null : i * 22.5;
  }
  const rad = d => d * Math.PI / 180;
  // moyenne de directions (vecteurs unitaires pondérés)
  function dirMoy(l) { let x = 0, y = 0; for (const [d, w = 1] of l) { x += w * Math.sin(rad(d)); y += w * Math.cos(rad(d)); } return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360; }

  // ---------- AROME HD par Open-Meteo ----------
  // Prévisions des 3 derniers mois : API de prévision ; plus anciennes (depuis 2022) : archive des prévisions
  async function telechargerArome(lat, lon, t0, t1) {
    const j = t => new Date(t).toISOString().slice(0, 10);
    const base = Date.now() - t0 < 80 * 864e5 ? 'https://api.open-meteo.com/v1/forecast' : 'https://historical-forecast-api.open-meteo.com/v1/forecast';
    for (const modele of ['meteofrance_arome_france_hd', 'meteofrance_arome_france', 'meteofrance_seamless']) {
      const u = `${base}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&start_date=${j(t0 - 3600e3)}&end_date=${j(t1 + 3600e3)}` +
        `&minutely_15=wind_speed_10m,wind_direction_10m,wind_gusts_10m&models=${modele}&wind_speed_unit=ms&timezone=GMT`;
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const d = await r.json(), m = d.minutely_15;
      if (!m || !m.time) continue;
      const pts = [];
      m.time.forEach((t, i) => {
        const tt = Date.parse(t + 'Z'), v = m.wind_speed_10m[i], dir = m.wind_direction_10m[i];
        if (tt >= t0 - 3600e3 && tt <= t1 + 3600e3 && v != null && dir != null) pts.push([tt, v, m.wind_gusts_10m[i], dir]);
      });
      if (pts.length >= 2) return { lat, lon, t0, t1, modele, pts };
    }
    throw new Error('prévision indisponible');
  }
  // prévision de la séance (gardée ; retéléchargée seulement si la séance ou sa position changent)
  async function arome(id, lat, lon, t0, t1) {
    const o = lire(id), a = o.arome;
    if (a && a.pts && a.pts.length && Math.abs(a.lat - lat) < 0.02 && Math.abs(a.lon - lon) < 0.02 && a.t0 <= t0 + 60e3 && a.t1 >= t1 - 60e3) return a;
    const n = await telechargerArome(lat, lon, t0, t1);
    const o2 = lire(id); o2.arome = n; if (!o2.mode) o2.mode = 'arome'; ecrire(id, o2);
    return n;
  }
  // vent retenu pour la séance : saisi s'il existe et choisi, sinon AROME (null si rien)
  function courant(id) {
    const o = lire(id);
    if (o.mode === 'saisi' && o.saisi && o.saisi.pts && o.saisi.pts.length) return { source: 'saisi', pts: o.saisi.pts, type: o.saisi.type, src: o.saisi.source || '' };
    if (o.arome && o.arome.pts && o.arome.pts.length) return { source: 'arome', pts: o.arome.pts };
    return null;
  }
  function saisir(id, type, pts, source) { const o = lire(id); o.saisi = { type, pts, source: source || '' }; o.mode = 'saisi'; ecrire(id, o); }
  function revenirArome(id) { const o = lire(id); o.mode = 'arome'; ecrire(id, o); }

  // vent à l'instant t : interpolation linéaire (direction par le plus court chemin) ; constant si un seul point
  function a(W, t) {
    const p = W.pts; if (!p.length) return null;
    if (p.length === 1 || t <= p[0][0]) return { v: p[0][1], raf: p[0][2], dir: p[0][3] };
    if (t >= p[p.length - 1][0]) { const q = p[p.length - 1]; return { v: q[1], raf: q[2], dir: q[3] }; }
    let i = 0; while (i < p.length - 2 && p[i + 1][0] <= t) i++;
    const A = p[i], B = p[i + 1], f = (t - A[0]) / (B[0] - A[0]), dd = ((B[3] - A[3] + 540) % 360) - 180;
    return { v: A[1] + f * (B[1] - A[1]), raf: A[2] != null && B[2] != null ? A[2] + f * (B[2] - A[2]) : (A[2] ?? B[2]), dir: (A[3] + f * dd + 360) % 360 };
  }
  // résumé du vent sur [t0, t1] : moyenne, début, fin, direction moyenne
  function resume(W, t0, t1) {
    const n = 24, l = [];
    for (let k = 0; k <= n; k++) l.push(a(W, t0 + (t1 - t0) * k / n));
    return { v: l.reduce((s, x) => s + x.v, 0) / l.length, deb: l[0], fin: l[n], dir: dirMoy(l.map(x => [x.dir, x.v || 1])),
      raf: Math.max(...l.map(x => x.raf || 0)) || null };
  }

  // ---------- VMG, allures, manœuvres ----------
  // pts : [{ t, v (m/s), cap }] ; W : vent. Seuls comptent les points en mouvement (plus de 2,5 m/s, ≈ 5 nd).
  // Allures (angle au vent) : près < 70°, travers 70–110°, portant > 110°. VMG = v·cos(angle) ; meilleure VMG sur 10 s.
  const MOUV = 2.5, NOMS = ['près', 'travers', 'portant'];
  const allure = twa => twa < 70 ? 0 : twa <= 110 ? 1 : 2;
  function analyse(pts, W) {
    const n = pts.length; if (n < 3 || !W) return null;
    const twa = new Float32Array(n), rel = new Float32Array(n), up = new Float32Array(n), dt = new Float32Array(n), mouv = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const w = a(W, pts[i].t), r = ((w.dir - pts[i].cap + 540) % 360) - 180; // > 0 : vent par tribord
      rel[i] = r; twa[i] = Math.abs(r); up[i] = pts[i].v * Math.cos(rad(twa[i]));
      dt[i] = i < n - 1 ? Math.min(5000, pts[i + 1].t - pts[i].t) / 1000 : 0; mouv[i] = pts[i].v >= MOUV;
    }
    const temps = [0, 0, 0]; let sPres = 0, tPres = 0; const angP = { tribord: [0, 0], babord: [0, 0] };
    for (let i = 0; i < n; i++) {
      if (!mouv[i]) continue;
      const c = allure(twa[i]); temps[c] += dt[i];
      if (c === 0) { sPres += up[i] * dt[i]; tPres += dt[i]; const am = rel[i] > 0 ? angP.tribord : angP.babord; am[0] += twa[i] * dt[i]; am[1] += dt[i]; }
    }
    // meilleure VMG sur 10 s glissantes (points en mouvement seulement)
    let bestUp = 0, bestDown = 0;
    for (let i = 0, j = 0, s = 0, d = 0; i < n; i++) {
      while (j < n && pts[j].t - pts[i].t <= 10000) { if (mouv[j]) { s += up[j] * dt[j]; d += dt[j]; } j++; }
      if (pts[Math.min(j, n) - 1].t - pts[i].t >= 9000 && d >= 8) { bestUp = Math.max(bestUp, s / d); bestDown = Math.max(bestDown, -s / d); }
      if (mouv[i]) { s -= up[i] * dt[i]; d -= dt[i]; }
    }
    // virements et empannages : changement d'amure confirmé (nouvelle amure tenue 8 s en mouvement) ;
    // virement si le cap est passé par le vent (angle minimal < 90°), empannage s'il est passé par le vent arrière
    let amure = 0, depuis = -1, candidat = 0, tCand = 0, iCand = 0, vir = 0, emp = 0, dernierStable = -1;
    for (let i = 0; i < n; i++) {
      if (!mouv[i]) continue;
      const s = rel[i] > 0 ? 1 : -1;
      if (!amure) { amure = s; dernierStable = i; continue; }
      if (s === amure) { candidat = 0; dernierStable = i; continue; }
      if (candidat !== s) { candidat = s; tCand = pts[i].t; iCand = i; }
      if (pts[i].t - tCand >= 8000) {
        let mn = 180; for (let k = Math.max(0, dernierStable); k <= iCand + 2 && k < n; k++) mn = Math.min(mn, twa[k]);
        if (mn < 90) vir++; else emp++;
        amure = s; candidat = 0; dernierStable = i;
      }
    }
    const tot = temps[0] + temps[1] + temps[2];
    return { bestUp, bestDown, vmgPres: tPres ? sPres / tPres : null, angTribord: angP.tribord[1] > 20 ? angP.tribord[0] / angP.tribord[1] : null,
      angBabord: angP.babord[1] > 20 ? angP.babord[0] / angP.babord[1] : null, virements: vir, empannages: emp,
      allures: tot ? temps.map(x => x / tot) : [0, 0, 0], twa, rel };
  }
  return { lire, cardinal, lireDir, arome, courant, saisir, revenirArome, a, resume, analyse, allure, NOMS };
})();
