package io.github.ymcadevwow.radarroches;

import android.content.Context;
import android.os.PowerManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Garde le processeur éveillé (écran éteint) pendant que le radar tourne : calculs et bips continuent.
 * Libéré à l'arrêt du radar, et au plus tard après 6 h par sécurité.
 */
@CapacitorPlugin(name = "Veille")
public class VeillePlugin extends Plugin {
    private PowerManager.WakeLock verrou;

    @PluginMethod
    public void garder(PluginCall call) {
        if (verrou == null) {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            verrou = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RadarRoches::radar");
            verrou.setReferenceCounted(false);
        }
        verrou.acquire(6 * 60 * 60 * 1000L);
        call.resolve();
    }

    @PluginMethod
    public void liberer(PluginCall call) {
        if (verrou != null && verrou.isHeld()) verrou.release();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (verrou != null && verrou.isHeld()) verrou.release();
    }
}
