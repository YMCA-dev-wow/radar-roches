package io.github.ymcadevwow.radarroches;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.Arrays;

/**
 * Journal de session (une ligne JSON par événement) dans les fichiers de l'appli, à partager par WhatsApp ou e-mail.
 * La page y écrit positions, alertes, sons ; Android y ajoute de lui-même écran allumé / éteint, appli en arrière-plan,
 * et un battement toutes les 10 s : si la page s'endort écran éteint, le journal le montre.
 * Aussi : état de l'appareil (optimisation de la batterie, autorisations) et demande d'exemption d'optimisation.
 */
@CapacitorPlugin(name = "Journal")
public class JournalPlugin extends Plugin {
    private static final int GARDER = 30; // journaux conservés
    private FileWriter sortie; private String nom;
    private HandlerThread filBattement; private Handler battement;
    private volatile boolean ecranAllume = true;
    private long nLignes = 0;

    private final BroadcastReceiver ecran = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            ecranAllume = Intent.ACTION_SCREEN_ON.equals(i.getAction());
            natif("{\"type\":\"ecran\",\"allume\":" + ecranAllume + "}");
        }
    };

    private File dossier() { File d = new File(getContext().getFilesDir(), "journaux"); d.mkdirs(); return d; }

    private synchronized void ecrireLigne(String ligne) {
        if (sortie == null) return;
        try { sortie.write(ligne); sortie.write('\n'); sortie.flush(); nLignes++; } catch (IOException e) { /* disque plein : on continue sans journal */ }
    }

    // ligne écrite par Android : horodatage ajouté ici
    private void natif(String json) {
        ecrireLigne("{\"t\":" + System.currentTimeMillis() + ",\"src\":\"android\"," + json.substring(1));
    }

    @PluginMethod
    public void ouvrir(PluginCall call) {
        fermerInterne();
        nom = call.getString("nom", "session_" + System.currentTimeMillis()) + ".jsonl";
        try { sortie = new FileWriter(new File(dossier(), nom), true); } catch (IOException e) { call.reject(e.getMessage()); return; }
        nLignes = 0;
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        ecranAllume = pm.isInteractive();
        IntentFilter f = new IntentFilter(Intent.ACTION_SCREEN_OFF); f.addAction(Intent.ACTION_SCREEN_ON);
        ContextCompat.registerReceiver(getContext(), ecran, f, ContextCompat.RECEIVER_NOT_EXPORTED);
        filBattement = new HandlerThread("radar-journal"); filBattement.start();
        battement = new Handler(filBattement.getLooper());
        battement.postDelayed(new Runnable() {
            @Override public void run() {
                natif("{\"type\":\"battement\",\"ecran\":" + ecranAllume + ",\"notes\":" + SonPlugin.nNotes + ",\"motifs\":" + SonPlugin.nCadences +
                        ",\"batterie\":" + batterie() + ",\"economie\":" + ((PowerManager) getContext().getSystemService(Context.POWER_SERVICE)).isPowerSaveMode() + "}");
                if (battement != null) battement.postDelayed(this, 10000);
            }
        }, 10000);
        purger();
        JSObject r = new JSObject(); r.put("nom", nom); call.resolve(r);
    }

    @PluginMethod
    public void ecrire(PluginCall call) {
        JSArray l = call.getArray("lignes");
        if (l != null) for (int i = 0; i < l.length(); i++) ecrireLigne(l.optString(i));
        call.resolve();
    }

    @PluginMethod
    public void fermer(PluginCall call) { fermerInterne(); call.resolve(); }

    private synchronized void fermerInterne() {
        if (battement != null) { battement.removeCallbacksAndMessages(null); battement = null; filBattement.quitSafely(); }
        if (sortie != null) {
            try { getContext().unregisterReceiver(ecran); } catch (IllegalArgumentException e) { /* déjà retiré */ }
            try { sortie.close(); } catch (IOException e) { /* rien */ }
            sortie = null;
        }
    }

    @Override protected void handleOnPause() { natif("{\"type\":\"appli\",\"etat\":\"arriere-plan\"}"); }
    @Override protected void handleOnResume() { natif("{\"type\":\"appli\",\"etat\":\"premier-plan\"}"); }
    @Override protected void handleOnDestroy() { natif("{\"type\":\"appli\",\"etat\":\"fermee\"}"); fermerInterne(); }

    private void purger() {
        File[] l = dossier().listFiles();
        if (l == null || l.length <= GARDER) return;
        Arrays.sort(l, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (int i = 0; i < l.length - GARDER; i++) l[i].delete();
    }

    @PluginMethod
    public void liste(PluginCall call) {
        File[] l = dossier().listFiles();
        JSArray a = new JSArray();
        if (l != null) {
            Arrays.sort(l, (x, y) -> Long.compare(y.lastModified(), x.lastModified()));
            for (File f : l) { JSObject o = new JSObject(); o.put("nom", f.getName()); o.put("taille", f.length()); o.put("date", f.lastModified()); a.put(o); }
        }
        JSObject r = new JSObject(); r.put("journaux", a); call.resolve(r);
    }

    @PluginMethod
    public void partager(PluginCall call) {
        File f = new File(dossier(), call.getString("nom", ""));
        if (!f.exists()) { call.reject("journal introuvable"); return; }
        Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
        Intent i = new Intent(Intent.ACTION_SEND);
        i.setType("application/octet-stream");
        i.putExtra(Intent.EXTRA_STREAM, u);
        i.putExtra(Intent.EXTRA_SUBJECT, "Radar roches : journal " + f.getName());
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent choix = Intent.createChooser(i, "Envoyer le journal");
        choix.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(choix);
        call.resolve();
    }

    // Plusieurs journaux d'un coup (une seule fenêtre de partage, un seul message WhatsApp ou e-mail)
    @PluginMethod
    public void partagerPlusieurs(PluginCall call) {
        JSArray noms = call.getArray("noms");
        java.util.ArrayList<Uri> uris = new java.util.ArrayList<>();
        if (noms != null) for (int k = 0; k < noms.length(); k++) {
            File f = new File(dossier(), noms.optString(k));
            if (f.exists()) uris.add(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f));
        }
        if (uris.isEmpty()) { call.reject("aucun journal"); return; }
        Intent i = new Intent(Intent.ACTION_SEND_MULTIPLE);
        i.setType("application/octet-stream");
        i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        i.putExtra(Intent.EXTRA_SUBJECT, "Radar roches : " + uris.size() + " journaux");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent choix = Intent.createChooser(i, "Envoyer les journaux");
        choix.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(choix);
        call.resolve();
    }

    // Contenu d'un journal, pour le rejeu dans l'appli
    @PluginMethod
    public void lire(PluginCall call) {
        File f = new File(dossier(), call.getString("nom", ""));
        if (!f.exists()) { call.reject("journal introuvable"); return; }
        try {
            byte[] b = java.nio.file.Files.readAllBytes(f.toPath());
            JSObject r = new JSObject(); r.put("texte", new String(b, java.nio.charset.StandardCharsets.UTF_8)); call.resolve(r);
        } catch (IOException e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void supprimer(PluginCall call) {
        String n = call.getString("nom", "");
        if (!n.equals(nom)) new File(dossier(), n).delete();
        call.resolve();
    }

    private int batterie() {
        BatteryManager b = (BatteryManager) getContext().getSystemService(Context.BATTERY_SERVICE);
        return b.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
    }

    private boolean accorde(String p) { return ContextCompat.checkSelfPermission(getContext(), p) == PackageManager.PERMISSION_GRANTED; }

    // État de l'appareil : vérifications avant de partir et en-tête du journal
    @PluginMethod
    public void appareil(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject o = new JSObject();
        o.put("marque", Build.MANUFACTURER); o.put("modele", Build.MODEL); o.put("android", Build.VERSION.RELEASE); o.put("sdk", Build.VERSION.SDK_INT);
        o.put("batterieLibre", Build.VERSION.SDK_INT < 23 || pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        o.put("economie", pm.isPowerSaveMode());
        o.put("batterie", batterie());
        o.put("gpsPrecis", accorde(Manifest.permission.ACCESS_FINE_LOCATION));
        o.put("notifications", Build.VERSION.SDK_INT < 33 || accorde("android.permission.POST_NOTIFICATIONS"));
        call.resolve(o);
    }

    // Exemption d'optimisation de la batterie : Android affiche sa propre demande (Autoriser / Refuser)
    @PluginMethod
    public void demanderBatterie(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { getContext().startActivity(i); }
        catch (Exception e) { // certains fabricants : page générale des optimisations
            Intent g = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS); g.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(g);
        }
        call.resolve();
    }
}
