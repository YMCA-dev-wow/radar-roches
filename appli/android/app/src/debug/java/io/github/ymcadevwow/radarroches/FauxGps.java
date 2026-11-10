package io.github.ymcadevwow.radarroches;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.os.SystemClock;
import android.util.Log;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.tasks.Tasks;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.ArrayList;
import java.util.List;

/**
 * Fausse position pour les essais (version de test « Radar test » seulement, build debug) : rejoue un trajet enregistré
 * dans le service de localisation de Google, une position par seconde, comme le GPS sur l'eau. Le radar reçoit ces
 * positions par son service Android habituel, écran allumé ou éteint.
 * Prérequis (adb) : adb shell appops set io.github.ymcadevwow.radarroches.test android:mock_location allow
 * Lancer : adb shell am broadcast -n io.github.ymcadevwow.radarroches.test/io.github.ymcadevwow.radarroches.FauxGps
 *            --es trajet trajet.csv   (fichier dans les fichiers de l'appli, lignes « lat,lon,vitesse m/s,cap ° »)
 * Arrêter : … --es cmd stop      Journal : adb logcat -s FauxGps
 */
public class FauxGps extends BroadcastReceiver {
    private static final String TAG = "FauxGps";
    private static volatile Thread fil = null;
    private static volatile boolean arret = false;

    @Override
    public void onReceive(Context ctx, Intent it) {
        final Context app = ctx.getApplicationContext();
        arret = true;
        if (fil != null) try { fil.join(3000); } catch (InterruptedException ignore) {}
        if ("stop".equals(it.getStringExtra("cmd"))) { Log.i(TAG, "arrêt demandé"); return; }
        final String nom = it.getStringExtra("trajet");
        if (nom == null) { Log.e(TAG, "extra « trajet » manquant"); return; }
        arret = false;
        fil = new Thread(() -> jouer(app, new File(app.getFilesDir(), nom)), "faux-gps");
        fil.start();
    }

    private static void jouer(Context c, File f) {
        List<double[]> pts = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(new FileReader(f))) {
            String l;
            while ((l = r.readLine()) != null) {
                String[] p = l.trim().split(",");
                if (p.length < 4) continue;
                try { pts.add(new double[]{ Double.parseDouble(p[0]), Double.parseDouble(p[1]), Double.parseDouble(p[2]), Double.parseDouble(p[3]) }); }
                catch (NumberFormatException ignore) {}
            }
        } catch (Exception e) { Log.e(TAG, "trajet illisible : " + f, e); return; }
        FusedLocationProviderClient cl = LocationServices.getFusedLocationProviderClient(c);
        try { Tasks.await(cl.setMockMode(true)); }
        catch (Exception e) { Log.e(TAG, "mode fausse position refusé (appops mock_location ?)", e); return; }
        Log.i(TAG, "début : " + pts.size() + " positions");
        try {
            long t0 = SystemClock.elapsedRealtime();
            for (int i = 0; i < pts.size() && !arret; i++) {
                double[] p = pts.get(i);
                Location loc = new Location("fused");
                loc.setLatitude(p[0]); loc.setLongitude(p[1]);
                loc.setSpeed((float) p[2]); loc.setBearing((float) p[3]);
                loc.setAccuracy(3f); loc.setAltitude(0);
                loc.setTime(System.currentTimeMillis());
                loc.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
                Tasks.await(cl.setMockLocation(loc));
                if (i % 30 == 0) Log.i(TAG, "position " + i + "/" + pts.size() + " " + p[0] + "," + p[1]);
                long attente = t0 + (i + 1) * 1000L - SystemClock.elapsedRealtime();
                if (attente > 0) Thread.sleep(attente);
            }
        } catch (Exception e) { Log.e(TAG, "interrompu", e); }
        finally {
            try { Tasks.await(cl.setMockMode(false)); } catch (Exception ignore) {}
            Log.i(TAG, "fin du trajet");
        }
    }
}
