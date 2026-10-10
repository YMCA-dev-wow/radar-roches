// Diagnostic : affiche à l'écran toute erreur de script (utile dans l'appli, où la console n'est pas visible)
// et une ligne d'état (construction, mode appli, modules natifs). Chargé avant tout autre script.
(function () {
  const erreurs = [];
  function afficher(m) {
    erreurs.push(m);
    let b = document.getElementById('diagErreur');
    if (!b) {
      b = document.createElement('div'); b.id = 'diagErreur';
      b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#b00020;color:#fff;font:12px/1.35 monospace;' +
        'padding:8px;white-space:pre-wrap;max-height:45vh;overflow:auto';
      b.onclick = () => b.remove();
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = 'Erreur – fais une capture d’écran (touche pour fermer) :\n' + erreurs.join('\n');
  }
  window.addEventListener('error', e => afficher(`${e.message || e} @ ${(e.filename || '').split('/').pop()}:${e.lineno || ''}:${e.colno || ''}`));
  window.addEventListener('unhandledrejection', e => afficher('Promesse rejetée : ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
  window.diagEtat = async function () {
    const C = window.Capacitor;
    let version = 'web';
    try { const r = await fetch('version.txt', { cache: 'no-store' }); if (r.ok) version = (await r.text()).trim().slice(0, 20); } catch {}
    const natifs = C && C.PluginHeaders ? C.PluginHeaders.map(p => p.name).join(', ') : '–';
    return `construction ${version} · appli ${C && C.isNativePlatform && C.isNativePlatform() ? 'oui' : 'non'} · modules : ${natifs}`;
  };
})();
