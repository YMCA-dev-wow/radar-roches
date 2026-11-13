package io.github.ymcadevwow.radarroches;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
 */
@CapacitorPlugin(name = "Saut")
public class SautPlugin extends Plugin implements SensorEventListener {
    private static final int HZ = 100, N = HZ * 10;                // 10 s d'historique
    private static final double G = 9.81, BAS = 0.6, PIC = 2.2, CHOC = 3.0;   // seuils en g
    private SensorManager sm; private HandlerThread fil; private Handler hFil; private boolean actif = false, gravite = false;
    private final float[] acc = new float[N], accV = new float[N]; private final long[] tAcc = new long[N]; private int nAcc = 0;
    private float gx = 0, gy = 0, gz = 0;   // gravité estimée par Android (repère du téléphone)
    private long dernierChoc = 0;
    private final float[] alt = new float[N]; private final long[] tAlt = new long[N]; private int nAlt = 0;
    private long debutBas = -1, finBas = -1, dernierSaut = 0;
    private int nSauts = 0;

    @PluginMethod
    public void demarrer(PluginCall call) {
        sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        Sensor a = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER), p = sm.getDefaultSensor(Sensor.TYPE_PRESSURE), gr = sm.getDefaultSensor(Sensor.TYPE_GRAVITY);
        if (a == null) { call.reject("pas d'accéléromètre"); return; }
        if (!actif) {
            fil = new HandlerThread("radar-sauts"); fil.start();
            Handler h = new Handler(fil.getLooper()); hFil = h;
            sm.registerListener(this, a, 1000000 / HZ, 0, h);
            if (gr != null) sm.registerListener(this, gr, 1000000 / HZ, 0, h);
            if (p != null) sm.registerListener(this, p, 40000, 0, h);
            actif = true; gravite = gr != null; nAcc = 0; nAlt = 0; debutBas = -1; finBas = -1; nSauts = 0; dernierChoc = 0;
        }
        JSObject r = new JSObject(); r.put("barometre", p != null); r.put("gravite", gr != null); r.put("hz", HZ); call.resolve(r);
    }

    @PluginMethod
    public void arreter(PluginCall call) {
        if (actif) { sm.unregisterListener(this); fil.quitSafely(); actif = false; }
        JSObject r = new JSObject(); r.put("sauts", nSauts); call.resolve(r);
    }

    @Override public void onAccuracyChanged(Sensor s, int a) {}

    @Override
    public void onSensorChanged(SensorEvent e) {
        long t = System.currentTimeMillis();
        if (e.sensor.getType() == Sensor.TYPE_PRESSURE) {
            int k = nAlt++ % N; tAlt[k] = t; alt[k] = SensorManager.getAltitude(SensorManager.PRESSURE_STANDARD_ATMOSPHERE, e.values[0]);
            return;
        }
        if (e.sensor.getType() == Sensor.TYPE_GRAVITY) { gx = e.values[0]; gy = e.values[1]; gz = e.values[2]; return; }
        float g = (float) (Math.sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]) / G);
        double ng = Math.sqrt(gx * gx + gy * gy + gz * gz);
        // composante verticale (vers le haut) de l'accélération ressentie, en g : 1 au repos, 0 en chute libre, > 0 si l'aile porte
        float v = ng > 1 ? (float) ((e.values[0] * gx + e.values[1] * gy + e.values[2] * gz) / ng / G) : g;
        int k = nAcc++ % N; tAcc[k] = t; acc[k] = g; accV[k] = v;
        // phase allégée : moyenne glissante sur 0,1 s sous BAS
        double m = 0; int n = Math.min(HZ / 10, nAcc);
        for (int i = 0; i < n; i++) m += acc[(nAcc - 1 - i) % N];
        m /= n;
        if (m < BAS) { if (debutBas < 0) debutBas = t - 100; finBas = t; }
        else if (debutBas >= 0 && t - finBas > 400) debutBas = -1; // la phase allégée s'est terminée sans réception
        if (g > PIC && debutBas >= 0 && finBas - debutBas >= 300 && t - finBas < 400 && t - dernierSaut > 2000) {
            final double vol = (t - debutBas) / 1000.0; final long t0 = debutBas, t1 = t;
            if (vol < 4) { final boolean vrai = enVol(t0, t1); hFil.postDelayed(() -> signaler(t0, t1, vol, vrai), 1000); } // les rejetés partent aussi au journal (réglage)
            debutBas = -1; dernierSaut = t;
        } else if (g > CHOC && t - dernierChoc > 3000 && t - dernierSaut > 2000) { // choc sans phase allégée : candidat saut de kite
            dernierChoc = t; final long tc = t; final float pic = g;
            hFil.postDelayed(() -> signalerChoc(tc, pic), 1000);
        }
    }

    // Vrai vol : allégé tout du long (moyenne sous 0,35 g, au moins 70 % des mesures sous 0,6 g, au moins 0,45 s). Le pompage dans les molles
    // (séance du 26/10, 418 faux sauts) oscille autour de 1 g en moyenne : rejeté.
    private boolean enVol(long t0, long t1) {
        double s = 0; int n = 0, bas = 0;
        for (int i = 0; i < Math.min(nAcc, N); i++) {
            int k = (nAcc - 1 - i) % N;
            if (tAcc[k] < t0 || tAcc[k] >= t1 - 60) continue;   // sans le pic de réception
            s += acc[k]; n++; if (acc[k] < BAS) bas++;
        }
        return n >= 0.4 * HZ && s / n < 0.35 && bas >= 0.7 * n;   // 26/10 : les 418 faux sauts avaient tous une moyenne ≥ 0,37 g
    }

    private void signaler(long t0, long t1, double vol, boolean vrai) {
        if (vrai) nSauts++;
        JSObject o = new JSObject();
        o.put("vrai", vrai);
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
        o.put("hInt", Math.round(hauteurIntegree(t0, t1) * 10) / 10.0);
        ajouterCourbes(o, t0 - 2000, t1 + 1000, 2);
        o.put("avant", 2.0); o.put("hz", HZ / 2); o.put("vertical", gravite);
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

    // Courbes |a| (« courbe ») et a_vert (« courbeV »), en g, de ta à tb, un point sur « pas »
    private void ajouterCourbes(JSObject o, long ta, long tb, int pas) {
        JSArray c = new JSArray(), cv = new JSArray(); int j = 0;
        for (int i = Math.min(nAcc, N) - 1; i >= 0; i--) {
            int k = (nAcc - 1 - i) % N;
            if (tAcc[k] < ta || tAcc[k] > tb) continue;
            if (j++ % pas != 0) continue;
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

    @Override
    protected void handleOnDestroy() { if (actif) { sm.unregisterListener(this); fil.quitSafely(); actif = false; } }
}
