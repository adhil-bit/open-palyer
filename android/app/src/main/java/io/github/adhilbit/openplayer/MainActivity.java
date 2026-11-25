package io.github.adhilbit.openplayer;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaLibraryPlugin.class);
        registerPlugin(NativePlayerPlugin.class);
        super.onCreate(savedInstanceState);

        // Back goes one step back inside the app (menu → player → folder → library) instead of
        // closing it. The page decides in window.OPBack(): "handled", "background" or "exit".
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web == null) { finish(); return; }
                web.evaluateJavascript("(function(){try{return window.OPBack?window.OPBack():'exit'}catch(e){return 'exit'}})()", r -> {
                    String v = r == null ? "" : r.replace("\"", "");
                    if ("handled".equals(v)) return;
                    if ("background".equals(v)) { moveTaskToBack(true); return; }   // keep music playing
                    finish();
                });
            }
        });
    }
}
