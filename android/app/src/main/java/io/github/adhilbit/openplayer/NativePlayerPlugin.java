package io.github.adhilbit.openplayer;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.audiofx.DynamicsProcessing;
import android.media.audiofx.Equalizer;
import android.media.audiofx.LoudnessEnhancer;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.text.CueGroup;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.SubtitleView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import io.github.anilbeesetti.nextlib.media3ext.ffdecoder.FfmpegSubtitleExtractorsFactory;
import io.github.anilbeesetti.nextlib.media3ext.ffdecoder.FfmpegSubtitleSourceKt;
import io.github.anilbeesetti.nextlib.media3ext.ffdecoder.FfmpegTextRendererKt;
import io.github.anilbeesetti.nextlib.media3ext.ffdecoder.NextRenderersFactory;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Open Player's "all formats" engine: Media3 ExoPlayer with NextLib's FFmpeg decoders.
 *
 * The video is drawn on a TextureView placed *behind* the (transparent) WebView, so the web
 * interface — controls, gestures, menus — stays on top. Events go to JavaScript as "player"
 * events; the JS side wraps them in an object that behaves like a <video> element.
 */
@OptIn(markerClass = UnstableApi.class)
@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {

    private static final Set<String> WEB_AUDIO = new HashSet<>(Arrays.asList(
        "audio/mp4a-latm", "audio/mpeg", "audio/opus", "audio/vorbis", "audio/flac", "audio/raw"));
    private static final Set<String> WEB_VIDEO = new HashSet<>(Arrays.asList(
        "video/avc", "video/hevc", "video/x-vnd.on2.vp8", "video/x-vnd.on2.vp9", "video/av01"));
    // Containers the WebView can't open, or where tracks/subtitles are usually embedded.
    private static final Set<String> NATIVE_EXT = new HashSet<>(Arrays.asList(
        "mkv", "avi", "flv", "ts", "m2ts", "mts", "mpg", "mpeg", "vob", "divx", "3gp"));

    private final Handler main = new Handler(Looper.getMainLooper());
    private ExoPlayer player;
    private FrameLayout container;
    private AspectRatioFrameLayout frame;
    private TextureView surface;
    private SubtitleView subtitles;
    private Equalizer eq;
    private LoudnessEnhancer booster;
    private DynamicsProcessing night;
    private float volume = 1f;
    private float zoom = 1f;
    private boolean mirror = false;
    private float forcedAspect = 0f;
    private boolean sentMeta = false;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (player == null) return;
            JSObject o = new JSObject();
            o.put("type", "time");
            o.put("position", player.getCurrentPosition());
            o.put("buffered", player.getBufferedPosition());
            emit(o);
            if (player.isPlaying()) main.postDelayed(this, 250);
        }
    };

    private void emit(JSObject o) {
        notifyListeners("player", o);
    }

    private void onMain(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) r.run();
        else main.post(r);
    }

    /**
     * A whole number sent from JavaScript.
     *
     * Not call.getLong(): the bridge parses numbers below 2^31 as Integer, and getLong() only
     * accepts a Long, so it silently returned the default (0) for every real position. That made
     * every jump (seek bar, ±10 s, double-tap, resume) restart the video from 0:00.
     */
    private static long longArg(PluginCall call, String key, long fallback) {
        Object v = call.getData().opt(key);
        return v instanceof Number ? ((Number) v).longValue() : fallback;
    }

    /* ---------------- should this file use the native engine? ---------------- */

    @PluginMethod
    public void probe(PluginCall call) {
        String path = call.getString("path");
        String uri = call.getString("uri");
        String name = call.getString("name", path != null ? path : uri);
        JSObject r = new JSObject();
        String ext = "";
        if (name != null && name.lastIndexOf('.') > 0) ext = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        if (NATIVE_EXT.contains(ext)) {
            r.put("needsNative", true);
            r.put("reason", "container:" + ext);
            call.resolve(r);
            return;
        }
        MediaExtractor ex = new MediaExtractor();
        try {
            if (path != null && new File(path).canRead()) ex.setDataSource(path);
            else if (uri != null) ex.setDataSource(getContext(), Uri.parse(uri), null);
            else throw new IllegalArgumentException("no source");
            int audio = 0, text = 0;
            String reason = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime == null) continue;
                if (mime.startsWith("audio/")) {
                    audio++;
                    if (!WEB_AUDIO.contains(mime)) reason = "audio:" + mime;
                } else if (mime.startsWith("video/")) {
                    if (!WEB_VIDEO.contains(mime)) reason = "video:" + mime;
                } else if (mime.startsWith("text/") || mime.startsWith("application/")) {
                    text++;
                }
            }
            if (reason == null && audio > 1) reason = "audio tracks:" + audio;
            if (reason == null && text > 0) reason = "subtitle tracks:" + text;
            r.put("needsNative", reason != null);
            r.put("reason", reason);
            r.put("audioTracks", audio);
            r.put("textTracks", text);
        } catch (Exception e) {
            r.put("needsNative", true);
            r.put("reason", "unreadable by Android's extractor");
        } finally {
            try { ex.release(); } catch (Exception ignored) {}
        }
        call.resolve(r);
    }

    /* ---------------- open / close ---------------- */

    private void ensureViews() {
        if (container != null) return;
        Activity a = getActivity();
        WebView web = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) web.getParent();

        container = new FrameLayout(a);
        container.setBackgroundColor(Color.BLACK);

        frame = new AspectRatioFrameLayout(a);
        frame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        surface = new TextureView(a);
        frame.addView(surface, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        container.addView(frame, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));

        subtitles = new SubtitleView(a);
        subtitles.setUserDefaultStyle();
        subtitles.setUserDefaultTextSize();
        container.addView(subtitles, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        subtitles.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, orr, ob) -> {
            if (player != null && r > l && b > t) {
                try { FfmpegTextRendererKt.setSubtitleViewportSize(player, r - l, b - t); } catch (Throwable ignored) {}
            }
        });

        parent.addView(container, 0, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(Color.TRANSPARENT);
    }

    private void ensurePlayer() {
        if (player != null) return;
        Context ctx = getContext();
        DefaultDataSource.Factory data = new DefaultDataSource.Factory(ctx);
        // MkvSeekFix: MKV files without a seek index (Cues) become seekable.
        DefaultMediaSourceFactory media = new DefaultMediaSourceFactory(ctx, new MkvSeekFix(ctx, new FfmpegSubtitleExtractorsFactory()));
        media.setDataSourceFactory(data);
        MediaSource.Factory sources = FfmpegSubtitleSourceKt.withFfmpegSubtitles(media, data);
        NextRenderersFactory renderers = new NextRenderersFactory(ctx);
        // Phone decoders first; FFmpeg takes over for anything they can't play (AC3, DTS, TrueHD…).
        renderers.setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON);
        player = new ExoPlayer.Builder(ctx)
            .setRenderersFactory(renderers)
            .setMediaSourceFactory(sources)
            .build();
        player.setVideoTextureView(surface);
        player.addListener(listener);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String path = call.getString("path");
        String uri = call.getString("uri");
        long startMs = longArg(call, "startMs", 0L);
        boolean playNow = Boolean.TRUE.equals(call.getBoolean("play", true));
        if (path == null && uri == null) { call.reject("No file"); return; }
        onMain(() -> {
            try {
                ensureViews();
                ensurePlayer();
                sentMeta = false;
                forcedAspect = 0f;
                Uri u = path != null && new File(path).canRead() ? Uri.fromFile(new File(path)) : Uri.parse(uri);
                player.setMediaItem(MediaItem.fromUri(u), Math.max(0, startMs));
                // Subtitles: off unless the file marks one as default/forced; the user picks in the menu.
                player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .clearOverrides()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                    .setPreferredTextLanguage(null)
                    .build());
                player.setVolume(Math.min(1f, volume));
                player.setPlayWhenReady(playNow);
                player.prepare();
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not open: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        onMain(() -> {
            releaseAll();
            call.resolve();
        });
    }

    private void releaseAll() {
        main.removeCallbacks(ticker);
        releaseEffects();
        if (player != null) {
            player.removeListener(listener);
            player.release();
            player = null;
        }
        if (container != null) {
            ViewGroup p = (ViewGroup) container.getParent();
            if (p != null) p.removeView(container);
            container = null;
            frame = null;
            surface = null;
            subtitles = null;
        }
        try { getBridge().getWebView().setBackgroundColor(Color.parseColor("#0f1115")); } catch (Exception ignored) {}
    }

    /* ---------------- transport ---------------- */

    @PluginMethod
    public void play(PluginCall call) {
        onMain(() -> {
            if (player != null) {
                if (player.getPlaybackState() == Player.STATE_ENDED) player.seekTo(0);
                player.play();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        onMain(() -> { if (player != null) player.pause(); call.resolve(); });
    }

    /** Details for the app's "Playback details" screen. */
    @PluginMethod
    public void diag(PluginCall call) {
        onMain(() -> {
            JSObject o = new JSObject();
            o.put("mkv", MkvSeekFix.lastInfo);
            o.put("rangeServed", RangeWebViewClient.served);
            o.put("range", RangeWebViewClient.lastInfo);
            if (player != null) {
                o.put("seekable", player.isCurrentMediaItemSeekable());
                o.put("position", player.getCurrentPosition());
                o.put("duration", player.getDuration());
                o.put("state", player.getPlaybackState());
                androidx.media3.common.Format a = player.getAudioFormat(), v = player.getVideoFormat();
                o.put("audio", a == null ? "" : String.valueOf(a.sampleMimeType));
                o.put("video", v == null ? "" : String.valueOf(v.sampleMimeType));
            }
            call.resolve(o);
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        long ms = longArg(call, "ms", 0L);
        onMain(() -> { if (player != null) player.seekTo(Math.max(0, ms)); call.resolve(); });
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        float rate = call.getFloat("rate", 1f);
        onMain(() -> {
            if (player != null) player.setPlaybackParameters(new PlaybackParameters(Math.max(0.1f, Math.min(4f, rate))));
            call.resolve();
        });
    }

    /** 0..1 is normal volume; above 1 boosts with LoudnessEnhancer (up to 2 = +6 dB). */
    @PluginMethod
    public void setVolume(PluginCall call) {
        float v = call.getFloat("volume", 1f);
        onMain(() -> {
            volume = Math.max(0f, Math.min(2f, v));
            if (player != null) {
                player.setVolume(Math.min(1f, volume));
                try {
                    if (volume > 1f) {
                        if (booster == null) booster = new LoudnessEnhancer(player.getAudioSessionId());
                        booster.setTargetGain((int) Math.round(2000 * Math.log10(volume)));
                        booster.setEnabled(true);
                    } else if (booster != null) {
                        booster.setEnabled(false);
                    }
                } catch (Exception ignored) {}
            }
            call.resolve();
        });
    }

    /* ---------------- picture ---------------- */

    @PluginMethod
    public void setLayout(PluginCall call) {
        String mode = call.getString("mode", "fit");
        float z = call.getFloat("zoom", 1f);
        boolean m = Boolean.TRUE.equals(call.getBoolean("mirror", false));
        onMain(() -> {
            if (frame == null) { call.resolve(); return; }
            zoom = z;
            mirror = m;
            forcedAspect = 0f;
            switch (mode) {
                case "fill": frame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_ZOOM); break;
                case "stretch": frame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FILL); break;
                case "16:9": frame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT); forcedAspect = 16f / 9f; break;
                case "4:3": frame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT); forcedAspect = 4f / 3f; break;
                default: frame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
            }
            applyAspect();
            frame.setScaleX(zoom * (mirror ? -1 : 1));
            frame.setScaleY(zoom);
            call.resolve();
        });
    }

    private void applyAspect() {
        if (frame == null || player == null) return;
        if (forcedAspect > 0) { frame.setAspectRatio(forcedAspect); return; }
        VideoSize vs = player.getVideoSize();
        if (vs.width > 0 && vs.height > 0) frame.setAspectRatio(vs.width * vs.pixelWidthHeightRatio / vs.height);
    }

    @PluginMethod
    public void screenshot(PluginCall call) {
        onMain(() -> {
            if (surface == null || player == null) { call.reject("Nothing to capture"); return; }
            VideoSize vs = player.getVideoSize();
            int w = vs.width > 0 ? Math.round(vs.width * vs.pixelWidthHeightRatio) : surface.getWidth();
            int h = vs.height > 0 ? vs.height : surface.getHeight();
            Bitmap bmp = w > 0 && h > 0 ? surface.getBitmap(w, h) : null;
            if (bmp == null) { call.reject("Nothing to capture"); return; }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
            JSObject r = new JSObject();
            r.put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            r.put("width", w);
            r.put("height", h);
            call.resolve(r);
        });
    }

    /* ---------------- tracks & subtitles ---------------- */

    private JSArray describeTracks(Tracks tracks) {
        JSArray arr = new JSArray();
        List<Tracks.Group> groups = tracks.getGroups();
        for (int g = 0; g < groups.size(); g++) {
            Tracks.Group grp = groups.get(g);
            int type = grp.getType();
            if (type != C.TRACK_TYPE_AUDIO && type != C.TRACK_TYPE_TEXT) continue;
            for (int t = 0; t < grp.length; t++) {
                Format f = grp.getTrackFormat(t);
                JSObject o = new JSObject();
                o.put("type", type == C.TRACK_TYPE_AUDIO ? "audio" : "text");
                o.put("group", g);
                o.put("track", t);
                o.put("label", f.label);
                o.put("language", f.language);
                o.put("codec", f.sampleMimeType != null ? f.sampleMimeType : f.codecs);
                o.put("channels", f.channelCount);
                o.put("selected", grp.isTrackSelected(t));
                o.put("supported", grp.isTrackSupported(t));
                o.put("forced", (f.selectionFlags & C.SELECTION_FLAG_FORCED) != 0);
                arr.put(o);
            }
        }
        return arr;
    }

    @PluginMethod
    public void selectTrack(PluginCall call) {
        String type = call.getString("type", "audio");
        int g = call.getInt("group", -1);
        int t = call.getInt("track", -1);
        boolean off = Boolean.TRUE.equals(call.getBoolean("off", false));
        onMain(() -> {
            if (player == null) { call.resolve(); return; }
            int trackType = "text".equals(type) ? C.TRACK_TYPE_TEXT : C.TRACK_TYPE_AUDIO;
            TrackSelectionParameters.Builder b = player.getTrackSelectionParameters().buildUpon();
            if (off) {
                b.setTrackTypeDisabled(trackType, true);
            } else {
                List<Tracks.Group> groups = player.getCurrentTracks().getGroups();
                if (g < 0 || g >= groups.size()) { call.reject("No such track"); return; }
                b.setTrackTypeDisabled(trackType, false)
                 .setOverrideForType(new TrackSelectionOverride(groups.get(g).getMediaTrackGroup(), t));
            }
            player.setTrackSelectionParameters(b.build());
            call.resolve();
        });
    }

    /** Style for embedded subtitles, to match the user's subtitle settings. */
    @PluginMethod
    public void setSubtitleStyle(PluginCall call) {
        float sizePx = call.getFloat("size", 20f);           // CSS pixels
        float bottom = call.getFloat("bottom", 0.09f);       // fraction of the screen height
        boolean background = Boolean.TRUE.equals(call.getBoolean("background", false));
        boolean visible = !Boolean.FALSE.equals(call.getBoolean("visible", true));
        onMain(() -> {
            if (subtitles == null) { call.resolve(); return; }
            subtitles.setFixedTextSize(TypedValue.COMPLEX_UNIT_DIP, sizePx);
            subtitles.setBottomPaddingFraction(Math.max(0f, Math.min(0.5f, bottom)));
            subtitles.setApplyEmbeddedStyles(true);
            subtitles.setStyle(new CaptionStyleCompat(Color.WHITE,
                background ? Color.argb(166, 0, 0, 0) : Color.TRANSPARENT, Color.TRANSPARENT,
                CaptionStyleCompat.EDGE_TYPE_OUTLINE, Color.BLACK, null));
            subtitles.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
            call.resolve();
        });
    }

    /* ---------------- sound: equalizer and night mode ---------------- */

    @PluginMethod
    public void setAudio(PluginCall call) {
        boolean eqOn = Boolean.TRUE.equals(call.getBoolean("eq", false));
        boolean nightOn = Boolean.TRUE.equals(call.getBoolean("night", false));
        JSArray gains = call.getArray("bands");
        JSArray freqs = call.getArray("freqs");
        onMain(() -> {
            if (player == null) { call.resolve(); return; }
            int session = player.getAudioSessionId();
            try {
                if (eqOn || eq != null) {
                    if (eq == null) eq = new Equalizer(0, session);
                    short n = eq.getNumberOfBands();
                    short[] range = eq.getBandLevelRange();
                    double[] g = toDoubles(gains), f = toDoubles(freqs);
                    for (short b = 0; b < n; b++) {
                        double hz = eq.getCenterFreq(b) / 1000.0;
                        int mB = eqOn ? (int) Math.round(interpolate(f, g, hz) * 100) : 0;
                        eq.setBandLevel(b, (short) Math.max(range[0], Math.min(range[1], mB)));
                    }
                    eq.setEnabled(eqOn);
                }
            } catch (Exception ignored) {}
            try {
                if (Build.VERSION.SDK_INT >= 28) {
                    if (nightOn) {
                        if (night == null) {
                            DynamicsProcessing.Config cfg = new DynamicsProcessing.Config.Builder(
                                DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 2,
                                false, 0, true, 1, false, 0, true).build();
                            night = new DynamicsProcessing(0, session, cfg);
                            // Squash loud peaks, lift quiet dialogue.
                            DynamicsProcessing.MbcBand band = new DynamicsProcessing.MbcBand(
                                true, 20000f, 3f, 250f, 6f, -32f, 12f, -90f, 1f, 0f, 9f);
                            night.setMbcBandAllChannelsTo(0, band);
                            night.setLimiterAllChannelsTo(new DynamicsProcessing.Limiter(
                                true, true, 0, 1f, 60f, 10f, -3f, 0f));
                        }
                        night.setEnabled(true);
                    } else if (night != null) {
                        night.setEnabled(false);
                    }
                }
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    private static double[] toDoubles(JSArray a) {
        if (a == null) return new double[0];
        double[] out = new double[a.length()];
        for (int i = 0; i < out.length; i++) out[i] = a.optDouble(i, 0);
        return out;
    }

    /** Gain at frequency hz, interpolated on a log-frequency scale between the 10 UI bands. */
    private static double interpolate(double[] freqs, double[] gains, double hz) {
        int n = Math.min(freqs.length, gains.length);
        if (n == 0) return 0;
        if (hz <= freqs[0]) return gains[0];
        if (hz >= freqs[n - 1]) return gains[n - 1];
        for (int i = 1; i < n; i++) {
            if (hz <= freqs[i]) {
                double a = Math.log(freqs[i - 1]), b = Math.log(freqs[i]), x = Math.log(hz);
                return gains[i - 1] + (gains[i] - gains[i - 1]) * (x - a) / (b - a);
            }
        }
        return 0;
    }

    private void releaseEffects() {
        try { if (eq != null) eq.release(); } catch (Exception ignored) {}
        try { if (booster != null) booster.release(); } catch (Exception ignored) {}
        try { if (night != null) night.release(); } catch (Exception ignored) {}
        eq = null;
        booster = null;
        night = null;
    }

    /* ---------------- events ---------------- */

    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_READY && !sentMeta) {
                sentMeta = true;
                VideoSize vs = player.getVideoSize();
                JSObject o = new JSObject();
                o.put("type", "meta");
                o.put("duration", player.getDuration() == C.TIME_UNSET ? -1 : player.getDuration());
                o.put("seekable", player.isCurrentMediaItemSeekable());
                o.put("width", vs.width);
                o.put("height", vs.height);
                emit(o);
                applyAspect();
            }
            sendState();
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            sendState();
            main.removeCallbacks(ticker);
            if (isPlaying) main.post(ticker);
            else ticker.run();   // one last position update
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            sendState();
        }

        @Override
        public void onVideoSizeChanged(@NonNull VideoSize vs) {
            applyAspect();
            JSObject o = new JSObject();
            o.put("type", "size");
            o.put("width", Math.round(vs.width * vs.pixelWidthHeightRatio));
            o.put("height", vs.height);
            emit(o);
        }

        @Override
        public void onTracksChanged(@NonNull Tracks tracks) {
            JSObject o = new JSObject();
            o.put("type", "tracks");
            o.put("tracks", describeTracks(tracks));
            emit(o);
        }

        @Override
        public void onCues(@NonNull CueGroup cues) {
            if (subtitles != null) subtitles.setCues(cues.cues);
        }

        @Override
        public void onPlaybackParametersChanged(@NonNull PlaybackParameters p) {
            JSObject o = new JSObject();
            o.put("type", "rate");
            o.put("rate", p.speed);
            emit(o);
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException e) {
            JSObject o = new JSObject();
            o.put("type", "error");
            o.put("code", e.errorCode);
            o.put("name", e.getErrorCodeName());
            o.put("message", e.getMessage());
            emit(o);
        }
    };

    private void sendState() {
        if (player == null) return;
        int s = player.getPlaybackState();
        JSObject o = new JSObject();
        o.put("type", "state");
        o.put("state", s == Player.STATE_BUFFERING ? "buffering" : s == Player.STATE_READY ? "ready" : s == Player.STATE_ENDED ? "ended" : "idle");
        o.put("playWhenReady", player.getPlayWhenReady());
        o.put("playing", player.isPlaying());
        o.put("position", player.getCurrentPosition());
        o.put("duration", player.getDuration() == C.TIME_UNSET ? -1 : player.getDuration());
        o.put("seekable", player.isCurrentMediaItemSeekable());
        emit(o);
    }

    /* ---------------- app lifecycle ---------------- */

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        Activity a = getActivity();
        boolean pip = a != null && Build.VERSION.SDK_INT >= 24 && a.isInPictureInPictureMode();
        if (player != null && !pip) player.pause();   // like other players: video pauses in the background
    }

    @Override
    protected void handleOnDestroy() {
        releaseAll();
        super.handleOnDestroy();
    }
}
