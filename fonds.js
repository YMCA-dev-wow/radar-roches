// Fonds de carte communs (éditeur de roches, carte et téléchargements) : fond de base (photo aérienne IGN, OpenStreetMap
// ou aucun), carte marine SHOM et relief Litto3D par-dessus, chacun avec son opacité. Les choix sont mémorisés par page.
// Usage : fondsCarte(map, conteneur, 'cle.stockage', { base: 'ortho', shom: true, ... }) ; renvoie les couches.
'use strict';
function fondsCarte(map, conteneur, cle, defauts) {
  const geopf = (layer, fmt, maxNative) => L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layer +
    '&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=' + fmt,
    { maxZoom: 20, maxNativeZoom: maxNative, attribution: '© IGN / SHOM' });
  const bases = {
    ortho: geopf('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg', 19),
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap' }),
    none: null,
  };
  const shom = geopf('GEOGRAPHICALGRIDSYSTEMS.COASTALMAPS', 'image/png', 16).setZIndex(5);
  // Relief Litto3D Bretagne 2018-2021 (service WMS public du SHOM, licence ouverte)
  const lidar = L.tileLayer.wms('https://services.data.shom.fr/INSPIRE/wms/r', {
    layers: 'LITTO3D_BZH_2018_2021_PYR_3857_WMSR', format: 'image/png', transparent: true, version: '1.3.0',
    maxZoom: 20, attribution: 'Litto3D® Shom – IGN',
  }).setZIndex(6);

  const r = Object.assign({ base: 'ortho', baseOp: 1, shom: true, shomOp: 1, lidar: false, lidarOp: 0.8 }, defauts);
  try { Object.assign(r, JSON.parse(localStorage.getItem(cle)) || {}); } catch {}
  if (!(r.base in bases)) r.base = 'ortho';
  const garder = () => { try { localStorage.setItem(cle, JSON.stringify(r)); } catch {} };

  let base = null;
  const appliquer = () => {
    if (base) map.removeLayer(base);
    base = bases[r.base]; if (base) base.setOpacity(r.baseOp).addTo(map).bringToBack();
    shom.setOpacity(r.shomOp); r.shom ? shom.addTo(map) : map.removeLayer(shom);
    lidar.setOpacity(r.lidarOp); r.lidar ? lidar.addTo(map) : map.removeLayer(lidar);
  };
  appliquer();

  if (conteneur) {
    const curseur = (k) => `<input type="range" data-k="${k}" min="0" max="1" step="0.05" value="${r[k]}" aria-label="Opacité">`;
    conteneur.classList.add('fonds');
    conteneur.innerHTML = `
      <div class="fonds-ligne"><select data-k="base" aria-label="Fond de carte">
        <option value="ortho">Photo aérienne IGN</option><option value="osm">OpenStreetMap</option><option value="none">Aucun fond</option>
      </select>${curseur('baseOp')}</div>
      <div class="fonds-ligne"><label><input type="checkbox" data-k="shom"> Carte marine SHOM</label>${curseur('shomOp')}</div>
      <div class="fonds-ligne"><label><input type="checkbox" data-k="lidar"> Relief Litto3D</label>${curseur('lidarOp')}</div>`;
    conteneur.querySelector('[data-k=base]').value = r.base;
    conteneur.querySelector('[data-k=shom]').checked = r.shom;
    conteneur.querySelector('[data-k=lidar]').checked = r.lidar;
    conteneur.addEventListener('input', e => {
      const k = e.target.dataset.k; if (!k) return;
      r[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'range' ? +e.target.value : e.target.value;
      if (k === 'baseOp' && base) base.setOpacity(r.baseOp);
      else if (k === 'shomOp') shom.setOpacity(r.shomOp);
      else if (k === 'lidarOp') lidar.setOpacity(r.lidarOp);
      else appliquer();
      garder();
    });
    // pas de styles de page dans le module : le minimum pour l'alignement
    if (!document.getElementById('fonds-css')) {
      const st = document.createElement('style'); st.id = 'fonds-css';
      st.textContent = '.fonds-ligne{display:flex;align-items:center;gap:10px;margin:6px 0}.fonds-ligne>select,.fonds-ligne>label{flex:0 0 52%;width:auto;display:flex;align-items:center;gap:6px}' +
        '.fonds-ligne input[type=checkbox]{width:auto}.fonds-ligne input[type=range]{flex:1;min-width:60px}';
      document.head.append(st);
    }
  }
  return { bases, shom, lidar };
}
