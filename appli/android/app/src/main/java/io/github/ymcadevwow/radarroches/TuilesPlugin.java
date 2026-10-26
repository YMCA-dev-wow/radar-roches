package io.github.ymcadevwow.radarroches;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.nio.ByteBuffer;

/**
 * Décodage des tuiles du relevé (PNG embarqués dans l'appli) par Android plutôt que par la page web.
 * Constaté sur l'eau (26/10) : écran éteint, la page ne termine plus le décodage des nouvelles tuiles (chargement en
 * attente indéfiniment) ; le radar devenait aveugle hors de la zone préchargée au départ. Ici, lecture directe dans les
 * fichiers de l'appli, sans passer par l'affichage : fonctionne écran éteint.
 * Renvoie les pixels RVBA (256 × 256 × 4 octets) en base64, sans prémultiplication ni conversion de couleur.
 */
@CapacitorPlugin(name = "Tuiles")
public class TuilesPlugin extends Plugin {
    @PluginMethod
    public void lire(PluginCall call) {
        String chemin = call.getString("chemin", "");
        if (chemin.startsWith("/")) chemin = chemin.substring(1);
        final String c = chemin;
        getBridge().execute(() -> {   // hors du fil de l'interface
            try (InputStream in = getContext().getAssets().open("public/" + c)) {
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inPremultiplied = false; o.inScaled = false; o.inPreferredConfig = Bitmap.Config.ARGB_8888;
                Bitmap b = BitmapFactory.decodeStream(in, null, o);
                if (b == null) { call.reject("tuile illisible"); return; }
                ByteBuffer buf = ByteBuffer.allocate(b.getByteCount());
                b.copyPixelsToBuffer(buf);   // octets dans l'ordre R, V, B, A
                JSObject r = new JSObject();
                r.put("l", b.getWidth()); r.put("h", b.getHeight());
                r.put("rvba", Base64.encodeToString(buf.array(), Base64.NO_WRAP));
                b.recycle();
                call.resolve(r);
            } catch (Exception e) { call.reject("tuile absente : " + e.getMessage()); }
        });
    }
}
