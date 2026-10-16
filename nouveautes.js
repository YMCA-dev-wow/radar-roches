// Nouveautés : au premier démarrage après une mise à jour de l'appli, une feuille présente les entrées de nouveautes.json
// pas encore vues (fichier embarqué dans l'APK : il décrit la version installée, même hors ligne). Première installation :
// rien n'est montré. Historique complet : nouveautes.ouvrir(true) (Plus → Nouveautés).
(function () {
  const CLE = 'nouveautes.vue';
  const lire = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  // relevé au chargement, avant que la page n'écrive ses réglages : l'appli avait-elle déjà servi ?
  let dejaUtilisee = false;
  try { dejaUtilisee = Object.keys(localStorage).some(k => k.startsWith('radar.') || k.startsWith('maj.') || k === 'roches-sillon-v1'); } catch {}

  async function entrees() {
    try { const r = await fetch('nouveautes.json', { cache: 'no-store' }); return (await r.json()).entrees || []; } catch { return []; }
  }
  const date = d => new Date(d + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });

  function feuille(liste, titre) {
    const f = document.createElement('div'); f.className = 'feuille on';
    const In = document.createElement('div'); In.className = 'in';
    const h = document.createElement('h2'); h.textContent = titre; h.style.marginTop = '0'; In.append(h);
    for (const e of liste) {
      const t = document.createElement('h3'); t.style.margin = '14px 0 4px';
      t.textContent = e.titre; In.append(t);
      const s = document.createElement('div'); s.className = 'sub'; s.textContent = date(e.date) + (e.montre ? ' · applis montre' : ''); In.append(s);
      const ul = document.createElement('ul'); ul.style.cssText = 'margin:6px 0 0;padding-left:20px;line-height:1.45';
      for (const p of e.points) { const li = document.createElement('li'); li.textContent = p; ul.append(li); }
      In.append(ul);
    }
    const b = document.createElement('button'); b.className = 'btn prim'; b.textContent = 'OK'; b.style.cssText = 'width:100%;margin-top:18px';
    const fermer = () => f.remove();
    b.onclick = fermer; f.onclick = e => { if (e.target === f) fermer(); };
    In.append(b); f.append(In); document.body.append(f);
  }

  window.nouveautes = {
    // tout : historique complet ; sinon les entrées pas encore vues (rien à la première installation)
    async ouvrir(tout) {
      const liste = await entrees();
      if (!liste.length) return;
      const max = Math.max(...liste.map(e => e.id));
      const vue = lire(CLE);
      ecrire(CLE, max);
      if (tout) return feuille(liste, 'Nouveautés');
      let neuves;
      if (vue != null) neuves = liste.filter(e => e.id > vue);
      else if (dejaUtilisee) neuves = liste.filter(e => Date.now() - new Date(e.date) < 14 * 864e5).slice(0, 3); // avant ce journal
      else neuves = [];
      if (neuves.length) feuille(neuves, 'Quoi de neuf ?');
    },
  };
})();
