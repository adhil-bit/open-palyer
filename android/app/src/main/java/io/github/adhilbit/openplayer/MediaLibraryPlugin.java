package io.github.adhilbit.openplayer;

import android.Manifest;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.util.Rational;
import android.util.Size;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Open Player's bridge to Android: media permission, listing every video and
 * song on the device (MediaStore), thumbnails, saving files, and a few window
 * helpers (immersive fullscreen, rotation, keep-screen-on, picture-in-picture).
 */
@CapacitorPlugin(
    name = "MediaLibrary",
    permissions = {
        @Permission(alias = "video", strings = { Manifest.permission.READ_MEDIA_VIDEO }),
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class MediaLibraryPlugin extends Plugin {

    private static final boolean MODERN = Build.VERSION.SDK_INT >= 33;

    /* ---------------- permission ---------------- */

    private String[] aliasesFor(PluginCall call) {
        if (!MODERN) return new String[] { "storage" };
        JSArray types = call.getArray("types");
        boolean video = true, audio = true;
        if (types != null) {
            String t = types.toString();
            video = t.contains("video");
            audio = t.contains("audio");
        }
        if (video && audio) return new String[] { "video", "audio" };
        return new String[] { audio ? "audio" : "video" };
    }

    private JSObject permState() {
        JSObject o = new JSObject();
        if (MODERN) {
            o.put("video", getPermissionState("video").toString());
            o.put("audio", getPermissionState("audio").toString());
        } else {
            String s = getPermissionState("storage").toString();
            o.put("video", s);
            o.put("audio", s);
        }
        return o;
    }

    @PluginMethod
    public void checkAccess(PluginCall call) {
        call.resolve(permState());
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        requestPermissionForAliases(aliasesFor(call), call, "accessCallback");
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        call.resolve(permState());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /* ---------------- "All files access" for hidden folders ---------------- */

    private boolean hasAllFiles() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return getPermissionState("storage") == PermissionState.GRANTED;
    }

    @PluginMethod
    public void checkAllFiles(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", hasAllFiles());
        call.resolve(r);
    }

    @PluginMethod
    public void requestAllFiles(PluginCall call) {
        if (Build.VERSION.SDK_INT < 30) {
            requestPermissionForAliases(new String[] { "storage" }, call, "allFilesCallback");
            return;
        }
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            Intent i = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        // The user answers in system Settings; the app re-checks when it comes back.
        JSObject r = new JSObject();
        r.put("opened", true);
        call.resolve(r);
    }

    @PermissionCallback
    private void allFilesCallback(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", hasAllFiles());
        call.resolve(r);
    }

    private static final String VIDEO_EXT = ".mp4.m4v.mkv.webm.mov.avi.3gp.3g2.ts.m2ts.mts.flv.wmv.ogv.mpg.mpeg.";
    private static final String AUDIO_EXT = ".mp3.m4a.aac.flac.wav.ogg.oga.opus.wma.amr.aif.aiff.";
    private static final int MAX_FILES = 20000;

    /** Walks shared storage and returns media files, including those in hidden or .nomedia folders. */
    @PluginMethod
    public void deepScan(PluginCall call) {
        if (!hasAllFiles()) { call.reject("All files access not granted"); return; }
        File root = Environment.getExternalStorageDirectory();
        JSArray items = new JSArray();
        int[] count = { 0 };
        walk(root, root, 0, false, items, count);
        JSObject r = new JSObject();
        r.put("items", items);
        r.put("truncated", count[0] >= MAX_FILES);
        call.resolve(r);
    }

    private void walk(File root, File dir, int depth, boolean hiddenParent, JSArray out, int[] count) {
        if (depth > 12 || count[0] >= MAX_FILES) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        boolean noMedia = new File(dir, ".nomedia").exists();
        boolean hidden = hiddenParent || noMedia || (depth > 0 && dir.getName().startsWith("."));
        for (File f : list) {
            if (count[0] >= MAX_FILES) return;
            String name = f.getName();
            if (f.isDirectory()) {
                // Android/data and Android/obb belong to other apps (unreadable); Android/media is shared.
                if (depth == 1 && dir.getName().equals("Android") && !name.equals("media")) continue;
                walk(root, f, depth + 1, hidden, out, count);
                continue;
            }
            int dot = name.lastIndexOf('.');
            if (dot < 0) continue;
            String ext = name.substring(dot).toLowerCase() + ".";
            boolean video = VIDEO_EXT.contains(ext), audio = !video && AUDIO_EXT.contains(ext);
            if (!video && !audio) continue;
            if (f.length() < 32 * 1024) continue; // skip stubs and tiny fragments
            JSObject o = new JSObject();
            o.put("path", f.getAbsolutePath());
            o.put("name", name);
            o.put("size", f.length());
            o.put("mtime", f.lastModified());
            o.put("folder", dir.getName());
            o.put("kind", video ? "video" : "audio");
            o.put("hidden", hidden || name.startsWith("."));
            out.put(o);
            count[0]++;
        }
    }

    /* ---------------- listing ---------------- */

    private static String str(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        return i >= 0 && !c.isNull(i) ? c.getString(i) : null;
    }

    private static long num(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        return i >= 0 && !c.isNull(i) ? c.getLong(i) : 0;
    }

    private static String parentName(String path) {
        if (path == null) return null;
        File p = new File(path).getParentFile();
        return p != null ? p.getName() : null;
    }

    @PluginMethod
    public void listVideos(PluginCall call) {
        Uri coll = Build.VERSION.SDK_INT >= 29
            ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
            : MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
        String[] proj = { "_id", "_display_name", "_size", "duration", "width", "height",
            "date_modified", "mime_type", "bucket_display_name", "_data" };
        JSArray items = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(coll, proj, null, null, "date_modified DESC")) {
            if (c != null) while (c.moveToNext()) {
                long id = num(c, "_id");
                String path = str(c, "_data");
                JSObject o = new JSObject();
                o.put("id", "v" + id);
                o.put("uri", ContentUris.withAppendedId(coll, id).toString());
                o.put("path", path);
                o.put("name", str(c, "_display_name"));
                o.put("size", num(c, "_size"));
                o.put("duration", num(c, "duration"));
                o.put("width", num(c, "width"));
                o.put("height", num(c, "height"));
                o.put("mtime", num(c, "date_modified") * 1000);
                o.put("mime", str(c, "mime_type"));
                String folder = str(c, "bucket_display_name");
                o.put("folder", folder != null ? folder : parentName(path));
                items.put(o);
            }
        } catch (Exception e) {
            call.reject("Could not read videos: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("items", items);
        call.resolve(r);
    }

    @PluginMethod
    public void listAudio(PluginCall call) {
        Uri coll = Build.VERSION.SDK_INT >= 29
            ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
            : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String[] proj = { "_id", "_display_name", "title", "artist", "album", "album_id",
            "duration", "_size", "date_modified", "mime_type", "_data" };
        String where = "is_music != 0 OR is_podcast != 0";
        JSArray items = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(coll, proj, where, null, "title COLLATE NOCASE ASC")) {
            if (c != null) while (c.moveToNext()) {
                long id = num(c, "_id");
                String path = str(c, "_data");
                JSObject o = new JSObject();
                o.put("id", "a" + id);
                o.put("uri", ContentUris.withAppendedId(coll, id).toString());
                o.put("path", path);
                o.put("name", str(c, "_display_name"));
                o.put("title", str(c, "title"));
                o.put("artist", str(c, "artist"));
                o.put("album", str(c, "album"));
                o.put("albumId", num(c, "album_id"));
                o.put("duration", num(c, "duration"));
                o.put("size", num(c, "_size"));
                o.put("mtime", num(c, "date_modified") * 1000);
                o.put("mime", str(c, "mime_type"));
                o.put("folder", parentName(path));
                items.put(o);
            }
        } catch (Exception e) {
            call.reject("Could not read music: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("items", items);
        call.resolve(r);
    }

    /* ---------------- thumbnails / album art ---------------- */

    @PluginMethod
    public void getThumbnail(PluginCall call) {
        String uriStr = call.getString("uri");
        String path = call.getString("path");
        boolean audio = Boolean.TRUE.equals(call.getBoolean("audio", false));
        int w = call.getInt("width", 256);
        Bitmap bmp = null;
        ContentResolver cr = getContext().getContentResolver();
        if (uriStr != null && Build.VERSION.SDK_INT >= 29) {
            try { bmp = cr.loadThumbnail(Uri.parse(uriStr), new Size(w, w), null); } catch (Exception ignored) {}
        }
        if (bmp == null) {
            MediaMetadataRetriever mmr = new MediaMetadataRetriever();
            try {
                if (path != null && new File(path).canRead()) mmr.setDataSource(path);
                else if (uriStr != null) mmr.setDataSource(getContext(), Uri.parse(uriStr));
                if (audio) {
                    byte[] art = mmr.getEmbeddedPicture();
                    if (art != null) bmp = BitmapFactory.decodeByteArray(art, 0, art.length);
                } else {
                    bmp = mmr.getFrameAtTime(2_000_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                }
            } catch (Exception ignored) {
            } finally {
                try { mmr.release(); } catch (Exception ignored) {}
            }
        }
        JSObject r = new JSObject();
        if (bmp != null) {
            if (bmp.getWidth() > w) {
                int h = Math.max(1, Math.round(bmp.getHeight() * (w / (float) bmp.getWidth())));
                bmp = Bitmap.createScaledBitmap(bmp, w, h, true);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 72, out);
            r.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        } else {
            r.put("dataUrl", null);
        }
        call.resolve(r);
    }

    /* ---------------- saving screenshots / clips ---------------- */

    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("name", "open-player-file");
        String mime = call.getString("mime", "application/octet-stream");
        String b64 = call.getString("base64");
        if (b64 == null) { call.reject("No data"); return; }
        byte[] data = Base64.decode(b64, Base64.DEFAULT);
        boolean image = mime.startsWith("image/");
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH,
                    (image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_MOVIES) + "/Open Player");
                Uri coll = image
                    ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    : MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                Uri uri = getContext().getContentResolver().insert(coll, v);
                if (uri == null) throw new Exception("insert failed");
                try (OutputStream os = getContext().getContentResolver().openOutputStream(uri)) { os.write(data); }
                JSObject r = new JSObject();
                r.put("uri", uri.toString());
                call.resolve(r);
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(
                    image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_MOVIES), "Open Player");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("cannot create folder");
                File f = new File(dir, name);
                try (FileOutputStream os = new FileOutputStream(f)) { os.write(data); }
                JSObject r = new JSObject();
                r.put("path", f.getAbsolutePath());
                call.resolve(r);
            }
        } catch (Exception e) {
            call.reject("Could not save: " + e.getMessage());
        }
    }

    /* ---------------- "Open with" / share into the app ---------------- */

    private JSObject describeIntent(Intent intent) {
        if (intent == null) return null;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(action)) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return null;
        JSObject o = new JSObject();
        o.put("uri", uri.toString());
        o.put("mime", intent.getType() != null ? intent.getType() : getContext().getContentResolver().getType(uri));
        String name = uri.getLastPathSegment();
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = str(c, OpenableColumns.DISPLAY_NAME);
                if (n != null) name = n;
                o.put("size", num(c, OpenableColumns.SIZE));
            }
        } catch (Exception ignored) {}
        o.put("name", name);
        return o;
    }

    @PluginMethod
    public void getLaunchFile(PluginCall call) {
        Activity a = getActivity();
        JSObject f = a != null ? describeIntent(a.getIntent()) : null;
        if (a != null && f != null) a.setIntent(new Intent(Intent.ACTION_MAIN)); // consume once
        JSObject r = new JSObject();
        r.put("file", f);
        call.resolve(r);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject f = describeIntent(intent);
        if (f != null) notifyListeners("openFile", f, true);
    }

    /* ---------------- window helpers ---------------- */

    @PluginMethod
    public void setImmersive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        Activity a = getActivity();
        if (a == null) { call.resolve(); return; }
        a.runOnUiThread(() -> {
            Window w = a.getWindow();
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
            if (on) {
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsetsCompat.Type.systemBars());
            } else {
                c.show(WindowInsetsCompat.Type.systemBars());
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setOrientation(PluginCall call) {
        String o = call.getString("orientation", "auto");
        Activity a = getActivity();
        if (a == null) { call.resolve(); return; }
        int v = "landscape".equals(o) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            : "portrait".equals(o) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        a.runOnUiThread(() -> { a.setRequestedOrientation(v); call.resolve(); });
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        Activity a = getActivity();
        if (a == null) { call.resolve(); return; }
        a.runOnUiThread(() -> {
            if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @PluginMethod
    public void enterPip(PluginCall call) {
        Activity a = getActivity();
        if (a == null || Build.VERSION.SDK_INT < 26) { call.reject("Picture-in-picture needs Android 8 or newer"); return; }
        int w = Math.max(1, call.getInt("width", 16));
        int h = Math.max(1, call.getInt("height", 9));
        // Android only accepts ratios between 1:2.39 and 2.39:1.
        float r = (float) w / h;
        if (r > 2.39f) { w = 239; h = 100; } else if (r < 1 / 2.39f) { w = 100; h = 239; }
        final int fw = w, fh = h;
        a.runOnUiThread(() -> {
            try {
                PictureInPictureParams p = new PictureInPictureParams.Builder().setAspectRatio(new Rational(fw, fh)).build();
                a.enterPictureInPictureMode(p);
                call.resolve();
            } catch (Exception e) {
                call.reject("Picture-in-picture isn't available");
            }
        });
    }
}
