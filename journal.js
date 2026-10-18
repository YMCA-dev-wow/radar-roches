// Journal de session de l'appli : une ligne JSON par événement, écrite par Android dans un fichier (JournalPlugin),
// à envoyer par WhatsApp ou e-mail depuis Plus → Journaux de session. Contenu : appareil, réglages, chaque position
// avec l'analyse (dangers), chaque son et annonce vocale, GPS perdu / retrouvé, page visible ou non, erreurs ;
// Android y ajoute écran allumé / éteint et un battement toutes les 10 s (la page endormie se voit à l'absence de positions).
// Les lignes partent par paquets (20 lignes ou 3 s) pour limiter les échanges avec Android.
'use strict';
// module natif : celui du noyau (page radar), sinon enregistré ici (page Plus)
const APPLI_J = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() && window.Capacitor.registerPlugin);
const NJ = () => (typeof Natif !== 'undefined' && Natif && Natif.journal) || (window.journalNatif = window.journalNatif || window.Capacitor.registerPlugin('Journal'));
const JournalSession = (() => {
  const dispo = APPLI_J;
  let ouvert = false, tampon = [], dernierEnvoi = 0, nom = null, nPos = 0;
  const envoyer = () => {
    if (!ouvert || !tampon.length) return;
    const lignes = tampon; tampon = []; dernierEnvoi = Date.now();
    NJ().ecrire({ lignes }).catch(() => {});
  };
  function ev(type, d = {}) {
    if (!ouvert) return;
    if (type === 'pos') nPos++;
    tampon.push(JSON.stringify({ t: Date.now(), type, ...d }));
    if (tampon.length >= 20 || Date.now() - dernierEnvoi > 3000) envoyer();
  }
  const deux = n => String(n).padStart(2, '0');
  async function ouvrir(entete) {
    if (!dispo) return;
    const d = new Date();
    const n = `radar_${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}_${deux(d.getHours())}h${deux(d.getMinutes())}`;
    try { nom = (await NJ().ouvrir({ nom: n })).nom; } catch { return; }
    ouvert = true; nPos = 0;
    ev('debut', entete);
  }
  async function fermer(resume = {}) {
    if (!ouvert) return;
    ev('fin', { positions: nPos, ...resume }); envoyer(); ouvert = false;
    try { await NJ().fermer(); } catch {}
  }
  if (dispo) {
    setInterval(envoyer, 3000);
    addEventListener('error', e => ev('erreur', { msg: e.message, ou: (e.filename || '').split('/').pop() + ':' + e.lineno }));
    addEventListener('unhandledrejection', e => ev('erreur', { msg: String((e.reason && e.reason.message) || e.reason) }));
    document.addEventListener('visibilitychange', () => ev('page', { visible: !document.hidden }));
  }
  return { ev, ouvrir, fermer, get ouvert() { return ouvert; }, get nom() { return nom; } };
})();

// Liste des journaux (Plus → Journaux de session) : envoyer ou supprimer
async function afficherJournaux(conteneur) {
  if (!APPLI_J) { conteneur.textContent = 'Disponible dans l\'appli Android.'; return; }
  let l = [];
  try { l = (await NJ().liste()).journaux || []; } catch (e) { conteneur.textContent = 'Lecture impossible : ' + e.message; return; }
  conteneur.innerHTML = '';
  if (!l.length) { conteneur.textContent = 'Aucun journal : un journal est créé à chaque lancement du radar.'; return; }
  for (const j of l) {
    const ligne = document.createElement('div'); ligne.className = 'journal';
    const txt = document.createElement('div');
    txt.innerHTML = '<b></b><small></small>';
    txt.querySelector('b').textContent = new Date(j.date).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    txt.querySelector('small').textContent = ` · ${Math.max(1, Math.round(j.taille / 1024))} Ko`;
    const env = document.createElement('button'); env.className = 'btn prim'; env.textContent = 'Envoyer';
    env.onclick = () => NJ().partager({ nom: j.nom }).catch(e => alert(e.message));
    const rej = document.createElement('button'); rej.className = 'btn'; rej.textContent = 'Rejouer';
    rej.onclick = () => { location.href = 'rejeu.html?journal=' + encodeURIComponent(j.nom); };
    const sup = document.createElement('button'); sup.className = 'btn'; sup.textContent = 'Suppr.';
    sup.onclick = async () => { if (confirm('Supprimer ce journal ?')) { await NJ().supprimer({ nom: j.nom }).catch(() => {}); afficherJournaux(conteneur); } };
    ligne.append(txt, rej, env, sup); conteneur.append(ligne);
  }
}
