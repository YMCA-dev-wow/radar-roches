package io.github.ymcadevwow.radarroches;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Relief des zones (tuiles Litto3D) téléchargé à la demande, comme les cartes de Maps.me : l'appli ne contient plus que
 * les pages, les marées et la description des zones ; chaque zone est téléchargée une fois (Wi-Fi conseillé) dans les
 * fichiers de l'appli, puis lue sur place, sans réseau (TuilesPlugin).
 * Dossier : fichiers de l'appli / zones / <dossier de la zone> / tuiles / 16 / x / y.png, plus « version.txt » une fois
 * la zone complète (même version que donnees/zones.json : sinon, mise à jour proposée).
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

    // État de chaque zone : version complète présente (ou null), place occupée
    @PluginMethod
    public void etat(PluginCall call) {
        JSArray dossiers = call.getArray("dossiers");
        JSObject r = new JSObject();
        if (dossiers != null) for (int i = 0; i < dossiers.length(); i++) {
            String d = dossiers.optString(i);
            File z = new File(racine(getContext()), d), v = new File(z, "version.txt");
            JSObject o = new JSObject();
            try { o.put("version", v.exists() ? new String(Files.readAllBytes(v.toPath()), StandardCharsets.UTF_8).trim() : null); }
            catch (Exception e) { o.put("version", null); }
            o.put("taille", taille(z));
            o.put("enCours", d.equals(enCours));
            r.put(d, o);
        }
        call.resolve(r);
    }

    // Téléchargement d'une zone : liste des tuiles « x/y », adresse du site, version. Reprise possible (tuiles déjà là
    // conservées si la version n'a pas changé). Avancement : évènement « progres » ; fin : résolution de l'appel.
    @PluginMethod
    public void telecharger(PluginCall call) {
        final String dossier = call.getString("dossier"), base = call.getString("base"), version = call.getString("version", "1");
        final int zoom = call.getInt("zoom", 16);
        final JSArray tuiles = call.getArray("tuiles");
        if (dossier == null || base == null || tuiles == null) { call.reject("paramètres manquants"); return; }
        if (enCours != null) { call.reject("un téléchargement est déjà en cours (" + enCours + ")"); return; }
        enCours = dossier; annule = false;
        call.setKeepAlive(true);
        new Thread(() -> {
            File z = new File(racine(getContext()), dossier), v = new File(z, "version.txt"), vEnCours = new File(z, "version_en_cours.txt");
            try {
                // nouvelle version : on repart de zéro (sinon on complète ce qui manque)
                String prec = vEnCours.exists() ? new String(Files.readAllBytes(vEnCours.toPath()), StandardCharsets.UTF_8).trim() : null;
                if (v.exists() && !version.equals(new String(Files.readAllBytes(v.toPath()), StandardCharsets.UTF_8).trim())) effacer(z);
                else if (prec != null && !version.equals(prec)) effacer(z);
                z.mkdirs(); v.delete();
                try (FileOutputStream o = new FileOutputStream(vEnCours)) { o.write(version.getBytes(StandardCharsets.UTF_8)); }
                final int n = tuiles.length();
                final AtomicInteger fait = new AtomicInteger(0), erreurs = new AtomicInteger(0);
                ExecutorService pool = Executors.newFixedThreadPool(6);
                for (int i = 0; i < n; i++) {
                    final String t = tuiles.optString(i);
                    pool.execute(() -> {
                        if (annule) return;
                        File f = new File(z, "tuiles/" + zoom + "/" + t + ".png");
                        if (!(f.exists() && f.length() > 0)) {
                            boolean ok = false;
                            for (int essai = 0; essai < 3 && !ok && !annule; essai++) ok = charger(base + dossier + "/tuiles/" + zoom + "/" + t + ".png", f);
                            if (!ok) erreurs.incrementAndGet();
                        }
                        int k = fait.incrementAndGet();
                        if (k % 25 == 0 || k == n) {
                            JSObject p = new JSObject(); p.put("dossier", dossier); p.put("fait", k); p.put("total", n); p.put("erreurs", erreurs.get());
                            notifyListeners("progres", p);
                        }
                    });
                }
                pool.shutdown();
                pool.awaitTermination(2, TimeUnit.HOURS);
                JSObject r = new JSObject(); r.put("dossier", dossier); r.put("erreurs", erreurs.get()); r.put("annule", annule); r.put("taille", taille(z));
                if (!annule && erreurs.get() == 0) {
                    try (FileOutputStream o = new FileOutputStream(v)) { o.write(version.getBytes(StandardCharsets.UTF_8)); }
                    vEnCours.delete();
                    r.put("version", version);
                }
                enCours = null;
                call.resolve(r);
            } catch (Exception e) { enCours = null; call.reject(e.getMessage()); }
        }, "radar-zones").start();
    }

    private static boolean charger(String adresse, File f) {
        HttpURLConnection c = null;
        try {
            f.getParentFile().mkdirs();
            c = (HttpURLConnection) new URL(adresse).openConnection();
            c.setConnectTimeout(15000); c.setReadTimeout(30000);
            if (c.getResponseCode() == 404) return true;   // tuile absente du site : rien à garder
            if (c.getResponseCode() != 200) return false;
            File tmp = new File(f.getPath() + ".tmp");
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(tmp)) {
                byte[] b = new byte[16384]; int r;
                while ((r = in.read(b)) > 0) out.write(b, 0, r);
            }
            return tmp.renameTo(f);
        } catch (Exception e) { return false; }
        finally { if (c != null) c.disconnect(); }
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
