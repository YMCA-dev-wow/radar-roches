package io.github.ymcadevwow.radarroches;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.health.connect.HealthConnectManager;
import android.health.connect.HealthPermissions;
import android.health.connect.ReadRecordsRequestUsingFilters;
import android.health.connect.ReadRecordsResponse;
import android.health.connect.TimeInstantRangeFilter;
import android.health.connect.datatypes.DistanceRecord;
import android.health.connect.datatypes.ExerciseRoute;
import android.health.connect.datatypes.ExerciseSessionRecord;
import android.health.connect.datatypes.ExerciseSessionType;
import android.health.connect.datatypes.HeartRateRecord;
import android.health.connect.datatypes.Record;
import android.health.connect.datatypes.SpeedRecord;
import android.os.Build;
import android.os.OutcomeReceiver;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.lang.reflect.Field;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Health Connect (prototype, 16/11/2026) : ce que les autres applis (Garmin Connect, Suunto…) déposent dans le carnet de
 * santé d'Android — séances, fréquence cardiaque, vitesse, distance, trace GPS. Lecture seule, sur le téléphone, sans
 * compte ni serveur. Health Connect fait partie d'Android depuis la version 14 (API 34) : API du système, pas de bibliothèque.
 * diagnostic() ne renvoie que des comptes et des résumés (pas de coordonnées) : le rapport sert à savoir ce qui est disponible.
 */
@SuppressLint("NewApi") // appels à Health Connect seulement si Android 14+ (dispo())
@CapacitorPlugin(name = "Sante", permissions = {
    @Permission(alias = "sante", strings = {
        HealthPermissions.READ_EXERCISE, HealthPermissions.READ_EXERCISE_ROUTES, HealthPermissions.READ_HEART_RATE,
        HealthPermissions.READ_SPEED, HealthPermissions.READ_DISTANCE, HealthPermissions.READ_HEALTH_DATA_HISTORY })
})
public class SantePlugin extends Plugin {
    private static final String[] PERMS = { HealthPermissions.READ_EXERCISE, HealthPermissions.READ_EXERCISE_ROUTES, HealthPermissions.READ_HEART_RATE,
        HealthPermissions.READ_SPEED, HealthPermissions.READ_DISTANCE, HealthPermissions.READ_HEALTH_DATA_HISTORY };
    private static final String GARMIN = "com.garmin.android.apps.connectmobile";

    private boolean dispo() { return Build.VERSION.SDK_INT >= 34; }

    private JSObject etatObj() {
        JSObject r = new JSObject();
        r.put("disponible", dispo()); r.put("android", Build.VERSION.SDK_INT);
        JSObject p = new JSObject();
        for (String s : PERMS) p.put(s.substring(s.lastIndexOf('.') + 1), getContext().checkSelfPermission(s) == PackageManager.PERMISSION_GRANTED);
        r.put("permissions", p);
        boolean g; try { getContext().getPackageManager().getPackageInfo(GARMIN, 0); g = true; } catch (Exception e) { g = false; }
        r.put("garminConnect", g);
        return r;
    }

    @PluginMethod
    public void etat(PluginCall call) { call.resolve(etatObj()); }

    @PluginMethod
    public void demander(PluginCall call) {
        if (!dispo()) { call.reject("Health Connect intégré : Android 14 ou plus"); return; }
        if (getPermissionState("sante") == PermissionState.GRANTED) { call.resolve(etatObj()); return; }
        requestPermissionForAlias("sante", call, "apresDemande");
    }

    @PermissionCallback
    private void apresDemande(PluginCall call) { call.resolve(etatObj()); }

    // écran d'Android où l'on accorde ou retire les autorisations Health Connect de l'appli
    @PluginMethod
    public void reglages(PluginCall call) {
        if (!dispo()) { call.reject("Android 14 ou plus"); return; }
        try {
            Intent i = new Intent(HealthConnectManager.ACTION_MANAGE_HEALTH_PERMISSIONS);
            i.putExtra(Intent.EXTRA_PACKAGE_NAME, getContext().getPackageName());
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    private <T extends Record> List<T> lire(HealthConnectManager hc, Class<T> c, Instant a, Instant b) throws Exception {
        List<T> tout = new ArrayList<>(); long jeton = -1;
        do {
            ReadRecordsRequestUsingFilters.Builder<T> bd = new ReadRecordsRequestUsingFilters.Builder<>(c)
                .setTimeRangeFilter(new TimeInstantRangeFilter.Builder().setStartTime(a).setEndTime(b).build()).setPageSize(5000);
            if (jeton != -1) bd.setPageToken(jeton);
            CompletableFuture<ReadRecordsResponse<T>> f = new CompletableFuture<>();
            hc.readRecords(bd.build(), Runnable::run, new OutcomeReceiver<ReadRecordsResponse<T>, android.health.connect.HealthConnectException>() {
                @Override public void onResult(ReadRecordsResponse<T> r) { f.complete(r); }
                @Override public void onError(android.health.connect.HealthConnectException e) { f.completeExceptionally(e); }
            });
            ReadRecordsResponse<T> r = f.get(60, TimeUnit.SECONDS);
            tout.addAll(r.getRecords()); jeton = r.getNextPageToken();
        } while (jeton != -1 && tout.size() < 100000);
        return tout;
    }

    // nom lisible du type de séance (constante EXERCISE_SESSION_TYPE_… d'Android)
    private static String nomType(int t) {
        for (Field f : ExerciseSessionType.class.getFields()) {
            try { if (f.getType() == int.class && f.getInt(null) == t) return f.getName().replace("EXERCISE_SESSION_TYPE_", ""); } catch (Exception ignored) {}
        }
        return String.valueOf(t);
    }

    @PluginMethod
    public void diagnostic(PluginCall call) {
        if (!dispo()) { call.reject("Health Connect intégré : Android 14 ou plus"); return; }
        final int jours = call.getInt("jours", 30);
        Executors.newSingleThreadExecutor().execute(() -> {
            JSObject r = etatObj();
            try {
                HealthConnectManager hc = getContext().getSystemService(HealthConnectManager.class);
                Instant fin = Instant.now(), debut = fin.minus(Duration.ofDays(jours));
                r.put("jours", jours);
                JSObject erreurs = new JSObject();
                List<ExerciseSessionRecord> ses = new ArrayList<>(); List<HeartRateRecord> fc = new ArrayList<>();
                List<SpeedRecord> vit = new ArrayList<>(); List<DistanceRecord> dis = new ArrayList<>();
                try { ses = lire(hc, ExerciseSessionRecord.class, debut, fin); } catch (Exception e) { erreurs.put("seances", e.toString()); }
                try { fc = lire(hc, HeartRateRecord.class, debut, fin); } catch (Exception e) { erreurs.put("frequenceCardiaque", e.toString()); }
                try { vit = lire(hc, SpeedRecord.class, debut, fin); } catch (Exception e) { erreurs.put("vitesse", e.toString()); }
                try { dis = lire(hc, DistanceRecord.class, debut, fin); } catch (Exception e) { erreurs.put("distance", e.toString()); }
                r.put("erreurs", erreurs);
                // totaux par appli d'origine
                Map<String, int[]> parOrigine = new HashMap<>(); // [séances, enregistrements FC, mesures FC, vitesse, distance]
                for (ExerciseSessionRecord s : ses) parOrigine.computeIfAbsent(s.getMetadata().getDataOrigin().getPackageName(), k -> new int[5])[0]++;
                for (HeartRateRecord h : fc) { int[] o = parOrigine.computeIfAbsent(h.getMetadata().getDataOrigin().getPackageName(), k -> new int[5]); o[1]++; o[2] += h.getSamples().size(); }
                for (SpeedRecord v : vit) parOrigine.computeIfAbsent(v.getMetadata().getDataOrigin().getPackageName(), k -> new int[5])[3]++;
                for (DistanceRecord d : dis) parOrigine.computeIfAbsent(d.getMetadata().getDataOrigin().getPackageName(), k -> new int[5])[4]++;
                JSArray orig = new JSArray();
                for (Map.Entry<String, int[]> e : parOrigine.entrySet()) {
                    JSObject o = new JSObject(); int[] v = e.getValue();
                    o.put("appli", e.getKey()); o.put("seances", v[0]); o.put("enregistrementsFC", v[1]); o.put("mesuresFC", v[2]); o.put("vitesse", v[3]); o.put("distance", v[4]);
                    orig.put(o);
                }
                r.put("origines", orig);
                // chaque séance : type, origine, trace, FC et vitesse pendant la séance (comptes, pas de coordonnées)
                JSArray l = new JSArray();
                for (ExerciseSessionRecord s : ses) {
                    JSObject o = new JSObject();
                    Instant a = s.getStartTime(), b = s.getEndTime();
                    o.put("debut", a.toEpochMilli()); o.put("fin", b.toEpochMilli());
                    o.put("type", nomType(s.getExerciseType())); o.put("typeNum", s.getExerciseType());
                    o.put("titre", s.getTitle() != null ? s.getTitle().toString() : "");
                    o.put("origine", s.getMetadata().getDataOrigin().getPackageName());
                    o.put("traceAnnoncee", s.hasRoute());
                    ExerciseRoute route = null;
                    try { route = s.getRoute(); } catch (Exception ignored) {}
                    if (route != null) {
                        List<ExerciseRoute.Location> pts = route.getRouteLocations();
                        o.put("tracePoints", pts.size());
                        if (pts.size() > 1) o.put("tracePas", Math.round((pts.get(pts.size() - 1).getTime().toEpochMilli() - pts.get(0).getTime().toEpochMilli()) / 100.0 / (pts.size() - 1)) / 10.0);
                        o.put("traceAltitude", pts.size() > 0 && pts.get(0).getAltitude() != null);
                    } else o.put("tracePoints", s.hasRoute() ? "présente, non lue (autorisation de trace)" : 0);
                    int n = 0; long mn = 999, mx = 0, som = 0; Instant t0 = null, t1 = null;
                    for (HeartRateRecord h : fc) for (HeartRateRecord.HeartRateSample e : h.getSamples()) {
                        Instant t = e.getTime(); if (t.isBefore(a) || t.isAfter(b)) continue;
                        n++; long bpm = e.getBeatsPerMinute(); mn = Math.min(mn, bpm); mx = Math.max(mx, bpm); som += bpm;
                        if (t0 == null || t.isBefore(t0)) t0 = t; if (t1 == null || t.isAfter(t1)) t1 = t;
                    }
                    o.put("fcMesures", n);
                    if (n > 0) { o.put("fcMin", mn); o.put("fcMax", mx); o.put("fcMoy", som / n); if (n > 1) o.put("fcPas", Math.round((t1.toEpochMilli() - t0.toEpochMilli()) / 100.0 / (n - 1)) / 10.0); }
                    int nv = 0; double vmax = 0;
                    for (SpeedRecord v : vit) for (SpeedRecord.SpeedRecordSample e : v.getSamples()) {
                        if (e.getTime().isBefore(a) || e.getTime().isAfter(b)) continue;
                        nv++; vmax = Math.max(vmax, e.getSpeed().getInMetersPerSecond());
                    }
                    o.put("vitesseMesures", nv); if (nv > 0) o.put("vitesseMax", Math.round(vmax * 10) / 10.0);
                    double dtot = 0;
                    for (DistanceRecord d : dis) if (!d.getStartTime().isBefore(a) && !d.getEndTime().isAfter(b)) dtot += d.getDistance().getInMeters();
                    o.put("distance", Math.round(dtot));
                    l.put(o);
                }
                r.put("seances", l);
                call.resolve(r);
            } catch (Exception e) { call.reject(e.toString()); }
        });
    }
}
