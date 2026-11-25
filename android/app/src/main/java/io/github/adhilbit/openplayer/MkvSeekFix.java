package io.github.adhilbit.openplayer;

import android.content.Context;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.util.Util;
import androidx.media3.extractor.Extractor;
import androidx.media3.extractor.ExtractorInput;
import androidx.media3.extractor.ExtractorOutput;
import androidx.media3.extractor.ExtractorsFactory;
import androidx.media3.extractor.PositionHolder;
import androidx.media3.extractor.SeekMap;
import androidx.media3.extractor.SeekPoint;
import androidx.media3.extractor.TrackOutput;
import androidx.media3.extractor.text.SubtitleParser;

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.List;
import java.util.Map;

/**
 * Makes MKV files without a seek index (no "Cues", common in downloads and in files that are
 * still downloading) seekable.
 *
 * Media3's MatroskaExtractor treats such files as unseekable, so the seek bar and the ±10 s
 * buttons did nothing. This wraps every extractor; when one reports an unseekable map for a
 * Matroska file, we walk the file's clusters (reading only their headers) and hand the player a
 * seek map built from the cluster start times instead.
 */
@UnstableApi
final class MkvSeekFix implements ExtractorsFactory {
    private static final String TAG = "MkvSeekFix";
    private final Context ctx;
    private final ExtractorsFactory inner;

    MkvSeekFix(Context ctx, ExtractorsFactory inner) {
        this.ctx = ctx.getApplicationContext();
        this.inner = inner;
    }

    @Override
    public Extractor[] createExtractors() {
        return inner.createExtractors();
    }

    @Override
    public Extractor[] createExtractors(Uri uri, Map<String, List<String>> responseHeaders) {
        Extractor[] list = inner.createExtractors(uri, responseHeaders);
        Extractor[] out = new Extractor[list.length];
        for (int i = 0; i < list.length; i++) out[i] = new Wrapped(list[i], uri);
        return out;
    }

    @Override
    public ExtractorsFactory setSubtitleParserFactory(SubtitleParser.Factory factory) {
        inner.setSubtitleParserFactory(factory);
        return this;
    }

    @SuppressWarnings("deprecation")
    @Override
    public ExtractorsFactory experimentalSetTextTrackTranscodingEnabled(boolean enabled) {
        inner.experimentalSetTextTrackTranscodingEnabled(enabled);
        return this;
    }

    /* ---------------- extractor wrapper ---------------- */

    private final class Wrapped implements Extractor {
        private final Extractor e;
        private final Uri uri;

        Wrapped(Extractor e, Uri uri) { this.e = e; this.uri = uri; }

        @Override public boolean sniff(ExtractorInput input) throws IOException { return e.sniff(input); }
        @Override public void init(ExtractorOutput output) { e.init(new Out(output, uri)); }
        @Override public int read(ExtractorInput input, PositionHolder seekPosition) throws IOException { return e.read(input, seekPosition); }
        @Override public void seek(long position, long timeUs) { e.seek(position, timeUs); }
        @Override public void release() { e.release(); }
        @Override public Extractor getUnderlyingImplementation() { return e.getUnderlyingImplementation(); }
    }

    private final class Out implements ExtractorOutput {
        private final ExtractorOutput o;
        private final Uri uri;

        Out(ExtractorOutput o, Uri uri) { this.o = o; this.uri = uri; }

        @Override public TrackOutput track(int id, int type) { return o.track(id, type); }
        @Override public void endTracks() { o.endTracks(); }

        @Override
        public void seekMap(SeekMap map) {
            if (!map.isSeekable()) {
                SeekMap fixed = null;
                try { fixed = buildIndex(uri, map.getDurationUs()); } catch (Throwable t) { Log.w(TAG, "index failed", t); }
                if (fixed != null) { o.seekMap(fixed); return; }
            }
            o.seekMap(map);
        }
    }

    /* ---------------- cluster index ---------------- */

    private static final int ID_EBML = 0x1A45DFA3;
    private static final int ID_SEGMENT = 0x18538067;
    private static final int ID_INFO = 0x1549A966;
    private static final int ID_TIMECODE_SCALE = 0x2AD7B1;
    private static final int ID_CLUSTER = 0x1F43B675;
    private static final int ID_TIME_CODE = 0xE7;
    private static final int MAX_CLUSTERS = 200_000;

    /** One EBML element header: id, where its data starts, and its size (-1 if unknown). */
    private static final class El { int id; long data; long size; }

    @Nullable
    private SeekMap buildIndex(Uri uri, long durationUs) throws IOException {
        long started = System.currentTimeMillis();
        try (ParcelFileDescriptor pfd = ctx.getContentResolver().openFileDescriptor(uri, "r")) {
            if (pfd == null) return null;
            try (FileInputStream in = new FileInputStream(pfd.getFileDescriptor())) {
                FileChannel ch = in.getChannel();
                long len = ch.size();
                if (len <= 0) return null;
                ByteBuffer buf = ByteBuffer.allocate(64);

                El head = readEl(ch, buf, 0, len);
                if (head == null || head.id != ID_EBML || head.size < 0) return null;   // not Matroska
                El seg = readEl(ch, buf, head.data + head.size, len);
                if (seg == null || seg.id != ID_SEGMENT) return null;
                long end = seg.size < 0 ? len : Math.min(len, seg.data + seg.size);

                long scale = 1_000_000L;   // default TimecodeScale (ns per tick)
                long[] times = new long[1024], pos = new long[1024];
                int n = 0;
                long p = seg.data;
                while (p < end && n < MAX_CLUSTERS) {
                    El el = readEl(ch, buf, p, len);
                    if (el == null) break;                       // corrupt or not downloaded yet (zeros)
                    if (el.id == ID_INFO && el.size > 0) {
                        long q = el.data, infoEnd = Math.min(len, el.data + el.size);
                        while (q < infoEnd) {
                            El c = readEl(ch, buf, q, len);
                            if (c == null || c.size < 0) break;
                            if (c.id == ID_TIMECODE_SCALE) { long v = readUInt(ch, buf, c.data, (int) c.size); if (v > 0) scale = v; }
                            q = c.data + c.size;
                        }
                    } else if (el.id == ID_CLUSTER) {
                        long tc = -1, q = el.data;
                        long limit = el.size < 0 ? Math.min(len, el.data + 4096) : Math.min(len, Math.min(el.data + el.size, el.data + 4096));
                        for (int k = 0; k < 6 && q < limit; k++) {     // Timecode is (almost always) the first child
                            El c = readEl(ch, buf, q, len);
                            if (c == null || c.size < 0) break;
                            if (c.id == ID_TIME_CODE) { tc = readUInt(ch, buf, c.data, (int) c.size); break; }
                            q = c.data + c.size;
                        }
                        if (tc >= 0) {
                            if (n == times.length) {
                                times = java.util.Arrays.copyOf(times, n * 2);
                                pos = java.util.Arrays.copyOf(pos, n * 2);
                            }
                            long us = Util.scaleLargeTimestamp(tc, scale, 1000L);
                            if (n == 0 || us > times[n - 1]) { times[n] = us; pos[n] = p; n++; }
                        }
                    }
                    if (el.size < 0) break;                      // unknown size: can't hop to the next element
                    p = el.data + el.size;
                }
                Log.i(TAG, "indexed " + n + " clusters in " + (System.currentTimeMillis() - started) + " ms");
                if (n < 2) return null;
                long dur = durationUs != C.TIME_UNSET && durationUs > 0 ? durationUs : times[n - 1];
                return new IndexSeekMap(java.util.Arrays.copyOf(times, n), java.util.Arrays.copyOf(pos, n), dur);
            }
        }
    }

    @Nullable
    private static El readEl(FileChannel ch, ByteBuffer buf, long at, long len) throws IOException {
        if (at < 0 || at >= len) return null;
        buf.clear();
        buf.limit((int) Math.min(12, len - at));
        if (ch.read(buf, at) <= 0) return null;
        buf.flip();
        int b0 = buf.get(0) & 0xFF;
        int idLen = vintLength(b0);
        if (idLen == 0 || idLen > 4 || buf.limit() < idLen + 1) return null;
        int id = 0;
        for (int i = 0; i < idLen; i++) id = (id << 8) | (buf.get(i) & 0xFF);
        int s0 = buf.get(idLen) & 0xFF;
        int sLen = vintLength(s0);
        if (sLen == 0 || buf.limit() < idLen + sLen) return null;
        long size = s0 & (0xFF >> sLen);
        boolean allOnes = size == (0xFF >> sLen);
        for (int i = 1; i < sLen; i++) {
            int b = buf.get(idLen + i) & 0xFF;
            size = (size << 8) | b;
            if (b != 0xFF) allOnes = false;
        }
        El el = new El();
        el.id = id;
        el.data = at + idLen + sLen;
        el.size = allOnes ? -1 : size;
        return el;
    }

    private static int vintLength(int firstByte) {
        for (int i = 0; i < 8; i++) if ((firstByte & (0x80 >> i)) != 0) return i + 1;
        return 0;
    }

    private static long readUInt(FileChannel ch, ByteBuffer buf, long at, int size) throws IOException {
        if (size <= 0 || size > 8) return -1;
        buf.clear();
        buf.limit(size);
        if (ch.read(buf, at) != size) return -1;
        long v = 0;
        for (int i = 0; i < size; i++) v = (v << 8) | (buf.get(i) & 0xFF);
        return v;
    }

    private static final class IndexSeekMap implements SeekMap {
        private final long[] times, positions;
        private final long durationUs;

        IndexSeekMap(long[] times, long[] positions, long durationUs) {
            this.times = times; this.positions = positions; this.durationUs = durationUs;
        }

        @Override public boolean isSeekable() { return true; }
        @Override public long getDurationUs() { return durationUs; }

        @Override
        public SeekPoints getSeekPoints(long timeUs) {
            int i = Util.binarySearchFloor(times, timeUs, true, true);
            SeekPoint a = new SeekPoint(times[i], positions[i]);
            if (times[i] >= timeUs || i == times.length - 1) return new SeekPoints(a);
            return new SeekPoints(a, new SeekPoint(times[i + 1], positions[i + 1]));
        }
    }
}
