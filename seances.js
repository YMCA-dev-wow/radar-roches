// Séances : la liste des sorties (journaux du téléphone et fichiers importés), leurs chiffres, le sport, le commentaire,
// les regroupements et suppressions, les unités et les choix d'affichage. Utilisé par seances.html et rejeu.html.
//  - source : un journal du téléphone (« j:nom ») ou un fichier importé (« f:id », gardé dans IndexedDB) ;
//  - séance : une source, ou plusieurs regroupées à la main (« g:… ») ; une source = une séance par défaut ;
//  - résumé : chiffres d'une source (durée, distance, vitesses max, sauts, trace allégée), calculé une fois et gardé.
'use strict';
const Seances = (() => {
  const APPLI_S = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  let nj = null;
  const NJ = () => nj || (nj = (typeof Natif !== 'undefined' && Natif && Natif.journal) || window.Capacitor.registerPlugin('Journal'));
  const VERSION_RESUME = 2; // à augmenter quand le calcul des chiffres change (résumés recalculés)

  // ---------- préférences et réglages (localStorage) ----------
  const lireLS = (k, d) => { try { const v = localStorage.getItem('radar.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const ecrireLS = (k, v) => { try { localStorage.setItem('radar.' + k, JSON.stringify(v)); } catch {} };
  const pref = (k, d) => lireLS('seances.' + k, d);
  const setPref = (k, v) => ecrireLS('seances.' + k, v);

  // ---------- unités ----------
  const unites = () => Object.assign({ v: 'nd', d: 'km' }, lireLS('unites', {}));
  const setUnites = u => ecrireLS('unites', Object.assign(unites(), u));
  const fr = (x, n = 1) => x.toFixed(n).replace('.', ',');
  function vit(ms, n = 1) { const u = unites().v; return u === 'kmh' ? { n: fr(ms * 3.6, n), u: 'km/h' } : u === 'ms' ? { n: fr(ms, n), u: 'm/s' } : { n: fr(ms * 1.94384, n), u: 'nd' }; }
  // distance : km ou milles nautiques (NM), jamais de « mi » ambigu (mile terrestre)
  function dist(m, n = 1) { return unites().d === 'mi' ? { n: fr(m / 1852, n), u: 'NM' } : { n: fr(m / 1000, n), u: 'km' }; }
  const duree = ms => { const mn = Math.round(ms / 60000); return Math.floor(mn / 60) + ':' + String(mn % 60).padStart(2, '0'); };

  // ---------- sports ----------
  // une entrée par sport ; couleurs vives, vérifiées deux à deux dans l'ordre de la liste (fond sombre et clair) ;
  // rouge, orange et jaune restent réservés aux alertes ; « Autre » en gris neutre
  const SPORTS_DEFAUT = [
    { id: 'autre', nom: 'Autre', c: '#8a8a8a' }, { id: 'kitefoil', nom: 'Kitefoil', c: '#a855f7' }, { id: 'kite', nom: 'Kitesurf', c: '#e8389a' },
    { id: 'sup', nom: 'Paddle', c: '#c08a0c' }, { id: 'parawing', nom: 'Parawing', c: '#0fa596' }, { id: 'surf', nom: 'Surf', c: '#9a9a10' },
    { id: 'foil', nom: 'Surf foil, downwind', c: '#1e88e5' }, { id: 'voile', nom: 'Voile', c: '#b9702a' }, { id: 'windfoil', nom: 'Windfoil', c: '#0aa3bd' },
    { id: 'windsurf', nom: 'Windsurf', c: '#5b6cff' }, { id: 'wing', nom: 'Wingfoil', c: '#1aad54' },
  ];
  const PALETTE = ['#1aad54', '#5b6cff', '#e8389a', '#0aa3bd', '#a855f7', '#c08a0c', '#0fa596', '#1e88e5', '#b9702a', '#9a9a10', '#8a8a8a'];
  // anciennes couleurs pastel (avant le 16/11) : remplacées par les nouvelles dans une liste déjà enregistrée
  const PASTEL = ['#5ee6d6', '#6c8cff', '#a9b8ff', '#f2a3d3', '#d9b8f0', '#b8c97a', '#7fd1a8', '#d9c58f', '#9fb7c4', '#8a9aa0', '#e7b38a'];
  // liste triée par ordre alphabétique, « Autre » à la fin
  const trier = l => l.slice().sort((a, b) => (a.id === 'autre') - (b.id === 'autre') || a.nom.localeCompare(b.nom, 'fr'));
  function sports() {
    const l = lireLS('sports', null);
    if (!l) return trier(SPORTS_DEFAUT.map(s => ({ ...s })));
    for (const s of l) if (PASTEL.includes(s.c)) { const d = SPORTS_DEFAUT.find(x => x.id === s.id); s.c = d ? d.c : PALETTE[l.indexOf(s) % PALETTE.length]; }
    return trier(l);
  }
  const setSports = l => ecrireLS('sports', trier(l));
  const sport = id => sports().find(s => s.id === id) || null;
  // sport proposé d'après le profil du radar ou le sport du fichier FIT (43 planche à voile, 44 kitesurf, 37 paddle, 38 surf)
  const PROFIL_SPORT = { Foil: 'wing', Planche: 'windsurf', Kite: 'kite' };
  const FIT_SPORT = { 43: 'windsurf', 44: 'kite', 37: 'sup', 38: 'surf', 32: 'voile' };

  // ---------- métadonnées : sport, commentaire, lieu, regroupements, suppressions ----------
  const meta = () => Object.assign({ seances: {}, groupes: {}, supprimes: [] }, lireLS('seances.meta', {}));
  const setMeta = m => ecrireLS('seances.meta', m);

  // ---------- IndexedDB : fichiers importés et résumés ----------
  let dbP = null;
  function db() {
    return dbP || (dbP = new Promise((ok, ko) => {
      const r = indexedDB.open('radar-seances', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('fichiers'); r.result.createObjectStore('resumes'); };
      r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
    }));
  }
  async function idb(store, mode, f) {
    const d = await db();
    return new Promise((ok, ko) => { const tx = d.transaction(store, mode), s = tx.objectStore(store), r = f(s); tx.oncomplete = () => ok(r && r.result); tx.onerror = () => ko(tx.error); });
  }
  const idbGet = (s, k) => idb(s, 'readonly', st => st.get(k));
  const idbPut = (s, k, v) => idb(s, 'readwrite', st => st.put(v, k));
  const idbDel = (s, k) => idb(s, 'readwrite', st => st.delete(k));
  const idbTout = s => idb(s, 'readonly', st => st.getAll());
  const idbCles = s => idb(s, 'readonly', st => st.getAllKeys());

  // ---------- sources ----------
  async function sources() {
    const l = [];
    if (APPLI_S) {
      try { for (const j of (await NJ().liste()).journaux || []) l.push({ src: 'j:' + j.nom, nom: j.nom, date: j.date, taille: j.taille, type: 'journal' }); } catch {}
    }
    try {
      const cles = await idbCles('fichiers'), fs = await idbTout('fichiers');
      fs.forEach((f, i) => l.push({ src: 'f:' + cles[i], nom: f.nom, date: f.ajoute, taille: f.taille, type: f.type }));
    } catch {}
    return l;
  }
  async function contenu(src) {
    if (src.startsWith('j:')) return (await NJ().lire({ nom: src.slice(2) })).texte;
    if (src.startsWith('f:')) { const f = await idbGet('fichiers', src.slice(2)); if (!f) throw new Error('fichier introuvable'); return f.data; }
    if (src.startsWith('ex:')) return (await fetch(`donnees/exemples/exemple${src.slice(3)}.jsonl`)).text();
    throw new Error('source inconnue');
  }
  // nom d'origine d'une source (fichier importé : nom du fichier ; journal : nom du journal)
  async function nomSource(src) {
    if (src.startsWith('f:')) { try { const f = await idbGet('fichiers', src.slice(2)); if (f) return f.nom; } catch {} }
    return src.replace(/^[a-z]+:/, '');
  }
  async function ajouterFichier(file) {
    const fit = /\.fit$/i.test(file.name), data = fit ? await file.arrayBuffer() : await file.text();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await idbPut('fichiers', id, { nom: file.name, type: fit ? 'fit' : /\.jsonl$/i.test(file.name) ? 'journal' : 'gpx', data, taille: file.size, ajoute: Date.now() });
    return 'f:' + id;
  }

  // ---------- résumés ----------
  let zonesP = null;
  const zones = () => zonesP || (zonesP = fetch('donnees/zones.json').then(r => r.json()).catch(() => []));
  // lieu : port de la zone le plus proche en longitude du départ
  async function lieuDe(lat, lon) {
    const zs = await zones(); let z = null, bd = Infinity;
    for (const c of zs) { const [a, b, cc, d] = c.bornes, dd = Math.max(0, a - lat, lat - cc) + Math.max(0, b - lon, lon - d); if (dd < bd) { bd = dd; z = c; } }
    if (!z || bd > 0.2) return '';
    let p = null, pd = Infinity; for (const q of z.ports || []) if (Math.abs(q.lon - lon) < pd) { pd = Math.abs(q.lon - lon); p = q; }
    return p ? p.nom : z.nom;
  }
  async function calculerResume(s) {
    const R = Traces.lire(await contenu(s.src), s.nom), c = Traces.chiffres(R.pts);
    const r = { v: VERSION_RESUME, taille: s.taille, nom: s.nom, type: R.type, nPos: R.pts.length, nSauts: R.sauts.length,
      hMax: R.sauts.reduce((m, x) => Math.max(m, x.h || 0), 0), profil: R.profil, sportAuto: PROFIL_SPORT[R.profil] || FIT_SPORT[R.sportFIT] || null };
    if (c) Object.assign(r, c, { trace: Traces.alleger(R.pts), lieu: await lieuDe(R.pts[0].lat, R.pts[0].lon) });
    return r;
  }
  async function resume(s) {
    try { const r = await idbGet('resumes', s.src); if (r && r.v === VERSION_RESUME && r.taille === s.taille) return r; } catch {}
    const r = await calculerResume(s);
    try { await idbPut('resumes', s.src, r); } catch {}
    return r;
  }
  // une séance trop courte (radar ouvert sans naviguer) n'apparaît pas dans la liste
  const vide = r => !r || !r.t0 || r.nPos < 30 || r.duree < 120000 || r.dist < 200;

  // ---------- trait de côte (donnees/cote.json, tiré du relief : outils/trait_cote.py) ----------
  let coteP = null;
  const cote = () => coteP || (coteP = fetch('donnees/cote.json').then(r => r.json()).then(j => Object.values(j.zones).flat()).catch(() => []));

  // ---------- séances ----------
  // liste(progres) : séances triées de la plus récente à la plus ancienne ; progres(fait, total) pendant le calcul des résumés
  async function liste(progres) {
    const m = meta(), sups = new Set(m.supprimes), src = (await sources()).filter(s => !sups.has(s.src));
    const res = new Map();
    let fait = 0;
    for (const s of src) {
      try { res.set(s.src, await resume(s)); } catch (e) { res.set(s.src, null); }
      if (progres) progres(++fait, src.length);
    }
    const dansGroupe = new Map();
    for (const [g, l] of Object.entries(m.groupes)) for (const x of l) dansGroupe.set(x, g);
    const out = [], vus = new Set();
    for (const s of src) {
      const g = dansGroupe.get(s.src);
      if (g) {
        if (vus.has(g)) continue; vus.add(g);
        const membres = m.groupes[g].filter(x => res.get(x) && !vide(res.get(x)));
        if (!membres.length) continue;
        out.push(construire(g, membres.map(x => ({ src: x, r: res.get(x) })), m));
      } else if (!vide(res.get(s.src))) out.push(construire(s.src, [{ src: s.src, r: res.get(s.src) }], m));
    }
    return out.sort((a, b) => b.t0 - a.t0);
  }
  function construire(id, membres, m) {
    membres.sort((a, b) => a.r.t0 - b.r.t0);
    const R = membres.map(x => x.r), mx = k => Math.max(...R.map(r => r[k] || 0)), sm = k => R.reduce((s, r) => s + (r[k] || 0), 0);
    const e = m.seances[id] || {};
    return { id, sources: membres.map(x => x.src), groupe: membres.length > 1, t0: R[0].t0, t1: R[R.length - 1].t1, duree: sm('duree'), dist: sm('dist'),
      vInst: mx('vInst'), v2s: mx('v2s'), v100: mx('v100'), v250: mx('v250'), v500: mx('v500'), v1852: mx('v1852'), nSauts: sm('nSauts'), hMax: mx('hMax'),
      trace: R.flatMap(r => r.trace || []), traces: R.map(r => r.trace || []), type: R[0].type, profil: R[0].profil,
      sport: e.sport !== undefined ? e.sport : R[0].sportAuto, commentaire: e.commentaire || '', lieu: e.lieu != null ? e.lieu : R[0].lieu || '' };
  }
  async function seance(id) { return (await liste()).find(s => s.id === id) || null; }
  function modifier(id, champs) { const m = meta(); m.seances[id] = Object.assign(m.seances[id] || {}, champs); setMeta(m); }
  // regrouper : les sources des séances choisies forment une seule séance (sport et commentaire de la plus ancienne)
  function regrouper(seancesChoisies) {
    const m = meta(), l = seancesChoisies.slice().sort((a, b) => a.t0 - b.t0), srcs = l.flatMap(s => s.sources);
    for (const s of l) if (m.groupes[s.id]) delete m.groupes[s.id];
    const g = 'g:' + srcs[0];
    m.groupes[g] = srcs; m.seances[g] = Object.assign({}, m.seances[l[0].id] || {}, m.seances[g] || {});
    setMeta(m); return g;
  }
  function separer(id) { const m = meta(); delete m.groupes[id]; setMeta(m); }
  // supprimer : journal effacé du téléphone, fichier importé effacé ; irréversible
  async function supprimer(s) {
    const m = meta();
    for (const src of s.sources) {
      if (src.startsWith('j:')) { try { await NJ().supprimer({ nom: src.slice(2) }); } catch {} m.supprimes.push(src); }
      else if (src.startsWith('f:')) { try { await idbDel('fichiers', src.slice(2)); } catch {} }
      try { await idbDel('resumes', src); } catch {}
    }
    delete m.groupes[s.id]; delete m.seances[s.id];
    m.supprimes = [...new Set(m.supprimes)].slice(-500);
    setMeta(m);
  }

  // ---------- export ----------
  // Appli : fichier écrit puis fenêtre de partage d'Android ; navigateur : téléchargement
  async function exporter(nom, data, type = 'application/octet-stream') {
    if (APPLI_S) {
      const o = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
      let bin = ''; for (let i = 0; i < o.length; i += 0x8000) bin += String.fromCharCode.apply(null, o.subarray(i, i + 0x8000));
      const b64 = btoa(bin);
      return NJ().partagerFichier({ nom, base64: b64, type });
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = nom; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // titre lisible d'une séance
  const titre = s => (sport(s.sport) || {}).nom || 'Séance';
  const couleur = s => (sport(s.sport) || {}).c || '#8a9aa0';

  return { APPLI: APPLI_S, pref, setPref, unites, setUnites, vit, dist, duree, fr, sports, setSports, sport, SPORTS_DEFAUT, PALETTE,
    liste, seance, contenu, nomSource, cote, ajouterFichier, modifier, regrouper, separer, supprimer, exporter, titre, couleur, sources };
})();
