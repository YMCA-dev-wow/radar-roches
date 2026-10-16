package io.github.ymcadevwow.radarroches;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.Locale;

/**
 * Sons et voix du radar, joués par Android et non par la page web : ils continuent écran éteint, même si le navigateur
 * intégré ralentit la page. Canal « alarme » : plus fort que le canal média, réglable à part, joué en mode silencieux.
 *  - jouer(notes)            : notes ponctuelles (pré-alerte, veille, GPS perdu…)
 *  - cadence(notes, periode, duree) : motif répété toutes les « periode » s pendant « duree » s (bips d'alerte) ;
 *                              la page le renouvelle à chaque position : si elle se tait, les bips s'arrêtent seuls.
 *  - continu(f, duree)       : son continu (moins de 10 m), f = 0 pour couper
 *  - parler(texte) / taire() : synthèse vocale sur le même canal
 *  - volumeMax(on)           : volume alarme au maximum pendant le radar, rétabli à l'arrêt
 * Note : { f: Hz, f1: Hz fin (glissando), t: décalage ms, d: durée ms, v: 0..1, onde: "carre" | "triangle" }
 */
@CapacitorPlugin(name = "Son")
public class SonPlugin extends Plugin {
    private static final int TAUX = 22050, BLOC = 441; // 20 ms par bloc
    private static final AudioAttributes ATTR = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();

    private static class Note { long debut, fin; double f0, f1, v; boolean triangle; double phase; }

    private final Object verrou = new Object();
    private final ArrayList<Note> notes = new ArrayList<>();
    private ArrayList<double[]> motif = null; // [f, f1, t ms, d ms, v, triangle]
    private double periode = 1; private long prochainMotif = 0, finCadence = 0;
    private volatile double gain = 1;  // volume des alertes choisi dans l'appli (0,1 à 1)
    private double continuF = 0; private long finContinu = 0; private double phaseContinu = 0;
    private long pos = 0;               // échantillons écrits depuis le début
    private volatile Thread fil; private volatile boolean marche = false;
    static volatile int nNotes = 0, nCadences = 0; // compteurs pour le journal (lus aussi par JournalPlugin)
    private Integer volumeAvant = null;
    private TextToSpeech tts; private boolean ttsPret = false;
    private PluginCall appelParole = null;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), statut -> {
            ttsPret = statut == TextToSpeech.SUCCESS;
            if (ttsPret) {
                tts.setLanguage(Locale.FRANCE);
                tts.setAudioAttributes(ATTR);
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id) { finParole(); }
                    @Override public void onError(String id) { finParole(); }
                    @Override public void onStop(String id, boolean interrompu) { finParole(); }
                });
            }
        });
    }

    private synchronized void finParole() {
        if (appelParole != null) { appelParole.resolve(); appelParole = null; }
    }

    // ---------------------------------------------------------------- synthèse
    // Fil de synthèse : démarré au premier son, arrêté après 5 s sans rien à jouer (économie de batterie).
    // Appelé sous « verrou », après l'ajout des notes : le fil ne peut pas s'arrêter entre-temps.
    private void assurerFil() {
        if (marche) return;
        marche = true;
        Thread t = new Thread(() -> {
            int mini = AudioTrack.getMinBufferSize(TAUX, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioTrack piste = new AudioTrack.Builder().setAudioAttributes(ATTR)
                    .setAudioFormat(new AudioFormat.Builder().setSampleRate(TAUX).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(Math.max(mini, BLOC * 2 * 4)).setTransferMode(AudioTrack.MODE_STREAM).build();
            piste.play();
            short[] tampon = new short[BLOC];
            int inactif = 0;
            while (true) {
                synchronized (verrou) {
                    if (fil != Thread.currentThread() || !marche) break;
                    boolean rien = notes.isEmpty() && motif == null && (continuF <= 0 || pos >= finContinu);
                    inactif = rien ? inactif + 1 : 0;
                    if (inactif > 250) { marche = false; fil = null; break; } // 5 s de silence
                }
                remplir(tampon);
                piste.write(tampon, 0, BLOC); // bloquant : cadence la boucle sur la sortie audio
            }
            piste.stop(); piste.release();
        }, "radar-son");
        fil = t;
        t.setPriority(Thread.MAX_PRIORITY);
        t.start();
    }

    private void remplir(short[] tampon) {
        synchronized (verrou) {
            // motif répété : on programme les répétitions qui commencent dans ce bloc
            while (motif != null && prochainMotif < pos + BLOC && prochainMotif < finCadence) {
                for (double[] m : motif) ajouter(prochainMotif, m);
                nCadences++;
                prochainMotif += (long) (periode * TAUX);
            }
            if (motif != null && prochainMotif >= finCadence) motif = null;
            for (int i = 0; i < BLOC; i++) {
                long s = pos + i; double x = 0;
                for (Note n : notes) {
                    if (s < n.debut || s >= n.fin) continue;
                    double k = (double) (s - n.debut) / (n.fin - n.debut), f = n.f0 + (n.f1 - n.f0) * k;
                    n.phase += f / TAUX; n.phase -= Math.floor(n.phase);
                    double onde = n.triangle ? 4 * Math.abs(n.phase - 0.5) - 1 : (n.phase < 0.5 ? 1 : -1);
                    long a = s - n.debut, b = n.fin - s, r = TAUX / 100; // rampes de 10 ms (pas de clic)
                    double env = Math.min(1, Math.min((double) a / r, (double) b / r));
                    x += onde * n.v * env;
                }
                if (continuF > 0 && s < finContinu) {
                    phaseContinu += continuF / TAUX; phaseContinu -= Math.floor(phaseContinu);
                    x += (phaseContinu < 0.5 ? 1 : -1) * 0.9;
                }
                tampon[i] = (short) (Math.max(-1, Math.min(1, x)) * 30000 * gain);
            }
            pos += BLOC;
            for (Iterator<Note> it = notes.iterator(); it.hasNext(); ) if (it.next().fin < pos) it.remove();
        }
    }

    private void ajouter(long debut, double[] m) {
        Note n = new Note();
        n.debut = debut + (long) (m[2] * TAUX / 1000); n.fin = n.debut + (long) (m[3] * TAUX / 1000);
        n.f0 = m[0]; n.f1 = m[1]; n.v = m[4]; n.triangle = m[5] > 0;
        notes.add(n); nNotes++;
    }

    private static ArrayList<double[]> lireNotes(JSArray tab) {
        ArrayList<double[]> r = new ArrayList<>();
        if (tab == null) return r;
        for (int i = 0; i < tab.length(); i++) {
            org.json.JSONObject o = tab.optJSONObject(i);
            if (o == null) continue;
            double f = o.optDouble("f", 800);
            r.add(new double[] { f, o.optDouble("f1", f), o.optDouble("t", 0), o.optDouble("d", 100), o.optDouble("v", 0.9),
                    "triangle".equals(o.optString("onde")) ? 1 : 0 });
        }
        return r;
    }

    // ---------------------------------------------------------------- méthodes appelées par la page
    @PluginMethod
    public void jouer(PluginCall call) {
        ArrayList<double[]> l = lireNotes(call.getArray("notes"));
        synchronized (verrou) { long t = pos + BLOC; for (double[] m : l) ajouter(t, m); if (!l.isEmpty()) assurerFil(); }
        call.resolve();
    }

    @PluginMethod
    public void cadence(PluginCall call) {
        ArrayList<double[]> l = lireNotes(call.getArray("notes"));
        double p = Math.max(0.1, call.getDouble("periode", 1.0)), duree = call.getDouble("duree", 2.5);
        synchronized (verrou) {
            boolean enCours = motif != null && prochainMotif > pos;
            motif = l.isEmpty() ? null : l; periode = p;
            if (!enCours) prochainMotif = pos + BLOC;
            else prochainMotif = Math.min(prochainMotif, pos + BLOC + (long) (p * TAUX)); // accélération immédiate
            finCadence = pos + (long) (duree * TAUX);
            if (motif != null) assurerFil();
        }
        call.resolve();
    }

    @PluginMethod
    public void continu(PluginCall call) {
        double f = call.getDouble("f", 0.0);
        synchronized (verrou) {
            continuF = f; finContinu = pos + (long) (call.getDouble("duree", 2.5) * TAUX);
            if (f > 0) { motif = null; assurerFil(); }
        }
        call.resolve();
    }

    @PluginMethod
    public void silence(PluginCall call) {
        synchronized (verrou) { notes.clear(); motif = null; continuF = 0; }
        call.resolve();
    }

    // Arrêt du radar : plus de son, la sortie audio est libérée
    @PluginMethod
    public void arreter(PluginCall call) {
        synchronized (verrou) { notes.clear(); motif = null; continuF = 0; marche = false; fil = null; }
        call.resolve();
    }

    // Volume des alertes dans l'appli (0,1 à 1), en plus du volume « alarme » d'Android ; vaut aussi pour la voix
    @PluginMethod
    public void gain(PluginCall call) {
        gain = Math.max(0.05, Math.min(1, call.getDouble("v", 1.0)));
        call.resolve();
    }

    @PluginMethod
    public void parler(PluginCall call) {
        if (!ttsPret) { call.reject("synthèse vocale indisponible"); return; }
        synchronized (this) { if (appelParole != null) { appelParole.resolve(); } appelParole = call; }
        call.setKeepAlive(true);
        Bundle p = new Bundle();
        p.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, (float) gain);
        tts.setSpeechRate(call.getDouble("vitesse", 1.2).floatValue());
        tts.speak(call.getString("texte", ""), TextToSpeech.QUEUE_FLUSH, p, "radar" + System.nanoTime());
    }

    @PluginMethod
    public void taire(PluginCall call) {
        if (ttsPret) tts.stop();
        finParole();
        call.resolve();
    }

    @PluginMethod
    public void volumeMax(PluginCall call) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        boolean on = call.getBoolean("on", true);
        try {
            if (on) {
                if (volumeAvant == null) volumeAvant = am.getStreamVolume(AudioManager.STREAM_ALARM);
                am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
            } else if (volumeAvant != null) {
                am.setStreamVolume(AudioManager.STREAM_ALARM, volumeAvant, 0);
                volumeAvant = null;
            }
        } catch (SecurityException e) { /* mode Ne pas déranger strict : volume inchangé */ }
        call.resolve(etat());
    }

    // État audio, pour le journal de session
    @PluginMethod
    public void etat(PluginCall call) { call.resolve(etat()); }

    private JSObject etat() {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        JSObject o = new JSObject();
        o.put("alarme", am.getStreamVolume(AudioManager.STREAM_ALARM));
        o.put("alarmeMax", am.getStreamMaxVolume(AudioManager.STREAM_ALARM));
        o.put("media", am.getStreamVolume(AudioManager.STREAM_MUSIC));
        o.put("mediaMax", am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        o.put("sonnerie", new String[] { "silencieux", "vibreur", "normal" }[Math.max(0, Math.min(2, am.getRingerMode()))]);
        o.put("voix", ttsPret);
        o.put("sortie", sortie(am));
        o.put("notes", nNotes); o.put("motifs", nCadences); o.put("fil", marche); o.put("gain", gain);
        return o;
    }

    private static String sortie(AudioManager am) {
        if (Build.VERSION.SDK_INT < 23) return "?";
        for (android.media.AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int t = d.getType();
            if (t == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || t == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO) return "bluetooth";
            if (t == android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET) return "casque";
        }
        return "haut-parleur";
    }

    @Override
    protected void handleOnDestroy() {
        marche = false;
        if (tts != null) tts.shutdown();
    }
}
