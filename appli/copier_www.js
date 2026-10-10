// Copie les pages web du radar (dossier parent) dans www/, que Capacitor embarque dans l'APK.
const fs = require('fs'), path = require('path');
const src = path.resolve(__dirname, '..'), dst = path.join(__dirname, 'www');
const FICHIERS = ['index.html', 'radar.html', 'rejeu.html', 'noyau.js', 'diagnostic.js', 'editeur_zones.html',
  'donnees/meta.json', 'donnees/tetes_auto.geojson', 'donnees/maree/saint_malo.json', 'donnees/maree/saint_malo.bin'];
fs.rmSync(dst, { recursive: true, force: true });
for (const f of FICHIERS) {
  fs.mkdirSync(path.dirname(path.join(dst, f)), { recursive: true });
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
fs.cpSync(path.join(src, 'donnees', 'tuiles'), path.join(dst, 'donnees', 'tuiles'), { recursive: true });
fs.writeFileSync(path.join(dst, 'version.txt'), process.env.GITHUB_RUN_NUMBER || 'locale');
console.log('www prêt');
