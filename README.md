# Open Player

An ad-free video player for your phone, built as a Progressive Web App.
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

## Install on your phone

1. Host the folder over HTTPS (GitHub Pages works — see below).
2. Open the link in Chrome on Android → menu → **Install app** / **Add to Home screen**.

## Deploy with GitHub Pages

1. Repo → **Settings → Pages**
2. Source: **Deploy from a branch**, Branch: `main`, folder `/ (root)` → Save
3. After a minute it's live at `https://adhil-bit.github.io/open-palyer/`

## Releasing an update

Bump the version in **both** `sw.js` (`VERSION`) and `app.js` (`APP_VERSION`), then push.
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
