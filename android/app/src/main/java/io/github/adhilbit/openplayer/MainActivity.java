package io.github.adhilbit.openplayer;

import android.app.PictureInPictureParams;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** Set by the page (MediaLibraryPlugin.setAutoPip): a video is playing in the full player. */
    static volatile boolean autoPip = false;
    static volatile int pipW = 16, pipH = 9;

    static PictureInPictureParams pipParams(boolean autoEnter) {
        int w = Math.max(1, pipW), h = Math.max(1, pipH);
        float r = (float) w / h;   // Android accepts 1:2.39 … 2.39:1
        if (r > 2.39f) { w = 239; h = 100; } else if (r < 1 / 2.39f) { w = 100; h = 239; }
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(new Rational(w, h));
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(autoEnter).setSeamlessResizeEnabled(true);
        return b.build();
    }

    // Android 8–11: pressing Home while a video plays opens the floating window (12+ does it via setAutoEnterEnabled).
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (autoPip && Build.VERSION.SDK_INT >= 26 && Build.VERSION.SDK_INT < 31) {
            try { enterPictureInPictureMode(pipParams(false)); } catch (Exception ignored) {}
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPip, newConfig);
        WebView web = getBridge() != null ? getBridge().getWebView() : null;
        if (web != null) web.evaluateJavascript("window.OPPip && window.OPPip(" + inPip + ")", null);
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaLibraryPlugin.class);
        registerPlugin(NativePlayerPlugin.class);
        super.onCreate(savedInstanceState);

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
