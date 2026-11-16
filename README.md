# Open Player

An ad-free video and music player for your phone — as an **Android app** (recommended) or a web app.
**No ads. No tracking. Nothing uploaded** — your videos are played straight from your device.

## How Open Player compares

All of these are good players, and VLC and Next Player are ad-free too. What Open Player does that none of them do:

- **One player on every device.** The same player runs in any browser on iPhone, PC and Mac and installs like an app; on Android there's the full app.
- **Proves it's genuine.** Every download comes with its SHA-256 checksum, signing-certificate fingerprint and VirusTotal result, and the app's **Verify app** screen shows its own fingerprint to compare.
- **Made for Telegram downloads.** A built-in guide for videos other players can't find, "Open with" from Telegram, and an optional hidden-folder search.
- **MX-style comfort, zero tracking.** A private PIN folder, play queue, playlists and familiar gestures, without ads, ad networks or analytics.

| | **Open Player** | MX Player (free) | VLC | Next Player |
|---|---|---|---|---|
| Ads | ✅ None | ❌ Yes: banners, pop-ups, video ads (paid Pro removes most) | ✅ None | ✅ None |
| Ad networks & trackers inside | ✅ None | ❌ 9 ad networks, plus analytics (AppsFlyer, CleverTap, Firebase) | ✅ None | ✅ None |
| Runs in a browser on any device | ✅ Android app + web app for iPhone, PC, Mac | ❌ No | ◐ Separate app per system | ❌ Android only |
| Prove your copy is genuine | ✅ Checksum, fingerprint and virus scan on the site; in-app **Verify app** | ◐ Play Store only | ◐ App stores (Play, F-Droid) | ◐ F-Droid |
| Private folder with PIN | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| Help with Telegram downloads | ✅ Guide, Open with, hidden-folder search | ◐ Open with | ◐ Open with | ◐ Open with |
| Gestures, PiP, speed, screen lock | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| Cache you can see & clear | ✅ Storage meter, one-tap refresh | ◐ Android settings | ◐ Android settings | ◐ Android settings |
| Format support | ◐ Common formats: MP4, WebM, most MKV, MP3, AAC, FLAC | ✅ Very wide | ✅ Widest | ✅ Wide (incl. AC3, DTS, TrueHD audio) |
| Embedded subtitles & audio-language choice | ❌ Not yet (external .srt / .vtt only) | ✅ Yes | ✅ Yes | ✅ Yes |

**When another player is better:** for unusual formats (AVI, WMV, FLV), films with AC3/DTS surround sound, or switching between subtitle tracks and audio languages inside an MKV, VLC or Next Player handle more today. VLC also plays from home network shares and casts to TVs.

<sub>Android versions, from public information as of November 2026: MX Player's ad networks and trackers as listed by [AppGoblin](https://www.appgoblin.info/apps/com.mxtech.videoplayer.ad); Next Player's features from its [F-Droid page](https://f-droid.org/packages/dev.anilbeesetti.nextplayer/). VLC, MX Player and Next Player are trademarks of their respective owners; Open Player isn't affiliated with them.</sub>

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
- **Frame preview** while dragging the seek bar or swiping to seek
- **Play queue**: reorder, remove, jump; **Play next** / **Add to end of queue** from any list; **Shuffle**
- **Playlists**: create, add to, play, shuffle, rename, delete (Playlists tab, or ⋮ → Playlists)
- **Subtitle encodings**: detects UTF-8/16, Windows-1250…1258, KOI8-R, GBK, Big5, Shift-JIS, EUC-JP/KR, Thai; manual override in the subtitle menu
- **Headphones** (Android app): pause on disconnect, resume on reconnect
- Lock-screen / notification media controls; keeps the screen on while playing

**Cache tools (Settings → Storage & cache)**
- **Refresh app cache** — clears the stored app files and reloads the latest version
- Clear thumbnail cache, clear watch history

**Library**
- Sort every list its own way: folders, videos, Recent, songs, albums/artists, playlists
- Long-press any file: Play, Play next, Add to queue, Add to playlist, Move to Private, Rename, Delete, Details
- **Private folder** with a 4-digit PIN (stored as a salted SHA-256 hash). It hides files inside Open Player only; other apps can still see them.
- Rename and delete need the Android app; Android shows its own confirmation for files other apps created

**Settings**
- Skip amount 5/10/15/30 s, gesture sensitivity (slow/normal/fast), controls auto-hide (2–8 s or never), frame preview on/off
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
3. After a minute it's live:
   - Landing page: `https://adhil-bit.github.io/open-palyer/`
   - The player (web app): `https://adhil-bit.github.io/open-palyer/app/`

## Releasing an update

Bump the version in **both** `app/sw.js` (`VERSION`) and `app/app.js` (`APP_VERSION`), then push. The APK build runs on the same push.
Installed apps will show "A new version is ready — Reload". Users can also force it with
**Settings → Refresh app cache**.

## Limits of a web player

- Formats depend on the browser's decoders: MP4 (H.264/AAC) and WebM play everywhere; many MKV files work; AC3/DTS audio and some older codecs don't.
- A web app can't scan the whole phone on its own — you pick files or folders, and Open Player remembers your progress for each one.
- The Recent list keeps your watch position, but a file has to be picked again after the app is closed (browser security rule).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Landing page (download, features, comparison, privacy) |
| `app/index.html` | Player layout and icons |
| `app/styles.css` | Player styling |
| `app/app.js` | Library, player, gestures, subtitles, settings |
| `app/sw.js` | Offline cache, updates, share target |
| `app/manifest.webmanifest` | Install info, share target, file handling |
| `sw.js` (root) | Retires the old service worker from before the player moved to `app/` |
| `android/` | Android app (Capacitor); native media code in `MediaLibraryPlugin.java` |
| `scripts/build-www.mjs` | Copies the web app into the Android build |
| `.github/workflows/android.yml` | Builds the APK and publishes it to Releases |


## Releases and verification

Every push to `main` runs **Android build & release** (`.github/workflows/android.yml`), which:

1. Builds the APK (full edition) and, if the Play upload key is set up, the Google Play bundle (`.aab`).
2. Works out the APK's **SHA-256 checksum** and **signing certificate SHA-256 fingerprint**, and writes `SHA256SUMS.txt`.
3. Creates a **GitHub build attestation**, proof that the APK was built by GitHub Actions from that exact commit. GitHub offers this for public repositories (private ones need GitHub Enterprise Cloud), so the step is skipped until the repo is public.
4. Uploads the APK to **VirusTotal** and waits for the result (needs the `VT_API_KEY` secret).
5. Publishes a GitHub Release whose notes list all of the above, plus `release.json` with the same details.
6. Deploys the website with the APK at `download/OpenPlayer.apk` and `release.json` next to it. The landing page's **Check your download** section and download buttons read from it.

Users can compare the fingerprint with **Settings → About → Verify app** inside the Android app.

### One-time setup

| What | Where | Why |
|---|---|---|
| `VT_API_KEY` secret | Settings → Secrets and variables → Actions | Free key from your VirusTotal account (profile → API key). Without it the scan is skipped. |
| Pages source: **GitHub Actions** | Settings → Pages | The workflow deploys the site itself. Pages on a private repo needs a paid GitHub plan. |
| Make the repo public | Settings → General → Danger Zone | Needed for attestations, free Pages, and for anyone to see the Releases page. **Move the signing key first** (below). |

### Signing key

The APK is signed with `android/app/openplayer-debug.keystore`, which is in this repo so that every build installs over the previous one. **Before the repo becomes public, replace it with a private key kept in GitHub Secrets**, or anyone could sign a fake update. Changing the key changes the fingerprint, and people then have to uninstall once before installing the new version.

## Google Play edition

The app has two editions (Gradle flavors):

| | `full` (direct APK) | `play` (Google Play) |
|---|---|---|
| Find videos in hidden folders ("All files access") | Yes | No. Google Play only allows that permission for file managers, backup apps and similar. |
| Everything else | Yes | Yes |
| Built as | `OpenPlayer-x.y.z.apk` | `OpenPlayer-x.y.z-play.aab` (upload to Play Console) |

To get the `.aab` from the workflow, create a Play **upload key** once and add it as secrets:

```bash
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 upload.jks > upload.jks.b64      # Mac: base64 -i upload.jks -o upload.jks.b64
```

Add these repository secrets: `UPLOAD_KEYSTORE_BASE64` (contents of `upload.jks.b64`), `UPLOAD_KEYSTORE_PASSWORD`, `UPLOAD_KEY_ALIAS` (`upload`), `UPLOAD_KEY_PASSWORD`. Keep `upload.jks` somewhere safe and **don't commit it**. With Play App Signing, Google keeps the real app-signing key, and a lost upload key can be reset through Play support.

In Play Console you'll also need:
- **Testing:** new personal developer accounts must run a closed test with 12 testers for 14 days before production.
- **Photo and video permissions:** declare that playing the user's videos and music is the app's core purpose (for `READ_MEDIA_VIDEO` / `READ_MEDIA_AUDIO`).
- **Data safety:** no data collected or shared.
- **Privacy policy URL:** the landing page's `#privacy` section.

The Play edition uses the same app ID as the APK, but Google re-signs it. Someone who installed the direct APK has to uninstall it before installing from Play.
