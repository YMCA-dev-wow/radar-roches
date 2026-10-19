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
 */
@CapacitorPlugin(name = "Saut")
public class SautPlugin extends Plugin implements SensorEventListener {
    private static final int HZ = 50, N = HZ * 8;                 // 8 s d'historique
    private static final double G = 9.81, BAS = 0.6, PIC = 2.2;   // seuils en g
    private SensorManager sm; private HandlerThread fil; private boolean actif = false;
    private final float[] acc = new float[N]; private final long[] tAcc = new long[N]; private int nAcc = 0;
    private final float[] alt = new float[N]; private final long[] tAlt = new long[N]; private int nAlt = 0;
    private long debutBas = -1, finBas = -1, dernierSaut = 0;
    private int nSauts = 0;

    @PluginMethod
    public void demarrer(PluginCall call) {
        sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        Sensor a = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER), p = sm.getDefaultSensor(Sensor.TYPE_PRESSURE);
        if (a == null) { call.reject("pas d'accéléromètre"); return; }
        if (!actif) {
            fil = new HandlerThread("radar-sauts"); fil.start();
            Handler h = new Handler(fil.getLooper());
            sm.registerListener(this, a, 1000000 / HZ, 0, h);
            if (p != null) sm.registerListener(this, p, 40000, 0, h);
            actif = true; nAcc = 0; nAlt = 0; debutBas = -1; finBas = -1; nSauts = 0;
        }
        JSObject r = new JSObject(); r.put("barometre", p != null); call.resolve(r);
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
        float g = (float) (Math.sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]) / G);
        int k = nAcc++ % N; tAcc[k] = t; acc[k] = g;
        // phase allégée : moyenne glissante sur 0,1 s sous BAS
        double m = 0; int n = Math.min(5, nAcc);
        for (int i = 0; i < n; i++) m += acc[(nAcc - 1 - i) % N];
        m /= n;
        if (m < BAS) { if (debutBas < 0) debutBas = t - 100; finBas = t; }
        else if (debutBas >= 0 && t - finBas > 400) debutBas = -1; // la phase allégée s'est terminée sans réception
        if (g > PIC && debutBas >= 0 && finBas - debutBas >= 300 && t - finBas < 400 && t - dernierSaut > 2000) {
            double vol = (t - debutBas) / 1000.0;
            if (vol < 4) signaler(debutBas, t, vol);
            debutBas = -1; dernierSaut = t;
        }
    }

    private void signaler(long t0, long t1, double vol) {
        nSauts++;
        JSObject o = new JSObject();
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
        // courbe d'accélération (g) de 2 s avant à 1 s après, un point sur deux (25 Hz), pour régler la détection
        JSArray c = new JSArray();
        for (int i = Math.min(nAcc, N) - 1; i >= 0; i--) {
            int k = (nAcc - 1 - i) % N;
            if (tAcc[k] >= t0 - 2000 && (i & 1) == 0) c.put((Object) Double.valueOf(Math.round(acc[k] * 100) / 100.0)); // put(Object) : pas d exception
        }
        o.put("courbe", c);
        notifyListeners("saut", o);
    }

    @Override
    protected void handleOnDestroy() { if (actif) { sm.unregisterListener(this); fil.quitSafely(); actif = false; } }
}
