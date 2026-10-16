// Barre de navigation du bas de l'appli (Radar, Roches, Plus) et petites icônes communes, sans dépendance réseau.
// L'onglet actif vient de <body data-onglet="radar|roches|plus">. La barre n'apparaît que dans l'appli Android :
// la version web (ordinateur) a sa propre page d'accueil.
(function () {
  const svg = (d, t = 24) => `<svg width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONES = {
    radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 L18 6"/><circle cx="17" cy="15" r="1.2" fill="currentColor"/>',
    roches: '<path d="M3 19 L8 10 L12 14 L15 9 L21 19 Z"/><path d="M2 21 h20"/>',
    plus: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
    carte: '<path d="M3 6 l6-2 6 2 6-2 v14 l-6 2 -6-2 -6 2 z"/><path d="M9 4 v14 M15 6 v14"/>',
    rejeu: '<path d="M3 12 a9 9 0 1 0 3-6.7"/><path d="M3 4 v4 h4"/><path d="M12 8 v4 l3 2"/>',
    profils: '<path d="M4 6 h10 M18 6 h2 M4 12 h4 M12 12 h8 M4 18 h12 M20 18 h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    reglages: '<circle cx="12" cy="12" r="3"/><path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3 M5 5 l2 2 M17 17 l2 2 M5 19 l2-2 M17 7 l2-2"/>',
    moderation: '<path d="M12 3 l8 3 v6 c0 5-3.5 8-8 9 c-4.5-1-8-4-8-9 V6 z"/><path d="M8.5 12 l2.5 2.5 L16 9.5"/>',
    journal: '<path d="M6 3 h9 l4 4 v14 H6 z"/><path d="M9 10 h7 M9 14 h7 M9 18 h4"/>',
    nouveautes: '<path d="M12 3 l2.2 5.6 L20 9.3 l-4.5 3.9 L17 19 l-5-3.2 L7 19 l1.5-5.8 L4 9.3 l5.8-.7 z"/>',
    notice: '<path d="M5 4 h10 l4 4 v12 H5 z"/><path d="M14 4 v5 h5 M8 13 h8 M8 17 h6"/>',
    montre: '<rect x="7" y="6" width="10" height="12" rx="3"/><path d="M9 6 l1-3 h4 l1 3 M9 18 l1 3 h4 l1-3"/>',
    telecharger: '<path d="M12 4 v11 M7 10 l5 5 5-5 M5 20 h14"/>',
    ajouter: '<path d="M12 5 v14 M5 12 h14"/>',
    retour: '<path d="M15 5 l-7 7 7 7"/>',
    alerte: '<path d="M12 3 L22 20 H2 Z"/><path d="M12 10 v4 M12 17 v.5"/>',
  };
  window.icone = (nom, taille) => svg(ICONES[nom] || '', taille);
  const appli = !!window.androidBridge;
  document.documentElement.classList.toggle('appli', appli);
  if (!appli) return;
  const onglets = [['radar', 'radar.html', 'Radar'], ['roches', 'editeur_zones.html', 'Roches'], ['plus', 'plus.html', 'Plus']];
  document.addEventListener('DOMContentLoaded', () => {
    if (document.body.dataset.sansBarre != null) return;
    const actif = document.body.dataset.onglet || 'plus';
    const nav = document.createElement('nav'); nav.className = 'barre-nav';
    for (const [id, href, lib] of onglets) {
      const a = document.createElement('a'); a.href = href; a.className = id === actif ? 'on' : '';
      a.innerHTML = svg(ICONES[id]) + lib;
      nav.append(a);
    }
    document.body.append(nav);
  });
})();
