package io.github.adhilbit.openplayer;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaLibraryPlugin.class);
        registerPlugin(NativePlayerPlugin.class);
        super.onCreate(savedInstanceState);

        // Correct "Range" answers for local files, so seeking works in the built-in video engine.
        if (getBridge() != null) getBridge().setWebViewClient(new RangeWebViewClient(getBridge()));

        // Tell the page how tall the status bar and navigation buttons are. Many WebViews report 0 for
        // CSS env(safe-area-inset-*), so the list ran under the navigation buttons.
        WebView w = getBridge() != null ? getBridge().getWebView() : null;
        if (w != null) {
            ViewCompat.setOnApplyWindowInsetsListener(w, (v, insets) -> {
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                float d = getResources().getDisplayMetrics().density;
                String js = "document.documentElement.style.setProperty('--nav-b','" + Math.round(bars.bottom / d) + "px');"
                    + "document.documentElement.style.setProperty('--nav-t','" + Math.round(bars.top / d) + "px');";
                ((WebView) v).evaluateJavascript(js, null);
                return insets;
            });
            w.post(() -> ViewCompat.requestApplyInsets(w));
        }

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
