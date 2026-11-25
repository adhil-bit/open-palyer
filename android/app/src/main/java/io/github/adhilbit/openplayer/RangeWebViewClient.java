package io.github.adhilbit.openplayer;

import android.content.ContentResolver;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Log;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Serves "Range" requests for local video and music files correctly.
 *
 * The phone's built-in video engine seeks by asking for "bytes from X onward". Capacitor's own
 * local server answers with a 206 header for X but sends the file from byte 0, so every seek,
 * ±10 s skip and drag of the seek bar restarted the video from the beginning. Here the stream
 * really starts at X, with the true file length (also for files over 2 GB).
 */
public class RangeWebViewClient extends BridgeWebViewClient {
    private static final String TAG = "RangeWebViewClient";
    private final Bridge bridge;

    public RangeWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        try {
            WebResourceResponse r = serveRange(request);
            if (r != null) return r;
        } catch (Throwable t) {
            Log.w(TAG, "range request failed, falling back", t);
        }
        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse serveRange(WebResourceRequest req) throws IOException {
        Map<String, String> h = req.getRequestHeaders();
        String range = h.get("Range") != null ? h.get("Range") : h.get("range");
        if (range == null || !range.startsWith("bytes=")) return null;
        Uri url = req.getUrl();
        String path = url.getPath(), encoded = url.getEncodedPath();
        if (path == null || encoded == null) return null;

        Uri target;
        if (path.startsWith(Bridge.CAPACITOR_FILE_START)) {
            target = Uri.fromFile(new File(path.substring(Bridge.CAPACITOR_FILE_START.length())));
        } else if (encoded.startsWith(Bridge.CAPACITOR_CONTENT_START)) {
            target = Uri.parse("content:/" + encoded.substring(Bridge.CAPACITOR_CONTENT_START.length()));
        } else {
            return null;   // app files and anything else: Capacitor handles them
        }

        ContentResolver cr = bridge.getContext().getContentResolver();
        ParcelFileDescriptor pfd = cr.openFileDescriptor(target, "r");
        if (pfd == null) return null;
        long total = pfd.getStatSize();
        if (total <= 0) { pfd.close(); return null; }   // a pipe with no known size: let Capacitor try

        String spec = range.substring(6).split(",")[0].trim();
        String[] p = spec.split("-", -1);
        long start, end;
        if (p[0].isEmpty()) {                          // "bytes=-500": the last 500 bytes
            long n = Long.parseLong(p[1]);
            start = Math.max(0, total - n);
            end = total - 1;
        } else {
            start = Long.parseLong(p[0]);
            end = p.length > 1 && !p[1].isEmpty() ? Math.min(Long.parseLong(p[1]), total - 1) : total - 1;
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-store");
        if (start >= total || start > end) {
            pfd.close();
            headers.put("Content-Range", "bytes */" + total);
            return new WebResourceResponse("text/plain", null, 416, "Range Not Satisfiable", headers, null);
        }

        FileInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
        in.getChannel().position(start);
        long length = end - start + 1;
        headers.put("Content-Range", "bytes " + start + "-" + end + "/" + total);
        headers.put("Content-Length", String.valueOf(length));
        return new WebResourceResponse(mimeOf(cr, target, path), null, 206, "Partial Content", headers, new Limited(in, length));
    }

    private static String mimeOf(ContentResolver cr, Uri target, String path) {
        try {
            String t = cr.getType(target);
            if (t != null && !t.equals("application/octet-stream")) return t;
        } catch (Exception ignored) {}
        int dot = path.lastIndexOf('.');
        String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        if (ext.equals("mkv")) return "video/x-matroska";
        String t = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return t != null ? t : "application/octet-stream";
    }

    /** Reads at most {@code left} bytes, then reports the end. */
    private static final class Limited extends FilterInputStream {
        private long left;
        Limited(InputStream in, long left) { super(in); this.left = left; }
        @Override public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
        @Override public int available() throws IOException { return (int) Math.min(super.available(), left); }
    }
}
