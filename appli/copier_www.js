// Copie les pages web du radar (dossier parent) dans www/, que Capacitor embarque dans l'APK.
const fs = require('fs'), path = require('path');
const src = path.resolve(__dirname, '..'), dst = path.join(__dirname, 'www');
const FICHIERS = ['index.html', 'plus.html', 'theme.css', 'nav.js', 'fonds.js', 'nouveautes.js', 'nouveautes.json', 'logo.svg', 'notice.html', 'maj.js', 'radar.html', 'rejeu.html', 'carte.html', 'noyau.js', 'diagnostic.js', 'editeur_zones.html', 'donnees/zones.json',
  'donnees/montres.json']; // applis montre (.prg) : téléchargées depuis le site, pas embarquées dans l'APK
// données de chaque zone décrite dans donnees/zones.json : méta, têtes de roche, marées, tuiles
const ZONES = JSON.parse(fs.readFileSync(path.join(src, 'donnees', 'zones.json'), 'utf8'));
for (const z of ZONES) {
  FICHIERS.push(z.dossier + '/meta.json', ...z.jauges.flatMap(j => ['json', 'bin'].map(e => `${z.dossier}/maree/${j.fichier}.${e}`)));
  if (fs.existsSync(path.join(src, z.dossier, 'tetes_auto.geojson'))) FICHIERS.push(z.dossier + '/tetes_auto.geojson');
}
fs.rmSync(dst, { recursive: true, force: true });
for (const f of FICHIERS) {
  fs.mkdirSync(path.dirname(path.join(dst, f)), { recursive: true });
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
for (const z of ZONES) fs.cpSync(path.join(src, z.dossier, 'tuiles'), path.join(dst, z.dossier, 'tuiles'), { recursive: true });
// bibliothèque Capacitor (registerPlugin…), chargée avant noyau.js dans les pages de l'appli seulement
fs.copyFileSync(path.join(__dirname, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'), path.join(dst, 'capacitor.js'));
for (const [page, script] of [['radar.html', 'noyau.js'], ['rejeu.html', 'noyau.js'], ['plus.html', 'maj.js']]) {
  const p = path.join(dst, page), html = fs.readFileSync(p, 'utf8'), balise = `<script src="${script}"></script>`;
  if (!html.includes(balise)) throw new Error(page + ' : balise ' + script + ' introuvable');
  fs.writeFileSync(p, html.replace(balise, '<script src="capacitor.js"></script>\n' + balise));
}
// l'appli s'ouvre directement sur le radar (l'accueil web, orienté ordinateur, n'y sert pas)
fs.writeFileSync(path.join(dst, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=radar.html"><script>location.replace("radar.html")</script>');
fs.writeFileSync(path.join(dst, 'version.txt'), process.env.GITHUB_RUN_NUMBER || 'locale');
console.log('www prêt');
