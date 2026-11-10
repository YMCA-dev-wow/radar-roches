package io.github.ymcadevwow.radarroches;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Relief des zones (tuiles Litto3D) téléchargé à la demande, comme les cartes de Maps.me : l'appli ne contient plus que
 * les pages, les marées et la description des zones ; chaque zone est téléchargée une fois (Wi-Fi conseillé) dans les
 * fichiers de l'appli, puis lue sur place, sans réseau (TuilesPlugin).
 * Le site publie le relief d'une zone en quelques paquets (relief_N.pack : PNG des tuiles mis bout à bout, index
 * relief.json) ; chaque paquet est lu d'un bout à l'autre et redécoupé en tuiles au fil du téléchargement.
 * Dossier : fichiers de l'appli / zones / <dossier de la zone> / tuiles / 16 / x / y.png, plus « version.txt » une fois
 * la zone complète (même version que donnees/zones.json : sinon, mise à jour proposée). Reprise : un paquet terminé est
 * marqué (paquet_<nom>.ok) et n'est pas retéléchargé tant que la version ne change pas.
 */
@CapacitorPlugin(name = "Zones")
public class ZonesPlugin extends Plugin {
    private volatile boolean annule = false;
    private volatile String enCours = null;

    static File racine(android.content.Context c) { return new File(c.getFilesDir(), "zones"); }

    private static long taille(File f) {
        if (!f.exists()) return 0;
        if (f.isFile()) return f.length();
        long s = 0; File[] l = f.listFiles();
        if (l != null) for (File x : l) s += taille(x);
        return s;
    }

    private static void effacer(File f) {
        File[] l = f.listFiles();
        if (l != null) for (File x : l) effacer(x);
        f.delete();
    }

    private static String lire(File f) {
        try { return f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).trim() : null; } catch (Exception e) { return null; }
    }

    private static void ecrire(File f, String s) throws IOException {
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(s.getBytes(StandardCharsets.UTF_8)); }
    }

    // État de chaque zone : version complète présente (ou null), place occupée
    @PluginMethod
    public void etat(PluginCall call) {
        JSArray dossiers = call.getArray("dossiers");
        JSObject r = new JSObject();
        if (dossiers != null) for (int i = 0; i < dossiers.length(); i++) {
            String d = dossiers.optString(i);
            File z = new File(racine(getContext()), d);
            JSObject o = new JSObject();
            o.put("version", lire(new File(z, "version.txt")));
            o.put("taille", taille(z));
            o.put("enCours", d.equals(enCours));
            r.put(d, o);
        }
        call.resolve(r);
    }

    // Téléchargement d'une zone : { dossier, base (adresse du site), version, zoom, packs: [{ nom, taille, tuiles: [[ "x/y",
    // début, longueur ], …] }] } (tuiles triées par position dans le paquet). Avancement : évènement « progres » (tuiles
    // écrites / total) ; fin : résolution de l'appel { erreurs, annule, taille, version si complète }.
    @PluginMethod
    public void telecharger(PluginCall call) {
        final String dossier = call.getString("dossier"), base = call.getString("base"), version = call.getString("version", "1");
        final int zoom = call.getInt("zoom", 16);
        final JSArray packs = call.getArray("packs");
        if (dossier == null || base == null || packs == null) { call.reject("paramètres manquants"); return; }
        if (enCours != null) { call.reject("un téléchargement est déjà en cours (" + enCours + ")"); return; }
        enCours = dossier; annule = false;
        call.setKeepAlive(true);
        new Thread(() -> {
            File z = new File(racine(getContext()), dossier), v = new File(z, "version.txt"), vEnCours = new File(z, "version_en_cours.txt");
            try {
                // nouvelle version : on repart de zéro (sinon on reprend les paquets non terminés)
                String fin = lire(v), prec = lire(vEnCours);
                if ((fin != null && !version.equals(fin)) || (prec != null && !version.equals(prec))) effacer(z);
                z.mkdirs(); v.delete();
                ecrire(vEnCours, version);
                int total = 0;
                for (int i = 0; i < packs.length(); i++) total += packs.getJSONObject(i).getJSONArray("tuiles").length();
                int fait = 0, erreurs = 0;
                for (int i = 0; i < packs.length() && !annule; i++) {
                    JSONObject p = packs.getJSONObject(i);
                    String nom = p.getString("nom");
                    JSONArray tuiles = p.getJSONArray("tuiles");
                    File ok = new File(z, "paquet_" + nom + ".ok");
                    if (version.equals(lire(ok))) { fait += tuiles.length(); progres(dossier, fait, total, erreurs); continue; }
                    boolean reussi = false;
                    for (int essai = 0; essai < 3 && !reussi && !annule; essai++) {
                        try {
                            int n = decouper(base + dossier + "/" + nom, tuiles, new File(z, "tuiles/" + zoom), dossier, fait, total, erreurs);
                            if (n == tuiles.length()) { reussi = true; ecrire(ok, version); }
                        } catch (Exception e) {
                            if (!annule) try { Thread.sleep(2000L * (essai + 1)); } catch (InterruptedException ignore) {}
                        }
                    }
                    if (!reussi && !annule) erreurs += tuiles.length();
                    fait += tuiles.length();
                    progres(dossier, fait, total, erreurs);
                }
                JSObject r = new JSObject(); r.put("dossier", dossier); r.put("erreurs", erreurs); r.put("annule", annule); r.put("taille", taille(z));
                if (!annule && erreurs == 0) {
                    ecrire(v, version);
                    vEnCours.delete();
                    File[] l = z.listFiles();
                    if (l != null) for (File x : l) if (x.getName().startsWith("paquet_")) x.delete();
                    r.put("version", version);
                }
                enCours = null;
                call.resolve(r);
            } catch (Exception e) { enCours = null; call.reject(e.getMessage()); }
        }, "radar-zones").start();
    }

    private void progres(String dossier, int fait, int total, int erreurs) {
        JSObject p = new JSObject(); p.put("dossier", dossier); p.put("fait", fait); p.put("total", total); p.put("erreurs", erreurs);
        notifyListeners("progres", p);
    }

    // Lit le paquet d'un bout à l'autre et écrit chaque tuile à sa place ; renvoie le nombre de tuiles écrites
    private int decouper(String adresse, JSONArray tuiles, File dest, String dossier, int fait0, int total, int erreurs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(adresse).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(30000);
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            int n = 0;
            try (InputStream in = new BufferedInputStream(c.getInputStream(), 65536)) {
                long pos = 0;
                for (int i = 0; i < tuiles.length(); i++) {
                    if (annule) return n;
                    JSONArray t = tuiles.getJSONArray(i);
                    String k = t.getString(0); long debut = t.getLong(1); int lon = t.getInt(2);
                    while (pos < debut) { long s = in.skip(debut - pos); if (s <= 0) { if (in.read() < 0) throw new IOException("paquet tronqué"); s = 1; } pos += s; }
                    byte[] b = new byte[lon];
                    int lu = 0;
                    while (lu < lon) { int r = in.read(b, lu, lon - lu); if (r < 0) throw new IOException("paquet tronqué"); lu += r; }
                    pos += lon;
                    File f = new File(dest, k + ".png"), tmp = new File(dest, k + ".png.tmp");
                    f.getParentFile().mkdirs();
                    try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(b); }
                    if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new IOException("écriture impossible"); }
                    n++;
                    if (n % 25 == 0) progres(dossier, fait0 + n, total, erreurs);
                }
            }
            return n;
        } finally { c.disconnect(); }
    }

    @PluginMethod
    public void annuler(PluginCall call) { annule = true; call.resolve(); }

    @PluginMethod
    public void supprimer(PluginCall call) {
        String d = call.getString("dossier", "");
        if (d.isEmpty() || d.equals(enCours)) { call.reject("zone en cours de téléchargement"); return; }
        effacer(new File(racine(getContext()), d));
        call.resolve();
    }
}
