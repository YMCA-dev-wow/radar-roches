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
    const n = 96, l = [];
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
  // ---------- relevés collés (page Holfuy, WindsUp…) ou fichier CSV ----------
  // Le texte est découpé en mots ; seuls comptent les relevés rattachés à une heure (14:15, 14h15), le reste (menus, titres,
  // publicités, code de page) est ignoré. Les relevés retenus ont tous la même forme (mêmes valeurs dans le même ordre),
  // les autres sont écartés. Colonnes : direction = points cardinaux ou degrés concordants ; vitesses rangées par dominance
  // (sur chaque ligne mini ≤ moyen ≤ rafale) ; température, pression, humidité écartées (unités ou plages).
  // Les en-têtes (CSV, ou libellés de lignes d'un tableau en colonnes comme Holfuy) priment sur ces déductions.
  const UNITES = { nd: 1 / 1.94384, kmh: 1 / 3.6, ms: 1 };
  const uniteDe = s => /(^|[^a-z])(nds?|n[oœ]euds?|kts?|knots?)([^a-z]|$)/i.test(s) ? 'nd' : /km\s?\/\s?h|\bkmh\b/i.test(s) ? 'kmh' : /\bm\s?\/\s?s\b/i.test(s) ? 'ms' : null;
  function mot(x) {
    const s = String(x).replace(/^[(\[]+|[)\],.:]+$/g, '');
    let m = /^(\d{1,2})[:hH](\d{2})(?::\d{2})?$/.exec(s);
    if (m && +m[1] < 24 && +m[2] < 60) return { k: 't', h: +m[1], mi: +m[2] };
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return { k: 'd', a: +m[1], mo: +m[2], j: +m[3] };
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s))) return { k: 'd', a: +m[3] < 100 ? 2000 + +m[3] : +m[3], mo: +m[2], j: +m[1] };
    if ((m = /^(-?\d+(?:[.,]\d+)?)(°c|°|nds?|kts?|km\/h|kmh|m\/s|%|hpa|mb)?$/i.exec(s))) return { k: 'n', v: parseFloat(m[1].replace(',', '.')), u: (m[2] || '').toLowerCase() };
    const c = POINTS.indexOf(s.toUpperCase().replace(/W/g, 'O'));
    if (c >= 0) return { k: 'c', v: c * 22.5 };
    if (/^(°c?|nds?|kts?|km\/h|kmh|m\/s|%|hpa|mb)$/i.test(s)) return { k: 'u', u: s.toLowerCase() };
    return { k: 'w', s };
  }
  const ecartDir = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  // rôle des colonnes : rows = relevés de même forme ({ k: 'n'|'c', v, u }) ; libs = en-têtes éventuels
  function attribuer(rows, libs = []) {
    const nc = rows[0].length, m = {}, pris = new Set();
    const prendre = (cle, j) => { if (m[cle] == null && !pris.has(j)) { m[cle] = j; pris.add(j); } };
    for (let j = 0; j < nc; j++) {
      const l = (libs[j] || '').toLowerCase(); if (!l) continue;
      if (/temp|°c|hum|press|hpa|pluie|rain|batt/.test(l)) pris.add(j);
      else if (/dir/.test(l)) prendre(rows[0][j].k === 'c' ? 'dirC' : 'dir', j);
      else if (/raf|gust|max|pointe/.test(l)) prendre('raf', j);
      else if (/min/.test(l)) prendre('min', j);
      else if (/moy|avg|aver|mean|vit|speed|vent|wind/.test(l)) prendre('v', j);
    }
    const col = j => rows.map(r => r[j]);
    for (let j = 0; j < nc; j++) if (rows[0][j].k === 'c') prendre('dirC', j);
    for (let j = 0; j < nc; j++) { // degrés : concordent avec les points cardinaux, ou marqués « ° »
      if (pris.has(j) || rows[0][j].k !== 'n') continue;
      const c = col(j);
      if (m.dirC != null ? c.filter((x, i) => x.v >= 0 && x.v <= 360 && ecartDir(x.v, rows[i][m.dirC].v) <= 50).length >= 0.8 * c.length : c.some(x => x.u === '°')) prendre('dir', j);
    }
    const cand = [];
    for (let j = 0; j < nc; j++) {
      if (pris.has(j) || rows[0][j].k !== 'n') continue;
      const c = col(j), u = (c.find(x => x.u) || {}).u || '', mx = Math.max(...c.map(x => x.v));
      if (/°c|%|hpa|mb/.test(u) || mx > 400) { pris.add(j); continue; }
      if (m.dir == null && m.dirC == null && mx > 90 && mx <= 360) { prendre('dir', j); continue; }
      cand.push(j);
    }
    const sous = (a, b) => rows.filter(r => r[a].v <= r[b].v + 1e-9).length >= 0.9 * rows.length; // a ≤ b sur presque toutes les lignes
    const moy = j => rows.reduce((s, r) => s + r[j].v, 0) / rows.length;
    if (m.v == null) {
      const s = cand.sort((a, b) => moy(a) - moy(b));
      if (s.length >= 3 && sous(s[0], s[1]) && sous(s[1], s[2])) { prendre('min', s[0]); prendre('v', s[1]); prendre('raf', s[2]); }
      else if (s.length >= 2 && sous(s[0], s[1])) { prendre('v', s[0]); prendre('raf', s[1]); }
      else if (s.length) prendre('v', s[0]);
    } else if (m.raf == null) { const r = cand.find(j => !pris.has(j) && sous(m.v, j)); if (r != null) prendre('raf', r); }
    const N = { min: 'mini (ignoré)', v: 'vent moyen', raf: 'rafales', dir: 'direction', dirC: m.dir != null ? 'direction en points (doublon)' : 'direction' };
    const noms = []; for (let j = 0; j < nc; j++) { const k = Object.keys(m).find(x => m[x] === j); noms.push(k ? N[k] : 'ignorée'); }
    return { m, noms };
  }
  // heure locale → instant : date lue dans le texte, sinon le jour (veille, jour même ou lendemain) le plus proche de la séance
  function instant(h, mi, d, t0, t1) {
    if (d) return +new Date(d.a, d.mo - 1, d.j, h, mi);
    let best = null;
    for (const k of [-1, 0, 1]) {
      const x = new Date(t0); x.setDate(x.getDate() + k); x.setHours(h, mi, 0, 0);
      const e = +x < t0 ? t0 - x : +x > t1 ? x - t1 : 0;
      if (!best || e < best.e) best = { t: +x, e };
    }
    return best.t;
  }
  function lireReleves(texte, t0, t1, opt = {}) {
    texte = String(texte || '').replace(/ /g, ' ');
    const lignes = texte.split(/\r?\n/).filter(l => l.trim()), tout = texte + ' ' + (opt.nom || '');
    const source = /winds-?up/i.test(tout) ? 'WindsUp' : /holfuy/i.test(tout) ? 'Holfuy' : '';
    const valeur = x => x.k === 'n' || x.k === 'c';
    let recs = [], ecartees = 0, libs = [], uniteTxt = null; // recs : { t, vals }
    const tete = lignes[0] || '', sep = [';', '\t', ','].find(s => tete.split(s).length >= 4 && /[a-z]/i.test(tete) && !tete.split(/[\s;,\t]+/).some(x => mot(x).k === 't'));
    if (sep) {
      // ---- CSV avec en-tête : colonne de temps (horodatage Unix, date et heure, ou heure seule) puis colonnes de valeurs
      const H = tete.split(sep).map(x => x.trim()), n = H.length; uniteTxt = uniteDe(tete);
      const L = lignes.slice(1).map(l => l.split(sep).map(x => x.trim()));
      let ok = L.filter(r => r.length === n || (r.length === n + 1 && r[n] === ''));
      const heureDe = s => s.split(/[\sT]+/).map(mot);
      const jt = H.findIndex((h, j) => /time|stamp|epoch|unix/i.test(h) && ok.filter(r => /^\d{9,13}$/.test(r[j])).length >= 0.5 * ok.length);
      const jd = H.findIndex((h, j) => j !== jt && ok.filter(r => heureDe(r[j]).some(x => x.k === 't')).length >= 0.5 * ok.length);
      if (jt < 0 && jd < 0) return { pts: [], erreur: "Aucune colonne d'heure reconnue dans le fichier." };
      ok = ok.filter(r => jt >= 0 ? /^\d{9,13}$/.test(r[jt]) : heureDe(r[jd]).some(x => x.k === 't'));
      ecartees = L.filter(r => r.length >= n - 1).length - ok.length; // lignes de données illisibles (le reste du fichier est ignoré sans le compter)
      const cols = [];
      for (let j = 0; j < n; j++) {
        if (j === jt || j === jd || /^id$|\bid\b|anemometer|station|spot/i.test(H[j])) continue;
        const ks = ok.map(r => mot(r[j]).k);
        if (ks.every(k => k === 'n') || ks.every(k => k === 'c')) cols.push(j);
      }
      libs = cols.map(j => H[j]);
      for (const r of ok) {
        let t;
        if (jt >= 0) { const x = +r[jt]; t = x > 1e12 ? x : x * 1000; }
        else { const ms = heureDe(r[jd]), h = ms.find(x => x.k === 't'), d = ms.find(x => x.k === 'd'); t = instant(h.h, h.mi, d, t0, t1); }
        recs.push({ t, vals: cols.map(j => mot(r[j])) });
      }
    } else {
      const parLigne = lignes.map(l => l.split(/[\s;|]+/).filter(Boolean).map(mot));
      const jT = parLigne.findIndex(l => l.filter(x => x.k === 't').length >= 3);
      if (jT >= 0) {
        // ---- tableau en colonnes (Holfuy) : une ligne d'heures, puis une ligne par mesure (libellé + autant de valeurs)
        const T = parLigne[jT].filter(x => x.k === 't'), d = parLigne.slice(0, jT + 1).flat().find(x => x.k === 'd'), rangs = [];
        for (const l of parLigne.slice(jT + 1)) {
          const v = l.filter(valeur);
          if (v.length === T.length && v.every(x => x.k === v[0].k)) {
            rangs.push(v); libs.push(l.filter(x => x.k === 'w').map(x => x.s).join(' ') + ' ' + ((l.find(x => x.k === 'u') || {}).u || ''));
          } else if (l.filter(x => x.k === 't').length >= 3) break;
        }
        if (!rangs.length) return { pts: [], erreur: 'Aucune ligne de valeurs sous les heures.' };
        T.forEach((h, i) => recs.push({ t: instant(h.h, h.mi, d, t0, t1), vals: rangs.map(r => r[i]) }));
        uniteTxt = uniteDe(libs.join(' ')) || uniteDe(texte);
      } else {
        // ---- relevés à la suite (WindsUp, tableau copié ligne à ligne) : heure puis valeurs ;
        // si le texte commence par des valeurs et finit par une heure, c'est que l'heure suit les valeurs
        const M = parLigne.flat();
        M.forEach((x, i) => { if (x.k === 'u' && i && M[i - 1].k === 'n' && !M[i - 1].u) M[i - 1].u = x.u; });
        const V = M.filter(x => x.k !== 'u'), iT = [];
        V.forEach((x, i) => { if (x.k === 't') iT.push(i); });
        if (!iT.length) return { pts: [], erreur: 'Aucune heure reconnue dans le texte.' };
        const finitParHeure = !V.slice(iT[iT.length - 1] + 1).some(valeur), commenceParValeur = V.slice(0, iT[0]).some(valeur);
        const avant = finitParHeure && commenceParValeur; // heure après les valeurs
        let d = null; const bruts = [];
        iT.forEach((it, q) => {
          const a = avant ? (q ? iT[q - 1] + 1 : 0) : it + 1, b = avant ? it : (iT[q + 1] ?? V.length);
          for (const x of V.slice(q ? iT[q - 1] : 0, it)) if (x.k === 'd') d = x;
          bruts.push({ h: V[it], d, vals: V.slice(a, b).filter(valeur) });
        });
        if (!avant && commenceParValeur) ecartees++;
        const forme = r => r.vals.map(x => x.k + (/°c|%|hpa|mb/.test(x.u) ? x.u : '')).join('');
        const nb = {}; bruts.forEach(r => { if (r.vals.length) { const f = forme(r); nb[f] = (nb[f] || 0) + 1; } });
        const dom = Object.keys(nb).sort((a, b) => nb[b] - nb[a])[0];
        if (!dom) return { pts: [], erreur: 'Aucune valeur de vent reconnue après les heures.' };
        // un relevé suivi de texte parasite (pied de page, publicité) garde ses premières valeurs s'il commence par la forme dominante
        const nd = nb[dom] && dom.match(/[a-z](°c|%|hpa|mb)?/g).length;
        for (const r of bruts) {
          const v = r.vals.length > nd && forme({ vals: r.vals.slice(0, nd) }) === dom ? r.vals.slice(0, nd) : r.vals;
          if (forme({ vals: v }) === dom) recs.push({ t: instant(r.h.h, r.h.mi, r.d, t0, t1), vals: v }); else ecartees++;
        }
        uniteTxt = uniteDe(texte);
      }
    }
    if (!recs.length || !recs[0].vals.length) return { pts: [], erreur: 'Aucune valeur de vent reconnue.' };
    const A = attribuer(recs.map(r => r.vals), libs), m = A.m;
    if (m.v == null || (m.dir == null && m.dirC == null)) return { pts: [], erreur: 'Colonnes de vent et de direction non reconnues.', colonnes: A.noms };
    const unite = opt.unite || uniteTxt || 'nd', k = UNITES[unite];
    const tous = recs.map(r => [r.t, r.vals[m.v].v * k, m.raf != null ? r.vals[m.raf].v * k : null, m.dir != null ? r.vals[m.dir].v % 360 : r.vals[m.dirC].v]);
    const dedans = tous.filter(p => p[0] >= t0 - 1800e3 && p[0] <= t1 + 1800e3).sort((a, b) => a[0] - b[0]).filter((p, i, l) => !i || p[0] !== l[i - 1][0]);
    const res = { pts: dedans, unite, uniteLue: !!(opt.unite || uniteTxt), colonnes: A.noms, ecartees, hors: tous.length - dedans.length, total: tous.length, source };
    if (!dedans.length) {
      const t = tous.map(p => p[0]), f = x => new Date(x).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
      res.erreur = `${tous.length} relevés lus, mais aucun pendant la séance (ils vont du ${f(Math.min(...t))} au ${f(Math.max(...t))}).`;
    }
    return res;
  }
  return { lire, cardinal, lireDir, arome, courant, saisir, revenirArome, a, resume, analyse, allure, NOMS, lireReleves, UNITES };
})();
