// Zones téléchargées (appli) : le relief Litto3D de chaque zone (tuiles) n'est plus dans l'appli, il se télécharge une
// fois, zone par zone, depuis le site (ZonesPlugin), puis se lit sans réseau. Les marées et la description des zones
// restent dans l'appli. Version attendue : donnees/zones.json (version_tuiles) ; une version différente sur le téléphone
// = mise à jour proposée.
'use strict';
const ZonesLocales = (() => {
  const SITE_Z = 'https://ymca-dev-wow.github.io/radar-roches/';
  const appli = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() && window.Capacitor.registerPlugin);
  const P = () => (typeof Natif !== 'undefined' && Natif && Natif.zones) || (window.zonesNatif = window.zonesNatif || window.Capacitor.registerPlugin('Zones'));
  let etat = {};
  async function lire(zs) {
    if (!appli) return etat;
    try { etat = await P().etat({ dossiers: zs.map(z => z.dossier) }); } catch { etat = {}; }
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
  async function telecharger(z, progres) {
    const m = z.meta || await (await fetch(z.dossier + '/meta.json')).json();
    const ecoute = await P().addListener('progres', p => { if (p.dossier === z.dossier && progres) progres(p.fait, p.total, p.erreurs); });
    try {
      return await P().telecharger({ dossier: z.dossier, base: SITE_Z, version: String(z.version_tuiles), zoom: m.zoom, tuiles: m.tuiles.map(t => t[0] + '/' + t[1]) });
    } finally { ecoute.remove(); }
  }
  const annuler = () => P().annuler();
  const supprimer = z => P().supprimer({ dossier: z.dossier });
  return { appli, lire, statut, telecharger, annuler, supprimer };
})();

// Liste des zones (Plus → Zones) : taille, état, Télécharger / Mettre à jour / Supprimer, avancement
async function afficherZones(conteneur) {
  const zs = await (await fetch('donnees/zones.json')).json();
  if (!ZonesLocales.appli) { conteneur.textContent = 'Sur ordinateur, le relief est lu en ligne : rien à télécharger.'; return; }
  await ZonesLocales.lire(zs);
  conteneur.innerHTML = '';
  const mo = o => (o / 1048576).toFixed(0) + ' Mo';
  for (const z of zs) {
    const st = ZonesLocales.statut(z);
    const ligne = document.createElement('div'); ligne.className = 'zoneLigne';
    const txt = document.createElement('div');
    txt.innerHTML = '<b></b><small></small><div class="barre" hidden><i></i></div>';
    txt.querySelector('b').textContent = z.nom;
    const info = { ok: '✓ téléchargée', maj: 'mise à jour disponible', absente: 'non téléchargée', encours: 'téléchargement en cours…', inconnu: 'état inconnu' }[st];
    txt.querySelector('small').textContent = ` · ${mo(z.taille_tuiles || 0)} · ${info}`;
    txt.querySelector('small').className = st === 'ok' ? 'ok' : st === 'absente' || st === 'maj' ? 'ko' : '';
    const b = document.createElement('button'); b.className = 'btn prim';
    b.textContent = st === 'ok' ? 'À jour' : st === 'maj' ? 'Mettre à jour' : st === 'encours' ? 'Annuler' : 'Télécharger';
    b.disabled = st === 'ok';
    const barre = txt.querySelector('.barre'), jauge = barre.firstChild;
    b.onclick = async () => {
      if (b.textContent === 'Annuler') { await ZonesLocales.annuler().catch(() => {}); return; }
      b.textContent = 'Annuler'; barre.hidden = false;
      try {
        const r = await ZonesLocales.telecharger(z, (fait, total, err) => {
          jauge.style.width = (100 * fait / total).toFixed(1) + '%';
          txt.querySelector('small').textContent = ` · ${fait} / ${total} portions${err ? ` · ${err} en échec` : ''}`;
        });
        if (r.erreurs) alert(`${z.nom} : ${r.erreurs} portions n'ont pas pu être téléchargées (réseau ?). Relance le téléchargement : il reprendra là où il s'est arrêté.`);
      } catch (e) { alert('Téléchargement impossible : ' + e.message); }
      afficherZones(conteneur);
    };
    const sup = document.createElement('button'); sup.className = 'btn'; sup.textContent = 'Suppr.';
    sup.hidden = st === 'absente' || st === 'encours';
    sup.onclick = async () => { if (confirm(`Supprimer le relief de ${z.nom} du téléphone ? Le radar ne verra plus les roches de cette zone sans réseau.`)) { await ZonesLocales.supprimer(z).catch(e => alert(e.message)); afficherZones(conteneur); } };
    ligne.append(txt, b, sup); conteneur.append(ligne);
  }
}
