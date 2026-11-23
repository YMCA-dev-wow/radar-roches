package io.github.ymcadevwow.radarroches;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.zip.GZIPOutputStream;

/**
 * Détection des sauts (version d'essai), téléphone porté sur le tronc (pochette sous le gilet).
 * Accéléromètre à 50 Hz : un saut = une phase « allégée » (accélération ressentie nettement sous 1 g, le corps n'appuie plus
 * sur la planche) d'au moins 0,3 s, terminée par une réception (pic au-dessus de 2,2 g).
 *  - temps de vol t : du début de la phase allégée à la réception ;
 *  - hauteur balistique h = g·t²/8 (surestimée quand l'aile porte pendant le saut) ;
 *  - hauteur baromètre (si le téléphone en a un) : montée maximale de l'altitude pendant le vol par rapport aux 2 s d'avant.
 * Chaque saut est envoyé à la page (évènement « saut ») avec la courbe d'accélération autour (pour régler la détection).
 * 13/11/2026 (données pour affiner le calcul) :
 *  - 100 Hz ; composante verticale de l'accélération (projetée sur la gravité estimée par Android, TYPE_GRAVITY) ;
 *  - hauteur intégrée hInt : double intégration de g·(a_vert − 1) entre décollage et réception, avec z = 0 aux deux bouts
 *    (tient compte de la portance de l'aile, que la formule de chute libre ignore ; même principe que le brevet PIQ) ;
 *  - envoi 1 s après la réception : courbes |a| et a_vert à 50 Hz de 2 s avant le décollage à 1 s après la réception,
 *    altitude baromètre point par point ;
 *  - « chocs » : pic au-dessus de 3 g sans phase allégée (réception d'un saut de kite, où l'aile porte et l'accélération
 *    ne tombe pas vers 0), envoyés avec 4 s de courbes avant et 1 s après, pour mettre au point une détection kite.
 * 19/11/2026 : données brutes en option (« brut » = nom du journal de la séance) : accéléromètre 3 axes et gyroscope à 100 Hz,
 *  gravité d'Android et orientation fusionnée (vecteur de rotation « jeu », sans boussole) à 50 Hz, pression à 25 Hz, dans
 *  bruts/<journal>_brut.csv.gz, partagé avec le journal. But : trajectoire réelle des sauts de kite (verticale en repère
 *  terrestre par le gyroscope, double intégration), la gravité estimée par Android s'alignant sur la traction de l'aile.
 *  Format (une ligne par mesure) : lettre, µs depuis la ligne « debut », valeurs (a, G : m/s² ; g : rad/s ; r : x, y, z, w ; p : hPa).
 * 23/11/2026 (séance wing du 22/11 dans la baston, données brutes : 2 vrais sauts, 165 candidats) :
 *  - vrai saut = hauteur intégrée hInt d'au moins 1,2 m (les faux plafonnent à 0,6 m en wing, 0,8 m en kite) ; l'ancien
 *    critère « moyenne sous 0,35 g » rejetait les sauts où l'aile porte (0,57 g en moyenne dans la baston) ;
 *  - décollage = fin du pop (dernière moyenne 0,1 s ≥ 1,3 g dans la seconde avant la phase allégée), pour intégrer toute la montée ;
 *  - plus de blocage de 3 s entre candidats (0,5 s) : un accroupi avant le pop pris pour un petit saut masquait la vraie
 *    réception 2,5 s plus tard ; l'espacement des annonces reste dans la page ;
 *  - historique de 20 s et courbes ré-échantillonnées sur le temps (le Pixel 7 livre ~120 Hz au lieu des 100 demandés).
 * 24/11/2026 (séance kite du 22/11 avec données brutes et Woo : 14 sauts de 1,1 à 2,6 m, aucun retenu par les règles wing) :
 *  - verticale en repère terrestre par l'orientation fusionnée (GAME_ROTATION_VECTOR, gyroscope + accéléromètre) au lieu de
 *    la gravité estimée par Android, qui s'aligne sur la traction de l'aile ; repli sur TYPE_GRAVITY sans ce capteur ;
 *  - règles kite (option « kite » de demarrer, profil Kite) en plus des règles wing : en kite l'aile porte, |a| ne descend
 *    pas sous 0,6 g. Phase allégée = verticale moyenne sur 0,25 s sous 0,7 g pendant au moins 0,3 s, réception au-dessus de
 *    1,6 g moins de 0,6 s après ; décollage = traction la plus forte (moyenne 0,1 s de |a|, au moins 1,4 g) dans les 4 s
 *    avant la phase allégée ; vrai saut si hauteur intégrée >= 1,0 m (Woo 22/11 : 9 sauts sur 14 retrouvés, 6 faux).
 *    Ce pic n'est pas toujours l'impulsion du saut (rafale, carre, clapot) : le décollage est ensuite reculé au début de la
 *    montée (dernier instant à moins de 10 % de la hauteur avant le sommet), sinon temps de vol et distance comptent 1 à 2 s
 *    passées sur l'eau.
 */
@CapacitorPlugin(name = "Saut")
public class SautPlugin extends Plugin implements SensorEventListener {
    private static final int HZ = 100, N = HZ * 20;                // 20 s d'historique à 100 Hz (au moins 10 s si le capteur va plus vite)
    private static final double H_VRAI = 1.2, POP = 1.3;            // m : hauteur intégrée d'un vrai saut ; g : fin du pop (décollage)
    private static final double G = 9.81, BAS = 0.6, PIC = 2.2, CHOC = 3.0;   // seuils en g
    private static final double K_BAS = 0.7, K_PIC = 1.6, K_POP = 1.4, H_KITE = 1.0;   // règles kite (g, g, g, m)
    private boolean kite = false, rotation = false;
    private float qx = 0, qy = 0, qz = 0, qw = 1;   // orientation fusionnée (vecteur de rotation « jeu »)
    private long debK = -1, finK = -1;
    private final float[] acc10 = new float[N];      // moyenne de |a| sur 0,1 s (traction du décollage)
    private SensorManager sm; private HandlerThread fil; private Handler hFil; private boolean actif = false, gravite = false;
    private final float[] acc = new float[N], accV = new float[N]; private final long[] tAcc = new long[N]; private int nAcc = 0;
    private float gx = 0, gy = 0, gz = 0;   // gravité estimée par Android (repère du téléphone)
    private long dernierChoc = 0;
    private final float[] alt = new float[N]; private final long[] tAlt = new long[N]; private int nAlt = 0;
    private long debutBas = -1, finBas = -1, dernierSaut = 0;
    private int nSauts = 0;
    private static final int GARDER_BRUTS = 10;          // ~10-15 Mo par heure : on ne garde que les derniers
    private final Object verrou = new Object();
    private Writer brut = null; private String nomBrut = null; private long t0Brut = 0, dernierFlush = 0, nBrut = 0;

    @PluginMethod
    public void demarrer(PluginCall call) {
        sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        Sensor a = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER), p = sm.getDefaultSensor(Sensor.TYPE_PRESSURE), gr = sm.getDefaultSensor(Sensor.TYPE_GRAVITY);
        if (a == null) { call.reject("pas d'accéléromètre"); return; }
        String erreurBrut = null;
        if (!actif) {
            String nb = call.getString("brut", null);
            if (nb != null && !nb.isEmpty()) erreurBrut = ouvrirBrut(nb, a, gr, p);
            fil = new HandlerThread("radar-sauts"); fil.start();
            Handler h = new Handler(fil.getLooper()); hFil = h;
            sm.registerListener(this, a, 1000000 / HZ, 0, h);
            if (gr != null) sm.registerListener(this, gr, 1000000 / HZ, 0, h);
            if (p != null) sm.registerListener(this, p, 40000, 0, h);
            Sensor rv = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
            if (rv != null) sm.registerListener(this, rv, 20000, 0, h);   // verticale en repère terrestre (50 Hz)
            if (brut != null) {
                Sensor gy = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
                if (gy != null) sm.registerListener(this, gy, 1000000 / HZ, 0, h);
            }
            kite = Boolean.TRUE.equals(call.getBoolean("kite", false));
            actif = true; gravite = gr != null || rv != null; rotation = false; nAcc = 0; nAlt = 0; debutBas = -1; finBas = -1;
            debK = -1; finK = -1; nSauts = 0; dernierChoc = 0;
        }
        JSObject r = new JSObject(); r.put("barometre", p != null); r.put("gravite", gr != null); r.put("hz", HZ);
        r.put("orientation", sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR) != null); r.put("kite", kite);
        if (nomBrut != null) r.put("brut", nomBrut);
        if (erreurBrut != null) r.put("erreurBrut", erreurBrut);
        call.resolve(r);
    }

    @PluginMethod
    public void arreter(PluginCall call) {
        long n = nBrut;
        if (actif) { sm.unregisterListener(this); fil.quitSafely(); actif = false; }
        fermerBrut();
        JSObject r = new JSObject(); r.put("sauts", nSauts); r.put("mesuresBrutes", n); call.resolve(r);
    }

    @Override public void onAccuracyChanged(Sensor s, int a) {}

    @Override
    public void onSensorChanged(SensorEvent e) {
        long t = System.currentTimeMillis();
        int ty = e.sensor.getType();
        if (brut != null) ecrireBrut(e, ty);
        if (ty == Sensor.TYPE_GYROSCOPE) return;   // seulement pour les données brutes
        if (ty == Sensor.TYPE_GAME_ROTATION_VECTOR) {
            qx = e.values[0]; qy = e.values[1]; qz = e.values[2];
            qw = e.values.length > 3 ? e.values[3] : (float) Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz));
            rotation = true; return;
        }
        if (ty == Sensor.TYPE_PRESSURE) {
            int k = nAlt++ % N; tAlt[k] = t; alt[k] = SensorManager.getAltitude(SensorManager.PRESSURE_STANDARD_ATMOSPHERE, e.values[0]);
            return;
        }
        if (e.sensor.getType() == Sensor.TYPE_GRAVITY) { gx = e.values[0]; gy = e.values[1]; gz = e.values[2]; return; }
        float g = (float) (Math.sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]) / G);
        double ng = Math.sqrt(gx * gx + gy * gy + gz * gz);
        // composante verticale (vers le haut) de l'accélération ressentie, en g : 1 au repos, 0 en chute libre, > 0 si l'aile porte.
        // Repère terrestre par l'orientation fusionnée (3e ligne de la matrice de rotation) ; à défaut gravité estimée par Android
        float v;
        if (rotation) v = (float) ((2 * (qx * qz - qw * qy) * e.values[0] + 2 * (qy * qz + qw * qx) * e.values[1]
                + (1 - 2 * (qx * qx + qy * qy)) * e.values[2]) / G);
        else v = ng > 1 ? (float) ((e.values[0] * gx + e.values[1] * gy + e.values[2] * gz) / ng / G) : g;
        int k = nAcc++ % N; tAcc[k] = t; acc[k] = g; accV[k] = v;
        // phase allégée : moyenne glissante sur 0,1 s sous BAS
        double m = 0; int n = Math.min(HZ / 10, nAcc);
        for (int i = 0; i < n; i++) m += acc[(nAcc - 1 - i) % N];
        m /= n; acc10[k] = (float) m;
        if (kite && detecterKite(t, g)) return;
        if (m < BAS) { if (debutBas < 0) debutBas = t - 100; finBas = t; }
        else if (debutBas >= 0 && t - finBas > 400) debutBas = -1; // la phase allégée s'est terminée sans réception
        if (g > PIC && debutBas >= 0 && finBas - debutBas >= 300 && t - finBas < 400 && t - dernierSaut > 500) {
            final long t0 = decollage(debutBas), t1 = t; final double vol = (t1 - t0) / 1000.0;
            if (vol < 4) hFil.postDelayed(() -> signaler(t0, t1, vol, false), 1000); // les rejetés partent aussi au journal
            debutBas = -1; dernierSaut = t;
        } else if (g > CHOC && t - dernierChoc > 3000 && t - dernierSaut > 2000) { // choc sans phase allégée : candidat saut de kite
            dernierChoc = t; final long tc = t; final float pic = g;
            hFil.postDelayed(() -> signalerChoc(tc, pic), 1000);
        }
    }

    // Décollage : fin du pop, dernière moyenne sur 0,1 s d'au moins POP g dans la seconde avant la phase allégée
    // (l'aile porte encore au début du vol, |a| y reste parfois au-dessus de BAS) ; à défaut, début de la phase allégée
    private long decollage(long debut) {
        int n0 = Math.min(nAcc, N), w = HZ / 10;
        for (int i = 0; i + w <= n0; i++) {
            int k = (nAcc - 1 - i) % N; long tk = tAcc[k];
            if (tk > debut) continue;
            if (tk < debut - 1000) break;
            double m = 0; for (int j = 0; j < w; j++) m += acc[(nAcc - 1 - i - j) % N];
            if (m / w >= POP) return tk;
        }
        return debut;
    }

    // Règles kite : phase allégée sur la verticale (l'aile porte, |a| reste vers 1 g), réception plus douce, décollage = traction
    // la plus forte des 4 s d'avant. Renvoie vrai si un candidat vient d'être pris (les règles wing ne regardent pas ce pic).
    private boolean detecterKite(long t, float g) {
        double mv = 0; int n = Math.min(HZ / 4, nAcc);
        for (int i = 0; i < n; i++) mv += accV[(nAcc - 1 - i) % N];
        mv /= n;
        if (mv < K_BAS) { if (debK < 0 || t - finK > 150) debK = t - 250; finK = t; }
        if (g > K_PIC && debK >= 0 && finK - debK >= 300 && t - finK < 600 && t - dernierSaut > 1000) {
            long tPop = -1; float pop = 0; int n0 = Math.min(nAcc, N);
            for (int i = 0; i < n0; i++) {
                int kk = (nAcc - 1 - i) % N; long tk = tAcc[kk];
                if (tk >= debK) continue;
                if (tk < t - 4000) break;
                if (acc10[kk] > pop) { pop = acc10[kk]; tPop = tk; }
            }
            debK = -1; dernierSaut = t;
            if (tPop < 0 || pop < K_POP) return false;
            final long t0 = tPop, t1 = t; final double vol = (t1 - t0) / 1000.0;
            hFil.postDelayed(() -> signaler(t0, t1, vol, true), 1000);
            debutBas = -1; return true;
        }
        return false;
    }

    private void signaler(long t0, long t1, double vol, boolean regleKite) {
        if (regleKite) { t0 = debutMontee(t0, t1); vol = (t1 - t0) / 1000.0; }
        double hi = hauteurIntegree(t0, t1); boolean vrai = hi >= (regleKite ? H_KITE : H_VRAI);
        if (vrai) nSauts++;
        JSObject o = new JSObject();
        o.put("vrai", vrai);
        if (regleKite) { o.put("regle", "kite"); o.put("montee", true); }
        o.put("t", t1); o.put("vol", Math.round(vol * 100) / 100.0);
        o.put("h", Math.round(G * vol * vol / 8 * 10) / 10.0);
        // baromètre : altitude moyenne des 2 s avant le saut, puis maximum pendant le vol
        double base = 0, haut = -1e9; int nb = 0;
        for (int i = 0; i < Math.min(nAlt, N); i++) {
            int k = (nAlt - 1 - i) % N; long tt = tAlt[k];
            if (tt >= t0 - 2000 && tt < t0) { base += alt[k]; nb++; }
            if (tt >= t0 && tt <= t1 && alt[k] > haut) haut = alt[k];
        }
        if (nb > 0 && haut > -1e8) o.put("hBaro", Math.round((haut - base / nb) * 10) / 10.0);
        o.put("hInt", Math.round(hi * 10) / 10.0);
        ajouterCourbes(o, t0 - 2000, t1 + 1000, 2);
        o.put("avant", 2.0); o.put("hz", HZ / 2); o.put("vertical", gravite); o.put("repere", rotation ? "terrestre" : "gravite");
        ajouterBaro(o, t0, t0 - 2000, t1 + 1000);
        notifyListeners("saut", o);
    }

    // Choc sans phase allégée : courbes de 4 s avant à 1 s après (25 Hz) et altitude baromètre, pour l'analyse kite
    private void signalerChoc(long t, float pic) {
        JSObject o = new JSObject();
        o.put("t", t); o.put("pic", Math.round(pic * 100) / 100.0);
        ajouterCourbes(o, t - 4000, t + 1000, 4);
        o.put("avant", 4.0); o.put("hz", HZ / 4); o.put("vertical", gravite);
        ajouterBaro(o, t, t - 4000, t + 1000);
        notifyListeners("choc", o);
    }

    // Courbes |a| (« courbe ») et a_vert (« courbeV »), en g, de ta à tb, à HZ/pas points par seconde (sur le temps :
    // la fréquence réelle du capteur dépasse souvent celle demandée)
    private void ajouterCourbes(JSObject o, long ta, long tb, int pas) {
        JSArray c = new JSArray(), cv = new JSArray(); double suivant = ta, dt = 1000.0 * pas / HZ;
        for (int i = Math.min(nAcc, N) - 1; i >= 0; i--) {
            int k = (nAcc - 1 - i) % N;
            if (tAcc[k] < suivant || tAcc[k] > tb) continue;
            suivant += dt; if (tAcc[k] > suivant) suivant = tAcc[k] + dt;
            c.put((Object) Double.valueOf(Math.round(acc[k] * 100) / 100.0)); // put(Object) : pas d exception
            cv.put((Object) Double.valueOf(Math.round(accV[k] * 100) / 100.0));
        }
        o.put("courbe", c); o.put("courbeV", cv);
    }

    // Altitude baromètre point par point : [ms depuis tRef, m au-dessus de la moyenne des 2 s avant tRef]
    private void ajouterBaro(JSObject o, long tRef, long ta, long tb) {
        double base = 0; int nb = 0;
        for (int i = 0; i < Math.min(nAlt, N); i++) { int k = (nAlt - 1 - i) % N; if (tAlt[k] >= tRef - 2000 && tAlt[k] < tRef) { base += alt[k]; nb++; } }
        if (nb == 0) return;
        base /= nb;
        JSArray b = new JSArray();
        for (int i = Math.min(nAlt, N) - 1; i >= 0; i--) {
            int k = (nAlt - 1 - i) % N;
            if (tAlt[k] < ta || tAlt[k] > tb) continue;
            JSArray q = new JSArray(); q.put((Object) Long.valueOf(tAlt[k] - tRef)); q.put((Object) Double.valueOf(Math.round((alt[k] - base) * 100) / 100.0));
            b.put((Object) q);
        }
        o.put("baro", b);
    }

    // Début de la montée : dernier instant avant le sommet où le profil intégré est sous 10 % de la hauteur (règles kite)
    private long debutMontee(long t0, long t1) {
        int n0 = Math.min(nAcc, N); double[] zs = new double[n0]; long[] ts = new long[n0]; int n = 0;
        double vz = 0, z = 0; long tp = -1;
        for (int i = n0 - 1; i >= 0; i--) {
            int k = (nAcc - 1 - i) % N;
            if (tAcc[k] < t0 || tAcc[k] > t1) continue;
            if (tp >= 0) { double dt = (tAcc[k] - tp) / 1000.0; vz += G * (accV[k] - 1) * dt; z += vz * dt; }
            tp = tAcc[k]; zs[n] = z; ts[n] = tAcc[k]; n++;
        }
        if (n < 2 || ts[n - 1] <= ts[0]) return t0;
        double v0 = -zs[n - 1] / ((ts[n - 1] - ts[0]) / 1000.0), h = -1; int ip = 0;
        for (int i = 0; i < n; i++) { zs[i] += v0 * (ts[i] - ts[0]) / 1000.0; if (zs[i] > h) { h = zs[i]; ip = i; } }
        if (h <= 0) return t0;
        for (int i = ip; i >= 0; i--) if (zs[i] <= 0.1 * h) return ts[i];
        return t0;
    }

    // Hauteur par double intégration de g·(a_vert − 1) sur le vol, vitesse de départ choisie pour que z(fin) = 0
    private double hauteurIntegree(long t0, long t1) {
        int n0 = Math.min(nAcc, N); double[] zs = new double[n0]; long[] ts = new long[n0]; int n = 0;
        double vz = 0, z = 0; long tp = -1;
        for (int i = n0 - 1; i >= 0; i--) {
            int k = (nAcc - 1 - i) % N;
            if (tAcc[k] < t0 || tAcc[k] > t1) continue;
            if (tp >= 0) { double dt = (tAcc[k] - tp) / 1000.0; vz += G * (accV[k] - 1) * dt; z += vz * dt; }
            tp = tAcc[k]; zs[n] = z; ts[n] = tAcc[k]; n++;
        }
        if (n < 2 || ts[n - 1] <= ts[0]) return 0;
        double v0 = -zs[n - 1] / ((ts[n - 1] - ts[0]) / 1000.0), h = 0;
        for (int i = 0; i < n; i++) h = Math.max(h, zs[i] + v0 * (ts[i] - ts[0]) / 1000.0);
        return h;
    }

    // ---------- Données brutes ----------
    private File dossierBruts() { File d = new File(getContext().getFilesDir(), "bruts"); d.mkdirs(); return d; }

    private String ouvrirBrut(String nomJournal, Sensor a, Sensor gr, Sensor p) {
        try {
            File d = dossierBruts();
            File[] l = d.listFiles();
            if (l != null && l.length >= GARDER_BRUTS) {
                Arrays.sort(l, (x, y) -> Long.compare(x.lastModified(), y.lastModified()));
                for (int i = 0; i <= l.length - GARDER_BRUTS; i++) l[i].delete();
            }
            String n = nomJournal.replaceAll("[^A-Za-z0-9._-]", "_") + "_brut.csv.gz";
            Writer w = new BufferedWriter(new OutputStreamWriter(new GZIPOutputStream(new FileOutputStream(new File(d, n)), 65536, true), StandardCharsets.UTF_8), 65536);
            long ns = SystemClock.elapsedRealtimeNanos(), ms = System.currentTimeMillis();
            w.write("# Radar roches, données brutes des capteurs du téléphone. Une ligne par mesure : lettre, µs depuis « debut », valeurs.\n");
            w.write("# a = accéléromètre x,y,z (m/s², gravité comprise) ; g = gyroscope x,y,z (rad/s) ; G = gravité estimée par Android x,y,z (m/s²) ;\n");
            w.write("# r = orientation fusionnée sans boussole (GAME_ROTATION_VECTOR) x,y,z,w ; p = pression (hPa). Repère du téléphone.\n");
            w.write("debut,0," + ms + "\n");    // instant 0 = ms depuis 1970 (horloge du journal)
            w.write("appareil," + android.os.Build.MANUFACTURER.replace(',', ' ') + "," + android.os.Build.MODEL.replace(',', ' ') + "\n");
            Sensor gy = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE), rv = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
            Sensor[] cs = { a, gy, gr, rv, p }; String[] ls = { "a", "g", "G", "r", "p" };
            for (int i = 0; i < cs.length; i++) if (cs[i] != null)   // plage max : un pic de réception au-delà est écrêté
                w.write("capteur," + ls[i] + "," + cs[i].getName().replace(',', ' ') + "," + cs[i].getVendor().replace(',', ' ') + ",max=" + cs[i].getMaximumRange() + ",resolution=" + cs[i].getResolution() + "\n");
            synchronized (verrou) { brut = w; nomBrut = n; t0Brut = ns; dernierFlush = ns; nBrut = 0; }
            return null;
        } catch (Exception ex) { synchronized (verrou) { brut = null; nomBrut = null; } return ex.getMessage(); }
    }

    private static String f4(float v) { return Float.toString(Math.round(v * 10000f) / 10000f); }

    private void ecrireBrut(SensorEvent e, int ty) {
        String l;
        switch (ty) {
            case Sensor.TYPE_ACCELEROMETER: l = "a"; break;
            case Sensor.TYPE_GYROSCOPE: l = "g"; break;
            case Sensor.TYPE_GRAVITY: l = "G"; break;
            case Sensor.TYPE_GAME_ROTATION_VECTOR: l = "r"; break;
            case Sensor.TYPE_PRESSURE: l = "p"; break;
            default: return;
        }
        int nv = ty == Sensor.TYPE_PRESSURE ? 1 : ty == Sensor.TYPE_GAME_ROTATION_VECTOR ? Math.min(4, e.values.length) : 3;
        StringBuilder b = new StringBuilder(48).append(l).append(',').append((e.timestamp - t0Brut) / 1000);
        for (int i = 0; i < nv; i++) b.append(',').append(f4(e.values[i]));
        b.append('\n');
        synchronized (verrou) {
            if (brut == null) return;
            try {
                brut.write(b.toString()); nBrut++;
                if (e.timestamp - dernierFlush > 5_000_000_000L) { brut.flush(); dernierFlush = e.timestamp; }   // lisible même si l'appli est tuée
            } catch (IOException ex) { try { brut.close(); } catch (IOException x) { /* rien */ } brut = null; }
        }
    }

    private void fermerBrut() {
        synchronized (verrou) {
            if (brut != null) { try { brut.close(); } catch (IOException e) { /* rien */ } }
            brut = null; nomBrut = null;
        }
    }

    @Override
    protected void handleOnDestroy() { if (actif) { sm.unregisterListener(this); fil.quitSafely(); actif = false; } fermerBrut(); }
}
