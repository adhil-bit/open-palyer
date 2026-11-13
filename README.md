# Open Player

An ad-free video and music player for your phone — as an **Android app** (recommended) or a web app.
**No ads. No tracking. Nothing uploaded** — your videos are played straight from your device.

## Features

**Library**
- Add single videos or a whole folder (videos are grouped by folder)
- Thumbnails, length, resolution, "NEW" badges and a watched-progress bar
- Folders / Videos / Recent tabs, search, and sort by name, date, size or length
- Long-press a video for details or to remove it
- Share a video from any Android app → **Open Player**
- Play network streams from a direct link

**Player gestures**
- Swipe up/down on the left half → brightness
- Swipe up/down on the right half → volume (up to 200% boost)
- Swipe left/right → seek with a time preview
- Double-tap left/right → skip back/forward (keep tapping to skip more)
- Double-tap center → play/pause
- Press and hold → 2× speed while held
- Pinch → zoom

**Player controls**
- Screen lock, aspect ratio (fit, crop, stretch, 16:9, 4:3, original), rotation
- Playback speed 0.25×–4×, with "use as default"
- Subtitles (.srt / .vtt): auto-loaded when they share the video's name, with size, position, background and ±50 ms sync
- Resume where you left off, auto-play next, repeat one/all
- Sleep timer, screenshot, picture-in-picture
- **Record clip** — saves what's playing as a video file (also added to a "Recordings" folder)
- **A-B repeat**, **jump to time**, **bookmarks** (shown as marks on the seek bar)
- **Equalizer** with 12 presets and 10 adjustable bands
- **Audio delay** (saved per video) to fix out-of-sync sound
- **Video adjustments**: brightness, contrast, saturation, hue, mirror
- **Video details**: resolution, frame rate, bitrate, dropped frames
- Screen recordings (WebM files with no stored length) play with a working seek bar
- Lock-screen / notification media controls; keeps the screen on while playing

**Cache tools (Settings → Storage & cache)**
- **Refresh app cache** — clears the stored app files and reloads the latest version
- Clear thumbnail cache, clear watch history
- Shows storage used; an update banner appears when a new version is deployed

## Android app (recommended)

The Android app asks for permission once and then lists **every video and song on your phone**, like other players do.

**Install:** open [Releases](https://github.com/adhil-bit/open-palyer/releases/latest) on your phone, download the `OpenPlayer-x.y.z.apk`, and open it. Android asks to allow installs from your browser or file manager the first time.

Every push to `main` builds a new APK automatically (GitHub Actions → *Android APK*), and it installs over the previous one.

On first launch you choose:
- **Show all my videos & music** (recommended) — grants Android's media permission; everything is listed automatically.
- **I'll add files myself** — no permission; pick files or folders when you want.

Extra in the app:
- **Find videos in hidden folders** (Settings) — with the optional *All files access* permission, finds videos inside folders apps hide from players (`.nomedia` / dot-folders).
- **Open with / Share → Open Player** from any app (file managers, Telegram, etc.).
- Music tab with Songs / Albums / Artists, album art, and a mini player that keeps playing while you browse.
- Screenshots and recorded clips are saved to *Pictures › Open Player* and *Movies › Open Player*.

### Telegram / Plus Messenger downloads

Newer Telegram versions keep downloads in their own private storage (`Android/data/org.telegram.messenger`), which Android doesn't let **any** other app read — including VLC and MX Player. To watch them in Open Player:
1. In Telegram, open the video → ⋮ → **Share** / **Open with** → **Open Player** (plays immediately, no re-download), or
2. Use **Save to Downloads / Save to Gallery** so a copy lands in shared storage, where Open Player finds it.
3. To stop re-downloading: Telegram → Settings → Data and Storage → Storage Usage → **Keep Media: Forever**.

## Web app

1. Host the folder over HTTPS (GitHub Pages works — see below).
2. Open the link in Chrome → menu → **Install app** / **Add to Home screen**.

## Deploy with GitHub Pages

1. Repo → **Settings → Pages**
2. Source: **Deploy from a branch**, Branch: `main`, folder `/ (root)` → Save
3. After a minute it's live at `https://adhil-bit.github.io/open-palyer/`

## Releasing an update

Bump the version in **both** `sw.js` (`VERSION`) and `app.js` (`APP_VERSION`), then push. The APK build runs on the same push.
Installed apps will show "A new version is ready — Reload". Users can also force it with
**Settings → Refresh app cache**.

## Limits of a web player

- Formats depend on the browser's decoders: MP4 (H.264/AAC) and WebM play everywhere; many MKV files work; AC3/DTS audio and some older codecs don't.
- A web app can't scan the whole phone on its own — you pick files or folders, and Open Player remembers your progress for each one.
- The Recent list keeps your watch position, but a file has to be picked again after the app is closed (browser security rule).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App layout and icons |
| `styles.css` | All styling |
| `app.js` | Library, player, gestures, subtitles, settings |
| `sw.js` | Offline cache, updates, share target |
| `manifest.webmanifest` | Install info, share target, file handling |
| `android/` | Android app (Capacitor); native media code in `MediaLibraryPlugin.java` |
| `scripts/build-www.mjs` | Copies the web app into the Android build |
| `.github/workflows/android.yml` | Builds the APK and publishes it to Releases |
