package io.github.ymcadevwow.radarroches;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VeillePlugin.class); // maintien du processeur pendant la navigation, écran éteint
        registerPlugin(SonPlugin.class);    // sons et voix joués par Android (continuent écran éteint)
        registerPlugin(JournalPlugin.class); // journal de session, état de l'appareil
        super.onCreate(savedInstanceState);

        // Geste retour : page précédente ; pendant la navigation radar, il ne quitte jamais le radar
        // (l'appli passe seulement en arrière-plan, le radar continue) ; depuis l'accueil, l'appli passe en arrière-plan.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView vue = getBridge().getWebView();
                vue.evaluateJavascript("window.radarEnCours === true", enCours -> {
                    if ("true".equals(enCours)) moveTaskToBack(true);
                    else if (vue.canGoBack()) vue.goBack();
                    else moveTaskToBack(true);
                });
            }
        });
    }
}
