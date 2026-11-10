// Zones téléchargées (appli) : le relief Litto3D de chaque zone (tuiles) n'est plus dans l'appli, il se télécharge une
// fois, zone par zone, depuis le site (ZonesPlugin), puis se lit sans réseau. Les marées et la description des zones
// restent dans l'appli. Version attendue : donnees/zones.json (version_tuiles) ; une version différente sur le téléphone
// = mise à jour proposée.
// Évènements (window) : « zones-progres » (detail : dossier, fait, total, erreurs) pendant un téléchargement,
// « zones-change » quand l'état d'une zone a changé (fin de téléchargement, suppression).
'use strict';
const ZonesLocales = (() => {
  const SITE_Z = 'https://ymca-dev-wow.github.io/radar-roches/';
  const appli = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() && window.Capacitor.registerPlugin);
  const P = () => (typeof Natif !== 'undefined' && Natif && Natif.zones) || (window.zonesNatif = window.zonesNatif || window.Capacitor.registerPlugin('Zones'));
  let etat = {}, dernieres = [];
  async function lire(zs) {
    if (zs) dernieres = zs;
    if (!appli) return etat;
    try { etat = await P().etat({ dossiers: dernieres.map(z => z.dossier) }); } catch { etat = {}; }
    return etat;
  }
  // 'web' (navigateur : lu en ligne), 'ok', 'maj' (autre version sur le téléphone), 'absente', 'encours', 'inconnu'
  function statut(z) {
    if (!appli) return 'web';
    const e = etat[z.dossier];
    if (!e) return 'inconnu';
    if (e.enCours) return 'encours';
    if (e.version && e.version === String(z.version_tuiles)) return 'ok';
    return e.version ? 'maj' : 'absente';
  }
  const signaler = () => window.dispatchEvent(new Event('zones-change'));
  // Le site publie le relief en paquets (relief.json + relief_N.pack) : l'index dit où se trouve chaque tuile, Android
  // télécharge chaque paquet et le redécoupe en tuiles (ZonesPlugin)
  async function telecharger(z, progres) {
    const r = await fetch(SITE_Z + z.dossier + '/relief.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('index du relief introuvable (HTTP ' + r.status + ')');
    const idx = await r.json();
    const packs = idx.packs.map(p => ({ nom: p.nom, taille: p.taille, tuiles: [] }));
    for (const [k, [p, debut, n]] of Object.entries(idx.tuiles)) packs[p].tuiles.push([k, debut, n]);
    packs.forEach(p => p.tuiles.sort((a, b) => a[1] - b[1]));
    const ecoute = await P().addListener('progres', p => {
      if (p.dossier !== z.dossier) return;
      if (progres) progres(p.fait, p.total, p.erreurs);
      window.dispatchEvent(new CustomEvent('zones-progres', { detail: p }));
    });
    try {
      return await P().telecharger({ dossier: z.dossier, base: SITE_Z, version: String(z.version_tuiles), zoom: idx.zoom, packs });
    } finally { ecoute.remove(); await lire(); signaler(); }
  }
  const annuler = () => P().annuler();
  const supprimer = async z => { try { await P().supprimer({ dossier: z.dossier }); } finally { await lire(); signaler(); } };
  return { appli, lire, statut, telecharger, annuler, supprimer };
})();

const moZone = o => (o / 1048576).toFixed(0) + ' Mo';

// Une ligne de zone : nom, taille, état, Télécharger / Mettre à jour / Annuler / Suppr., barre d'avancement.
// opts.voir(z) : ajoute un bouton « Voir » (carte).
function ligneZone(z, opts = {}) {
  const st = ZonesLocales.statut(z);
  const ligne = document.createElement('div'); ligne.className = 'zoneLigne';
  const txt = document.createElement('div');
  txt.innerHTML = '<b></b><small></small><div class="barre" hidden><i></i></div>';
  txt.querySelector('b').textContent = z.nom;
  const info = { ok: '✓ téléchargée', maj: 'mise à jour disponible', absente: 'non téléchargée', encours: 'téléchargement en cours…',
    inconnu: 'état inconnu', web: 'lue en ligne sur ordinateur' }[st];
  const petit = txt.querySelector('small'), barre = txt.querySelector('.barre'), jauge = barre.firstChild;
  petit.textContent = `${z.taille_tuiles ? ' · ' + moZone(z.taille_tuiles) : ''} · ${info}`;
  petit.className = st === 'ok' ? 'ok' : st === 'absente' || st === 'maj' ? 'ko' : '';
  ligne.append(txt);
  if (opts.voir) { const v = document.createElement('button'); v.className = 'btn'; v.textContent = 'Voir'; v.onclick = () => opts.voir(z); ligne.append(v); }
  if (st === 'web' || st === 'inconnu') return ligne;
  const b = document.createElement('button'); b.className = 'btn prim';
  b.textContent = st === 'ok' ? 'À jour' : st === 'maj' ? 'Mettre à jour' : st === 'encours' ? 'Annuler' : 'Télécharger';
  b.disabled = st === 'ok';
  const sup = document.createElement('button'); sup.className = 'btn'; sup.textContent = 'Suppr.';
  sup.hidden = st === 'absente' || st === 'encours';
  // avancement, qu'il ait été lancé depuis cette ligne ou depuis une autre (feuille de la carte / liste)
  const surProgres = e => {
    if (!ligne.isConnected) { window.removeEventListener('zones-progres', surProgres); return; }
    const p = e.detail; if (p.dossier !== z.dossier) return;
    barre.hidden = false; b.textContent = 'Annuler'; b.disabled = false; sup.hidden = true;
    jauge.style.width = (100 * p.fait / p.total).toFixed(1) + '%';
    petit.className = ''; petit.textContent = ` · ${p.fait} / ${p.total} portions${p.erreurs ? ` · ${p.erreurs} en échec` : ''}`;
  };
  window.addEventListener('zones-progres', surProgres);
  b.onclick = async () => {
    if (b.textContent === 'Annuler') { await ZonesLocales.annuler().catch(() => {}); return; }
    b.textContent = 'Annuler'; barre.hidden = false; sup.hidden = true; petit.className = ''; petit.textContent = ' · démarrage…';
    try {
      const r = await ZonesLocales.telecharger(z);
      if (r.erreurs && !r.annule) alert(`${z.nom} : ${r.erreurs} portions n'ont pas pu être téléchargées (réseau ?). Relance le téléchargement : il reprendra là où il s'est arrêté.`);
    } catch (e) { alert('Téléchargement impossible : ' + e.message); }
  };
  sup.onclick = async () => {
    if (confirm(`Supprimer le relief de ${z.nom} du téléphone ? Le radar ne verra plus les roches de cette zone sans réseau.`))
      await ZonesLocales.supprimer(z).catch(e => alert(e.message));
  };
  ligne.append(b, sup);
  return ligne;
}
