package io.github.ymcadevwow.radarroches;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VeillePlugin.class); // maintien du processeur pendant la navigation, écran éteint
        super.onCreate(savedInstanceState);
    }
}
