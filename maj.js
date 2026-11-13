// Mise à jour de l'appli Android : compare la construction embarquée (version.txt, écrit à la fabrication de l'APK) à celle
// de la dernière publication GitHub (« construction n° N » dans sa description). Vérification au plus toutes les 6 h
// (limite de l'API GitHub sans compte : 60 appels par heure). Nouvelle version : bandeau sur la page et une notification
// Android (une seule fois par version). Sur le site web, rien à faire : les pages sont toujours à jour.
(function () {
  // canal de l'appli installée (version.json) : testeurs (publications voulues) ou développement (chaque mise à jour)
  const CANAUX = {
    testeurs: { apk: 'https://github.com/YMCA-dev-wow/radar-roches/releases/latest/download/radar-roches.apk',
                api: 'https://api.github.com/repos/YMCA-dev-wow/radar-roches/releases/tags/appli' },
    dev: { apk: 'https://github.com/YMCA-dev-wow/radar-roches/releases/download/appli-dev/radar-roches.apk',
           api: 'https://api.github.com/repos/YMCA-dev-wow/radar-roches/releases/tags/appli-dev' },
  };
  let canal = 'testeurs';
  const C = window.Capacitor, appli = !!(C && C.isNativePlatform && C.isNativePlatform());
  const lire = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  async function versionLocale() {
    try { const r = await fetch('version.txt', { cache: 'no-store' }); return parseInt(await r.text(), 10) || 0; } catch { return 0; }
  }
  // version affichée (génération.jalon) et canal de l'appli installée : version.json, écrit à la fabrication de l'APK
  async function nomLocal() {
    try {
      const v = await (await fetch('version.json', { cache: 'no-store' })).json();
      if (CANAUX[v.canal]) canal = v.canal;
      return v.version || '';
    } catch { return ''; }
  }
  // versionnage sémantique : génération.jalon.construction, « dev » sur le canal de développement
  const affiche = (nom, n, c = canal) => (nom ? `v${nom}.${n}` : `Construction ${n}`) + (c === 'dev' ? ' dev' : '');
  async function versionPubliee(force) {
    const c = lire('maj.publiee');
    if (!force && c && c.canal === canal && Date.now() - c.t < 6 * 3600e3) return c.n;
    const r = await fetch(CANAUX[canal].api, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('GitHub : HTTP ' + r.status);
    const corps = (await r.json()).body || '';
    const m = /construction n° (\d+)/.exec(corps), v = /version (\d+\.\d+)/.exec(corps);
    const n = m ? +m[1] : 0;
    ecrire('maj.publiee', { t: Date.now(), n, nom: v ? v[1] : '', canal });
    return n;
  }
  // zone : pied de page, une ligne discrète « Construction N · Vérifier les mises à jour », qui devient
  // « Construction N · Mise à jour disponible » (lien vers l'APK) quand une version plus récente est publiée ;
  // force : ignore le délai de 6 h
  const lien = (texte, href, fort) => {
    const a = document.createElement('a'); a.textContent = texte; a.href = href;
    a.style.cssText = 'display:inline;margin:0;padding:0;background:none;border:0;border-radius:0;color:inherit;text-decoration:underline' + (fort ? ';color:#7fb7e8' : '');
    return a;
  };
  window.verifierMaj = async function (zone, force = false) {
    if (!appli || !zone) return;
    const nom = await nomLocal(), ici = await versionLocale(), moi = affiche(nom, ici);
    const ligne = (...morceaux) => { zone.innerHTML = ''; morceaux.forEach((m, i) => { if (i) zone.append(' · '); zone.append(m); }); };
    let n;
    try { n = await versionPubliee(force); }
    catch (err) { ligne(moi, 'vérification impossible'); return; }
    if (n > ici) {
      const pub = affiche((lire('maj.publiee') || {}).nom, n);
      const a = lien(`Mise à jour disponible : ${pub}`, CANAUX[canal].apk, true); a.target = '_blank'; a.rel = 'noopener';
      ligne(moi, a);
      if ((lire('maj.notifiee') || 0) < n) { // notification Android, une fois par version
        ecrire('maj.notifiee', n);
        try {
          const N = C.registerPlugin('LocalNotifications');
          const p = await N.requestPermissions();
          if (p.display === 'granted') await N.schedule({ notifications: [{ id: 900, title: 'Radar roches : mise à jour', body: `${pub} disponible (tu as la ${moi}). Lien en bas de Plus.` }] });
        } catch {}
      }
    } else {
      const a = lien('Vérifier les mises à jour', '#');
      a.onclick = e => { e.preventDefault(); zone.textContent = 'Vérification…'; window.verifierMaj(zone, true); };
      ligne(moi, a);
    }
  };
})();
