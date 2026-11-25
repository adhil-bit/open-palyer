package io.github.adhilbit.openplayer;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RecoverableSecurityException;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.IntentSender;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaMetadataRetriever;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.util.Rational;
import android.util.Size;
import android.view.Window;
import android.view.WindowManager;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
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
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Open Player's bridge to Android: media permission, listing every video and
 * song on the device (MediaStore), thumbnails, saving files, and a few window
 * helpers (immersive fullscreen, rotation, keep-screen-on, picture-in-picture),
 * deleting / renaming files with Android's own confirmation, and headphone
 * connect / disconnect events.
 */
@CapacitorPlugin(
    name = "MediaLibrary",
    permissions = {
        @Permission(alias = "video", strings = { Manifest.permission.READ_MEDIA_VIDEO }),
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "write", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class MediaLibraryPlugin extends Plugin {

    private static final boolean MODERN = Build.VERSION.SDK_INT >= 33;

    private ActivityResultLauncher<IntentSenderRequest> confirmLauncher;
    private ActivityResultLauncher<String[]> pickLauncher;
    private PluginCall pickCall;
    private PluginCall pendingCall;
    private Runnable pendingOk;
    private BroadcastReceiver noisyReceiver;
    private AudioDeviceCallback deviceCallback;
    private final Set<Integer> knownOutputs = new HashSet<>();

    @Override
    public void load() {
        // "Add files myself": Android's own file picker. Unlike a browser file input it gives
        // real content:// links, so the all-formats engine can play MKV/AVI/AC3 files picked here.
        pickLauncher = getBridge().registerForActivityResult(
            new ActivityResultContracts.OpenMultipleDocuments(),
            uris -> {
                PluginCall c = pickCall;
                pickCall = null;
                if (c == null) return;
                JSArray out = new JSArray();
                if (uris != null) {
                    for (Uri u : uris) {
                        try {
                            getContext().getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        } catch (Exception ignored) {}
                        JSObject o = describeUri(u, null);
                        if (o != null) out.put(o);
                    }
                }
                JSObject r = new JSObject();
                r.put("files", out);
                c.resolve(r);
            });
        // Android shows its own "Allow Open Player to delete / modify this file?" dialog for
        // files that belong to other apps. Its answer comes back here.
        confirmLauncher = getBridge().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            result -> {
                PluginCall c = pendingCall;
                Runnable ok = pendingOk;
                pendingCall = null;
                pendingOk = null;
                if (c == null) return;
                if (result.getResultCode() == Activity.RESULT_OK && ok != null) ok.run();
                else c.resolve(outcome(false, true));
            }
        );
        try { watchHeadphones(); } catch (Exception ignored) {}
    }

    @Override
    protected void handleOnDestroy() {
        try { if (noisyReceiver != null) getContext().unregisterReceiver(noisyReceiver); } catch (Exception ignored) {}
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am != null && deviceCallback != null) am.unregisterAudioDeviceCallback(deviceCallback);
        } catch (Exception ignored) {}
        super.handleOnDestroy();
    }

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

    private boolean declaresAllFiles() {
        try {
            String[] req = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), PackageManager.GET_PERMISSIONS).requestedPermissions;
            return req != null && Arrays.asList(req).contains("android.permission.MANAGE_EXTERNAL_STORAGE");
        } catch (Exception e) {
            return false;
        }
    }

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
        if (Build.VERSION.SDK_INT >= 30 && !declaresAllFiles()) { call.reject("Not available in this version"); return; }
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

    /* ---------------- about this app (for "Verify this app") ---------------- */

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        JSObject r = new JSObject();
        try {
            PackageManager pm = getContext().getPackageManager();
            String pkg = getContext().getPackageName();
            PackageInfo pi;
            Signature[] sigs = null;
            if (Build.VERSION.SDK_INT >= 28) {
                pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES | PackageManager.GET_PERMISSIONS);
                if (pi.signingInfo != null) {
                    if (pi.signingInfo.hasMultipleSigners()) sigs = pi.signingInfo.getApkContentsSigners();
                    else {
                        Signature[] h = pi.signingInfo.getSigningCertificateHistory();
                        if (h != null && h.length > 0) sigs = new Signature[] { h[h.length - 1] };   // current key is last
                    }
                }
                r.put("versionCode", pi.getLongVersionCode());
            } else {
                pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES | PackageManager.GET_PERMISSIONS);
                sigs = pi.signatures;
                r.put("versionCode", pi.versionCode);
            }
            r.put("packageName", pkg);
            r.put("versionName", pi.versionName);
            if (sigs != null && sigs.length > 0) {
                byte[] d = MessageDigest.getInstance("SHA-256").digest(sigs[0].toByteArray());
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < d.length; i++) {
                    if (i > 0) sb.append(':');
                    sb.append(String.format("%02X", d[i] & 0xff));
                }
                r.put("certSha256", sb.toString());
            }
            boolean allFiles = pi.requestedPermissions != null
                && Arrays.asList(pi.requestedPermissions).contains("android.permission.MANAGE_EXTERNAL_STORAGE");
            r.put("allFilesSupported", allFiles);   // false in the Google Play version
            String installer = null;
            try {
                if (Build.VERSION.SDK_INT >= 30) installer = pm.getInstallSourceInfo(pkg).getInstallingPackageName();
                else installer = pm.getInstallerPackageName(pkg);
            } catch (Exception ignored) {}
            r.put("installer", installer);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not read app info: " + e.getMessage());
        }
    }

    /* ---------------- delete & rename ---------------- */

    private static JSObject outcome(boolean done, boolean cancelled) {
        JSObject r = new JSObject();
        r.put("done", done);
        r.put("cancelled", cancelled);
        return r;
    }

    /** Shows Android's confirmation dialog, then runs onOk if the user allows it. */
    private void askUser(PluginCall call, IntentSender sender, Runnable onOk) {
        Activity a = getActivity();
        if (a == null || confirmLauncher == null) { call.reject("Can't ask for permission right now"); return; }
        if (pendingCall != null) { call.reject("Another request is still waiting for your answer"); return; }
        pendingCall = call;
        pendingOk = onOk;
        a.runOnUiThread(() -> {
            try {
                confirmLauncher.launch(new IntentSenderRequest.Builder(sender).build());
            } catch (Exception e) {
                pendingCall = null;
                pendingOk = null;
                call.reject("Can't ask for permission: " + e.getMessage());
            }
        });
    }

    private static Uri mediaUri(String s) {
        return s != null && s.startsWith("content://media") ? Uri.parse(s) : null;
    }

    private String pathOf(Uri uri) {
        if (uri == null) return null;
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { "_data" }, null, null, null)) {
            if (c != null && c.moveToFirst()) return str(c, "_data");
        } catch (Exception ignored) {}
        return null;
    }

    private void scan(String... paths) {
        try { MediaScannerConnection.scanFile(getContext(), paths, null, null); } catch (Exception ignored) {}
    }

    @PluginMethod
    public void deleteMedia(PluginCall call) {
        final Uri uri = mediaUri(call.getString("uri"));
        final String path = call.getString("path");
        final ContentResolver cr = getContext().getContentResolver();
        try {
            // With "All files access" the file can be removed directly.
            if (path != null && hasAllFiles()) {
                File f = new File(path);
                if (f.exists() && !f.delete()) { call.reject("The file could not be deleted"); return; }
                if (uri != null) { try { cr.delete(uri, null, null); } catch (Exception ignored) {} }
                scan(path);
                call.resolve(outcome(true, false));
                return;
            }
            if (uri == null) { call.reject("This file can't be deleted from Open Player"); return; }
            if (Build.VERSION.SDK_INT >= 30) {
                PendingIntent pi = MediaStore.createDeleteRequest(cr, Collections.singletonList(uri));
                askUser(call, pi.getIntentSender(), () -> call.resolve(outcome(true, false)));
                return;
            }
            if (Build.VERSION.SDK_INT == 29) {
                try {
                    cr.delete(uri, null, null);
                    call.resolve(outcome(true, false));
                } catch (RecoverableSecurityException e) {
                    askUser(call, e.getUserAction().getActionIntent().getIntentSender(), () -> {
                        try {
                            cr.delete(uri, null, null);
                            call.resolve(outcome(true, false));
                        } catch (Exception e2) {
                            call.reject("Could not delete: " + e2.getMessage());
                        }
                    });
                }
                return;
            }
            if (getPermissionState("write") != PermissionState.GRANTED) {
                requestPermissionForAlias("write", call, "writeCallback");
                return;
            }
            String p = path != null ? path : pathOf(uri);
            if (p != null) {
                File f = new File(p);
                if (f.exists() && !f.delete()) { call.reject("The file could not be deleted"); return; }
            }
            try { cr.delete(uri, null, null); } catch (Exception ignored) {}
            if (p != null) scan(p);
            call.resolve(outcome(true, false));
        } catch (Exception e) {
            call.reject("Could not delete: " + e.getMessage());
        }
    }

    /** Storage cleaner: delete several files with one system confirmation (Android 11+). */
    @PluginMethod
    public void deleteMany(PluginCall call) {
        JSArray items = call.getArray("items");
        if (items == null || items.length() == 0) { call.resolve(outcome(true, false)); return; }
        final ContentResolver cr = getContext().getContentResolver();
        try {
            List<Uri> uris = new ArrayList<>();
            List<String> paths = new ArrayList<>();
            for (int i = 0; i < items.length(); i++) {
                org.json.JSONObject o = items.getJSONObject(i);
                Uri u = mediaUri(o.optString("uri", null));
                String p = o.isNull("path") ? null : o.optString("path", null);
                if (u != null) uris.add(u);
                if (p != null) paths.add(p);
            }
            if (hasAllFiles() && paths.size() == items.length()) {
                for (String p : paths) { File f = new File(p); if (f.exists()) f.delete(); }
                for (Uri u : uris) { try { cr.delete(u, null, null); } catch (Exception ignored) {} }
                scan(paths.toArray(new String[0]));
                call.resolve(outcome(true, false));
                return;
            }
            if (Build.VERSION.SDK_INT >= 30 && uris.size() == items.length()) {
                PendingIntent pi = MediaStore.createDeleteRequest(cr, uris);
                askUser(call, pi.getIntentSender(), () -> call.resolve(outcome(true, false)));
                return;
            }
            call.reject("Batch delete not available");   // the app falls back to one file at a time
        } catch (Exception e) {
            call.reject("Could not delete: " + e.getMessage());
        }
    }

    @PluginMethod
    public void renameMedia(PluginCall call) {
        final Uri uri = mediaUri(call.getString("uri"));
        final String path = call.getString("path");
        final String name = call.getString("name");
        if (name == null || name.trim().isEmpty() || name.contains("/")) { call.reject("Invalid name"); return; }
        try {
            if (uri != null && Build.VERSION.SDK_INT >= 29) {
                // Renaming through MediaStore keeps the file's library entry (and its watch history).
                try {
                    storeRename(call, uri, name);
                } catch (RecoverableSecurityException e) {
                    askUser(call, e.getUserAction().getActionIntent().getIntentSender(), () -> retryStoreRename(call, uri, name));
                } catch (SecurityException e) {
                    if (Build.VERSION.SDK_INT < 30) throw e;
                    PendingIntent pi = MediaStore.createWriteRequest(getContext().getContentResolver(), Collections.singletonList(uri));
                    askUser(call, pi.getIntentSender(), () -> retryStoreRename(call, uri, name));
                }
                return;
            }
            if (path != null && hasAllFiles()) { fileRename(call, path, name); return; }
            if (uri == null) { call.reject("This file can't be renamed from Open Player"); return; }
            if (getPermissionState("write") != PermissionState.GRANTED) {
                requestPermissionForAlias("write", call, "writeCallback");
                return;
            }
            String p = path != null ? path : pathOf(uri);
            if (p == null) { call.reject("File not found"); return; }
            fileRename(call, p, name);
        } catch (Exception e) {
            call.reject("Could not rename: " + e.getMessage());
        }
    }

    private void retryStoreRename(PluginCall call, Uri uri, String name) {
        try {
            storeRename(call, uri, name);
        } catch (Exception e) {
            call.reject("Could not rename: " + e.getMessage());
        }
    }

    private void storeRename(PluginCall call, Uri uri, String name) {
        String oldPath = pathOf(uri);
        if (oldPath != null) {
            File parent = new File(oldPath).getParentFile();
            if (parent != null && new File(parent, name).exists()) { call.reject("A file with that name already exists"); return; }
        }
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        int n = getContext().getContentResolver().update(uri, v, null, null);
        if (n == 0) throw new IllegalStateException("nothing was renamed");
        JSObject r = outcome(true, false);
        r.put("name", name);
        r.put("path", pathOf(uri));
        call.resolve(r);
    }

    private void fileRename(PluginCall call, String path, String name) {
        File f = new File(path);
        File t = new File(f.getParentFile(), name);
        if (t.exists()) { call.reject("A file with that name already exists"); return; }
        if (!f.renameTo(t)) { call.reject("The file could not be renamed"); return; }
        scan(path, t.getAbsolutePath());
        JSObject r = outcome(true, false);
        r.put("name", name);
        r.put("path", t.getAbsolutePath());
        call.resolve(r);
    }

    @PermissionCallback
    private void writeCallback(PluginCall call) {
        if (getPermissionState("write") != PermissionState.GRANTED) {
            call.reject("Storage permission is needed to change files");
            return;
        }
        if ("renameMedia".equals(call.getMethodName())) renameMedia(call);
        else deleteMedia(call);
    }

    /* ---------------- headphones ---------------- */

    private static boolean isHeadphone(int type) {
        return type == AudioDeviceInfo.TYPE_WIRED_HEADSET
            || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
            || type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
            || type == AudioDeviceInfo.TYPE_USB_HEADSET
            || type == 26; // AudioDeviceInfo.TYPE_BLE_HEADSET (Android 12+)
    }

    private void notifyHeadphones(boolean connected) {
        JSObject o = new JSObject();
        o.put("connected", connected);
        notifyListeners("headphones", o);
    }

    private void watchHeadphones() {
        Context ctx = getContext();
        // Unplugged / Bluetooth dropped: Android's "audio becoming noisy" broadcast.
        noisyReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(i.getAction())) notifyHeadphones(false);
            }
        };
        ContextCompat.registerReceiver(ctx, noisyReceiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED);

        // Plugged in / connected: watch for new headphone outputs (ignore ones already there).
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) knownOutputs.add(d.getId());
        deviceCallback = new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                boolean headphones = false;
                for (AudioDeviceInfo d : added) {
                    if (d.isSink() && knownOutputs.add(d.getId()) && isHeadphone(d.getType())) headphones = true;
                }
                if (headphones) notifyHeadphones(true);
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                for (AudioDeviceInfo d : removed) knownOutputs.remove(d.getId());
            }
        };
        am.registerAudioDeviceCallback(deviceCallback, new Handler(Looper.getMainLooper()));
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
        return describeUri(uri, intent.getType());
    }

    private JSObject describeUri(Uri uri, String type) {
        JSObject o = new JSObject();
        o.put("uri", uri.toString());
        o.put("mime", type != null ? type : getContext().getContentResolver().getType(uri));
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
    public void pickFiles(PluginCall call) {
        if (pickLauncher == null) { call.reject("Picker not available"); return; }
        if (pickCall != null) pickCall.reject("Replaced by a new request");
        pickCall = call;
        try {
            pickLauncher.launch(new String[] { "video/*", "audio/*", "application/octet-stream", "application/x-matroska" });
        } catch (Exception e) {
            pickCall = null;
            call.reject("Could not open the file picker");
        }
    }

    /** Files picked earlier: still readable? (permission can be lost if the file is moved). */
    @PluginMethod
    public void checkUris(PluginCall call) {
        JSArray in = call.getArray("uris");
        JSArray ok = new JSArray();
        if (in != null) {
            for (int i = 0; i < in.length(); i++) {
                String s = in.optString(i, null);
                if (s == null) continue;
                try (Cursor c = getContext().getContentResolver().query(Uri.parse(s), new String[] { OpenableColumns.SIZE }, null, null, null)) {
                    if (c != null && c.moveToFirst()) ok.put(s);
                } catch (Exception ignored) {}
            }
        }
        JSObject r = new JSObject();
        r.put("uris", ok);
        call.resolve(r);
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

    /** Heights of the status bar and navigation buttons, in CSS pixels. */
    @PluginMethod
    public void getInsets(PluginCall call) {
        Activity a = getActivity();
        if (a == null) { call.reject("No activity"); return; }
        a.runOnUiThread(() -> {
            JSObject o = new JSObject();
            WindowInsetsCompat w = ViewCompat.getRootWindowInsets(a.getWindow().getDecorView());
            float d = a.getResources().getDisplayMetrics().density;
            if (w != null) {
                Insets b = w.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                o.put("top", Math.round(b.top / d));
                o.put("bottom", Math.round(b.bottom / d));
            } else { o.put("top", 0); o.put("bottom", 0); }
            call.resolve(o);
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
