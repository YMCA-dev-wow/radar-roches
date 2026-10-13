// Mise à jour de l'appli Android : compare la construction embarquée (version.txt, écrit à la fabrication de l'APK) à celle
// de la dernière publication GitHub (« construction n° N » dans sa description). Vérification au plus toutes les 6 h
// (limite de l'API GitHub sans compte : 60 appels par heure). Nouvelle version : bandeau sur la page et une notification
// Android (une seule fois par version). Sur le site web, rien à faire : les pages sont toujours à jour.
(function () {
  const APK = 'https://github.com/YMCA-dev-wow/radar-roches/releases/latest/download/radar-roches.apk';
  const API = 'https://api.github.com/repos/YMCA-dev-wow/radar-roches/releases/tags/appli';
  const C = window.Capacitor, appli = !!(C && C.isNativePlatform && C.isNativePlatform());
  const lire = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  async function versionLocale() {
    try { const r = await fetch('version.txt', { cache: 'no-store' }); return parseInt(await r.text(), 10) || 0; } catch { return 0; }
  }
  async function versionPubliee(force) {
    const c = lire('maj.publiee');
    if (!force && c && Date.now() - c.t < 6 * 3600e3) return c.n;
    const r = await fetch(API, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('GitHub : HTTP ' + r.status);
    const m = /construction n° (\d+)/.exec((await r.json()).body || '');
    const n = m ? +m[1] : 0;
    ecrire('maj.publiee', { t: Date.now(), n });
    return n;
  }
  // alerte : élément du bandeau « nouvelle version » (en haut) ; zone : ligne discrète d'état (pied de page) ;
  // force : ignore le délai de 6 h
  window.verifierMaj = async function (alerte, zone, force = false) {
    if (!appli) return;
    if (!zone) zone = alerte;
    const ici = await versionLocale();
    let n;
    try { n = await versionPubliee(force); }
    catch (err) { if (zone) zone.textContent = `Construction ${ici}. Vérification impossible (réseau ?).`; return; }
    zone.innerHTML = ''; if (alerte) alerte.innerHTML = '';
    if (n > ici) {
      const b = document.createElement('div');
      b.style.cssText = 'background:#1f6f3a;color:#fff;border-radius:12px;padding:12px 14px;margin:8px 0';
      b.innerHTML = `<b>Nouvelle version disponible</b> (construction ${n}, tu as la ${ici}).<br>`;
      const a = document.createElement('a');
      a.href = APK; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Télécharger et installer la mise à jour';
      a.style.cssText = 'color:#fff;font-weight:600;display:inline-block;margin:6px 0 0;padding:0;background:none;border:0';
      b.append(a);
      (alerte || zone).append(b);
      if (zone !== alerte) zone.textContent = `Construction ${ici}.`;
      if ((lire('maj.notifiee') || 0) < n) { // notification Android, une fois par version
        ecrire('maj.notifiee', n);
        try {
          const N = C.registerPlugin('LocalNotifications');
          const p = await N.requestPermissions();
          if (p.display === 'granted') await N.schedule({ notifications: [{ id: 900, title: 'Radar roches : mise à jour', body: `Construction ${n} disponible (tu as la ${ici}). Ouvre l'appli pour l'installer.` }] });
        } catch {}
      }
    } else {
      const s = document.createElement('span');
      s.textContent = `Version : construction ${ici} (à jour) · `;
      const a = document.createElement('a'); a.href = '#'; a.textContent = 'Vérifier maintenant';
      a.style.cssText = 'display:inline;margin:0;padding:0;background:none;border:0;color:#5d8fc0';  // l'accueil met ses liens en cartes
      a.onclick = e => { e.preventDefault(); zone.textContent = 'Vérification…'; window.verifierMaj(alerte, zone, true); };
      zone.append(s, a);
    }
  };
})();
