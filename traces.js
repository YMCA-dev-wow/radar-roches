// Lecture des traces (FIT, GPX, journal du téléphone) et chiffres d'une séance, communs au rejeu (rejeu.html)
// et à la liste des séances (seances.html). Aucune dépendance : fonctions pures sur le contenu du fichier.
'use strict';
const Traces = (() => {
  const EPOCH = 631065600000, SEMI = 180 / 2 ** 31;
  const distM = (a, b) => Math.hypot((b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180), (b.lat - a.lat) * 110540);

  // Vitesse (mesurée par la montre si disponible) et cap sur une fenêtre de ±2 s (lisse le bruit GPS)
  function completer(out) {
    out = out.filter((p, i, a) => isFinite(p.t) && (i === 0 || p.t > a[i - 1].t));
    for (let i = 0; i < out.length; i++) {
      let a = i, b = i;
      while (a > 0 && out[i].t - out[a - 1].t <= 2000) a--;
      while (b < out.length - 1 && out[b + 1].t - out[i].t <= 2000) b++;
      if (a === b) { a = Math.max(0, i - 1); b = Math.min(out.length - 1, i + 1); }
      const p = out[a], q = out[b], kx = 111320 * Math.cos(p.lat * Math.PI / 180);
      const dx = (q.lon - p.lon) * kx, dy = (q.lat - p.lat) * 110540, dt = (q.t - p.t) / 1000 || 1;
      out[i].v = out[i].vDev != null ? out[i].vDev : Math.hypot(dx, dy) / dt;
      out[i].cap = Math.hypot(dx, dy) > 1 ? (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 : (i ? out[i - 1].cap : 0);
    }
    return out;
  }

  // GPX : traces (trkpt) ou routes (rtept) ; une route sans heures reçoit des heures à vitesse supposée (vSupp, km/h)
  function lireGPX(txt, nom, R, vSupp = 22) {
    const doc = new DOMParser().parseFromString(txt, 'application/xml');
    let out = [];
    for (const p of [...doc.getElementsByTagName('trkpt'), ...doc.getElementsByTagName('rtept')]) {
      const tm = p.getElementsByTagName('time')[0];
      const t = tm ? Date.parse(tm.textContent) : NaN, lat = +p.getAttribute('lat'), lon = +p.getAttribute('lon');
      if (isFinite(lat) && isFinite(lon)) out.push({ t, lat, lon });
    }
    R.sansHeure = out.length > 0 && out.filter(p => isFinite(p.t)).length < out.length / 2;
    if (R.sansHeure) {
      // heure de départ : métadonnées, sinon nom du fichier (…2026-10-04T14-06-35Z…), sinon maintenant
      const mt = doc.querySelector('metadata > time');
      const m = (doc.querySelector('metadata > name')?.textContent + ' ' + nom).match(/(\d{4}-\d\d-\d\d)T(\d\d)[-:](\d\d)[-:](\d\d)Z/);
      let t = mt ? Date.parse(mt.textContent) : m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : Date.now();
      const v = Math.max(1, vSupp) / 3.6;
      out = out.map((p, i) => { if (i) t += 1000 * distM(out[i - 1], p) / v; return { t, lat: p.lat, lon: p.lon }; });
    }
    return completer(out);
  }

  // FIT (montres) : « record » = heure, position, vitesse ; champs Connect IQ de l'appli montre (sauts, accélérations
  // brutes acc_x/y/z) ; message « jump » (285) des sauts natifs Garmin
  function lireFIT(buf, R) {
    const dv = new DataView(buf), hs = dv.getUint8(0), fin = hs + dv.getUint32(4, true);
    if (String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11)) !== '.FIT') throw new Error('fichier FIT invalide');
    const defs = {}, out = [], champsDev = {}; // « indexDev/numéro » -> nom (messages field_description, 206)
    let pos = hs, lastTs = 0;
    while (pos < fin) {
      const h = dv.getUint8(pos++);
      let local, compTs = null;
      if (h & 0x80) { local = (h >> 5) & 3; compTs = h & 0x1f; }
      else if (h & 0x40) { // définition
        local = h & 0x0f;
        const le = dv.getUint8(pos + 1) === 0, glob = dv.getUint16(pos + 2, le), n = dv.getUint8(pos + 4);
        pos += 5;
        const fields = [];
        for (let i = 0; i < n; i++, pos += 3) fields.push({ num: dv.getUint8(pos), size: dv.getUint8(pos + 1) });
        const dev = [];
        if (h & 0x20) { const nd = dv.getUint8(pos++); for (let i = 0; i < nd; i++, pos += 3) dev.push({ num: dv.getUint8(pos), size: dv.getUint8(pos + 1), idx: dv.getUint8(pos + 2) }); }
        defs[local] = { le, glob, fields, dev };
        continue;
      } else local = h & 0x0f;
      const d = defs[local];
      if (!d) throw new Error('FIT : message sans définition');
      const rec = {};
      for (const f of d.fields) {
        if (d.glob === 206) { // field_description : 0 index du développeur, 1 numéro du champ, 3 nom
          if (f.num === 0 || f.num === 1) rec[f.num] = dv.getUint8(pos);
          else if (f.num === 3) { let n = ''; for (let i = 0; i < f.size; i++) { const c = dv.getUint8(pos + i); if (!c) break; n += String.fromCharCode(c); } rec[3] = n; }
        }
        if (d.glob === 20 || d.glob === 0 || d.glob === 18) {
          if (f.size === 4) rec[f.num] = f.num === 0 || f.num === 1 ? dv.getInt32(pos, d.le) : dv.getUint32(pos, d.le);
          else if (f.size === 2) rec[f.num] = dv.getUint16(pos, d.le);
          else if (f.size === 1) rec[f.num] = dv.getUint8(pos);
        }
        if (d.glob === 285) { // jump : 0 distance, 1 hauteur, 3 temps de vol (flottants), 2 rotations, 5-6 position, 7/8 vitesse
          if (f.size === 4 && f.num <= 4) rec[f.num] = dv.getFloat32(pos, d.le);
          else if (f.num === 5 || f.num === 6) rec[f.num] = dv.getInt32(pos, d.le);
          else if (f.size === 4) rec[f.num] = dv.getUint32(pos, d.le);
          else if (f.size === 2) rec[f.num] = dv.getUint16(pos, d.le);
          else if (f.size === 1) rec[f.num] = dv.getUint8(pos);
        }
        pos += f.size;
      }
      const devVal = {};
      for (const f of d.dev) {
        const nom = champsDev[f.idx + '/' + f.num];
        if (nom && f.size === 4) devVal[nom] = dv.getFloat32(pos, d.le);
        else if (nom && /^acc_[xyz]$/.test(nom) && f.size >= 4) { const a = []; for (let i = 0; i + 1 < f.size; i += 2) a.push(dv.getInt16(pos + i, d.le)); devVal[nom] = a; }
        pos += f.size;
      }
      if (d.glob === 206 && rec[3]) champsDev[rec[0] + '/' + rec[1]] = rec[3];
      if (rec[253] != null) lastTs = rec[253];
      else if (compTs != null) lastTs = (compTs >= (lastTs & 0x1f) ? lastTs - (lastTs & 0x1f) + compTs : lastTs - (lastTs & 0x1f) + 32 + compTs);
      if (d.glob === 18 && rec[5] != null && rec[5] !== 0xff) R.sportFIT = rec[5]; // session : sport FIT (5 = planche à voile…)
      if (d.glob === 20 && devVal.acc_x && devVal.acc_y && devVal.acc_z && devVal.acc_x[0] !== 32767) R.brut.push({ t: EPOCH + lastTs * 1000, x: devVal.acc_x, y: devVal.acc_y, z: devVal.acc_z }); // 32767 : seconde sans mesure
      if (d.glob === 285 && rec[3] > 0 && rec[3] < 10) {
        const vN = rec[8] != null && rec[8] !== 0xffffffff ? rec[8] / 1000 : rec[7] != null && rec[7] !== 0xffff ? rec[7] / 1000 : null;
        R.sauts.push({ t: EPOCH + lastTs * 1000, vol: Math.round(rec[3] * 100) / 100, h: isFinite(rec[1]) && rec[1] > 0 ? Math.round(rec[1] * 10) / 10 : Math.round(9.81 * rec[3] * rec[3] / 8 * 10) / 10,
          dNat: isFinite(rec[0]) && rec[0] > 0 ? rec[0] : null, vNat: vN, rot: rec[2] != null && rec[2] !== 0xff ? rec[2] : null, natif: true });
        continue;
      }
      if (d.glob !== 20 || rec[0] == null || rec[1] == null || rec[0] === 0x7fffffff || rec[1] === 0x7fffffff) continue;
      const v = rec[73] != null && rec[73] !== 0xffffffff ? rec[73] / 1000 : rec[6] != null && rec[6] !== 0xffff ? rec[6] / 1000 : null;
      out.push({ t: EPOCH + lastTs * 1000, lat: rec[0] * SEMI, lon: rec[1] * SEMI, vDev: v });
      if (devVal.saut > 0) R.sauts.push({ t: EPOCH + lastTs * 1000, h: Math.round(devVal.saut * 10) / 10, vol: Math.round((devVal.saut_vol || 0) * 100) / 100, moy: devVal.saut_moy > 0 ? devVal.saut_moy : null, montre: true }); // sauts de l'appli montre
    }
    return completer(out);
  }

  // Journaux d'avant le filtre du 26/10 (pas de champ « ecarte ») : même critère que SautPlugin.enVol sur la courbe
  // (vrai vol si moyenne < 0,35 g et au moins 70 % des mesures sous 0,6 g)
  function pompage(e) {
    if (!Array.isArray(e.courbe) || e.courbe.length < 60) return false;
    const hz = e.hz || 25, i0 = Math.round((e.avant ?? 2) * hz), vol = e.courbe.slice(i0, i0 + Math.round(e.vol * hz));
    if (vol.length < 10) return true;
    const moy = vol.reduce((s, a) => s + a, 0) / vol.length, bas = vol.filter(a => a < 0.6).length;
    return !(moy < 0.35 && bas >= 0.7 * vol.length);
  }

  // Journal de session de l'appli (.jsonl) : positions « pos » (la, lo, v en km/h) ; « debut » : réglages et profil du radar
  function lireJournal(txt, R) {
    const out = [];
    for (const l of txt.split('\n')) {
      if (!l.trim()) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.type === 'debut') { // plusieurs journaux : réglages de la première séance
        R.reglages = R.reglages || e.reglages || null; R.exemple = R.exemple || e.exemple || null;
        R.profil = R.profil || e.profil || null; R.zone = R.zone || e.zone || null;
      }
      else if (e.type === 'saut' && !e.ecarte && !pompage(e)) R.sauts.push(e); // candidats écartés (pompage, vitesse) gardés au journal
      else if (e.type === 'choc') R.chocs.push(e);
      else if (e.type === 'pos' && isFinite(e.la) && isFinite(e.lo) && !e.sim) out.push({ t: e.t, lat: e.la, lon: e.lo, vDev: e.v != null ? e.v / 3.6 : null });
    }
    return completer(out);
  }

  // contenu : texte (GPX, journal) ou ArrayBuffer (FIT)
  function lire(contenu, nom = '', opts = {}) {
    const R = { pts: [], sauts: [], chocs: [], brut: [], reglages: null, exemple: null, profil: null, zone: null, sansHeure: false, sportFIT: null, type: '' };
    if (typeof contenu !== 'string') { R.type = 'fit'; R.pts = lireFIT(contenu, R); }
    else if (/\.jsonl$/i.test(nom) || contenu.trimStart().startsWith('{')) { R.type = 'journal'; R.pts = lireJournal(contenu, R); }
    else { R.type = 'gpx'; R.pts = lireGPX(contenu, nom, R, opts.vSupp); }
    return R;
  }

  // Chiffres d'une trace : durée, distance, vitesses max (instantanée, sur 2 s, sur 100 / 250 / 500 m et 1 mille).
  // Les sauts de position aberrants (plus de 30 m/s, reprise du GPS) ne comptent pas dans la distance.
  function chiffres(pts) {
    const n = pts.length;
    if (n < 2) return null;
    // distance parcourue : intégrale de la vitesse mesurée par le GPS (effet Doppler, bien moins bruitée que l'écart entre
    // deux positions : 27,6 nd sur 2 s avec les positions le 15/11 pour 20 nd réels) quand le fichier la donne, sinon positions
    const doppler = pts.filter(p => p.vDev != null).length > n * 0.8;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const d = distM(pts[i - 1], pts[i]), dt = (pts[i].t - pts[i - 1].t) / 1000;
      const dv = doppler && dt > 0 && dt <= 10 && pts[i].vDev != null && pts[i - 1].vDev != null ? (pts[i].vDev + pts[i - 1].vDev) / 2 * dt : d;
      cum[i] = cum[i - 1] + (dt > 0 && dv / dt < 30 ? dv : 0);
    }
    // instantanée : médiane de 3 points (écarte les pointes isolées du GPS)
    let vInst = 0;
    for (let i = 1; i < n - 1; i++) { const a = [pts[i - 1].v, pts[i].v, pts[i + 1].v].sort((x, y) => x - y)[1]; if (a < 30 && a > vInst) vInst = a; }
    const surDuree = s => { let m = 0; for (let i = 0, j = 0; i < n; i++) { while (j < n && pts[j].t - pts[i].t < s * 1000) j++; if (j >= n) break; const dt = (pts[j].t - pts[i].t) / 1000; if (dt <= s * 2) m = Math.max(m, (cum[j] - cum[i]) / dt); } return m; };
    const surDist = D => { let m = 0; for (let i = 0, j = 0; i < n; i++) { while (j < n && cum[j] - cum[i] < D) j++; if (j >= n) break; const dt = (pts[j].t - pts[i].t) / 1000; if (dt > 0) m = Math.max(m, (cum[j] - cum[i]) / dt); } return m; };
    const duree = pts[n - 1].t - pts[0].t;
    return { t0: pts[0].t, t1: pts[n - 1].t, duree, dist: cum[n - 1], vmoy: duree > 0 ? cum[n - 1] / (duree / 1000) : 0,
      vInst, v2s: surDuree(2), v100: surDist(100), v250: surDist(250), v500: surDist(500), v1852: surDist(1852) };
  }

  // Trace allégée pour les vignettes et la carte des séances : un point tous les « pas » mètres (au plus ~n points)
  function alleger(pts, n = 150) {
    if (!pts.length) return [];
    let tot = 0; for (let i = 1; i < pts.length; i++) tot += distM(pts[i - 1], pts[i]);
    const pas = Math.max(5, tot / n), r = [[+pts[0].lat.toFixed(5), +pts[0].lon.toFixed(5)]];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) { acc += distM(pts[i - 1], pts[i]); if (acc >= pas || i === pts.length - 1) { r.push([+pts[i].lat.toFixed(5), +pts[i].lon.toFixed(5)]); acc = 0; } }
    return r;
  }

  // Export GPX (trace horodatée)
  function gpx(pts, nom) {
    const esc = s => String(s).replace(/[<&>"]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
    return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Radar roches" xmlns="http://www.topografix.com/GPX/1/1">\n'
      + `<metadata><name>${esc(nom)}</name>${pts.length ? `<time>${new Date(pts[0].t).toISOString()}</time>` : ''}</metadata>\n<trk><name>${esc(nom)}</name><trkseg>\n`
      + pts.map(p => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`).join('\n')
      + '\n</trkseg></trk>\n</gpx>\n';
  }

  return { lire, completer, chiffres, alleger, gpx, pompage, distM };
})();
