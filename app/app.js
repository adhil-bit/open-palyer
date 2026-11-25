/* Open Player — ad-free video & music player (web app + Android app).
   No ads, no tracking, nothing leaves the device. */

const APP_VERSION = '1.7.7';
// The website's download section: the APK link there comes with its checksum and signing fingerprint.
const ANDROID_APK_URL = new URL('../#download', location.href).href;
const VERIFY_URL = new URL('../#verify', location.href).href;
const SITE_VERIFY_URL = 'https://adhil-bit.github.io/open-palyer/#verify';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|3gp|3g2|ts|m2ts|mts|flv|wmv|ogv|mpg|mpeg|vob|divx)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|wma|amr|aiff?|alac)$/i;
const SUB_EXT = /\.(srt|vtt)$/i;

/* Running inside the Android app? (Capacitor) */
const Cap = window.Capacitor;
const NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const ML = NATIVE ? (Cap.registerPlugin ? Cap.registerPlugin('MediaLibrary') : Cap.Plugins?.MediaLibrary) : null;
const DESK = window.OPDesktop || null;   // desktop app (Electron) with its own FFmpeg
const NP = NATIVE && Cap.registerPlugin ? Cap.registerPlugin('NativePlayer') : null;   // all-formats engine
const IS_ANDROID_BROWSER = !NATIVE && /Android/i.test(navigator.userAgent);
const nativeSrc = (path, uri) => Cap.convertFileSrc(path ? 'file://' + path : uri);

/* ---------------- settings ---------------- */
const DEFAULTS = {
  resume: 'always',      // always | ask | never
  autoNext: true,
  seekStep: 10,
  defaultSpeed: 1,
  keepAwake: true,
  rememberBright: false,
  brightness: 1,
  subSize: 20,
  subBg: false,
  subPos: 9,
  sort: 'name',          // name | date | size | duration  (old; per-list sorts live in S.sorts)
  sortDir: 1,
  gestureSens: 'normal', // slow | normal | fast
  autoHide: 3.5,         // seconds before controls hide; 0 = never
  framePreview: true,
  shuffle: false,
  hpPause: true,         // Android app: pause when headphones disconnect
  hpResume: true,        // …and resume when they reconnect
  autoFull: null,        // full screen when a video starts; null = phones yes, computers no
  engine: 'auto',        // Android app: auto | web (standard) | native (all formats)
  night: false,          // night audio mode
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('op.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('op.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('op.' + k); } catch {} },
};
const S = Object.assign({}, DEFAULTS, store.get('settings', {}));
const saveSettings = () => store.set('settings', S);

/* ---------------- IndexedDB (thumbnail cache) ---------------- */
const idb = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('open-player', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('thumbs');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('thumbs', mode);
      const out = fn(t.objectStore('thumbs'));
      t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => null),
    set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => {}),
    clear: () => tx('readwrite', s => s.clear()).catch(() => {}),
  };
})();

/* ---------------- library state ---------------- */
const lib = {
  items: [],              // {id, file, name, size, mtime, folder, url, dur, thumb, w, h, sub}
  byId: new Map(),
  tab: 'folders',
  folder: null,
  query: '',
};
const progress = store.get('progress', {});   // id -> {t, d, ts}
let recents = store.get('recents', []);        // [{id, name, folder, size, ts}]

const fileId = f => `${f.name}|${f.size}|${f.lastModified || 0}`;
const fmtTime = s => {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const fmtSize = b => {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`;
};
const baseName = n => n.replace(/\.[^.]+$/, '');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function addFiles(fileList, fromFolder = false) {
  const files = [...fileList];
  const subs = new Map();
  for (const f of files) if (SUB_EXT.test(f.name)) {
    const dir = (f.webkitRelativePath || '').split('/').slice(0, -1).join('/');
    subs.set(dir + '/' + baseName(f.name).toLowerCase(), f);
  }
  let added = 0, songs = 0;
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  for (const f of files) {
    const isAudio = (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name);
    const isVideo = !isAudio && ((f.type && f.type.startsWith('video/')) || VIDEO_EXT.test(f.name));
    if (!isVideo && !isAudio) continue;
    const id = fileId(f);
    if (lib.byId.has(id)) continue;
    const parts = (f.webkitRelativePath || '').split('/');
    const dir = parts.slice(0, -1).join('/');
    const folder = dir ? parts[parts.length - 2] : (fromFolder ? 'Folder' : `Added ${today}`);
    // auto-attach a subtitle with the same name (VLC-style)
    const sub = isAudio ? null : (subs.get(dir + '/' + baseName(f.name).toLowerCase())
      || subs.get(dir + '/' + baseName(baseName(f.name)).toLowerCase()) || null);
    const it = { id, kind: isAudio ? 'audio' : 'video', file: f, name: f.name, size: f.size, mtime: f.lastModified || 0, folder, url: null, dur: 0, thumb: null, sub };
    if (isAudio) { it.title = baseName(f.name); it.artist = ''; it.album = folder; songs++; }
    if (DESK) { const pth = DESK.pathFor(f); if (pth) { it.dpath = pth; it.subPath = sub ? DESK.pathFor(sub) : null; } }
    lib.items.push(it); lib.byId.set(id, it); added++;
  }
  if (added) {
    adoptMovedHistory(lib.items.slice(-added));
    if (DESK) deskSave();
    const vids = added - songs;
    snack([vids && `${vids} video${vids > 1 ? 's' : ''}`, songs && `${songs} song${songs > 1 ? 's' : ''}`].filter(Boolean).join(' and ') + ' added');
    render();
    hydrateThumbs();
  } else if (files.length) {
    snack('No playable videos or music found in that selection');
  }
}

/* ---------------- Android app: scan the whole device ---------------- */
let scanning = false, lastScan = 0;
/* true from launch until the first look through the phone's library finishes: show the shimmer, not "No videos" */
let libLoading = !!(NATIVE || DESK);
function libLoaded() { if (!libLoading) return; libLoading = false; render(); hydrateThumbs(); }
setTimeout(libLoaded, 10000);   // never shimmer forever (no permission yet, onboarding, errors)
async function scanDevice(quiet) {
  if (!NATIVE || scanning) return;
  scanning = true; lastScan = Date.now();
  try {
    const perm = await ML.checkAccess();
    const wantVideo = perm.video === 'granted', wantAudio = perm.audio === 'granted';
    if (!wantVideo && !wantAudio) return;
    const [v, a] = await Promise.all([
      wantVideo ? ML.listVideos() : { items: [] },
      wantAudio ? ML.listAudio() : { items: [] },
    ]);
    // keep manually-added files, replace everything that came from the device
    lib.items = lib.items.filter(i => !i.native || i.keep);   // keep files picked or opened by hand
    lib.byId = new Map(lib.items.map(i => [i.id, i]));
    for (const m of v.items) {
      const it = {
        id: 'ms:' + m.id, kind: 'video', native: true, nuri: m.uri, npath: m.path,
        src: nativeSrc(m.path, m.uri), name: m.name || 'Video', size: m.size, mtime: m.mtime,
        folder: m.folder || 'Videos', dur: (m.duration || 0) / 1000, w: m.width, h: m.height,
        mime: m.mime, thumb: null, sub: null,
      };
      lib.items.push(it); lib.byId.set(it.id, it);
    }
    for (const m of a.items) {
      const it = {
        id: 'ms:' + m.id, kind: 'audio', native: true, nuri: m.uri, npath: m.path,
        src: nativeSrc(m.path, m.uri), name: m.name || m.title || 'Song',
        title: m.title || baseName(m.name || 'Song'), artist: cleanTag(m.artist) || 'Unknown artist',
        album: cleanTag(m.album) || 'Unknown album', albumId: m.albumId,
        size: m.size, mtime: m.mtime, folder: m.folder || 'Music', dur: (m.duration || 0) / 1000,
        mime: m.mime, thumb: null,
      };
      lib.items.push(it); lib.byId.set(it.id, it);
    }
    adoptMovedHistory(lib.items);
    render();
    hydrateThumbs();
    if (!quiet) snack(`Found ${plural(v.items.length, 'video')} and ${plural(a.items.length, 'song')}`);
    if (S.deepScan && allFiles) deepScan(true);
  } catch (e) {
    if (!quiet) snack('Couldn’t read your media library');
  } finally { scanning = false; libLoaded(); }
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const cleanTag = s => (!s || s === '<unknown>') ? '' : s;

/* ---------------- thumbnails ---------------- */
let thumbBusy = false;
async function hydrateThumbs() {
  if (thumbBusy) return; thumbBusy = true;
  // Thumbnails for what's on screen first, then everything else.
  const onScreen = new Set($$('.row[data-id]', listEl).map(r => r.dataset.id));
  const order = [...lib.items].sort((a, b) => onScreen.has(b.id) - onScreen.has(a.id));
  for (const it of order) {
    if (it.thumb || it.thumbTried) continue;
    if (!it.file && !it.native && !it.dpath) continue;
    if (it.kind === 'audio' && !it.native && !it.dpath) continue;     // no artwork reader for manual songs
    it.thumbTried = true;
    const key = it.id + (it.native ? '|' + it.mtime : '');
    const cached = await idb.get(key);
    if (cached) { Object.assign(it, cached); updateRow(it); continue; }
    let data = null;
    if (it.native) {
      try {
        const r = await ML.getThumbnail({ uri: it.nuri, path: it.npath, audio: it.kind === 'audio', width: 256 });
        data = { thumb: r.dataUrl || null, noArt: !r.dataUrl };
      } catch {}
    } else if (it.dpath) data = await deskThumb(it);
    else data = await makeThumb(it.file);
    if (data) { Object.assign(it, data); idb.set(key, data); updateRow(it); }
  }
  thumbBusy = false;
}
function makeThumb(file) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = r => { if (done) return; done = true; clearTimeout(to); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); resolve(r); };
    const to = setTimeout(() => finish(v.duration ? { dur: v.duration, thumb: null } : null), 9000);
    v.muted = true; v.preload = 'metadata'; v.playsInline = true;
    let probing = false;
    const seekForThumb = () => { v.currentTime = Math.min(Math.max(0.5, v.duration * 0.1), 30); };
    v.onloadedmetadata = () => {
      // Screen recordings often store no length (duration = Infinity).
      // Jumping far past the end makes the browser work out the real length.
      if (!isFinite(v.duration)) { probing = true; v.currentTime = 1e101; return; }
      seekForThumb();
    };
    v.ondurationchange = () => { if (probing && isFinite(v.duration)) { probing = false; seekForThumb(); } };
    v.onseeked = () => {
      if (probing) return;
      try {
        const w = 256, h = v.videoHeight ? Math.round(w * v.videoHeight / v.videoWidth) : 144;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        finish({ dur: v.duration, w: v.videoWidth, h: v.videoHeight, thumb: v.videoWidth ? c.toDataURL('image/jpeg', 0.72) : null });
      } catch { finish({ dur: v.duration, thumb: null }); }
    };
    v.onerror = () => finish(null);
    v.src = url;
  });
}

/* ---------------- library rendering ---------------- */
const listEl = $('#list');
const isAudio = i => i.kind === 'audio';
const videoItems = () => lib.items.filter(i => !isAudio(i) && !privateIds.has(i.id) && kidsAllowed(i));
const audioItems = () => lib.items.filter(i => isAudio(i) && !privateIds.has(i.id));
lib.musicView = 'songs';   // songs | albums | artists
lib.group = null;          // selected album/artist

function sortItems(arr, ctx = sortCtx()) { return sortBy(arr, ctx === 'songs' ? 'songs' : ctx === 'infolder' ? 'infolder' : 'videos'); }
function matchQuery(i) {
  if (!lib.query) return true;
  const q = lib.query.toLowerCase();
  return [i.name, i.title, i.artist, i.album].some(s => s && s.toLowerCase().includes(q));
}
function visibleItems() {
  if (lib.tab === 'playlists') {
    const pl = lib.playlist && plById(lib.playlist);
    return pl ? plPlayable(pl).filter(matchQuery) : [];
  }
  if (lib.tab === 'folders' && lib.folder === PRIV) return privUnlocked ? sortBy(privateItems().filter(matchQuery), 'videos') : [];
  if (lib.tab === 'music') {
    let arr = audioItems().filter(matchQuery);
    if (lib.group) arr = arr.filter(i => (lib.musicView === 'albums' ? i.album : i.artist) === lib.group);
    return sortItems(arr, 'songs');
  }
  let arr = videoItems().filter(matchQuery);
  if (lib.tab === 'folders' && lib.folder) arr = arr.filter(i => i.folder === lib.folder);
  return sortItems(arr);
}
function rowHTML(it) {
  if (isAudio(it)) return songRowHTML(it);
  const p = progress[it.id];
  const pct = p && p.d ? clamp(p.t / p.d * 100, 0, 100) : 0;
  const isNew = !p;
  const res = it.h ? (it.h >= 2160 ? '4K' : it.h >= 1080 ? '1080p' : it.h >= 720 ? '720p' : `${it.h}p`) : '';
  return `<button class="row" data-id="${esc(it.id)}">
    <div class="thumb${it.thumb ? '' : ' ph'}">
      ${it.thumb ? `<img src="${it.thumb}" alt="" loading="lazy">` : '<svg><use href="#i-film"/></svg>'}
      ${it.dur ? `<span class="dur">${fmtTime(it.dur)}</span>` : ''}
      ${pct > 1 ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ''}
    </div>
    <div class="meta">
      <div class="name">${esc(it.name)}</div>
      <div class="sub">${isNew ? '<span class="badge">NEW</span>' : ''}<span>${fmtSize(it.size)}</span>${res ? `<span>${res}</span>` : ''}${it.sub ? '<span>CC</span>' : ''}</div>
    </div>
  </button>`;
}
function songRowHTML(it) {
  const playing = P.item === it && !P.v.paused;
  return `<button class="row song${playing ? ' playing' : ''}" data-id="${esc(it.id)}">
    <div class="art${it.thumb ? '' : ' ph'}">${it.thumb ? `<img src="${it.thumb}" alt="" loading="lazy">` : '<svg><use href="#i-note"/></svg>'}${playing ? '<span class="eqbars"><i></i><i></i><i></i></span>' : ''}</div>
    <div class="meta">
      <div class="name">${esc(it.title || it.name)}</div>
      <div class="sub"><span>${esc(it.artist || 'Unknown artist')}</span>${it.dur ? `<span>${fmtTime(it.dur)}</span>` : ''}</div>
    </div>
  </button>`;
}
function updateRow(it) {
  const el = listEl.querySelector(`.row[data-id="${CSS.escape(it.id)}"]`);
  if (el) el.outerHTML = rowHTML(it);
  if (P.item === it) updateMini();
}
const emptyMsg = t => `<div class="empty" style="position:static;padding:60px 24px"><p>${t}</p></div>`;
/* Long lists (thousands of songs) are built a screenful at a time: the first rows appear at once,
   more are added as you scroll. Building every row at once froze the app on big libraries. */
const ROWS_FIRST = 50, ROWS_MORE = 50;
let moreObs = null;
function paintRows(head, rows, empty = '') {
  listEl._rows = rows; listEl._shown = Math.min(rows.length, ROWS_FIRST);
  listEl.innerHTML = head + (rows.length ? rows.slice(0, listEl._shown).join('') : empty) +
    (rows.length > listEl._shown ? '<div class="more-rows" id="moreRows"></div>' : '');
  watchMore();
}
function watchMore() {
  moreObs?.disconnect();
  const sentinel = $('#moreRows'); if (!sentinel) return;
  moreObs = new IntersectionObserver(es => {
    if (!es.some(e => e.isIntersecting)) return;
    const rows = listEl._rows || [], from = listEl._shown, to = Math.min(rows.length, from + ROWS_MORE);
    sentinel.insertAdjacentHTML('beforebegin', rows.slice(from, to).join(''));
    listEl._shown = to;
    if (to >= rows.length) { moreObs.disconnect(); sentinel.remove(); }
    hydrateThumbs();
  }, { root: listEl, rootMargin: '1200px 0px' });
  moreObs.observe(sentinel);
}
/* shimmer placeholder shown for the moment between tapping a tab and the list appearing */
function showSkeleton() {
  moreObs?.disconnect();
  const row = '<div class="row skel"><div class="thumb"></div><div class="meta"><i></i><i></i></div></div>';
  listEl.innerHTML = '<div class="skel-list" aria-hidden="true">' + row.repeat(8) + '</div>';
}
let renderQueued = 0;
function renderSoon() {   // paint the shimmer now, build the list on the next frame
  showSkeleton();
  cancelAnimationFrame(renderQueued);
  renderQueued = requestAnimationFrame(() => { renderQueued = requestAnimationFrame(() => { render(); listEl.scrollTop = 0; hydrateThumbs(); }); });
}
function render() {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === lib.tab));
  const showCrumb = (lib.tab === 'folders' && lib.folder) || (lib.tab === 'music' && lib.group) || (lib.tab === 'playlists' && lib.playlist);
  $('#crumb').hidden = !showCrumb;
  if (showCrumb) $('#crumbTitle').textContent = lib.tab === 'music' ? lib.group
    : lib.tab === 'playlists' ? (plById(lib.playlist)?.name || '')
    : lib.folder === PRIV ? 'Private' : lib.folder;
  $('#musicChips').hidden = lib.tab !== 'music' || !!lib.group;
  $$('#musicChips button').forEach(b => b.classList.toggle('sel', b.dataset.mv === lib.musicView));

  let html = '';
  $('#empty').hidden = true;
  if (lib.tab === 'recent') {
    const list = sortBy(recents
      .filter(r => !privateIds.has(r.id) && (!lib.query || r.name.toLowerCase().includes(lib.query.toLowerCase())))
      .map(r => { const it = lib.byId.get(r.id); return { r, it, name: it?.name || r.name, title: it?.title, mtime: it?.mtime || 0, size: it?.size || r.size || 0, dur: it?.dur || progress[r.id]?.d || 0, played: r.ts }; }), 'recent');
    const rows = [];
    for (const { r, it } of list) {
      if (it) { rows.push(rowHTML(it)); continue; }
      const p = progress[r.id]; const pct = p && p.d ? clamp(p.t / p.d * 100, 0, 100) : 0;
      rows.push(`<button class="row missing" data-recent="${esc(r.id)}">
        <div class="thumb ph"><svg><use href="#i-film"/></svg>${pct > 1 ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ''}</div>
        <div class="meta"><div class="name">${esc(r.name)}</div><div class="sub"><span>${p ? fmtTime(p.t) + ' / ' + fmtTime(p.d) : ''}</span><span>Tap to re-open</span></div></div>
      </button>`);
    }
    paintRows('', rows, emptyMsg('Videos and songs you play show up here.'));
    return;
  }

  if (lib.tab === 'music') {
    const songs = audioItems();
    if (!songs.length && libLoading) { showSkeleton(); return; }
    if (!songs.length) {
      listEl.innerHTML = `<div class="empty" style="position:static;padding:50px 24px">
        <div class="empty-art"><svg><use href="#i-music"/></svg></div><h2>No music yet</h2>
        <p>${NATIVE ? 'Allow music access to see every song on your phone, or add songs yourself.' : 'Add songs or a music folder from your phone.'}</p>
        <div class="empty-actions">${NATIVE && !hasAccess('audio') ? '<button class="btn primary" data-act="grant">Allow music access</button>' : ''}<button class="btn${NATIVE && !hasAccess('audio') ? '' : ' primary'}" data-act="addMusic"><svg><use href="#i-plus"/></svg>Add music</button></div></div>`;
      return;
    }
    if (lib.musicView !== 'songs' && !lib.group && !lib.query) {
      const key = lib.musicView === 'albums' ? 'album' : 'artist';
      const groups = new Map();
      for (const s of songs) {
        const g = groups.get(s[key]) || { name: s[key], n: 0, art: null, artist: s.artist };
        g.n++; if (!g.art && s.thumb) g.art = s.thumb;
        groups.set(s[key], g);
      }
      const rows = [];
      for (const g of sortBy([...groups.values()], 'groups')) {
        const name = g.name;
        rows.push(`<button class="row" data-group="${esc(name)}">
          <div class="art${key === 'artist' ? ' round' : ''}${g.art ? '' : ' ph'}">${g.art ? `<img src="${g.art}" alt="" loading="lazy">` : `<svg><use href="#${key === 'album' ? 'i-disc' : 'i-user'}"/></svg>`}</div>
          <div class="meta"><div class="name">${esc(name)}</div><div class="sub"><span>${key === 'album' ? esc(g.artist || '') + ' · ' : ''}${g.n} song${g.n > 1 ? 's' : ''}</span></div></div>
          <svg class="chev"><use href="#i-chev"/></svg></button>`);
      }
      paintRows('', rows);
    } else {
      const items = visibleItems();
      paintRows(items.length ? `<button class="playall" data-act="playall"><svg><use href="#i-play"/></svg>Play all · ${items.length}</button>` : '',
        items.map(songRowHTML), emptyMsg('No matches.'));
    }
    return;
  }

  if (lib.tab === 'playlists') { listEl.innerHTML = renderPlaylists(); return; }
  if (lib.tab === 'folders' && lib.folder === PRIV) {
    if (!privUnlocked) { lib.folder = null; return render(); }
    const items = visibleItems();
    paintRows(`<div class="privnote"><svg><use href="#i-lock"/></svg>Only you can see these, and they lock again when you leave.</div>`,
      items.map(rowHTML), emptyMsg('Nothing here yet. Long-press any video or song and choose “Move to Private”.'));
    return;
  }
  const vids = videoItems();
  const showPriv = lib.tab === 'folders' && !lib.folder && !lib.query && (pinRec || privateIds.size);
  if (!vids.length && !showPriv) {
    if (libLoading) { showSkeleton(); return; }
    $('#empty').hidden = false; listEl.innerHTML = ''; return;
  }
  if (lib.tab === 'folders' && !lib.folder && !lib.query) {
    if (showPriv) html += `<button class="row" data-private="1">
        <div class="folder-ico priv"><svg><use href="#i-lock"/></svg></div>
        <div class="meta"><div class="name">Private</div><div class="sub"><span>${privUnlocked ? plural(privateItems().length, 'file') : 'Locked with PIN'}</span></div></div>
        <svg class="chev"><use href="#i-chev"/></svg></button>`;
    const groups = new Map();
    for (const it of vids) {
      const g = groups.get(it.folder) || { name: it.folder, n: 0, size: 0, fresh: 0, hidden: 0, mtime: 0, dur: 0 };
      g.n++; g.size += it.size || 0; g.dur += it.dur || 0; g.mtime = Math.max(g.mtime, it.mtime || 0);
      if (!progress[it.id]) g.fresh++; if (it.hidden) g.hidden++;
      groups.set(it.folder, g);
    }
    for (const g of sortBy([...groups.values()], 'folders')) {
      const name = g.name;
      html += `<button class="row" data-folder="${esc(name)}">
        <div class="folder-ico"><svg><use href="#i-folder"/></svg></div>
        <div class="meta"><div class="name">${esc(name)}</div>
          <div class="sub"><span>${g.n} video${g.n > 1 ? 's' : ''}</span><span>${fmtSize(g.size)}</span>${g.fresh ? `<span class="badge">${g.fresh} NEW</span>` : ''}${g.hidden ? '<span class="badge hid">HIDDEN</span>' : ''}</div></div>
        <svg class="chev"><use href="#i-chev"/></svg>
      </button>`;
    }
  } else {
    paintRows('', visibleItems().map(rowHTML), emptyMsg('No matches.'));
    return;
  }
  paintRows(html, []);
}
function renderPlaylists() {
  const pl = lib.playlist && plById(lib.playlist);
  if (lib.playlist && !pl) lib.playlist = null;
  if (!pl) {
    const q = lib.query.toLowerCase();
    const rows = sortBy(playlists.filter(p => !q || p.name.toLowerCase().includes(q))
      .map(p => ({ pl: p, name: p.name, n: p.items.length, mtime: p.ts })), 'plists');
    let html = `<button class="playall ghost" data-act="newpl"><svg><use href="#i-plus"/></svg>New playlist</button>`;
    if (!playlists.length) return html + emptyMsg('No playlists yet. Long-press any video or song and choose “Add to playlist”, or save your play queue.');
    for (const { pl: p } of rows) {
      const items = plPlayable(p);
      const art = items.find(i => i.thumb)?.thumb;
      const total = items.reduce((a, i) => a + (i.dur || 0), 0);
      html += `<button class="row" data-plist="${esc(p.id)}">
        <div class="art${art ? '' : ' ph'}">${art ? `<img src="${art}" alt="" loading="lazy">` : '<svg><use href="#i-plist"/></svg>'}</div>
        <div class="meta"><div class="name">${esc(p.name)}</div><div class="sub"><span>${plural(p.items.length, 'item')}</span>${total ? `<span>${fmtTime(total)}</span>` : ''}</div></div>
        <svg class="chev"><use href="#i-chev"/></svg></button>`;
    }
    return html;
  }
  const ents = playlistOrder(pl).filter(x => !lib.query || matchQuery(x.it || { name: x.e.name }));
  const n = ents.filter(x => x.it).length;
  let html = n ? `<div class="plbar"><button class="playall" data-act="plplay"><svg><use href="#i-play"/></svg>Play all · ${n}</button><button class="playall ghost" data-act="plshuffle"><svg><use href="#i-shuffle"/></svg>Shuffle</button></div>` : '';
  if (!ents.length) return emptyMsg('This playlist is empty. Long-press any video or song and choose “Add to playlist”.');
  for (const x of ents) {
    html += x.it ? rowHTML(x.it) : `<button class="row missing" data-plmiss="${x.i}">
      <div class="thumb ph"><svg><use href="#i-${x.e.kind === 'audio' ? 'note' : 'film'}"/></svg></div>
      <div class="meta"><div class="name">${esc(x.e.name)}</div><div class="sub"><span>Not on this device right now · tap to remove</span></div></div></button>`;
  }
  return html;
}

/* long-press on a row → info sheet */
let rowPress = null, pressFiredAt = 0;
listEl.addEventListener('pointerdown', e => {
  const row = e.target.closest('.row[data-id], .row[data-plist]'); if (!row) return;
  clearTimeout(rowPress);
  if (S.kids?.on) return;   // no menus (delete, rename…) in kids mode
  rowPress = setTimeout(() => {
    rowPress = null; pressFiredAt = Date.now(); navigator.vibrate?.(15);
    if (row.dataset.plist) { const pl = plById(row.dataset.plist); if (pl) sheetPlaylistMenu(pl); }
    else sheetItemMenu(lib.byId.get(row.dataset.id));
  }, 520);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => listEl.addEventListener(t, () => clearTimeout(rowPress)));
listEl.addEventListener('scroll', () => clearTimeout(rowPress), { passive: true });
listEl.addEventListener('contextmenu', e => e.preventDefault());
listEl.addEventListener('click', e => {
  if (Date.now() - pressFiredAt < 700) return;   // the release that ended a long-press isn't a tap
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'grant') return requestMediaAccess();
  if (act === 'addMusic') return $('#pickMusic').click();
  if (act === 'playall') { const q = visibleItems(); if (q.length) openPlayer(S.shuffle ? q[Math.floor(Math.random() * q.length)] : q[0], q); return; }
  if (act === 'newpl') {
    askText('New playlist', '', { placeholder: 'Playlist name', ok: 'Create' }).then(name => {
      if (!name) return;
      const pl = createPlaylist(name); lib.playlist = pl.id; render();
      snack('Playlist created. Long-press any video or song → Add to playlist', null, null, 5000);
    });
    return;
  }
  if (act === 'plplay' || act === 'plshuffle') { const pl = plById(lib.playlist); if (pl) playPlaylist(pl, act === 'plshuffle'); return; }
  const row = e.target.closest('.row'); if (!row) return;
  if (row.dataset.private) return openPrivate();
  if (row.dataset.plist) { lib.playlist = row.dataset.plist; render(); listEl.scrollTop = 0; hydrateThumbs(); return; }
  if (row.dataset.plmiss != null) {
    const pl = plById(lib.playlist); if (!pl) return;
    const i = +row.dataset.plmiss, [gone] = pl.items.splice(i, 1); savePlaylists(); render();
    return snack('Removed from playlist', 'Undo', () => { pl.items.splice(i, 0, gone); savePlaylists(); render(); });
  }
  if (row.dataset.folder) { lib.folder = row.dataset.folder; render(); listEl.scrollTop = 0; return; }
  if (row.dataset.group) { lib.group = row.dataset.group; render(); listEl.scrollTop = 0; return; }
  if (row.dataset.recent) {
    snack('Re-add this file to keep watching from where you left off', 'Add', () => $('#pickFiles').click());
    return;
  }
  const it = lib.byId.get(row.dataset.id);
  if (it) openPlayer(it, visibleQueueFor(it));
});
function visibleQueueFor(it) {
  if (lib.tab === 'recent') return recents.map(r => lib.byId.get(r.id)).filter(i => i && i.kind === it.kind);
  if (lib.tab === 'folders') return lib.folder ? visibleItems() : sortBy(videoItems().filter(i => i.folder === it.folder), 'videos');
  return visibleItems();
}
$$('#musicChips button').forEach(b => b.onclick = () => { lib.musicView = b.dataset.mv; lib.group = null; render(); listEl.scrollTop = 0; });

/* tabs, search, sort, pickers */
$$('.tab').forEach(t => t.onclick = () => {
  if (lib.folder === PRIV) privUnlocked = false;
  lib.tab = t.dataset.tab; lib.folder = null; lib.group = null; lib.playlist = null;
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  renderSoon();
});
$('#btnCrumbBack').onclick = () => { if (lib.folder === PRIV) privUnlocked = false; lib.folder = null; lib.group = null; lib.playlist = null; render(); };
$('#btnSearch').onclick = () => { $('#searchbar').hidden = false; $('#searchInput').focus(); };
$('#btnSearchClose').onclick = () => { $('#searchbar').hidden = true; $('#searchInput').value = ''; lib.query = ''; render(); };
$('#searchInput').oninput = e => { lib.query = e.target.value.trim(); render(); };
$('#fab').onclick = () => sheetAdd();
$$('[data-pick]').forEach(b => b.onclick = () => (b.dataset.pick === 'folder' ? $('#pickFolder') : $('#pickFiles')).click());
$('#pickFiles').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
$('#pickFolder').onchange = e => { addFiles(e.target.files, true); e.target.value = ''; };
$('#pickMusic').onchange = e => { addFiles(e.target.files); e.target.value = ''; lib.tab = 'music'; render(); };
$('#btnSort').onclick = sheetSort;
$('#btnSettings').onclick = sheetSettings;

/* ---------------- sheets ---------------- */
const sheet = $('#sheet'), scrim = $('#scrim');
let sheetOnClose = null;
function openSheet(title, html, onClose) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  sheet.hidden = scrim.hidden = false;
  sheet.scrollTop = 0;
  $('#snackbar').hidden = true;   // don't cover the panel (e.g. the PIN pad)
  sheetOnClose = onClose || null;
  holdControls(true);
  return $('#sheetBody');
}
function closeSheet() {
  sheet.hidden = scrim.hidden = true;
  sheetOnClose?.(); sheetOnClose = null;
  holdControls(false);
}
scrim.onclick = closeSheet;
const opt = (id, icon, label, val = '', cls = '') =>
  `<button class="opt ${cls}" data-o="${id}"><svg><use href="#${icon}"/></svg><span class="lbl">${label}</span>${val}</button>`;
const sw = on => `<span class="switch${on ? ' on' : ''}"></span>`;
/* segmented choice row used in Settings */
const seg = (key, icon, label, sub, choices) => `<div class="segrow" data-seg="${key}">
    <div class="seglbl"><svg><use href="#${icon}"/></svg><span>${label}${sub ? `<small>${sub}</small>` : ''}</span></div>
    <div class="seg">${choices.map(([v, l]) => `<button data-v="${v}" class="${String(S[key]) === String(v) ? 'sel' : ''}">${l}</button>`).join('')}</div>
  </div>`;

function sheetAdd() {
  const b = openSheet('Add videos',
    opt('files', 'i-film', 'Pick videos<small>Choose one or more files</small>') +
    opt('folder', 'i-folder', 'Pick a folder<small>Adds every video inside, with matching subtitles</small>') +
    opt('url', 'i-loop', 'Open network stream<small>Play a direct video link (http/https)</small>'));
  b.onclick = e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'files') DESK ? deskPick() : NATIVE && ML.pickFiles ? pickNative() : $('#pickFiles').click();
    if (o === 'folder') $('#pickFolder').click();
    if (o === 'url') sheetUrl();
  };
}
/* Android app: Android's own picker gives content:// links, so these files can use the
   all-formats engine (a browser file input only gives a blob the native player can't read). */
let picked = store.get('picked', []);
function addPicked(f, ts) {
  const id = 'pk:' + f.uri;
  if (lib.byId.has(id)) return null;
  const kind = (f.mime || '').startsWith('audio/') || AUDIO_EXT.test(f.name || '') ? 'audio' : 'video';
  if (kind === 'video' && !(f.mime || '').startsWith('video/') && !VIDEO_EXT.test(f.name || '')) return null;
  const folder = `Added ${new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  const it = { id, kind, native: true, keep: true, picked: true, nuri: f.uri, npath: null, src: Cap.convertFileSrc(f.uri),
    name: f.name || 'Video', size: f.size || 0, mtime: ts, folder, dur: 0, thumb: null, sub: null };
  if (kind === 'audio') { it.title = baseName(it.name); it.artist = ''; it.album = folder; }
  lib.items.push(it); lib.byId.set(id, it);
  return it;
}
async function pickNative() {
  let r; try { r = await ML.pickFiles(); } catch { return $('#pickFiles').click(); }
  const files = r?.files || []; if (!files.length) return;
  const ts = Date.now(), added = files.map(f => addPicked(f, ts)).filter(Boolean);
  picked = [...picked.filter(p => !added.some(a => a.nuri === p.uri)), ...added.map(a => ({ uri: a.nuri, name: a.name, size: a.size, mime: '', ts }))];
  store.set('picked', picked);
  adoptMovedHistory(added);
  render(); hydrateThumbs();
  snack(added.length ? `${plural(added.length, 'file')} added` : 'Those files are already in your library');
}
async function restorePicked() {
  if (!picked.length || !ML.checkUris) return;
  try {
    const { uris } = await ML.checkUris({ uris: picked.map(p => p.uri) });
    const ok = new Set(uris);
    picked = picked.filter(p => ok.has(p.uri)); store.set('picked', picked);
    picked.forEach(p => addPicked(p, p.ts));
    render(); hydrateThumbs();
  } catch {}
}
function sheetUrl() {
  const b = openSheet('Network stream', `
    <div style="padding:4px 20px 6px">
      <input id="urlIn" type="url" inputmode="url" placeholder="https://example.com/video.mp4"
        style="width:100%;height:46px;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);padding:0 14px;font-size:16px">
      <p style="color:var(--muted);font-size:12.5px;margin:8px 2px 12px">Works with direct MP4/WebM links and HLS where the browser supports it.</p>
      <button class="btn primary" id="urlGo" style="width:100%;justify-content:center">Play</button>
    </div>`);
  const go = () => {
    const u = $('#urlIn').value.trim();
    if (!/^https?:\/\//i.test(u)) { $('#urlIn').focus(); return; }
    closeSheet();
    const name = decodeURIComponent(u.split(/[?#]/)[0].split('/').pop() || 'Stream');
    openPlayer({ id: 'url:' + u, name, url: u, remote: true, folder: 'Network' }, []);
  };
  $('#urlGo', b).onclick = go;
  $('#urlIn', b).onkeydown = e => { if (e.key === 'Enter') go(); };
  setTimeout(() => $('#urlIn')?.focus(), 50);
}
function sheetSort() {
  const ctx = sortCtx();
  const items = SORT_OPTS[ctx];
  const dirLbl = (k, d) => (k === 'name' || k === 'artist') ? (d > 0 ? 'A → Z' : 'Z → A')
    : k === 'custom' ? (d > 0 ? 'First → last' : 'Last → first')
    : (k === 'date' || k === 'played') ? (d > 0 ? 'Oldest first' : 'Newest first')
    : (d > 0 ? 'Smallest first' : 'Largest first');
  const title = ctx === 'groups' ? (lib.musicView === 'albums' ? 'Sort albums' : 'Sort artists') : SORT_TITLES[ctx];
  const draw = () => {
    const cur = S.sorts[ctx];
    return items.map(([k, l]) => opt(k, cur.k === k ? 'i-check' : 'i-sort', l,
      cur.k === k ? `<span class="val">${dirLbl(k, cur.d)} ⇅</span>` : '', cur.k === k ? 'sel' : '')).join('') +
      `<p class="sheet-note">Tap the selected option again to reverse the order.</p>`;
  };
  const b = openSheet(title, draw());
  b.onclick = e => {
    const k = e.target.closest('[data-o]')?.dataset.o; if (!k) return;
    const cur = S.sorts[ctx];
    if (cur.k === k) cur.d *= -1;
    else S.sorts[ctx] = { k, d: (k === 'name' || k === 'artist' || k === 'custom') ? 1 : -1 };
    saveSettings(); b.innerHTML = draw(); render();
  };
}

/* settings + cache tools */
async function storageInfo() {
  let usage = 0, quota = 0, cacheCount = 0;
  try { ({ usage = 0, quota = 0 } = await navigator.storage.estimate()); } catch {}
  try { cacheCount = (await caches.keys()).length; } catch {}
  return { usage, quota, cacheCount };
}
async function sheetSettings() {
  const resumeLbl = { always: 'Always', ask: 'Ask', never: 'Off' };
  const accessLbl = hasAccess('video') || hasAccess('audio') ? 'Allowed' : 'Not allowed';
  const mediaSection = NATIVE ? `
    <div class="group">Your media</div>
    ${opt('access', 'i-folder', 'Show all videos &amp; music<small>Lets Open Player list everything on your phone</small>', `<span class="val">${accessLbl}</span>`)}
    ${appInfo?.allFilesSupported === false ? '' : opt('deep', 'i-search', 'Find videos in hidden folders<small>Folders apps hide from players (.nomedia). Needs “All files access”.</small>', sw(S.deepScan && allFiles))}
    ${opt('rescan', 'i-refresh', 'Rescan phone now')}
    ${opt('cleaner', 'i-trash', 'Clean up storage<small>Duplicate copies, watched and largest videos</small>')}
    ${opt('tghelp', 'i-info', 'Telegram / Plus downloads not showing?')}`
    : `
    <div class="group">Your media</div>
    ${opt('getapp', 'i-dl', 'Get the app<small>Desktop app for Linux, Windows, Mac; Android app; install this web app</small>', '<span class="val">Recommended</span>')}
    ${opt('tghelp', 'i-info', 'Telegram / Plus downloads not showing?')}`;
  const draw = (info) => `${mediaSection}
    <div class="group">Playback</div>
    ${opt('resume', 'i-loop', 'Resume where you left off', `<span class="val">${resumeLbl[S.resume]}</span>`)}
    ${opt('autoNext', 'i-next', 'Auto-play next video', sw(S.autoNext))}
    ${NATIVE ? opt('autoPip', 'i-pip', 'Floating window when you press Home<small>The video keeps playing in a small window over other apps</small>', sw(S.autoPip !== false)) : ''}
    ${opt('bgPlay', 'i-pip', 'Keep playing after leaving the player<small>Back shows a mini player at the bottom, like MX Player</small>', sw(S.bgPlay !== false))}
    ${opt('musicMini', 'i-note', 'Play songs in the mini player<small>Off: songs open the full music screen</small>', sw(S.musicMini !== false))}
    ${opt('autoFull', 'i-aspect', 'Full screen when a video starts<small>Off: plays in the window; use the full-screen button or press F</small>', sw(wantAutoFull()))}
    ${seg('seekStep', 'i-fwd', 'Skip amount', 'Double-tap and skip buttons', [[5, '5s'], [10, '10s'], [15, '15s'], [30, '30s']])}
    ${seg('gestureSens', 'i-hand', 'Gesture sensitivity', 'Swipes for seek, volume and brightness', [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']])}
    ${seg('autoHide', 'i-timer', 'Hide controls after', 'While a video is playing', [[2, '2s'], [3.5, '3.5s'], [5, '5s'], [8, '8s'], [0, 'Never']])}
    ${NP || DESK ? seg('engine', 'i-film', 'Player engine', 'All formats plays MKV, AVI, AC3/DTS sound and built-in subtitles', [['auto', 'Auto'], ['web', 'Standard'], ['native', 'All formats']]) : ''}
    ${opt('night', 'i-moon', 'Night mode<small>Softer loud scenes, clearer dialogue</small>', sw(S.night))}
    ${opt('framePreview', 'i-pip', 'Frame preview while seeking<small>Shows the picture at that moment</small>', sw(S.framePreview))}
    ${opt('keepAwake', 'i-sun', 'Keep screen on while playing', sw(S.keepAwake))}
    ${opt('rememberBright', 'i-sun', 'Remember brightness', sw(S.rememberBright))}
    ${NATIVE ? `<div class="group">Headphones</div>
    ${opt('hpPause', 'i-headphones', 'Pause when headphones disconnect<small>Wired and Bluetooth</small>', sw(S.hpPause))}
    ${opt('hpResume', 'i-headphones', 'Resume when they reconnect<small>Within 15 minutes of disconnecting</small>', sw(S.hpResume))}` : ''}
    <div class="group">Privacy</div>
    ${opt('kids', 'i-user', 'Kids mode<small>Only chosen folders, daily time limit, PIN to exit</small>', `<span class="val">${S.kids.on ? 'On' : 'Off'}</span>`)}
    ${opt('privacy', 'i-lock', pinRec ? 'Private folder<small>Open, change PIN or turn off</small>' : 'Private folder<small>Hide videos and songs behind a PIN</small>', `<span class="val">${pinRec ? 'PIN on' : 'Off'}</span>`)}
    <div class="group">Storage &amp; cache</div>
    <div class="storage">App storage used: <b>${fmtSize(info.usage) || '0 B'}</b>${info.quota ? ` of ${fmtSize(info.quota)}` : ''} · ${info.cacheCount} cache${info.cacheCount === 1 ? '' : 's'}
      <div class="bar"><i style="width:${info.quota ? clamp(info.usage / info.quota * 100, 1, 100) : 1}%"></i></div></div>
    ${opt('refreshCache', 'i-refresh', 'Refresh app cache<small>Clears stored app files and reloads the latest version</small>')}
    ${opt('clearThumbs', 'i-trash', 'Clear thumbnail cache<small>Thumbnails are rebuilt next time</small>')}
    ${opt('clearHistory', 'i-trash', 'Clear watch history<small>Resume points and Recent list</small>', '', 'danger')}
    <div class="group">About</div>
    ${NATIVE
      ? opt('verify', 'i-info', `Open Player ${esc(appInfo?.versionName || APP_VERSION)}<small>No ads. No tracking. Your videos never leave this device.</small>`, '<span class="val">Verify app</span>')
      : opt('update', 'i-info', `Open Player ${APP_VERSION}<small>No ads. No tracking. Your videos never leave this device.</small>`, '<span class="val">Check for update</span>') +
        opt('verifyweb', 'i-android', 'Verify the Android download<small>Checksum, signing fingerprint and virus scan</small>')}`;
  const b = openSheet('Settings', draw(await storageInfo()));
  const redraw = async () => { const sc = sheet.scrollTop; b.innerHTML = draw(await storageInfo()); sheet.scrollTop = sc; };
  b.onclick = async e => {
    const sv = e.target.closest('[data-seg] [data-v]');
    if (sv) {
      const key = sv.closest('[data-seg]').dataset.seg, raw = sv.dataset.v;
      S[key] = isNaN(+raw) ? raw : +raw;
      saveSettings();
      if (key === 'seekStep') applySeekStepIcons();
      return redraw();
    }
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    if (o === 'framePreview') S.framePreview = !S.framePreview;
    if (o === 'night') { S.night = !S.night; saveSettings(); if (P.item) applyAudioFx(); return redraw(); }
    if (o === 'kids') { closeSheet(); return S.kids.on ? exitKids() : sheetKidsSetup(); }
    if (o === 'cleaner') { closeSheet(); return sheetCleaner(); }
    if (o === 'hpPause') S.hpPause = !S.hpPause;
    if (o === 'hpResume') S.hpResume = !S.hpResume;
    if (o === 'privacy') { closeSheet(); return sheetPrivacy(); }
    if (o === 'resume') S.resume = { always: 'ask', ask: 'never', never: 'always' }[S.resume];
    if (o === 'autoNext') S.autoNext = !S.autoNext;
    if (o === 'bgPlay') S.bgPlay = S.bgPlay === false;
    if (o === 'autoPip') { S.autoPip = S.autoPip === false; P.autoPipKey = null; syncAutoPip(); }
    if (o === 'musicMini') S.musicMini = S.musicMini === false;
    if (o === 'autoFull') S.autoFull = !wantAutoFull();
    if (o === 'keepAwake') S.keepAwake = !S.keepAwake;
    if (o === 'rememberBright') S.rememberBright = !S.rememberBright;
    if (o === 'refreshCache') { closeSheet(); return refreshAppCache(); }
    if (o === 'clearThumbs') {
      await idb.clear();
      lib.items.forEach(i => { i.thumb = null; i.thumbTried = false; });
      render(); hydrateThumbs(); snack('Thumbnail cache cleared');
    }
    if (o === 'clearHistory') {
      if (!confirm('Clear all resume points and the Recent list? This can’t be undone.')) return;
      for (const k in progress) delete progress[k];
      recents = []; store.del('progress'); store.del('recents'); render(); snack('Watch history cleared');
    }
    if (o === 'update') { closeSheet(); return checkForUpdate(true); }
    if (o === 'verify') { closeSheet(); return sheetVerifyApp(); }
    if (o === 'verifyweb') { window.open(VERIFY_URL, '_blank', 'noopener'); return; }
    if (o === 'access') {
      if (hasAccess('video') || hasAccess('audio')) { closeSheet(); return snack('Access is on. To turn it off, use Android settings.', 'Open', () => ML.openAppSettings(), 5000); }
      closeSheet(); return requestMediaAccess();
    }
    if (o === 'deep') { closeSheet(); return toggleDeepScan(); }
    if (o === 'rescan') { closeSheet(); await scanDevice(); return; }
    if (o === 'tghelp') { closeSheet(); return sheetTelegramHelp(); }
    if (o === 'getapp') { closeSheet(); return sheetGetApp(); }
    saveSettings(); redraw();
  };
}

async function refreshAppCache() {
  snack('Refreshing app cache…');
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.update().catch(() => {}); reg.waiting?.postMessage('SKIP_WAITING'); }
  } catch {}
  store.set('justRefreshed', true);
  setTimeout(() => location.reload(), 350);
}

/* snackbar */
let snackTimer;
function snack(text, action, fn, ms = 3200) {
  const el = $('#snackbar');
  $('#snackText').textContent = text;
  const a = $('#snackAction');
  a.hidden = !action; a.textContent = action || '';
  a.onclick = () => { el.hidden = true; fn?.(); };
  el.hidden = false;
  clearTimeout(snackTimer);
  if (ms) snackTimer = setTimeout(() => (el.hidden = true), ms);
}

/* ---------------- info sheet ---------------- */
function showInfo(it) {
  if (!it) return;
  const p = progress[it.id];
  const rows = [
    ['File', it.name], ['Folder', it.folder], ['Size', fmtSize(it.size)],
    ['Length', it.dur ? fmtTime(it.dur) : '—'], ['Resolution', it.w ? `${it.w} × ${it.h}` : '—'],
    ['Type', it.file?.type || it.mime || '—'], ['Subtitles', it.sub ? it.sub.name : 'None'],
    ...(it.npath ? [['Location', it.npath]] : []),
    ['Watched', p ? `${fmtTime(p.t)} of ${fmtTime(p.d)}` : 'Not yet'],
  ];
  const b = openSheet('Details',
    `<div style="padding:0 20px 8px">${rows.map(([k, v]) =>
      `<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)"><span style="color:var(--muted);width:90px;flex:none">${k}</span><span style="word-break:break-word">${esc(v)}</span></div>`).join('')}</div>`);
}

/* =================================================================
   PLAYER
   ================================================================= */
const P = {
  el: $('#player'), stage: $('#stage'), gesture: $('#gesture'),
  v: $('#video'),
  item: null, queue: [], idx: -1,
  ctlTimer: 0, held: 0, locked: false,
  aspect: 0, zoom: 1, rotate: 'auto',
  bright: S.rememberBright ? S.brightness : 1,
  vol: 1, boost: null,
  cues: [], subOn: true, subDelay: 0,
  sleep: null, sleepEnd: false, repeat: 'off',
  wake: null, lastSave: 0,
};
const ASPECTS = [
  ['fit', 'Fit to screen'], ['fill', 'Crop to fill'], ['stretch', 'Stretch'],
  ['16:9', '16:9'], ['4:3', '4:3'], ['orig', 'Original size'],
];

/* --- video element (replaceable, see note in setSource) --- */
function bindVideo(v) {
  v.addEventListener('seeking', () => { if (v === P.v && !P.el.hidden) watchSeek(v.currentTime); });
  v.addEventListener('loadedmetadata', onMeta);
  v.addEventListener('timeupdate', onTime);
  v.addEventListener('progress', onBuffer);
  v.addEventListener('play', onPlayState);
  v.addEventListener('pause', onPlayState);
  v.addEventListener('waiting', () => ($('#spinner').hidden = false));
  v.addEventListener('playing', () => ($('#spinner').hidden = true));
  v.addEventListener('canplay', () => ($('#spinner').hidden = true));
  v.addEventListener('ended', onEnded);
  v.addEventListener('error', onError);
  v.addEventListener('ratechange', () => ($('#btnSpeed').textContent = fmtRate(v.playbackRate)));
}
bindVideo(P.v);
function freshVideo() {
  // A video element routed through Web Audio (for volume boost) can't later play
  // a non-CORS network stream with sound, so swap in a clean element when needed.
  const old = P.webV || P.v, n = old.cloneNode(false);
  n.removeAttribute('src');
  old.replaceWith(n); P.boost = null;
  if (P.v === old) P.v = n;
  P.webV = n;
  bindVideo(n);
}
/* ---------- all-formats engine (Android app): Media3 + FFmpeg, drawn behind the web UI ----------
   NativeVideo behaves like a <video> element (currentTime, play(), events…) so the rest of the
   player works unchanged; the real decoding happens in NativePlayerPlugin.java. */
class NativeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, {
      isNative: true, _t: 0, _d: NaN, _paused: true, _rate: 1, _vol: 1, _muted: false, _buf: 0,
      videoWidth: 0, videoHeight: 0, readyState: 0, error: null, _src: '', loop: false, style: {}, tracks: [], _open: false,
    });
  }
  _fire(type) { this.dispatchEvent(new Event(type)); }
  openItem(item, startAt) {
    Object.assign(this, {
      _t: startAt || 0, _d: NaN, _paused: false, _buf: 0, videoWidth: 0, videoHeight: 0, seekable: null,
      readyState: 0, error: null, tracks: [], _src: item.src || '', _open: true,
    });
    NP.open({ path: item.npath || null, uri: item.nuri || null, startMs: Math.round((startAt || 0) * 1000), play: true })
      .catch(e => { this.error = { code: 4, message: e?.message || 'Could not open' }; this._fire('error'); });
    this._fire('play');
  }
  close() { if (!this._open) return; this._open = false; this._paused = true; NP.close().catch(() => {}); }
  get src() { return this._src; }
  set src(v) { this._src = v; }          // opening goes through openItem()
  get currentSrc() { return this._src; }
  get currentTime() { return this._t; }
  set currentTime(t) {
    t = Math.max(0, +t || 0);
    if (isFinite(this._d)) t = Math.min(t, Math.max(0, this._d - 0.05));
    if (this.seekable === false) { this._fire('unseekable'); return; }   // the file has no seek index
    this._t = t;
    watchSeek(t);
    NP.seek({ ms: Math.round(t * 1000) }).then(() => this._fire('seeked')).catch(() => {});
    this._fire('timeupdate');
  }
  get duration() { return this._d; }
  get paused() { return this._paused; }
  get ended() { return this._ended; }
  get playbackRate() { return this._rate; }
  set playbackRate(r) { this._rate = +r || 1; NP.setRate({ rate: this._rate }).catch(() => {}); this._fire('ratechange'); }
  get volume() { return this._vol; }
  set volume(v) { this._vol = clamp(+v || 0, 0, 1); }   // the real level is sent by setVolume()
  get muted() { return this._muted; }
  set muted(m) { this._muted = !!m; }
  get buffered() { const e = this._buf; return { length: e > 0 ? 1 : 0, start: () => 0, end: () => e }; }
  play() {
    if (this._paused) { this._paused = false; this._fire('play'); }
    return NP.play().then(() => {});
  }
  pause() {
    if (!this._paused) { this._paused = true; this._fire('pause'); }
    NP.pause().catch(() => {});
  }
  load() {}
  setAttribute() {}
  removeAttribute(name) { if (name === 'src') this.close(); }
  _onEvent(e) {
    if (!this._open || !e) return;
    switch (e.type) {
      case 'meta':
        if (typeof e.seekable === 'boolean') this.seekable = e.seekable;
        if (e.duration > 0) this._d = e.duration / 1000;
        if (e.width) { this.videoWidth = e.width; this.videoHeight = e.height; }
        this.readyState = 4;
        this._fire('durationchange'); this._fire('loadedmetadata'); this._fire('canplay');
        break;
      case 'size':
        this.videoWidth = e.width; this.videoHeight = e.height; this._fire('resize');
        break;
      case 'state': {
        if (typeof e.seekable === 'boolean') this.seekable = e.seekable;
        if (e.duration > 0 && !(this._d > 0)) { this._d = e.duration / 1000; this._fire('durationchange'); }
        this._ended = e.state === 'ended';
        const paused = !e.playWhenReady || this._ended;
        if (paused !== this._paused) { this._paused = paused; this._fire(paused ? 'pause' : 'play'); }
        if (e.state === 'buffering') this._fire('waiting');
        if (e.state === 'ready') { this._fire('canplay'); if (e.playing) this._fire('playing'); }
        if (this._ended) this._fire('ended');
        break;
      }
      case 'time':
        this._t = e.position / 1000; this._buf = e.buffered / 1000;
        this._fire('timeupdate'); this._fire('progress');
        break;
      case 'tracks': this.tracks = e.tracks || []; this._fire('tracks'); break;
      case 'rate': this._rate = e.rate; break;
      case 'error':
        this.error = { code: 4, message: e.message, name: e.name };
        this._fire('error');
        break;
    }
  }
}
P.webV = P.v;
P.nv = NP ? new NativeVideo() : null;
// A file the player can't jump around in (rare after the MKV fix): say so instead of doing nothing.
P.nv?.addEventListener('unseekable', () => {
  if (Date.now() - (P.unseekToast || 0) < 4000) return;
  P.unseekToast = Date.now();
  ptoast('This file can only play from start to end. It has no seek index, often because it isn’t fully downloaded.', null, null, 4200);
});
P.engineFor = {};      // item id → 'native' | 'web', chosen by the user or by an automatic fallback
P.vol = 1;
if (P.nv) {
  bindVideo(P.nv);
  P.nv.addEventListener('resize', () => { applyAspect(); autoOrient(); if (P.item && !P.item.remote) { P.item.w = P.nv.videoWidth; P.item.h = P.nv.videoHeight; } });
  P.nv.addEventListener('tracks', onNativeTracks);
  try { NP.addListener('player', ev => P.nv._onEvent(ev)); } catch {}
}

const fmtRate = r => (Math.round(r * 100) / 100).toFixed(r % 0.25 ? 2 : (r % 1 ? 2 : 1)).replace(/0$/, '') + '×';

const playerLive = () => !P.el.hidden || !$('#mini').hidden;
function openPlayer(item, queue, opts = {}) {
  P.queue = (queue && queue.length ? queue : [item]).slice();
  if (!P.queue.includes(item)) P.queue.unshift(item);
  P.origQueue = null;
  if (S.shuffle && P.queue.length > 1) { P.origQueue = P.queue.slice(); P.queue = [item, ...shuffled(P.queue.filter(x => x !== item))]; }
  P.idx = Math.max(0, P.queue.indexOf(item));
  if (item.kind === 'audio' && !opts.full && S.musicMini !== false) {   // music: no full screen, just play
    if (!P.el.hidden) closePlayer();
    showMini();
    load(item);
    return;
  }
  P.el.hidden = false;
  document.documentElement.style.background = '#000';
  hideMini();
  if (item.kind !== 'audio' && wantAutoFull()) enterFullscreen();
  if (!history.state?.player) history.pushState({ player: 1 }, '');
  load(item);
  showControls();
}
const IS_PHONE = NATIVE || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820);
const wantAutoFull = () => S.autoFull ?? IS_PHONE;
function isFull() { return !!document.fullscreenElement; }
function toggleFull() {
  if (isFull()) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
}
function syncFullBtn() { $('#btnFull use').setAttribute('href', isFull() ? '#i-unfull' : '#i-full'); $('#btnFull').setAttribute('aria-label', isFull() ? 'Exit full screen' : 'Full screen'); }
document.addEventListener('fullscreenchange', syncFullBtn);
if (!NATIVE) { $('#btnFull').hidden = false; $('#btnFull').onclick = toggleFull; }
function enterFullscreen() {
  if (NATIVE) { ML.setImmersive({ on: true }).catch(() => {}); return; }
  try { document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {}); } catch {}
}
function exitFullscreen() {
  if (NATIVE) { ML.setImmersive({ on: false }).catch(() => {}); ML.setOrientation({ orientation: 'auto' }).catch(() => {}); return; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  try { screen.orientation.unlock(); } catch {}
}
function load(item, startAt) {
  const token = P.loadToken = (P.loadToken || 0) + 1;
  if (DESK && item.dpath) {
    saveProgress(true); P.v.pause(); $('#spinner').hidden = false;
    deskProbe(item).then(() => { if (token === P.loadToken && playerLive()) loadWith(item, startAt, 'web'); });
    return;
  }
  if (!P.nv || item.remote || !item.native) return loadWith(item, startAt, 'web');
  saveProgress(true); P.v.pause();
  $('#spinner').hidden = false;
  chooseEngine(item).then(e => { if (token === P.loadToken && playerLive()) loadWith(item, startAt, e); });
}
function loadWith(item, startAt, engine) {
  saveProgress(true);
  setEngine(engine);
  P.item = item;
  P.tracksHinted = null; P.silentCheck = 0;
  P.cues = []; P.subDelay = 0; P.subBuf = null; P.subEnc = null; P.subEncForced = null; renderSub();
  P.zoom = 1;
  pvReset(); pvHide();
  hidePlayError();
  deskDetach();
  if (item.remote && P.boost) freshVideo();
  if (P.v.isNative) P.v.openItem(item, startAt);
  else if (item.dpath) deskAttach(item);
  else if (item.remote) P.v.src = item.url;
  else if (item.src) P.v.src = item.src;
  else { item.url ||= URL.createObjectURL(item.file); P.v.src = item.url; }
  setAudioView(item);
  P.v.playbackRate = S.defaultSpeed;
  $('#vTitle').textContent = item.kind === 'audio' ? (item.title || item.name) : item.name;
  updateQueueUi();
  $('#spinner').hidden = false;
  P.pendingStart = startAt;
  P.ab = { a: null, b: null };
  P.audioDelay = item.remote ? 0 : (allDelays[item.id] || 0);
  if (!item.remote && !P.v.isNative && (S.eqOn || P.audioDelay || S.night)) ensureBoost();
  applyAudioFx();
  if (P.v.isNative) { setVolume(P.vol ?? 1); applySubStyle(); syncNativeLayout(); }
  if (P.rec) stopRecording();
  if (item.sub) loadSubFile(item.sub, true);
  else if (item.subPath) fetch(DESK.url('file', item.subPath)).then(r => r.blob()).then(b => { if (P.item === item) loadSubFile(new File([b], 'sub.srt'), true); }).catch(() => {});
  applyBright();
  if (!item.remote && !privateIds.has(item.id)) touchRecent(item);
  P.v.play().catch(() => {});
}
function onMeta() {
  const v = P.v, it = P.item;
  if (!isFinite(v.duration) && !it.remote && !v.isNative) {
    // No stored length (common in screen recordings): probe it, then continue.
    if (P.probing) return;
    P.probing = true;
    const wasPaused = v.paused;
    const done = () => {
      if (!isFinite(v.duration)) return;
      v.removeEventListener('durationchange', done);
      P.probing = false;
      v.currentTime = 0;
      if (!wasPaused) v.play().catch(() => {});
      onMeta();
    };
    v.addEventListener('durationchange', done);
    v.currentTime = 1e101;
    return;
  }
  if (it && !it.remote) { it.dur = v.duration; it.w = v.videoWidth; it.h = v.videoHeight; }
  $('#tDur').textContent = fmtTime(v.duration);
  if (it.kind !== 'audio' && !v.isNative && v.videoWidth === 0 && v.videoHeight === 0) {
    if (canGoNative(it)) return switchEngine('native', 'Opening with the all-formats player…');
    ptoast('Video codec not supported here — playing audio only');
  }
  applyAspect();
  autoOrient();
  const p = progress[it.id];
  if (P.pendingStart != null) v.currentTime = P.pendingStart;
  else if (p && p.t > 5 && p.t < v.duration - 8 && S.resume !== 'never') {
    if (S.resume === 'always') {
      v.currentTime = p.t;
      ptoast(`Resumed at ${fmtTime(p.t)}`, 'Start over', () => { v.currentTime = 0; });
    } else {
      v.pause();
      ptoast(`Resume from ${fmtTime(p.t)}?`, 'Resume', () => { v.currentTime = p.t; v.play(); }, 8000, () => v.play());
    }
  }
  updateSeek();
  drawMarkers();
}
function videoTransform() {
  const t = [];
  if (P.zoom !== 1) t.push(`scale(${P.zoom})`);
  if (P.adj?.mirror) t.push('scaleX(-1)');
  return t.join(' ');
}
function onTime() {
  kidsTick();
  silentAudioCheck();
  if (P.ab.b != null && P.v.currentTime >= P.ab.b) P.v.currentTime = P.ab.a;
  if (!$('#mini').hidden) updateMini();
  updateSeek();
  renderSub();
  const now = performance.now();
  if (now - P.lastSave > 4000) { P.lastSave = now; saveProgress(); }
  if ('setPositionState' in (navigator.mediaSession || {}) && isFinite(P.v.duration)) {
    try { navigator.mediaSession.setPositionState({ duration: P.v.duration, playbackRate: P.v.playbackRate, position: P.v.currentTime }); } catch {}
  }
}
function onBuffer() {
  const v = P.v; if (!v.duration || !v.buffered.length) return;
  let end = 0; for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 1) end = v.buffered.end(i);
  $('#seekBuf').style.width = (end / v.duration * 100) + '%';
}
/* Home while a video plays → floating window (picture-in-picture), like MX Player. */
function syncAutoPip() {
  if (!NATIVE || !ML?.setAutoPip) return;
  const on = S.autoPip !== false && !P.el.hidden && !!P.item && P.item.kind !== 'audio' && !P.v.paused;
  const key = on + ':' + (P.v.videoWidth || 16) + 'x' + (P.v.videoHeight || 9);
  if (key === P.autoPipKey) return;
  P.autoPipKey = key;
  ML.setAutoPip({ on, width: P.v.videoWidth || 16, height: P.v.videoHeight || 9 }).catch(() => {});
}
window.OPPip = inPip => {
  document.body.classList.toggle('in-pip', !!inPip);
  if (inPip) hideControls();
};
function onPlayState() {
  const playing = !P.v.paused;
  syncAutoPip();
  $('#btnPlay use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#btnPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (navigator.mediaSession) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  if (playing) P.unplugAt = 0;
  updateMini();
  if (P.item?.kind === 'audio' && P.el.hidden) {
    listEl.querySelectorAll('.row.song.playing').forEach(r => { const it = lib.byId.get(r.dataset.id); if (it && it !== P.item) r.outerHTML = songRowHTML(it); });
    updateRow(P.item);
  }
  if (playing) { keepAwake(true); scheduleHide(); } else { keepAwake(false); showControls(true); saveProgress(true); }
}
function onEnded() {
  saveProgress(true, true);
  if (P.sleepEnd) { P.sleepEnd = false; ptoast('Sleep timer: stopped'); return; }
  if (P.repeat === 'one') { P.v.currentTime = 0; P.v.play(); return; }
  if (P.idx < P.queue.length - 1 && (S.autoNext || P.repeat === 'all')) return next();
  if (P.repeat === 'all' && P.queue.length) {
    if (S.shuffle && P.queue.length > 2) { const last = P.item; P.queue = shuffled(P.queue); if (P.queue[0] === last) P.queue.push(P.queue.shift()); }
    P.idx = 0; return load(P.queue[0]);
  }
  showControls(true);
}
function onError() {
  $('#spinner').hidden = true;
  const code = P.v.error?.code, it = P.item;
  if (!P.v.isNative && (code === 3 || code === 4) && canGoNative(it)) return switchEngine('native', 'Opening with the all-formats player…');
  if (P.v.isNative) return showPlayError(nativeErrorKind(P.v.error?.name), { detail: P.v.error?.message });
  if (code === 2) return showPlayError('network');
  if (code === 4 && !NATIVE && !DESK) {
    sniffCodecs(it).then(c => {
      if (P.item !== it) return;
      if (c.incomplete) return showPlayError('incomplete');
      const parts = [c.video && `${c.video} video`, c.audio && `${c.audio} sound`].filter(Boolean);
      showPlayError('browser', { parts });
    });
    return;
  }
  if ((code === 3 || code === 4) && NATIVE && it && !it.native) return showPlayError('oldcopy');
  showPlayError(code === 4 ? 'unsupported' : 'generic');
}

function saveProgress(force, finished) {
  const it = P.item, v = P.v;
  if (!it || it.remote || !isFinite(v.duration) || !v.duration) return;
  const t = finished ? v.duration : v.currentTime;
  progress[it.id] = { t, d: v.duration, ts: Date.now() };
  if (force) rememberFp(it);
  if (force || Math.random() < 1) store.set('progress', progress);
}
function touchRecent(it) {
  recents = [{ id: it.id, name: it.name, folder: it.folder, size: it.size, ts: Date.now() }, ...recents.filter(r => r.id !== it.id)].slice(0, 60);
  store.set('recents', recents);
}

function closePlayer(fromPop) {
  setTimeout(syncAutoPip, 0);
  saveProgress(true);
  const keepMusic = !!P.item && !P.v.paused && (P.item.kind === 'audio' || S.bgPlay !== false);
  if (!keepMusic) { P.v.pause(); clearSleep(); deskDetach(); }
  P.el.hidden = true; closeSheet(); hidePlayError();
  P.loadToken = (P.loadToken || 0) + 1;
  if (P.v.isNative && !keepMusic) setEngine('web');
  document.documentElement.classList.remove('native-engine');   // the library covers the native video while in the mini bar
  setLock(false);
  document.documentElement.style.background = '';
  exitFullscreen();
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  if (!fromPop && history.state?.player) history.back();
  if (keepMusic) showMini();
  render();
}

/* ---------- music: artwork view + mini player ---------- */
function setAudioView(item) {
  const audio = item.kind === 'audio';
  P.el.classList.toggle('audio', audio);
  $('#audioview').hidden = !audio;
  P.v.style.visibility = audio ? 'hidden' : '';
  if (!audio) return;
  $('#avTitle').textContent = item.title || item.name;
  $('#avSub').textContent = [item.artist, item.album].filter(Boolean).join(' · ');
  const art = $('#avArt');
  art.classList.toggle('ph', !item.thumb);
  art.innerHTML = item.thumb ? `<img src="${item.thumb}" alt="">` : '<svg><use href="#i-note"/></svg>';
  $('#avBg').style.backgroundImage = item.thumb ? `url("${item.thumb}")` : 'none';
}
function showMini() { $('#mini').hidden = false; document.body.classList.add('has-mini'); updateMini(); miniLoop(); }
function hideMini() { $('#mini').hidden = true; document.body.classList.remove('has-mini'); cancelAnimationFrame(P.miniRaf); P.miniRaf = 0; }
/* the mini bar shows the video itself (standard engine), drawn a few times a second */
function miniLoop() {
  cancelAnimationFrame(P.miniRaf);
  let last = 0;
  const step = ts => {
    if ($('#mini').hidden) { P.miniRaf = 0; return; }
    if (ts - last > 80) {
      last = ts;
      const c = $('#miniCanvas');
      if (c && !P.v.isNative && P.v.videoWidth) { try { c.getContext('2d').drawImage(P.v, 0, 0, c.width, c.height); } catch {} }
    }
    P.miniRaf = requestAnimationFrame(step);
  };
  P.miniRaf = requestAnimationFrame(step);
}
function updateMini() {
  if ($('#mini').hidden || !P.item) return;
  const it = P.item;
  $('#miniTitle').textContent = it.title || it.name;
  $('#miniSub').textContent = it.kind === 'audio' ? (it.artist || it.album || '') : (P.v.isNative ? 'Playing in the background' : (it.folder || ''));
  const art = $('#miniArt');
  const live = it.kind !== 'audio' && !P.v.isNative;
  const mode = (it.kind === 'audio' ? 'a' : live ? 'v' : 'n') + (it.thumb ? 't' : '') + it.id;
  if (art.dataset.mode !== mode) {
    art.dataset.mode = mode;
    art.classList.toggle('vid', it.kind !== 'audio');
    art.classList.toggle('ph', !it.thumb && !live);
    art.innerHTML = live ? `<canvas id="miniCanvas" width="160" height="90"></canvas>`
      : it.thumb ? `<img src="${it.thumb}" alt="">` : `<svg><use href="#i-${it.kind === 'audio' ? 'note' : 'film'}"/></svg>`;
  }
  $('#miniPlay use').setAttribute('href', P.v.paused ? '#i-play' : '#i-pause');
  $('#miniProg').style.width = P.v.duration ? (P.v.currentTime / P.v.duration * 100) + '%' : '0';
}
$('#miniOpen').onclick = () => {
  hideMini();
  setTimeout(syncAutoPip, 0);
  P.el.hidden = false;
  document.documentElement.classList.toggle('native-engine', !!P.v.isNative);
  document.documentElement.style.background = P.v.isNative ? 'transparent' : '#000';
  if (P.item?.kind !== 'audio' && wantAutoFull()) enterFullscreen();
  if (!history.state?.player) history.pushState({ player: 1 }, '');
  showControls();
};
$('#miniPlay').onclick = () => { togglePlay(); setTimeout(updateMini, 50); };
$('#miniNext').onclick = () => { next(); setTimeout(updateMini, 300); };
$('#miniClose').onclick = () => {
  saveProgress(true); P.v.pause(); clearSleep(); deskDetach();
  if (P.v.isNative) setEngine('web');
  P.loadToken = (P.loadToken || 0) + 1;
  hideMini(); render();
};
/* Android Back button (MainActivity asks this): one step back inside the app, never straight out. */
window.OPBack = () => {
  try {
    if (!sheet.hidden) { closeSheet(); return 'handled'; }
    if (!P.el.hidden) {
      if (P.locked) { flashUnlock?.(); return 'handled'; }
      closePlayer(); return 'handled';
    }
    if (!$('#searchbar').hidden) { $('#btnSearchClose').click(); return 'handled'; }
    if (!$('#crumb').hidden) { $('#btnCrumbBack').click(); return 'handled'; }
    if (!$('#mini').hidden && P.v && !P.v.paused) return 'background';   // keep the music playing
    return 'exit';
  } catch { return 'exit'; }
};
window.addEventListener('popstate', () => {
  if (!sheet.hidden) { closeSheet(); if (!P.el.hidden) history.pushState({ player: 1 }, ''); return; }
  if (!P.el.hidden) closePlayer(true);
});

const togglePlay = () => (P.v.paused ? P.v.play().catch(() => {}) : P.v.pause());
function seekBy(s) {
  const v = P.v;
  if (!isFinite(v.duration)) { if (v.isNative) v.currentTime = Math.max(0, v.currentTime + s); return; }
  v.currentTime = clamp(v.currentTime + s, 0, v.duration - 0.1);
}
function next() { if (P.idx < P.queue.length - 1) { P.idx++; load(P.queue[P.idx]); } }
function prev() {
  if (P.v.currentTime > 5 || P.idx <= 0) { P.v.currentTime = 0; return; }
  P.idx--; load(P.queue[P.idx]);
}

/* --- controls visibility --- */
function showControls(stay) {
  if (P.locked) return;
  P.el.classList.add('ctl-on');
  if (!stay) scheduleHide(); else clearTimeout(P.ctlTimer);
}
function hideControls() { if (P.held) return; P.el.classList.remove('ctl-on'); }
function scheduleHide() { clearTimeout(P.ctlTimer); if (!P.v.paused && S.autoHide > 0) P.ctlTimer = setTimeout(hideControls, S.autoHide * 1000); }
function holdControls(on) { P.held = Math.max(0, P.held + (on ? 1 : -1)); if (!on && !P.held) scheduleHide(); }
function toggleControls() { P.el.classList.contains('ctl-on') ? hideControls() : showControls(); }
P.el.querySelector('.controls').addEventListener('pointerdown', e => { if (e.target.closest('button,.seek')) scheduleHide(); });

/* --- seekbar --- */
const seekEl = $('#seek');
function updateSeek(t = P.v.currentTime) {
  const d = P.v.duration;
  const pct = d ? clamp(t / d, 0, 1) * 100 : 0;
  $('#seekPlayed').style.width = pct + '%';
  $('#seekThumb').style.left = pct + '%';
  $('#tCur').textContent = fmtTime(t);
}
{
  let dragging = false, lastSet = 0;
  const frac = e => { const r = seekEl.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  const showTip = (f, t) => {
    const tip = $('#seekTip'); tip.hidden = false;
    $('#seekTipTime').textContent = fmtTime(t);
    pvShow('tip', t);
    // keep the bubble on screen near the edges
    const r = seekEl.getBoundingClientRect(), half = (tip.offsetWidth || 60) / 2;
    const x = clamp(f * r.width, half - r.left + 4, innerWidth - r.left - half - 4);
    tip.style.left = x + 'px';
  };
  const move = e => {
    const d = P.v.duration; if (!d) return;
    const f = frac(e), t = f * d;
    updateSeek(t);
    showTip(f, t);
    const now = performance.now();
    // With a frame preview the picture is in the bubble, so only move the real video occasionally.
    if (now - lastSet > (pvEnabled() ? 400 : 120)) { lastSet = now; P.v.currentTime = t; }
  };
  seekEl.addEventListener('pointermove', e => {
    if (dragging || e.pointerType !== 'mouse' || !P.v.duration) return;
    showTip(frac(e), frac(e) * P.v.duration);
  });
  seekEl.addEventListener('pointerleave', e => { if (!dragging && e.pointerType === 'mouse') { $('#seekTip').hidden = true; pvHide(); } });
  seekEl.addEventListener('pointerdown', e => { dragging = true; seekEl.setPointerCapture(e.pointerId); seekEl.classList.add('drag'); holdControls(true); move(e); });
  seekEl.addEventListener('pointermove', e => dragging && move(e));
  const end = e => {
    if (!dragging) return; dragging = false;
    seekEl.classList.remove('drag'); $('#seekTip').hidden = true; pvHide();
    if (P.v.duration) P.v.currentTime = frac(e) * P.v.duration;
    holdControls(false);
  };
  seekEl.addEventListener('pointerup', end); seekEl.addEventListener('pointercancel', end);
  seekEl.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') seekBy(-5); if (e.key === 'ArrowRight') seekBy(5); });
}

/* --- buttons --- */
$('#btnPlay').onclick = togglePlay;
$('#btnRew').onclick = () => { seekBy(-S.seekStep); ripple('L'); };
$('#btnFwd').onclick = () => { seekBy(S.seekStep); ripple('R'); };
$('#btnPrev').onclick = prev;
$('#btnNext').onclick = next;
$('#btnBack').onclick = () => closePlayer();
$('#btnLock').onclick = () => setLock(true);
$('#btnUnlock').onclick = () => setLock(false);
$('#btnAspect').onclick = () => { P.aspect = (P.aspect + 1) % ASPECTS.length; P.zoom = 1; applyAspect(); ptoast(ASPECTS[P.aspect][1]); };
$('#btnSpeed').onclick = sheetSpeed;
$('#btnSubs').onclick = sheetSubs;
$('#btnMore').onclick = sheetMore;
$('#btnRotate').onclick = () => {
  P.rotate = { auto: 'landscape', landscape: 'portrait', portrait: 'auto' }[P.rotate];
  autoOrient(true);
  ptoast({ auto: 'Rotation: auto', landscape: 'Rotation: landscape', portrait: 'Rotation: portrait' }[P.rotate]);
};
$('#btnPip').onclick = async () => {
  if (NATIVE) {
    try { hideControls(); await ML.enterPip({ width: P.v.videoWidth || 16, height: P.v.videoHeight || 9 }); }
    catch { ptoast('Picture-in-picture isn’t available on this phone'); }
    return;
  }
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await P.v.requestPictureInPicture();
  } catch { ptoast('Picture-in-picture isn’t available here'); }
};
if (!NATIVE && !document.pictureInPictureEnabled) $('#btnPip').hidden = true;
// In Android picture-in-picture the window is tiny: hide controls while it lasts.
window.addEventListener('resize', () => { if (NATIVE && !P.el.hidden && innerWidth < 300) hideControls(); });

function setLock(on) {
  P.locked = on;
  P.el.classList.toggle('locked', on);
  $('#btnUnlock').hidden = !on;
  if (on) { P.el.classList.remove('ctl-on'); flashUnlock(); ptoast('Screen locked'); }
  else { $('#btnUnlock').classList.remove('show'); showControls(); }
}
let unlockTimer;
function flashUnlock() {
  const b = $('#btnUnlock'); b.classList.add('show');
  clearTimeout(unlockTimer); unlockTimer = setTimeout(() => b.classList.remove('show'), 2200);
}

/* --- aspect & zoom --- */
function applyAspect() {
  if (P.v.isNative) return syncNativeLayout();
  const v = P.v, mode = ASPECTS[P.aspect][0];
  v.style.width = v.style.height = '100%';
  v.style.objectFit = { fit: 'contain', fill: 'cover', stretch: 'fill' }[mode] || 'contain';
  const W = P.stage.clientWidth, H = P.stage.clientHeight;
  if (mode === '16:9' || mode === '4:3') {
    const r = mode === '16:9' ? 16 / 9 : 4 / 3;
    let w = W, h = W / r; if (h > H) { h = H; w = H * r; }
    v.style.width = w + 'px'; v.style.height = h + 'px'; v.style.objectFit = 'fill';
  } else if (mode === 'orig' && v.videoWidth) {
    const dpr = window.devicePixelRatio || 1;
    v.style.width = Math.min(v.videoWidth / dpr, W * 4) + 'px';
    v.style.height = Math.min(v.videoHeight / dpr, H * 4) + 'px';
    v.style.objectFit = 'contain';
  }
  v.style.transform = videoTransform();
}
window.addEventListener('resize', () => { if (!P.el.hidden) applyAspect(); });

function autoOrient(force) {
  if (P.item?.kind === 'audio') return;
  let want = P.rotate;
  if (NATIVE) {
    if (want === 'auto') want = (!force && !P.v.videoWidth) ? 'auto' : (P.v.videoWidth >= P.v.videoHeight ? 'landscape' : 'portrait');
    ML.setOrientation({ orientation: want }).catch(() => {});
    return;
  }
  const o = screen.orientation; if (!o?.lock || !IS_PHONE) return;
  if (want === 'auto') {
    if (!force && !P.v.videoWidth) return;
    want = P.v.videoWidth >= P.v.videoHeight ? 'landscape' : 'portrait';
  }
  const go = () => o.lock(want).catch(() => {});
  if (document.fullscreenElement) go();
  else if (force || wantAutoFull()) document.documentElement.requestFullscreen?.().then(go).catch(() => {});
}

/* --- brightness / volume --- */
/* video look: gesture brightness + adjustments (contrast, saturation, hue, mirror) */
const ADJ_DEFAULT = { contrast: 1, saturate: 1, hue: 0, gamma: 1, mirror: false };
P.adj = { ...ADJ_DEFAULT };
function applyBright() {
  const b = P.bright, a = P.adj;
  $('#dim').style.opacity = b < 1 ? (1 - b) * 0.9 : 0;
  const f = [];
  if (b > 1) f.push(`brightness(${b})`);
  if (a.gamma !== 1) f.push(`brightness(${a.gamma})`);
  if (a.contrast !== 1) f.push(`contrast(${a.contrast})`);
  if (a.saturate !== 1) f.push(`saturate(${a.saturate})`);
  if (a.hue) f.push(`hue-rotate(${a.hue}deg)`);
  P.v.style.filter = f.join(' ');
  applyAspect();
}

function setVolume(val) {
  const allowBoost = !P.item?.remote;
  P.vol = clamp(val, 0, allowBoost ? 2 : 1);
  P.v.muted = P.vol === 0;
  if (P.v.isNative) { P.v.volume = Math.min(1, P.vol); NP.setVolume({ volume: P.vol }).catch(() => {}); return; }
  if (P.vol <= 1) {
    P.v.volume = P.vol;
    if (P.boost) P.boost.gain.gain.value = 1;
  } else {
    P.v.volume = 1;
    ensureBoost();
    if (P.boost) P.boost.gain.gain.value = P.vol;
  }
}

/* audio chain: source → delay → 10-band equalizer → boost → limiter → speakers.
   Built only when needed (boost, equalizer or audio delay is used). */
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  Flat:        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost':[7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  'Bass + treble': [6, 5, 3, 1, -1, -1, 1, 3, 5, 6],
  Treble:      [0, 0, 0, 0, 0, 1, 3, 5, 6, 7],
  Vocal:       [-3, -2, -1, 1, 4, 5, 4, 2, 0, -1],
  Headphones:  [4, 3, 1, 0, -1, 0, 1, 3, 4, 5],
  Movie:       [4, 3, 2, 0, 1, 3, 3, 2, 1, 0],
  Rock:        [5, 4, 2, -1, -2, -1, 2, 4, 5, 5],
  Pop:         [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  Classical:   [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
  Dance:       [6, 5, 2, 0, 0, -2, -2, 0, 4, 5],
  Night:       [-4, -3, -1, 1, 3, 4, 3, 1, -1, -3],
};
S.eqPreset ??= 'Flat';
S.eqBands ??= EQ_PRESETS.Flat.slice();
S.eqOn ??= false;
function ensureBoost() {
  if (P.v.isNative) return true;            // the native engine has its own effects
  if (P.boost) { P.boost.ctx.resume?.(); return true; }
  if (P.item?.remote) return false;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaElementSource(P.v);
    const delay = ctx.createDelay(5);
    const bands = EQ_FREQS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = 1.1; b.gain.value = 0;
      return b;
    });
    const gain = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();   // keeps boosted/EQ'd audio from clipping harshly
    const makeup = ctx.createGain();               // night mode lifts quiet speech after compressing
    let node = src.connect(delay);
    for (const b of bands) node = node.connect(b);
    node.connect(gain).connect(comp).connect(makeup).connect(ctx.destination);
    P.boost = { ctx, gain, delay, bands, comp, makeup };
    applyAudioFx();
    return true;
  } catch { P.boost = null; return false; }
}
function applyAudioFx() {
  if (P.v.isNative) { NP.setAudio({ eq: !!S.eqOn, bands: S.eqBands, freqs: EQ_FREQS, night: !!S.night }).catch(() => {}); return; }
  if (!P.boost) return;
  const c = P.boost.comp, n = !!S.night;
  c.threshold.value = n ? -42 : -6; c.knee.value = n ? 24 : 30; c.ratio.value = n ? 10 : 4;
  c.attack.value = n ? 0.005 : 0.003; c.release.value = n ? 0.3 : 0.25;
  P.boost.makeup.gain.value = n ? 2.4 : 1;
  P.boost.bands.forEach((b, i) => (b.gain.value = S.eqOn ? S.eqBands[i] : 0));
  P.boost.delay.delayTime.value = Math.max(0, P.audioDelay || 0);
}

/* --- HUDs --- */
let hudTimer;
function hud(icon, frac, text) {
  const h = $('#hud'); h.hidden = false;
  h.querySelector('use').setAttribute('href', '#' + icon);
  $('#hudFill').style.width = clamp(frac, 0, 1) * 100 + '%';
  $('#hudFill').style.background = frac > 0.5 && icon === 'i-vol' && P.vol > 1 ? '#ff5d5d' : '';
  $('#hudText').textContent = text;
  clearTimeout(hudTimer); hudTimer = setTimeout(() => (h.hidden = true), 700);
}
let ptoastTimer;
function ptoast(text, action, fn, ms = 2400, onTimeout) {
  const t = $('#ptoast');
  t.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; clearTimeout(ptoastTimer); fn?.(); };
  clearTimeout(ptoastTimer);
  ptoastTimer = setTimeout(() => { t.hidden = true; onTimeout?.(); }, ms);
}
function ripple(side) {
  const r = $('#ripple' + side);
  r.querySelector('span').textContent = side === 'L' ? `« ${S.seekStep}s` : `${S.seekStep}s »`;
  r.classList.add('show');
  clearTimeout(r._t); r._t = setTimeout(() => r.classList.remove('show'), 420);
}

/* --- touch gestures --- */
{
  const g = P.gesture;
  const pts = new Map();
  let start = null, mode = null, longT = 0, base = 0, target = 0;
  let pinch = null, lastTap = { t: 0, x: 0 }, singleT = 0, dblUntil = 0, dblSide = null;

  g.addEventListener('pointerdown', e => {
    g.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (P.locked) { flashUnlock(); return; }
    if (pts.size === 2) {
      clearTimeout(longT); if (mode === 'speed') endSpeed();
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: P.zoom }; mode = 'pinch';
      return;
    }
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
    mode = null;
    longT = setTimeout(() => {
      if (mode || P.v.paused) return;
      mode = 'speed'; P.prevRate = P.v.playbackRate; P.v.playbackRate = 2;
      $('#speedpill').hidden = false; navigator.vibrate?.(10);
    }, 450);
  });

  g.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || P.locked) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pinch' && pts.size === 2) {
      const [a, b] = [...pts.values()];
      P.zoom = clamp(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, 0.5, 4);
      if (P.v.isNative) syncNativeLayout(); else P.v.style.transform = videoTransform();
      hud('i-aspect', (P.zoom - 0.5) / 3.5, Math.round(P.zoom * 100) + '%');
      return;
    }
    if (!start || mode === 'speed' || mode === 'pinch') return;
    const W = g.clientWidth, H = g.clientHeight;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!mode) {
      if (Math.hypot(dx, dy) < 14) return;
      clearTimeout(longT);
      if (Math.abs(dx) > Math.abs(dy)) { mode = 'seek'; base = P.v.currentTime; }
      else if (start.y < 40 || start.y > H - 40) { mode = 'none'; }   // leave system edge gestures alone
      else if (start.x < W / 2) { mode = 'bright'; base = P.bright; }
      else { mode = 'vol'; base = P.v.muted ? 0 : P.vol; }
    }
    if (mode === 'seek' && isFinite(P.v.duration)) {
      const span = Math.min(P.v.duration, 180) * gestureSens();
      target = clamp(base + dx / W * span, 0, P.v.duration);
      const delta = target - base;
      $('#seekhud').hidden = false;
      $('#seekhudT').textContent = fmtTime(target);
      $('#seekhudD').textContent = `${delta >= 0 ? '+' : '−'}${fmtTime(Math.abs(delta))}`;
      pvShow('hud', target);
      updateSeek(target);
    } else if (mode === 'bright') {
      const maxB = P.v.isNative ? 1 : 1.5;   // over-brightening needs a CSS filter on the picture
      P.bright = clamp(base - dy / (H * 0.6) * gestureSens(), 0, maxB);
      applyBright();
      hud('i-sun', P.bright / maxB, Math.round(P.bright * 100) + '%');
    } else if (mode === 'vol') {
      setVolume(base - dy / (H * 0.6) * (P.item?.remote ? 1 : 1.4) * gestureSens());
      hud(P.vol ? 'i-vol' : 'i-mute', P.vol / (P.item?.remote ? 1 : 2), Math.round(P.vol * 100) + '%');
    }
  });

  const up = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    clearTimeout(longT);
    if (P.locked) return;
    if (mode === 'pinch') {
      if (pts.size === 0) { mode = null; start = null; if (Math.abs(P.zoom - 1) < 0.06) { P.zoom = 1; applyAspect(); } }
      return;
    }
    if (mode === 'speed') { endSpeed(); mode = null; return; }
    if (mode === 'seek') { P.v.currentTime = target; $('#seekhud').hidden = true; pvHide(); mode = null; return; }
    if (mode === 'bright') { if (S.rememberBright) { S.brightness = P.bright; saveSettings(); } mode = null; return; }
    if (mode) { mode = null; return; }
    if (e.type === 'pointercancel' || !start) return;

    // taps
    const now = performance.now(), W = g.clientWidth, x = e.clientX;
    const side = x < W * 0.35 ? 'L' : x > W * 0.65 ? 'R' : 'C';
    if (now < dblUntil && side === dblSide && side !== 'C') {        // keep tapping to keep seeking
      seekBy(side === 'L' ? -S.seekStep : S.seekStep); ripple(side);
      dblUntil = now + 650; return;
    }
    if (now - lastTap.t < 280 && Math.abs(x - lastTap.x) < 80) {
      clearTimeout(singleT); lastTap.t = 0;
      if (side === 'C') togglePlay();
      else { seekBy(side === 'L' ? -S.seekStep : S.seekStep); ripple(side); dblUntil = now + 650; dblSide = side; }
      return;
    }
    lastTap = { t: now, x };
    clearTimeout(singleT);
    singleT = setTimeout(toggleControls, 260);
  };
  g.addEventListener('pointerup', up);
  g.addEventListener('pointercancel', up);

  function endSpeed() { P.v.playbackRate = P.prevRate || 1; $('#speedpill').hidden = true; }
}

/* keyboard (desktop / TV remotes) */
document.addEventListener('keydown', e => {
  if (P.el.hidden || e.target.matches('input')) return;
  const k = e.key;
  if (k === ' ' || k === 'k') { togglePlay(); e.preventDefault(); }
  else if (k === 'ArrowLeft' || k === 'j') { seekBy(-S.seekStep); ripple('L'); }
  else if (k === 'ArrowRight' || k === 'l') { seekBy(S.seekStep); ripple('R'); }
  else if (k === 'ArrowUp') { setVolume(P.vol + 0.1); hud('i-vol', P.vol / 2, Math.round(P.vol * 100) + '%'); e.preventDefault(); }
  else if (k === 'ArrowDown') { setVolume(P.vol - 0.1); hud('i-vol', P.vol / 2, Math.round(P.vol * 100) + '%'); e.preventDefault(); }
  else if (k === 'f' && !NATIVE) toggleFull();
  else if (k === 'n') next();
  else if (k === 'p') prev();
  else if (k === 'Escape' && !document.fullscreenElement) closePlayer();
  showControls();
});

/* --- player sheets --- */
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];
function sheetSpeed() {
  const draw = () => `<div class="grid-opts">${SPEEDS.map(s =>
    `<button data-s="${s}" class="${Math.abs(P.v.playbackRate - s) < .01 ? 'sel' : ''}">${s}×</button>`).join('')}</div>
    <div class="range-row"><input type="range" id="spR" min="0.25" max="4" step="0.05" value="${P.v.playbackRate}"><output>${fmtRate(P.v.playbackRate)}</output></div>
    ${opt('def', 'i-check', 'Use as default speed', sw(Math.abs(S.defaultSpeed - P.v.playbackRate) < .01))}`;
  const b = openSheet('Playback speed', draw());
  b.onclick = e => {
    const s = e.target.closest('[data-s]')?.dataset.s;
    if (s) { P.v.playbackRate = +s; b.innerHTML = draw(); bindR(); }
    if (e.target.closest('[data-o="def"]')) { S.defaultSpeed = P.v.playbackRate; saveSettings(); b.innerHTML = draw(); bindR(); }
  };
  const bindR = () => { $('#spR', b).oninput = e => { P.v.playbackRate = +e.target.value; $('output', b).textContent = fmtRate(+e.target.value); }; };
  bindR();
}

function sheetSubs() {
  const draw = () => `
    ${embeddedSubsHtml()}
    ${nativeTracks('text').length ? '<div class="group">From a file</div>' : ''}
    ${opt('load', 'i-plus', 'Load subtitle file<small>.srt or .vtt</small>')}
    ${P.cues.length ? opt('toggle', 'i-cc', 'Show subtitles', sw(P.subOn)) : ''}
    ${P.subBuf ? opt('enc', 'i-text', 'Character encoding<small>Fix strange symbols</small>', `<span class="val">${P.subEncForced ? '' : 'Auto · '}${esc(encLabel(P.subEnc || 'utf-8').replace(/ \(.*/, ''))}</span>`) : ''}
    <div class="group">Sync</div>
    <div class="grid-opts">
      <button data-d="-0.5">−0.5s</button><button data-d="-0.05">−50ms</button>
      <button data-d="0.05">+50ms</button><button data-d="0.5">+0.5s</button>
    </div>
    ${opt('reset', 'i-refresh', 'Subtitle delay', `<span class="val">${P.subDelay >= 0 ? '+' : ''}${P.subDelay.toFixed(2)}s</span>`)}
    <div class="group">Style</div>
    <div class="range-row"><span>Size</span><input type="range" id="sSize" min="12" max="40" value="${S.subSize}"><output>${S.subSize}px</output></div>
    <div class="range-row"><span>Position</span><input type="range" id="sPos" min="2" max="40" value="${S.subPos}"><output>${S.subPos}%</output></div>
    ${opt('bg', 'i-aspect', 'Dark background behind text', sw(S.subBg))}`;
  const b = openSheet('Subtitles', draw());
  const bind = () => {
    $('#sSize', b).oninput = e => { S.subSize = +e.target.value; e.target.nextElementSibling.textContent = S.subSize + 'px'; applySubStyle(); saveSettings(); };
    $('#sPos', b).oninput = e => { S.subPos = +e.target.value; e.target.nextElementSibling.textContent = S.subPos + '%'; applySubStyle(); saveSettings(); };
  };
  bind();
  b.onclick = e => {
    const d = e.target.closest('[data-d]')?.dataset.d;
    const o = e.target.closest('[data-o]')?.dataset.o;
    if (d) P.subDelay = Math.round((P.subDelay + +d) * 100) / 100;
    if (o === 'load') { closeSheet(); $('#pickSub').click(); return; }
    if (o?.startsWith('st:')) { pickEmbeddedSub(o); closeSheet(); return; }
    if (o === 'enc') { closeSheet(); return sheetSubEncoding(); }
    if (o === 'toggle') P.subOn = !P.subOn;
    if (o === 'reset') P.subDelay = 0;
    if (o === 'bg') { S.subBg = !S.subBg; saveSettings(); applySubStyle(); }
    if (!d && !o) return;
    b.innerHTML = draw(); bind(); renderSub();
  };
}
$('#pickSub').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadSubFile(f); };

function sheetMore() {
  const sleepLbl = P.sleepEnd ? 'End of video' : P.sleep ? `${Math.ceil((P.sleep.at - Date.now()) / 60000)} min left` : 'Off';
  const abLbl = P.ab.b != null ? `${fmtTime(P.ab.a)} → ${fmtTime(P.ab.b)}` : P.ab.a != null ? `A at ${fmtTime(P.ab.a)} · tap to set B` : 'Off';
  const local = !P.item.remote, nat = !!P.v.isNative;
  const aTracks = nativeTracks('audio');
  const b = openSheet('More',
    `<div class="group">Tools</div>` +
    (nat ? '' : opt('record', 'i-rec', P.rec ? 'Stop recording' : 'Record clip<small>Saves what plays as a video file</small>', P.rec ? '<span class="val" style="color:#ff5d5d">● REC</span>' : '', P.rec ? 'danger' : '')) +
    opt('shot', 'i-camera', 'Save screenshot') +
    opt('ab', 'i-loop', 'A-B repeat', `<span class="val">${abLbl}</span>`) +
    opt('jump', 'i-fwd', 'Jump to time') +
    opt('bookmarks', 'i-bookmark', 'Bookmarks', `<span class="val">${getMarks().length || ''}</span>`) +
    `<div class="group">Picture &amp; sound</div>` +
    opt('aspect', 'i-aspect', 'Aspect ratio', `<span class="val">${ASPECTS[P.aspect][1]}</span>`) +
    (nat ? '' : opt('adjust', 'i-sun', 'Video adjustments<small>Contrast, color, mirror</small>')) +
    (aTracks.length > 1 ? opt('atrack', 'i-headphones', 'Audio track', `<span class="val">${esc(trackLabel(aTracks.find(t => t.selected) || aTracks[0], aTracks.findIndex(t => t.selected)).name)}</span>`) : '') +
    (local ? opt('eq', 'i-eq', 'Equalizer', `<span class="val">${S.eqOn ? esc(S.eqPreset) : 'Off'}</span>`) : '') +
    (local ? opt('night', 'i-moon', 'Night mode<small>Softer explosions, clearer dialogue</small>', sw(S.night)) : '') +
    ((local && P.nv && P.item.native && P.item.kind !== 'audio') || P.item.dpath ? opt('engine', 'i-film', 'Player engine<small>Switch if a file won’t play or has no sound</small>', `<span class="val">${nat || P.hls ? 'All formats' : 'Standard'}</span>`) : '') +
    (local && !nat ? opt('adelay', 'i-vol', 'Audio delay', `<span class="val">${P.audioDelay ? '+' + Math.round(P.audioDelay * 1000) + ' ms' : 'Off'}</span>`) : '') +
    `<div class="group">Playback</div>` +
    opt('queue', 'i-queue', 'Play queue', `<span class="val">${P.idx + 1} of ${P.queue.length}</span>`) +
    (NATIVE ? opt('pdiag', 'i-info', 'Playback details<small>Engine, seeking and file info, to share if something goes wrong</small>') : '') +
    opt('shuffle', 'i-shuffle', 'Shuffle', sw(S.shuffle)) +
    opt('playlists', 'i-plist', 'Playlists') +
    opt('repeat', 'i-loop', 'Repeat', `<span class="val">${{ off: 'Off', one: 'This video', all: 'All in list' }[P.repeat]}</span>`) +
    opt('sleep', 'i-moon', 'Sleep timer', `<span class="val">${sleepLbl}</span>`) +
    opt('info', 'i-info', 'Video details'));
  b.onclick = e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'record') return P.rec ? stopRecording() : startRecording();
    if (o === 'shot') return screenshot();
    if (o === 'ab') return cycleAB();
    if (o === 'jump') return sheetJump();
    if (o === 'bookmarks') return sheetBookmarks();
    if (o === 'aspect') return sheetAspect();
    if (o === 'adjust') return sheetAdjust();
    if (o === 'eq') return sheetEq();
    if (o === 'adelay') return sheetAudioDelay();
    if (o === 'atrack') return sheetAudioTracks();
    if (o === 'night') { toggleNight(); return; }
    if (o === 'engine' && P.item.dpath) return switchEngine(P.hls ? 'web' : 'native', P.hls ? 'Switching to the standard player…' : 'Converting this file as it plays…');
    if (o === 'engine') return switchEngine(nat ? 'web' : 'native', nat ? 'Switching to the standard player…' : 'Switching to the all-formats player…');
    if (o === 'sleep') return sheetSleep();
    if (o === 'info') return sheetMediaInfo();
    if (o === 'queue') return sheetQueue();
    if (o === 'pdiag') return sheetPlaybackDetails();
    if (o === 'playlists') return sheetPlaylists();
    if (o === 'shuffle') { setShuffle(!S.shuffle); return sheetMore(); }
    if (o === 'repeat') { P.repeat = { off: 'one', one: 'all', all: 'off' }[P.repeat]; P.v.loop = false; sheetMore(); }
  };
}

/* ---------- A-B repeat ---------- */
P.ab = { a: null, b: null };
function cycleAB() {
  const t = P.v.currentTime;
  if (P.ab.a == null) { P.ab.a = t; ptoast(`A set at ${fmtTime(t)} — open again to set B`); }
  else if (P.ab.b == null) {
    if (t <= P.ab.a + 0.5) { ptoast('B must be after A'); return; }
    P.ab.b = t; P.v.currentTime = P.ab.a; ptoast(`Looping ${fmtTime(P.ab.a)} → ${fmtTime(P.ab.b)}`, 'Clear', clearAB, 4000);
  } else { clearAB(); ptoast('A-B repeat off'); }
  drawMarkers();
}
function clearAB() { P.ab = { a: null, b: null }; drawMarkers(); }

/* ---------- jump to time ---------- */
function sheetJump() {
  const b = openSheet('Jump to time', `
    <div style="padding:4px 20px 12px">
      <input id="jumpIn" inputmode="numeric" placeholder="e.g. 1:23:45 or 12:30" value="${fmtTime(P.v.currentTime)}"
        style="width:100%;height:46px;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);padding:0 14px;font-size:18px;font-variant-numeric:tabular-nums">
      <p style="color:var(--muted);font-size:12.5px;margin:8px 2px 12px">Length ${fmtTime(P.v.duration)}</p>
      <button class="btn primary" id="jumpGo" style="width:100%;justify-content:center">Go</button>
    </div>`);
  const go = () => {
    const parts = $('#jumpIn').value.trim().split(/[:.\s]/).filter(Boolean).map(Number);
    if (!parts.length || parts.some(isNaN)) return $('#jumpIn').focus();
    const s = parts.reduce((acc, n) => acc * 60 + n, 0);
    P.v.currentTime = clamp(s, 0, (P.v.duration || s) - 0.1);
    closeSheet();
  };
  $('#jumpGo', b).onclick = go;
  $('#jumpIn', b).onkeydown = e => e.key === 'Enter' && go();
  setTimeout(() => { const i = $('#jumpIn'); i?.focus(); i?.select(); }, 50);
}

/* ---------- bookmarks (saved per video) ---------- */
const allMarks = store.get('bookmarks', {});
const getMarks = () => (P.item && allMarks[P.item.id]) || [];
function sheetBookmarks() {
  const draw = () => {
    const m = getMarks();
    return opt('add', 'i-plus', `Add bookmark at ${fmtTime(P.v.currentTime)}`) +
      (m.length ? m.map((t, i) =>
        `<div class="opt" style="padding-right:8px"><button class="lbl" data-go="${i}" style="text-align:left;display:flex;align-items:center;gap:14px"><svg><use href="#i-bookmark"/></svg>${fmtTime(t)}</button>
         <button class="icon-btn sm" data-del="${i}" aria-label="Delete bookmark"><svg><use href="#i-trash"/></svg></button></div>`).join('')
      : `<p style="color:var(--muted);padding:6px 20px 12px;margin:0">No bookmarks yet. They also show as marks on the seek bar.</p>`);
  };
  const b = openSheet('Bookmarks', draw());
  b.onclick = e => {
    const m = getMarks().slice();
    if (e.target.closest('[data-o="add"]')) {
      const t = Math.round(P.v.currentTime * 10) / 10;
      if (!m.some(x => Math.abs(x - t) < 1)) m.push(t);
      m.sort((x, y) => x - y);
    } else if (e.target.closest('[data-del]')) m.splice(+e.target.closest('[data-del]').dataset.del, 1);
    else if (e.target.closest('[data-go]')) { P.v.currentTime = m[+e.target.closest('[data-go]').dataset.go]; closeSheet(); return; }
    else return;
    if (m.length) allMarks[P.item.id] = m; else delete allMarks[P.item.id];
    store.set('bookmarks', allMarks);
    b.innerHTML = draw(); drawMarkers();
  };
}
function drawMarkers() {
  const host = $('#seekMarks'); if (!host) return;
  const d = P.v.duration;
  if (!d || !isFinite(d)) { host.innerHTML = ''; return; }
  let html = getMarks().map(t => `<i class="mk" style="left:${t / d * 100}%"></i>`).join('');
  if (P.ab.a != null) {
    const a = P.ab.a / d * 100, bb = P.ab.b != null ? P.ab.b / d * 100 : a;
    html += `<i class="ab" style="left:${a}%;width:${Math.max(0.6, bb - a)}%"></i>`;
  }
  host.innerHTML = html;
}

/* ---------- video adjustments ---------- */
function sheetAdjust() {
  const rows = [
    ['gamma', 'Brightness', 0.5, 1.6, 0.05, v => Math.round(v * 100) + '%'],
    ['contrast', 'Contrast', 0.5, 2, 0.05, v => Math.round(v * 100) + '%'],
    ['saturate', 'Saturation', 0, 2.5, 0.05, v => Math.round(v * 100) + '%'],
    ['hue', 'Hue', -180, 180, 5, v => v + '°'],
  ];
  const draw = () => rows.map(([k, l, mn, mx, st, f]) =>
    `<div class="range-row"><span style="width:84px">${l}</span><input type="range" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${P.adj[k]}"><output>${f(P.adj[k])}</output></div>`).join('') +
    opt('mirror', 'i-aspect', 'Mirror (flip left-right)', sw(P.adj.mirror)) +
    opt('reset', 'i-refresh', 'Reset all');
  const b = openSheet('Video adjustments', draw());
  const bind = () => $$('input[data-k]', b).forEach(inp => inp.oninput = () => {
    const r = rows.find(x => x[0] === inp.dataset.k);
    P.adj[inp.dataset.k] = +inp.value; inp.nextElementSibling.textContent = r[5](+inp.value); applyBright();
  });
  bind();
  b.onclick = e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    if (o === 'mirror') P.adj.mirror = !P.adj.mirror;
    if (o === 'reset') P.adj = { ...ADJ_DEFAULT };
    applyBright(); b.innerHTML = draw(); bind();
  };
}

/* ---------- equalizer ---------- */
function sheetEq() {
  const lbl = f => (f >= 1000 ? f / 1000 + 'k' : f);
  const draw = () =>
    opt('toggle', 'i-eq', 'Equalizer', sw(S.eqOn)) +
    `<div class="chips">${Object.keys(EQ_PRESETS).map(p =>
      `<button data-p="${esc(p)}" class="${S.eqOn && S.eqPreset === p ? 'sel' : ''}">${esc(p)}</button>`).join('')}
      ${S.eqPreset === 'Custom' ? '<button class="sel">Custom</button>' : ''}</div>
     <div class="eq${S.eqOn ? '' : ' off'}">${EQ_FREQS.map((f, i) =>
      `<label><output>${S.eqBands[i] > 0 ? '+' : ''}${S.eqBands[i]}</output><input type="range" data-i="${i}" min="-12" max="12" step="1" value="${S.eqBands[i]}" orient="vertical"><span>${lbl(f)}</span></label>`).join('')}</div>`;
  const b = openSheet('Equalizer', draw());
  const bind = () => $$('input[data-i]', b).forEach(inp => inp.oninput = () => {
    S.eqBands[+inp.dataset.i] = +inp.value; S.eqPreset = 'Custom'; S.eqOn = true;
    inp.previousElementSibling.textContent = (+inp.value > 0 ? '+' : '') + inp.value;
    ensureBoost(); applyAudioFx(); saveSettings();
  });
  const refresh = () => { b.innerHTML = draw(); bind(); };
  bind();
  b.onclick = e => {
    const p = e.target.closest('[data-p]')?.dataset.p;
    if (p) { S.eqPreset = p; S.eqBands = EQ_PRESETS[p].slice(); S.eqOn = true; }
    else if (e.target.closest('[data-o="toggle"]')) S.eqOn = !S.eqOn;
    else return;
    if (S.eqOn && !ensureBoost()) { S.eqOn = false; ptoast('Equalizer isn’t available for this video'); }
    applyAudioFx(); saveSettings(); refresh();
  };
}

/* ---------- audio delay (saved per video) ---------- */
const allDelays = store.get('audioDelays', {});
function sheetAudioDelay() {
  const draw = () => `
    <p style="color:var(--muted);padding:0 20px 6px;margin:0;font-size:13px">Sound ahead of the picture? Delay it until lips match.</p>
    <div class="range-row"><input type="range" id="adR" min="0" max="2000" step="50" value="${Math.round((P.audioDelay || 0) * 1000)}"><output>+${Math.round((P.audioDelay || 0) * 1000)} ms</output></div>
    <div class="grid-opts"><button data-d="-100">−100</button><button data-d="-50">−50</button><button data-d="50">+50</button><button data-d="100">+100</button></div>
    ${opt('reset', 'i-refresh', 'Reset to 0')}`;
  const b = openSheet('Audio delay', draw());
  const set = ms => {
    P.audioDelay = clamp(ms, 0, 2000) / 1000;
    if (P.audioDelay && !ensureBoost()) { P.audioDelay = 0; ptoast('Audio delay isn’t available for this video'); }
    applyAudioFx();
    if (P.audioDelay) allDelays[P.item.id] = P.audioDelay; else delete allDelays[P.item.id];
    store.set('audioDelays', allDelays);
  };
  const bind = () => { $('#adR', b).oninput = e => { set(+e.target.value); e.target.nextElementSibling.textContent = `+${e.target.value} ms`; }; };
  bind();
  b.onclick = e => {
    const d = e.target.closest('[data-d]')?.dataset.d;
    if (d) set(Math.round((P.audioDelay || 0) * 1000) + +d);
    else if (e.target.closest('[data-o="reset"]')) set(0);
    else return;
    b.innerHTML = draw(); bind();
  };
}

/* ---------- detailed media info ---------- */
async function sheetMediaInfo() {
  const v = P.v, it = P.item;
  const fps = await measureFps();
  const q = v.getVideoPlaybackQuality?.();
  const bitrate = it.size && isFinite(v.duration) && v.duration ? (it.size * 8 / v.duration) : 0;
  const rows = [
    ['File', it.name], ['Folder', it.folder || '—'],
    ['Container', it.remote ? '—' : (it.file?.type || it.name.split('.').pop().toUpperCase())],
    ['Resolution', v.videoWidth ? `${v.videoWidth} × ${v.videoHeight}` : 'Audio only'],
    ['Frame rate', fps ? `${fps} fps` : '—'],
    ['Length', fmtTime(v.duration)], ['Size', it.size ? fmtSize(it.size) : '—'],
    ['Avg. bitrate', bitrate ? (bitrate > 1e6 ? (bitrate / 1e6).toFixed(1) + ' Mbps' : Math.round(bitrate / 1e3) + ' kbps') : '—'],
    ['Dropped frames', q ? `${q.droppedVideoFrames} of ${q.totalVideoFrames}` : '—'],
    ['Subtitles', P.cues.length ? `${P.cues.length} lines` : 'None'],
  ];
  openSheet('Video details', `<div style="padding:0 20px 8px">${rows.map(([k, val]) =>
    `<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)"><span style="color:var(--muted);width:110px;flex:none">${k}</span><span style="word-break:break-word">${esc(val)}</span></div>`).join('')}</div>`);
}
function measureFps() {
  const v = P.v;
  if (!v.requestVideoFrameCallback || v.paused) return Promise.resolve(0);
  return new Promise(res => {
    let first = null, n = 0;
    const to = setTimeout(() => res(0), 1500);
    const cb = (now, m) => {
      if (first == null) first = m; n++;
      if (n >= 12) { clearTimeout(to); const dt = m.mediaTime - first.mediaTime, df = m.presentedFrames - first.presentedFrames;
        return res(dt > 0 ? Math.round(df / dt * v.playbackRate * 100) / 100 / v.playbackRate : 0); }
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  });
}

/* ---------- record clip (VLC-style record button) ---------- */
function startRecording() {
  const v = P.v;
  const capture = v.captureStream || v.mozCaptureStream;
  if (!capture || !window.MediaRecorder) return ptoast('Recording isn’t supported in this browser');
  let stream;
  try { stream = capture.call(v); } catch { return ptoast('This video can’t be recorded'); }
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  const mime = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
  let rec;
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6 } : undefined); }
  catch { return ptoast('This video can’t be recorded'); }
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const type = rec.mimeType || mime || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    const name = `${baseName(P.item.name)} clip ${new Date().toTimeString().slice(0, 8).replace(/:/g, '-')}.${ext}`;
    saveBlob(blob, name);
    const f = new File([blob], name, { type, lastModified: Date.now() });
    const id = fileId(f);
    if (!lib.byId.has(id)) {
      const it = { id, file: f, name, size: f.size, mtime: f.lastModified, folder: 'Recordings', url: null, dur: 0, thumb: null, sub: null };
      lib.items.push(it); lib.byId.set(id, it); hydrateThumbs();
    }
    ptoast(`Clip saved (${fmtTime((Date.now() - P.rec.start) / 1000)}) — also in “Recordings”`);
    P.rec = null; $('#recpill').hidden = true; clearInterval(P.recTick);
  };
  rec.start(1000);
  P.rec = { rec, start: Date.now() };
  if (v.paused) v.play().catch(() => {});
  const pill = $('#recpill'); pill.hidden = false;
  const tick = () => ($('#recTime').textContent = fmtTime((Date.now() - P.rec.start) / 1000));
  tick(); P.recTick = setInterval(tick, 500);
}
function stopRecording() { try { P.rec?.rec.stop(); } catch {} }
$('#recpill').onclick = stopRecording;
function sheetAspect() {
  const b = openSheet('Aspect ratio', ASPECTS.map(([k, l], i) =>
    opt(i, i === P.aspect ? 'i-check' : 'i-aspect', l, '', i === P.aspect ? 'sel' : '')).join(''));
  b.onclick = e => { const o = e.target.closest('[data-o]')?.dataset.o; if (o == null) return; P.aspect = +o; P.zoom = 1; applyAspect(); closeSheet(); };
}
function sheetSleep() {
  const opts = [['0', 'Off'], ['15', '15 minutes'], ['30', '30 minutes'], ['45', '45 minutes'], ['60', '1 hour'], ['90', '1.5 hours'], ['end', 'End of this video']];
  const b = openSheet('Sleep timer', opts.map(([k, l]) => opt(k, 'i-moon', l)).join(''));
  b.onclick = e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (o == null) return;
    clearSleep();
    if (o === 'end') { P.sleepEnd = true; ptoast('Will stop at the end of this video'); }
    else if (+o) {
      const ms = +o * 60000;
      P.sleep = { at: Date.now() + ms, t: setTimeout(() => { P.v.pause(); P.sleep = null; ptoast('Sleep timer: paused'); }, ms) };
      ptoast(`Pausing in ${o} minutes`);
    } else ptoast('Sleep timer off');
    closeSheet();
  };
}
function clearSleep() { if (P.sleep) clearTimeout(P.sleep.t); P.sleep = null; P.sleepEnd = false; }

/* Save a file: Android app → phone's Pictures/Movies "Open Player" folder; browser → download. */
async function saveBlob(blob, name) {
  if (NATIVE) {
    try {
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
      await ML.saveFile({ name, mime: blob.type || 'application/octet-stream', base64: b64 });
      return blob.type.startsWith('image/') ? 'Pictures › Open Player' : 'Movies › Open Player';
    } catch { ptoast('Couldn’t save the file'); return null; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return null;
}
function screenshot() {
  const v = P.v; if (!v.videoWidth) return ptoast('Nothing to capture');
  if (v.isNative) {
    NP.screenshot().then(r => fetch('data:image/png;base64,' + r.base64)).then(res => res.blob())
      .then(b => saveBlob(b, `${baseName(P.item.name)}_${fmtTime(v.currentTime).replace(/:/g, '-')}.png`))
      .then(where => ptoast(where ? `Screenshot saved to ${where}` : 'Screenshot saved'))
      .catch(() => ptoast('Couldn’t take a screenshot'));
    return;
  }
  try {
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob(b => {
      if (!b) return ptoast('Screenshot not allowed for this stream');
      saveBlob(b, `${baseName(P.item.name)}_${fmtTime(v.currentTime).replace(/:/g, '-')}.png`)
        .then(where => ptoast(where ? `Screenshot saved to ${where}` : 'Screenshot saved'));
    }, 'image/png');
  } catch { ptoast('Screenshot not allowed for this stream'); }
}

/* --- subtitles (own renderer: lets us restyle and re-time freely) --- */
function parseTime(s) {
  const m = s.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : NaN;
}
function parseSubs(text) {
  const out = [];
  const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  for (const blk of blocks) {
    const lines = blk.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const s = parseTime(a), e = parseTime(b);
    if (isNaN(s) || isNaN(e)) continue;
    const txt = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    if (txt) out.push({ s, e, txt });
  }
  return out.sort((x, y) => x.s - y.s);
}
async function loadSubFile(file, silent) {
  try {
    P.subBuf = new Uint8Array(await file.arrayBuffer());
    P.subEncForced = null;
    decodeSubs();
    if (!silent) ptoast(P.cues.length ? `Subtitles loaded · ${P.cues.length} lines · ${encLabel(P.subEnc).replace(/ \(.*/, '')}` : 'Couldn’t read that subtitle file');
    applySubStyle(); renderSub();
  } catch { ptoast('Couldn’t read that subtitle file'); }
}
let lastSubText = null;
function renderSub() {
  const el = $('#subs');
  if (!P.subOn || !P.cues.length) { if (lastSubText !== '') { el.innerHTML = ''; lastSubText = ''; } return; }
  const t = P.v.currentTime - P.subDelay;
  let lo = 0, hi = P.cues.length - 1, txt = '';
  while (lo <= hi) {                                 // binary search for active cue
    const m = (lo + hi) >> 1, c = P.cues[m];
    if (t < c.s) hi = m - 1; else if (t > c.e) lo = m + 1; else { txt = c.txt; break; }
  }
  if (txt === lastSubText) return;
  lastSubText = txt;
  el.innerHTML = txt ? `<span>${esc(txt)}</span>` : '';
}
function applySubStyle() {
  const r = document.documentElement.style;
  r.setProperty('--sub-size', S.subSize + 'px');
  r.setProperty('--sub-bottom', S.subPos + '%');
  r.setProperty('--sub-bg', S.subBg ? 'rgba(0,0,0,.65)' : 'transparent');
  if (P.v?.isNative) NP.setSubtitleStyle({ size: S.subSize, bottom: S.subPos / 100, background: !!S.subBg, visible: true }).catch(() => {});
}
applySubStyle();

/* --- wake lock, media session --- */
async function keepAwake(on) {
  if (NATIVE) { ML.keepAwake({ on: on && S.keepAwake }).catch(() => {}); return; }
  try {
    if (on && S.keepAwake && 'wakeLock' in navigator) { if (!P.wake) P.wake = await navigator.wakeLock.request('screen'); P.wake.onrelease = () => (P.wake = null); }
    else if (!on && P.wake) { await P.wake.release(); P.wake = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && privUnlocked) lockPrivate();
  if (document.visibilityState === 'visible' && !P.v.paused) keepAwake(true);
  if (document.visibilityState === 'hidden') saveProgress(true);
});
function setupMediaSession() {
  const ms = navigator.mediaSession; if (!ms) return;
  try {
    ms.metadata = new MediaMetadata({
      title: P.item.name, artist: 'Open Player', album: P.item.folder || '',
      artwork: P.item.thumb ? [{ src: P.item.thumb, sizes: '256x144', type: 'image/jpeg' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    const h = {
      play: () => P.v.play(), pause: () => P.v.pause(),
      seekbackward: d => seekBy(-(d.seekOffset || S.seekStep)), seekforward: d => seekBy(d.seekOffset || S.seekStep),
      previoustrack: P.idx > 0 ? prev : null, nexttrack: P.idx < P.queue.length - 1 ? next : null,
      seekto: d => { P.v.currentTime = d.seekTime; },
      enterpictureinpicture: () => P.v.requestPictureInPicture().catch(() => {}),
    };
    for (const [k, fn] of Object.entries(h)) { try { ms.setActionHandler(k, fn); } catch {} }
  } catch {}
}

/* =================================================================
   SERVICE WORKER, UPDATES, SHARE TARGET
   ================================================================= */
async function setupSW() {
  if (NATIVE || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    const prompt = w => snack('A new version of Open Player is ready', 'Reload', () => w.postMessage('SKIP_WAITING'), 0);
    if (reg.waiting && navigator.serviceWorker.controller) prompt(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) prompt(w); });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  } catch {}
}
async function checkForUpdate(manual) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return manual && snack('You’re on the latest version');
    await reg.update();
    if (!reg.installing && !reg.waiting && manual) snack('You’re on the latest version');
  } catch { manual && snack('Couldn’t check for updates — are you offline?'); }
}
async function importShared() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('op-share-inbox');
    const reqs = await cache.keys();
    const files = [];
    for (const r of reqs) {
      const res = await cache.match(r);
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-name') || 'Shared video');
      files.push(new File([blob], name, { type: blob.type, lastModified: +res.headers.get('x-mtime') || Date.now() }));
      await cache.delete(r);
    }
    if (files.length) {
      addFiles(files);
      const first = lib.items.find(i => i.name === files[0].name);
      if (first) openPlayer(first, lib.items.filter(i => i.folder === first.folder));
    }
  } catch {}
}
// Desktop "Open with" (File Handling API)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map(h => h.getFile()));
    addFiles(files);
    const first = lib.items.find(i => i.name === files[0].name);
    if (first) openPlayer(first, lib.items.filter(i => i.folder === first.folder));
  });
}

/* drag & drop (desktop) */
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

/* =================================================================
   ANDROID APP: media access, hidden folders, "Open with"
   ================================================================= */
let access = { video: 'prompt', audio: 'prompt' }, allFiles = false;
function hasAccess(k) { return access[k] === 'granted'; }
async function refreshAccess() {
  if (!NATIVE) return;
  try { access = await ML.checkAccess(); } catch {}
  try { allFiles = (await ML.checkAllFiles()).granted; } catch {}
}
async function requestMediaAccess() {
  if (!NATIVE) { window.open(ANDROID_APK_URL, '_blank', 'noopener'); return; }
  try {
    access = await ML.requestAccess({ types: ['video', 'audio'] });
    if (hasAccess('video') || hasAccess('audio')) { S.mediaMode = 'full'; saveSettings(); await scanDevice(); }
    else if (access.video === 'denied') snack('Permission is turned off for Open Player', 'Open settings', () => ML.openAppSettings(), 7000);
    else snack('No problem — you can add files yourself anytime', 'Add', () => sheetAdd(), 5000);
  } catch { snack('Couldn’t ask for permission'); }
  render();
}

async function toggleDeepScan() {
  if (S.deepScan && allFiles) {
    S.deepScan = false; saveSettings();
    lib.items = lib.items.filter(i => !i.deep); lib.byId = new Map(lib.items.map(i => [i.id, i]));
    render(); return snack('Hidden-folder search turned off');
  }
  S.deepScan = true; saveSettings();
  if (allFiles) return deepScan();
  const b = openSheet('Find hidden videos', `
    <div style="padding:0 20px 8px;color:var(--muted);font-size:14px;line-height:1.5">
      <p style="margin:0 0 10px">Some apps put videos in folders marked “hidden” so normal players skip them. To look inside those folders, Android needs you to turn on <b style="color:var(--text)">All files access</b> for Open Player.</p>
      <p style="margin:0">Open Player only reads videos and music. Nothing is changed, deleted or uploaded.</p>
    </div>
    ${opt('go', 'i-folder', 'Open Android settings<small>Turn on “Allow access to manage all files”, then come back</small>')}
    ${opt('cancel', 'i-close', 'Not now')}`);
  b.onclick = async e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'cancel') { S.deepScan = false; saveSettings(); return; }
    try { const r = await ML.requestAllFiles(); if (r.granted) { allFiles = true; deepScan(); } } catch {}
  };
}
async function deepScan(quiet) {
  if (!NATIVE) return;
  if (!allFiles) { try { allFiles = (await ML.checkAllFiles()).granted; } catch {} if (!allFiles) return; }
  if (!quiet) snack('Searching hidden folders…', null, null, 0);
  try {
    const r = await ML.deepScan();
    const known = new Set(lib.items.filter(i => i.npath && !i.deep).map(i => i.npath));
    lib.items = lib.items.filter(i => !i.deep);
    lib.byId = new Map(lib.items.map(i => [i.id, i]));
    let n = 0, hiddenN = 0;
    for (const m of r.items) {
      if (known.has(m.path)) continue;            // already listed by Android's media library
      const it = {
        id: 'fs:' + m.path, kind: m.kind, native: true, deep: true, hidden: m.hidden,
        npath: m.path, nuri: null, src: nativeSrc(m.path), name: m.name, size: m.size, mtime: m.mtime,
        folder: m.folder || 'Hidden', dur: 0, thumb: null, sub: null,
      };
      if (m.kind === 'audio') Object.assign(it, { title: baseName(m.name), artist: 'Unknown artist', album: m.folder || 'Unknown album' });
      lib.items.push(it); lib.byId.set(it.id, it); n++; if (m.hidden) hiddenN++;
    }
    render(); hydrateThumbs();
    if (!quiet || n) snack(n ? `Found ${n} more file${n > 1 ? 's' : ''}${hiddenN ? ` (${hiddenN} in hidden folders)` : ''}` : 'No extra files found in hidden folders');
  } catch { if (!quiet) snack('Couldn’t search hidden folders'); }
}

function sheetTelegramHelp() {
  openSheet('Can’t find Telegram downloads?', `
    <div class="help">
      <p>Newer versions of <b>Telegram</b> and <b>Plus Messenger</b> keep downloads in their own private storage. Android doesn’t let any other app open that folder — not Open Player, VLC or MX Player. Here’s how to get them:</p>
      <h4>1 · Play it straight away (no re-download)</h4>
      <p>In Telegram, open the video, tap <b>⋮</b> and choose <b>Share</b> or <b>Open with</b>, then pick <b>Open Player</b>.${NATIVE ? '' : ' (Needs the Open Player Android app.)'}</p>
      <h4>2 · Make them show up here automatically</h4>
      <p>Use <b>Save to Downloads</b> or <b>Save to Gallery</b> on a video. It’s copied to your phone’s shared storage (usually <i>Download › Telegram</i>), and Open Player lists it on the next scan. Telegram also has an automatic “Save to Gallery” option in <i>Settings › Data and Storage</i>.</p>
      <h4>3 · Stop having to download again</h4>
      <p>Telegram clears its cache to save space. In Telegram go to <i>Settings › Data and Storage › Storage Usage</i> and set <b>Keep Media</b> to <b>Forever</b>.</p>
      <p class="note">Menu names can differ slightly between Telegram versions and Plus Messenger.</p>
    </div>
    ${NATIVE ? opt('rescan', 'i-refresh', 'Rescan phone now') : opt('getapp', 'i-android', 'Get the Android app', '<span class="val">Recommended</span>')}`)
    .onclick = e => {
      const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
      closeSheet();
      if (o === 'rescan') scanDevice();
      if (o === 'getapp') window.open(ANDROID_APK_URL, '_blank', 'noopener');
    };
}

/* about this install: version, signing certificate, Play or direct download */
let appInfo = null;
async function loadAppInfo() {
  if (!NATIVE) return;
  try { appInfo = await ML.getAppInfo(); } catch { appInfo = null; }
  if (appInfo?.allFilesSupported === false && S.deepScan) { S.deepScan = false; saveSettings(); }
}
function sheetVerifyApp() {
  const i = appInfo || {};
  const from = i.installer === 'com.android.vending' ? 'Google Play' : 'Downloaded APK';
  const b = openSheet('Verify this app', `
    <p class="sheet-note">Every official Open Player build is signed with the same key. If the fingerprint below matches the one on the Open Player website, this copy is genuine and hasn’t been changed.</p>
    <div class="kv"><span>Version</span><b>${esc(i.versionName || APP_VERSION)}${i.versionCode ? ` (${esc(i.versionCode)})` : ''}</b></div>
    <div class="kv"><span>Edition</span><b>${i.allFilesSupported === false ? 'Google Play edition' : 'Full edition (direct download)'}</b></div>
    <div class="kv"><span>Installed from</span><b>${from}</b></div>
    <div class="kv col"><span>Signing certificate SHA-256</span><code id="certFp">${esc(i.certSha256 || 'Not available')}</code></div>
    ${i.installer === 'com.android.vending' ? '<p class="sheet-note">Apps from Google Play are re-signed by Google, so their fingerprint differs from the direct download. Play has already checked this copy.</p>' : ''}
    ${opt('copy', 'i-check', 'Copy fingerprint')}
    ${opt('site', 'i-info', 'Compare on the Open Player website')}`);
  b.onclick = async e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    if (o === 'copy') { try { await navigator.clipboard.writeText(i.certSha256 || ''); snack('Fingerprint copied'); } catch { snack('Couldn’t copy — long-press the fingerprint instead'); } }
    if (o === 'site') window.open(SITE_VERIFY_URL, '_blank', 'noopener');
  };
}

/* files opened from other apps ("Open with" / Share → Open Player) */
function handleOpenFile(f) {
  if (!f?.uri) return;
  const kind = (f.mime || '').startsWith('audio/') || AUDIO_EXT.test(f.name || '') ? 'audio' : 'video';
  const id = 'in:' + f.uri;
  let it = lib.byId.get(id);
  if (!it) {
    it = { id, kind, native: true, keep: true, nuri: f.uri, npath: null, src: Cap.convertFileSrc(f.uri), name: f.name || 'Shared file',
      title: f.name ? baseName(f.name) : 'Shared file', size: f.size || 0, mtime: Date.now(), folder: 'Opened from other apps', dur: 0, thumb: null };
    lib.items.push(it); lib.byId.set(id, it);
  }
  if (!P.el.hidden) closePlayer(true);
  openPlayer(it, [it]);
}

/* first run */
function showOnboarding() {
  $('#onboard').hidden = false;
  if (!NATIVE) {
    $('#obFullTitle').textContent = 'Get the Android app';
    $('#obFullText').textContent = 'Browsers can’t list the videos on your phone. The free Open Player app asks for permission once, then shows all your videos and music automatically.';
    $('#obFull svg use').setAttribute('href', '#i-android');
    $('#obFoot').textContent = 'Or keep using this web version and add files yourself. You can change this anytime in Settings.';
  }
}
$('#obFull').onclick = async () => {
  S.onboarded = true; saveSettings();
  if (!NATIVE) { window.open(ANDROID_APK_URL, '_blank', 'noopener'); $('#onboard').hidden = true; return; }
  $('#onboard').hidden = true;
  await requestMediaAccess();
};
$('#obManual').onclick = () => {
  S.onboarded = true; S.mediaMode = 'manual'; saveSettings();
  $('#onboard').hidden = true; render();
};

if (NATIVE) {
  try { ML.addListener('openFile', handleOpenFile); } catch {}
  // Coming back from Android settings (or another app): pick up permission changes and new files.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const before = JSON.stringify(access) + allFiles;
    await refreshAccess();
    const changed = before !== JSON.stringify(access) + allFiles;
    if ((hasAccess('video') || hasAccess('audio')) && (changed || Date.now() - lastScan > 60000)) scanDevice(!changed);
    else if (changed && S.deepScan && allFiles) deepScan();
  });
}

/* =================================================================
   v1.4 — sorting everywhere, private folder, item menu, play queue,
   shuffle, playlists, frame preview, subtitle encodings, headphones
   ================================================================= */

/* ---------- small sheet helpers ---------- */
function confirmSheet(title, text, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    let done = false;
    const b = openSheet(title, `<p class="sheet-note">${text}</p>
      <div class="sheet-actions"><button class="btn" data-a="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${okLabel}</button></div>`,
      () => { if (!done) { done = true; resolve(false); } });
    b.onclick = e => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      done = true; closeSheet(); resolve(a === 'yes');
    };
  });
}
function askText(title, value = '', { placeholder = '', ok = 'Save', suffix = '', note = '' } = {}) {
  return new Promise(resolve => {
    let done = false;
    const b = openSheet(title, `<div class="field-wrap">
        ${note ? `<p class="sheet-note" style="padding:0 0 10px">${note}</p>` : ''}
        <div class="field-row"><input class="field" id="askIn" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">${suffix ? `<span class="field-suffix">${esc(suffix)}</span>` : ''}</div>
        <p class="field-err" id="askErr" hidden></p>
      </div>
      <div class="sheet-actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="yes">${ok}</button></div>`,
      () => { if (!done) { done = true; resolve(null); } });
    const inp = $('#askIn', b);
    const go = () => {
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      done = true; closeSheet(); resolve(v);
    };
    b.onclick = e => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      if (a === 'yes') go(); else { done = true; closeSheet(); resolve(null); }
    };
    inp.onkeydown = e => { if (e.key === 'Enter') go(); };
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}

/* ---------- sorting in every list ---------- */
const SORT_OPTS = {
  folders: [['name', 'Name'], ['date', 'Newest video'], ['size', 'Total size'], ['count', 'Number of videos']],
  videos: [['name', 'Name'], ['date', 'Date modified'], ['size', 'Size'], ['duration', 'Length']],
  infolder: [['date', 'Date modified'], ['name', 'Name'], ['size', 'Size'], ['duration', 'Length']],
  recent: [['played', 'Last played'], ['name', 'Name'], ['date', 'Date modified'], ['size', 'Size'], ['duration', 'Length']],
  songs: [['name', 'Title'], ['artist', 'Artist'], ['date', 'Date added'], ['size', 'Size'], ['duration', 'Length']],
  groups: [['name', 'Name'], ['count', 'Number of songs']],
  playlist: [['custom', 'Playlist order'], ['name', 'Name'], ['date', 'Date modified'], ['duration', 'Length']],
  plists: [['name', 'Name'], ['date', 'Last changed'], ['count', 'Number of items']],
};
const SORT_TITLES = { folders: 'Sort folders', videos: 'Sort videos', infolder: 'Sort this folder', recent: 'Sort recent', songs: 'Sort songs', groups: 'Sort', playlist: 'Sort playlist', plists: 'Sort playlists' };
S.sorts = Object.assign({
  folders: { k: 'name', d: 1 }, videos: { k: S.sort || 'name', d: S.sortDir || 1 }, infolder: { k: 'date', d: -1 }, recent: { k: 'played', d: -1 },
  songs: { k: 'name', d: 1 }, groups: { k: 'name', d: 1 }, playlist: { k: 'custom', d: 1 }, plists: { k: 'date', d: -1 },
}, S.sorts || {});
function sortCtx() {
  if (lib.tab === 'recent') return 'recent';
  if (lib.tab === 'playlists') return lib.playlist ? 'playlist' : 'plists';
  if (lib.tab === 'music') return (lib.musicView !== 'songs' && !lib.group && !lib.query) ? 'groups' : 'songs';
  if (lib.tab === 'folders' && !lib.folder && !lib.query) return 'folders';
  if (lib.tab === 'folders' && lib.folder && lib.folder !== PRIV) return 'infolder';   // newest first by default
  return 'videos';
}
const nameOf = x => String(x.title || x.name || '');
const SORT_KEYS = {
  date: x => x.mtime || 0, size: x => x.size || 0, duration: x => x.dur || 0,
  count: x => x.n || 0, played: x => x.played || 0, custom: x => x.order || 0,
};
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' });
function sortBy(arr, ctx) {
  const { k, d } = S.sorts[ctx] || { k: 'name', d: 1 };
  if (k === 'name') return [...arr].sort((a, b) => byName(a, b) * d);
  if (k === 'artist') return [...arr].sort((a, b) => (String(a.artist || '').localeCompare(String(b.artist || ''), undefined, { sensitivity: 'base' }) * d) || byName(a, b));
  const key = SORT_KEYS[k] || SORT_KEYS.date;
  return [...arr].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * d || byName(a, b); });
}

/* ---------- private folder (PIN) ---------- */
const PRIV = '\u0000private';
let privateIds = new Set(store.get('privateIds', []));
let pinRec = store.get('pin', null);                 // { salt, hash }
let privUnlocked = false, pinFails = 0, pinLockUntil = 0;
const savePrivate = () => store.set('privateIds', [...privateIds]);
const privateItems = () => lib.items.filter(i => privateIds.has(i.id));
async function hashPin(pin, salt) {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 2166136261; for (const c of salt + ':' + pin) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return 'f' + (h >>> 0).toString(16);
  }
}
function askPin(title, sub) {
  return new Promise(resolve => {
    let pin = '', done = false;
    const dots = () => [0, 1, 2, 3].map(i => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
    const b = openSheet(title, `<p class="pin-sub">${sub}</p><div class="pindots" id="pinDots">${dots()}</div>
      <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-k="${n}">${n}</button>`).join('')}<span></span><button data-k="0">0</button><button data-k="del" aria-label="Delete"><svg><use href="#i-back"/></svg></button></div>`,
      () => { document.removeEventListener('keydown', onKey, true); if (!done) { done = true; resolve(null); } });
    const press = k => {
      if (k === 'del') pin = pin.slice(0, -1);
      else if (pin.length < 4) pin += k;
      $('#pinDots', b).innerHTML = dots();
      if (pin.length === 4) { done = true; setTimeout(() => { closeSheet(); resolve(pin); }, 120); }
    };
    const onKey = e => {
      if (/^\d$/.test(e.key)) { press(e.key); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'Backspace') { press('del'); e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener('keydown', onKey, true);
    b.onclick = e => { const k = e.target.closest('[data-k]')?.dataset.k; if (k != null) { navigator.vibrate?.(8); press(k); } };
  });
}
async function setNewPin() {
  const a = await askPin('Create a PIN', 'Choose 4 digits to lock your Private folder.');
  if (!a) return false;
  const c = await askPin('Confirm PIN', 'Enter the same 4 digits again.');
  if (!c) return false;
  if (a !== c) { snack('The PINs didn’t match — try again'); return false; }
  const salt = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('');
  pinRec = { salt, hash: await hashPin(a, salt) };
  store.set('pin', pinRec);
  privUnlocked = true;
  snack('PIN set — your Private folder is locked');
  return true;
}
async function verifyPin(title = 'Enter PIN') {
  if (!pinRec) return true;
  let sub = 'Enter your 4-digit PIN.';
  for (;;) {
    if (Date.now() < pinLockUntil) { snack(`Too many wrong tries. Try again in ${Math.ceil((pinLockUntil - Date.now()) / 1000)} s`); return false; }
    const p = await askPin(title, sub);
    if (p == null) return false;
    if (await hashPin(p, pinRec.salt) === pinRec.hash) { pinFails = 0; return true; }
    pinFails++; navigator.vibrate?.([40, 60, 40]);
    if (pinFails >= 5) { pinFails = 0; pinLockUntil = Date.now() + 30000; }
    sub = '<span class="err">Wrong PIN. Try again.</span>';
  }
}
async function openPrivate() {
  if (!pinRec) {
    const ok = await confirmSheet('Private folder',
      'Keep videos and songs out of your library behind a 4-digit PIN. Long-press any file and choose <b>Move to Private</b>.<br><br><span class="muted">Private files are hidden inside Open Player only. Your gallery and file manager can still see them.</span>',
      'Create PIN');
    if (!ok || !(await setNewPin())) return;
  } else if (!privUnlocked) {
    if (!(await verifyPin('Unlock Private'))) return;
    privUnlocked = true;
  }
  lib.tab = 'folders'; lib.folder = PRIV; render(); listEl.scrollTop = 0; hydrateThumbs();
}
function lockPrivate() {
  privUnlocked = false;
  if (lib.folder === PRIV) { lib.folder = null; render(); }
}
async function togglePrivate(it) {
  if (privateIds.has(it.id)) {
    privateIds.delete(it.id); savePrivate(); render(); snack('Moved back to your library'); return;
  }
  if (!pinRec && !(await setNewPin())) return;
  privateIds.add(it.id); savePrivate();
  recents = recents.filter(r => r.id !== it.id); store.set('recents', recents);
  render();
  snack('Moved to Private', 'Undo', () => { privateIds.delete(it.id); savePrivate(); render(); });
}
async function sheetPrivacy() {
  if (!pinRec) {
    if (await setNewPin()) snack('PIN set. Long-press any file → Move to Private', null, null, 5000);
    return;
  }
  const b = openSheet('Private folder',
    opt('open', 'i-lock', 'Open Private folder') +
    opt('change', 'i-edit', 'Change PIN') +
    opt('remove', 'i-trash', 'Turn off PIN<small>Moves all private files back to your library</small>', '', 'danger') +
    `<p class="sheet-note">Forgot your PIN? Clear Open Player’s storage in Android settings to reset it (this also clears your watch history).</p>`);
  b.onclick = async e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'open') return openPrivate();
    if (!(await verifyPin(o === 'change' ? 'Current PIN' : 'Enter PIN'))) return;
    if (o === 'change') { await setNewPin(); return; }
    if (o === 'remove') {
      if (!(await confirmSheet('Turn off PIN?', `${plural(privateIds.size, 'private file')} will appear in your library again.`, 'Turn off', true))) return;
      pinRec = null; store.del('pin'); privateIds.clear(); savePrivate(); privUnlocked = false;
      if (lib.folder === PRIV) lib.folder = null;
      render(); snack('PIN turned off');
    }
  };
}

/* ---------- long-press menu ---------- */
const canFileOps = it => NATIVE && it.native && ((it.nuri && it.nuri.startsWith('content://media')) || (it.npath && allFiles));
function sheetItemMenu(it) {
  if (!it) return;
  const inPriv = privateIds.has(it.id);
  const fileOps = canFileOps(it);
  const playing = !!P.item;
  const b = openSheet(it.title || it.name,
    opt('play', 'i-play', 'Play') +
    (playing && P.item !== it ? opt('next', 'i-next', 'Play next') + opt('queue', 'i-queue', 'Add to end of queue') : '') +
    opt('plist', 'i-plist', 'Add to playlist') +
    (lib.tab === 'playlists' && lib.playlist ? opt('unplist', 'i-close', 'Remove from this playlist') : '') +
    opt('private', 'i-lock', inPriv ? 'Remove from Private' : 'Move to Private') +
    (fileOps ? opt('rename', 'i-edit', 'Rename') : '') +
    (fileOps ? opt('delete', 'i-trash', 'Delete from device', '', 'danger')
      : opt('remove', 'i-trash', 'Remove from list' + (NATIVE ? '' : '<small>The file stays on your device</small>'), '', 'danger')) +
    opt('info', 'i-info', 'Details'));
  b.onclick = async e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'play') return openPlayer(it, visibleQueueFor(it));
    if (o === 'next') return playNext(it);
    if (o === 'queue') return addToQueue(it);
    if (o === 'plist') return sheetAddToPlaylist([it]);
    if (o === 'unplist') {
      const pl = plById(lib.playlist); if (!pl) return;
      const i = pl.items.findIndex(x => x.id === it.id); if (i < 0) return;
      const [removed] = pl.items.splice(i, 1); pl.ts = Date.now(); savePlaylists(); render();
      return snack('Removed from playlist', 'Undo', () => { pl.items.splice(i, 0, removed); savePlaylists(); render(); });
    }
    if (o === 'private') return togglePrivate(it);
    if (o === 'rename') return renameItem(it);
    if (o === 'delete') return deleteItem(it);
    if (o === 'remove') { forgetItem(it, false); render(); return snack('Removed from list'); }
    if (o === 'info') return showInfo(it);
  };
}
function migrateId(oldId, newId) {
  if (oldId === newId) return;
  const it = lib.byId.get(oldId);
  if (it) { lib.byId.delete(oldId); it.id = newId; lib.byId.set(newId, it); }
  if (progress[oldId]) { progress[newId] = progress[oldId]; delete progress[oldId]; store.set('progress', progress); }
  recents.forEach(r => { if (r.id === oldId) r.id = newId; }); store.set('recents', recents);
  if (privateIds.delete(oldId)) { privateIds.add(newId); savePrivate(); }
  playlists.forEach(pl => pl.items.forEach(e => { if (e.id === oldId) e.id = newId; })); savePlaylists();
  if (allMarks[oldId]) { allMarks[newId] = allMarks[oldId]; delete allMarks[oldId]; store.set('bookmarks', allMarks); }
  if (allDelays[oldId]) { allDelays[newId] = allDelays[oldId]; delete allDelays[oldId]; store.set('audioDelays', allDelays); }
}
/* Remove an item from the app's lists. deleted=true also drops its history (the file is gone). */
function forgetItem(it, deleted) {
  lib.items = lib.items.filter(i => i !== it); lib.byId.delete(it.id);
  if (it.picked) { picked = picked.filter(p => 'pk:' + p.uri !== it.id); store.set('picked', picked); }
  if (it.dpath) deskSave();
  if (it.url) URL.revokeObjectURL(it.url);
  if (deleted) {
    delete progress[it.id]; store.set('progress', progress);
    recents = recents.filter(r => r.id !== it.id); store.set('recents', recents);
    if (privateIds.delete(it.id)) savePrivate();
    playlists.forEach(pl => { pl.items = pl.items.filter(e => e.id !== it.id); }); savePlaylists();
    delete allMarks[it.id]; store.set('bookmarks', allMarks);
  }
  const qi = P.queue.indexOf(it);
  if (qi >= 0) {
    if (P.item === it) {
      const active = !P.el.hidden || !$('#mini').hidden;
      if (P.queue.length > 1 && active) {
        P.queue.splice(qi, 1);
        if (P.origQueue) P.origQueue = P.origQueue.filter(x => x !== it);
        P.idx = Math.min(qi, P.queue.length - 1);
        load(P.queue[P.idx]);
      } else {
        P.v.pause(); P.v.removeAttribute('src'); P.v.load(); P.item = null; P.queue = []; P.idx = -1;
        hideMini(); if (!P.el.hidden) closePlayer();
      }
    } else {
      P.queue.splice(qi, 1);
      if (P.origQueue) P.origQueue = P.origQueue.filter(x => x !== it);
      if (qi < P.idx) P.idx--;
    }
    updateQueueUi();
  }
  if (lib.folder && lib.folder !== PRIV && !lib.items.some(i => i.folder === lib.folder)) lib.folder = null;
}
async function deleteItem(it) {
  const ok = await confirmSheet('Delete from device?', `“${esc(it.name)}” will be permanently deleted from your phone. This can’t be undone.`, 'Delete', true);
  if (!ok) return;
  try {
    const r = await ML.deleteMedia({ uri: it.nuri || null, path: it.npath || null });
    if (!r || !r.done) { if (!r?.cancelled) snack('Couldn’t delete this file'); return; }
    forgetItem(it, true); render(); snack('Deleted');
  } catch (e) { snack(e?.message ? `Couldn’t delete: ${e.message}` : 'Couldn’t delete this file'); }
}
async function renameItem(it) {
  const dot = it.name.lastIndexOf('.');
  const ext = dot > 0 ? it.name.slice(dot) : '';
  const base = dot > 0 ? it.name.slice(0, dot) : it.name;
  let name = await askText('Rename', base, { suffix: ext, ok: 'Rename' });
  if (name == null) return;
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  if (!name || name === base) return;
  try {
    const r = await ML.renameMedia({ uri: it.nuri || null, path: it.npath || null, name: name + ext });
    if (!r || !r.done) { if (!r?.cancelled) snack('Couldn’t rename this file'); return; }
    it.name = r.name || name + ext;
    if (it.kind === 'audio' && (!it.title || it.title === base)) it.title = name;
    if (r.path) {
      it.npath = r.path;
      const newSrc = nativeSrc(it.npath, it.nuri);
      if (P.item === it && newSrc !== it.src) {
        // the old path no longer exists: reopen the renamed file at the same spot
        const wasPlaying = !P.v.paused;
        P.pendingStart = P.v.currentTime; P.v.src = newSrc;
        if (wasPlaying) P.v.play().catch(() => {});
      }
      it.src = newSrc;
      if (it.id.startsWith('fs:')) migrateId(it.id, 'fs:' + r.path);
    }
    recents.forEach(x => { if (x.id === it.id) x.name = it.name; }); store.set('recents', recents);
    playlists.forEach(pl => pl.items.forEach(e => { if (e.id === it.id) e.name = it.title || it.name; })); savePlaylists();
    if (P.item === it) $('#vTitle').textContent = it.kind === 'audio' ? (it.title || it.name) : it.name;
    render(); snack('Renamed');
  } catch (e) {
    snack(/exist/i.test(e?.message || '') ? 'A file with that name already exists' : 'Couldn’t rename this file');
  }
}

/* ---------- play queue, play next, shuffle ---------- */
function updateQueueUi() {
  const it = P.item; if (!it) return;
  P.idx = Math.max(0, P.queue.indexOf(it));
  $('#vSub').textContent = P.queue.length > 1 ? `${P.idx + 1} of ${P.queue.length} · ${it.folder || ''}` : (it.folder || '');
  const noPrev = P.idx <= 0, noNext = P.idx >= P.queue.length - 1;
  $('#btnPrev').disabled = noPrev; $('#btnPrev').style.opacity = noPrev ? .35 : 1;
  $('#btnNext').disabled = noNext; $('#btnNext').style.opacity = noNext ? .35 : 1;
  setupMediaSession();
}
function playNext(it) {
  if (!P.item) return openPlayer(it, [it]);
  const at = P.queue.indexOf(it);
  if (at >= 0 && at !== P.idx) { P.queue.splice(at, 1); if (at < P.idx) P.idx--; }
  P.queue.splice(P.idx + 1, 0, it);
  if (P.origQueue && !P.origQueue.includes(it)) P.origQueue.push(it);
  updateQueueUi();
  snack(`“${it.title || it.name}” will play next`);
}
function addToQueue(it) {
  if (!P.item) return openPlayer(it, [it]);
  if (P.queue.includes(it)) return snack('Already in the queue');
  P.queue.push(it);
  if (P.origQueue) P.origQueue.push(it);
  updateQueueUi();
  snack(`Added to queue · ${P.queue.length - P.idx - 1} up next`);
}
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function applyShuffle(on) {
  const cur = P.item;
  if (on) {
    if (!P.origQueue) P.origQueue = P.queue.slice();
    P.queue = cur ? [cur, ...shuffled(P.queue.filter(x => x !== cur))] : shuffled(P.queue);
  } else if (P.origQueue) {
    const extra = P.queue.filter(x => !P.origQueue.includes(x));
    P.queue = P.origQueue.filter(x => P.queue.includes(x)).concat(extra);
    P.origQueue = null;
  }
  updateQueueUi();
}
function setShuffle(on) {
  S.shuffle = on; saveSettings();
  applyShuffle(on);
  ptoast(on ? 'Shuffle on' : 'Shuffle off');
}
function sheetQueue() {
  const draw = () => {
    const upNext = P.queue.length - P.idx - 1;
    return `<div class="qbar">
        <span>${plural(P.queue.length, 'item')}${upNext > 0 ? ` · ${upNext} up next` : ''}</span>
        <button class="chip-toggle${S.shuffle ? ' on' : ''}" data-q="shuffle"><svg><use href="#i-shuffle"/></svg>Shuffle</button>
      </div>
      <div class="qlist">${P.queue.map((it, i) => `
        <div class="qrow${i === P.idx ? ' cur' : ''}">
          <button class="qmain" data-q="jump" data-i="${i}">
            <span class="qn">${i === P.idx ? '<svg><use href="#i-play"/></svg>' : i + 1}</span>
            <span class="qt"><b>${esc(it.title || it.name)}</b><small>${esc(it.kind === 'audio' ? (it.artist || '') : (it.folder || ''))}${it.dur ? ' · ' + fmtTime(it.dur) : ''}</small></span>
          </button>
          <button class="icon-btn sm" data-q="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up"><svg><use href="#i-up"/></svg></button>
          <button class="icon-btn sm" data-q="down" data-i="${i}" ${i === P.queue.length - 1 ? 'disabled' : ''} aria-label="Move down"><svg><use href="#i-down"/></svg></button>
          ${i === P.idx ? '<span class="qgap"></span>' : `<button class="icon-btn sm" data-q="del" data-i="${i}" aria-label="Remove"><svg><use href="#i-close"/></svg></button>`}
        </div>`).join('')}</div>
      ${upNext > 0 ? opt('clear', 'i-trash', 'Clear up next') : ''}
      ${opt('saveq', 'i-plist', 'Save queue as playlist')}`;
  };
  const b = openSheet('Play queue', draw());
  const cur = b.querySelector('.qrow.cur'); if (cur) cur.scrollIntoView({ block: 'center' });
  b.onclick = async e => {
    const q = e.target.closest('[data-q]'), o = e.target.closest('[data-o]')?.dataset.o;
    if (o === 'clear') { P.queue = P.queue.slice(0, P.idx + 1); if (P.origQueue) P.origQueue = P.origQueue.filter(x => P.queue.includes(x)); updateQueueUi(); b.innerHTML = draw(); return; }
    if (o === 'saveq') {
      closeSheet();
      const name = await askText('Save queue as playlist', '', { placeholder: 'Playlist name', ok: 'Save' });
      if (name) { createPlaylist(name, P.queue); snack(`Saved “${name}”`); render(); }
      return;
    }
    if (!q || q.disabled) return;
    const i = +q.dataset.i, a = q.dataset.q;
    if (a === 'shuffle') setShuffle(!S.shuffle);
    if (a === 'jump') { if (i !== P.idx) { P.idx = i; load(P.queue[i]); } closeSheet(); return; }
    if (a === 'up' || a === 'down') {
      const j = a === 'up' ? i - 1 : i + 1;
      [P.queue[i], P.queue[j]] = [P.queue[j], P.queue[i]];
      updateQueueUi();
    }
    if (a === 'del') {
      const [gone] = P.queue.splice(i, 1);
      if (P.origQueue) P.origQueue = P.origQueue.filter(x => x !== gone);
      updateQueueUi();
    }
    const sc = b.scrollTop; b.innerHTML = draw(); sheet.scrollTop = sc;
  };
}

/* ---------- playlists ---------- */
let playlists = store.get('playlists', []);    // [{ id, name, items: [{ id, name, kind }], ts }]
const savePlaylists = () => store.set('playlists', playlists);
const plById = id => playlists.find(p => p.id === id);
const plEntries = pl => pl.items.map((e, i) => ({ e, i, it: lib.byId.get(e.id) })).filter(x => !(x.it && privateIds.has(x.it.id)));
function playlistOrder(pl) {
  const ents = plEntries(pl).map(x => ({ ...x, order: x.i, name: x.it?.name || x.e.name, title: x.it?.title, artist: x.it?.artist, mtime: x.it?.mtime || 0, size: x.it?.size || 0, dur: x.it?.dur || 0 }));
  return sortBy(ents, 'playlist');
}
const plPlayable = pl => playlistOrder(pl).filter(x => x.it).map(x => x.it);
function createPlaylist(name, items = []) {
  const pl = { id: 'pl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, items: [], ts: Date.now() };
  for (const it of items) if (!pl.items.some(e => e.id === it.id)) pl.items.push({ id: it.id, name: it.title || it.name, kind: it.kind });
  playlists.push(pl); savePlaylists();
  return pl;
}
function addToPlaylist(pl, items) {
  let n = 0;
  for (const it of items) if (!pl.items.some(e => e.id === it.id)) { pl.items.push({ id: it.id, name: it.title || it.name, kind: it.kind }); n++; }
  pl.ts = Date.now(); savePlaylists();
  return n;
}
function sheetAddToPlaylist(items) {
  const has = pl => items.every(it => pl.items.some(e => e.id === it.id));
  const b = openSheet('Add to playlist',
    opt('new', 'i-plus', 'New playlist…') +
    playlists.map(pl => opt('pl:' + pl.id, has(pl) ? 'i-check' : 'i-plist', `${esc(pl.name)}<small>${plural(pl.items.length, 'item')}</small>`, has(pl) ? '<span class="val">Added</span>' : '', has(pl) ? 'sel' : '')).join(''));
  b.onclick = async e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'new') {
      const name = await askText('New playlist', '', { placeholder: 'Playlist name', ok: 'Create' });
      if (!name) return;
      createPlaylist(name, items); render();
      return snack(`Added to “${name}”`);
    }
    const pl = plById(o.slice(3)); if (!pl) return;
    const n = addToPlaylist(pl, items); render();
    snack(n ? `Added to “${pl.name}”` : `Already in “${pl.name}”`);
  };
}
function playPlaylist(pl, shuffleIt) {
  const q = plPlayable(pl);
  if (!q.length) return snack('Nothing in this playlist is on this device right now');
  if (shuffleIt && !S.shuffle) { S.shuffle = true; saveSettings(); }
  openPlayer(shuffleIt ? q[Math.floor(Math.random() * q.length)] : q[0], q);
}
function sheetPlaylistMenu(pl) {
  const b = openSheet(pl.name,
    opt('play', 'i-play', 'Play') + opt('shuffle', 'i-shuffle', 'Shuffle play') +
    (P.item ? opt('queue', 'i-queue', 'Add to end of queue') : '') +
    opt('rename', 'i-edit', 'Rename') + opt('delete', 'i-trash', 'Delete playlist<small>Your files are not deleted</small>', '', 'danger'));
  b.onclick = async e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'play') return playPlaylist(pl, false);
    if (o === 'shuffle') return playPlaylist(pl, true);
    if (o === 'queue') {
      const add = plPlayable(pl).filter(it => !P.queue.includes(it));
      P.queue.push(...add); if (P.origQueue) P.origQueue.push(...add); updateQueueUi();
      return snack(`Added ${plural(add.length, 'item')} to the queue`);
    }
    if (o === 'rename') {
      const name = await askText('Rename playlist', pl.name, { ok: 'Rename' });
      if (name) { pl.name = name; pl.ts = Date.now(); savePlaylists(); render(); }
      return;
    }
    if (o === 'delete') {
      const i = playlists.indexOf(pl); playlists.splice(i, 1); savePlaylists();
      if (lib.playlist === pl.id) lib.playlist = null;
      render();
      snack(`Deleted “${pl.name}”`, 'Undo', () => { playlists.splice(i, 0, pl); savePlaylists(); render(); });
    }
  };
}
function sheetPlaylists() {
  const short = s => (s.length > 34 ? s.slice(0, 32) + '…' : s);
  const b = openSheet('Playlists',
    opt('addcur', 'i-plus', `Add this ${P.item.kind === 'audio' ? 'song' : 'video'} to a playlist<small>${esc(short(P.item.title || P.item.name))}</small>`) +
    (P.queue.length > 1 ? opt('saveq', 'i-queue', `Save queue as playlist<small>${plural(P.queue.length, 'item')}</small>`) : '') +
    (playlists.length ? '<div class="group">Play a playlist</div>' + playlists.map(pl => opt('pl:' + pl.id, 'i-plist', `${esc(pl.name)}<small>${plural(pl.items.length, 'item')}</small>`)).join('') : ''));
  b.onclick = async e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'addcur') return sheetAddToPlaylist([P.item]);
    if (o === 'saveq') {
      const name = await askText('Save queue as playlist', '', { placeholder: 'Playlist name', ok: 'Save' });
      if (name) { createPlaylist(name, P.queue); snack(`Saved “${name}”`); render(); }
      return;
    }
    const pl = plById(o.slice(3)); if (pl) playPlaylist(pl, S.shuffle);
  };
}

/* ---------- frame preview while scrubbing ---------- */
const PV = { v: $('#pvVideo'), src: null, want: null, busy: false, on: false };
function pvReset() { PV.src = null; PV.want = null; PV.busy = false; try { PV.v.removeAttribute('src'); PV.v.load(); } catch {} }
function pvEnabled() {
  const it = P.item;
  return !!(it && it.kind !== 'audio' && !it.remote && S.framePreview !== false && P.v.videoWidth && PV.failed !== it.id);
}
function pvShow(container, t) {
  if (!pvEnabled()) { $('#seekPrev').hidden = true; $('#hudPrev').hidden = true; return; }
  const src = P.v.currentSrc || P.v.src;
  if (PV.src !== src) { PV.src = src; PV.busy = false; PV.v.src = src; }
  const host = container === 'hud' ? $('#hudPrev') : $('#seekPrev');
  const other = container === 'hud' ? $('#seekPrev') : $('#hudPrev');
  if (PV.v.parentElement !== host) host.appendChild(PV.v);
  other.hidden = true; host.hidden = false;
  const r = P.v.videoWidth / P.v.videoHeight || 16 / 9;
  const w = r >= 1 ? 168 : Math.round(110 * r);
  host.style.width = w + 'px'; host.style.height = Math.round(w / r) + 'px';
  PV.want = t;
  if (!PV.busy) pvGo();
}
function pvGo() {
  if (PV.want == null) return;
  const t = PV.want; PV.want = null;
  if (PV.v.readyState < 1) { PV.want = t; PV.v.addEventListener('loadedmetadata', pvGo, { once: true }); return; }
  PV.busy = true;
  try { PV.v.currentTime = t; } catch { PV.busy = false; }
}
PV.v.addEventListener('seeked', () => { PV.busy = false; if (PV.want != null) pvGo(); });
PV.v.addEventListener('error', () => { PV.busy = false; if (P.item) PV.failed = P.item.id; pvHide(); });   // format the preview can't decode
function pvHide() { $('#seekPrev').hidden = true; $('#hudPrev').hidden = true; }

/* ---------- subtitle character encodings ---------- */
/* SUBENC-START */
const SUB_ENCODINGS = [
  ['auto', 'Automatic'], ['utf-8', 'Unicode (UTF-8)'], ['utf-16le', 'Unicode (UTF-16 LE)'], ['utf-16be', 'Unicode (UTF-16 BE)'],
  ['windows-1252', 'Western European (Windows-1252)'], ['windows-1250', 'Central European (Windows-1250)'],
  ['windows-1251', 'Cyrillic (Windows-1251)'], ['koi8-r', 'Cyrillic (KOI8-R)'], ['windows-1253', 'Greek (Windows-1253)'],
  ['windows-1254', 'Turkish (Windows-1254)'], ['windows-1255', 'Hebrew (Windows-1255)'], ['windows-1256', 'Arabic (Windows-1256)'],
  ['windows-874', 'Thai (Windows-874)'], ['windows-1258', 'Vietnamese (Windows-1258)'],
  ['gb18030', 'Chinese Simplified (GBK)'], ['big5', 'Chinese Traditional (Big5)'],
  ['shift_jis', 'Japanese (Shift-JIS)'], ['euc-jp', 'Japanese (EUC-JP)'], ['euc-kr', 'Korean (EUC-KR)'],
];
const encLabel = e => (SUB_ENCODINGS.find(x => x[0] === e) || [e, e])[1];
const LEGACY_ENC = [
  ['windows-1252', 'latin'], ['windows-1250', 'latin'], ['windows-1254', 'latin'], ['windows-1258', 'latin'],
  ['windows-1251', 'cyr'], ['koi8-r', 'cyr'], ['windows-1253', 'greek'], ['windows-1255', 'hebrew'],
  ['windows-1256', 'arabic'], ['windows-874', 'thai'],
  ['gb18030', 'zhs'], ['big5', 'zht'], ['shift_jis', 'ja'], ['euc-jp', 'ja'], ['euc-kr', 'ko'],
];
const LANG_ENC = {
  ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', sr: 'windows-1251', mk: 'windows-1251', be: 'windows-1251',
  el: 'windows-1253', he: 'windows-1255', iw: 'windows-1255', ar: 'windows-1256', fa: 'windows-1256', ur: 'windows-1256',
  tr: 'windows-1254', az: 'windows-1254', th: 'windows-874', vi: 'windows-1258',
  pl: 'windows-1250', cs: 'windows-1250', sk: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250', hr: 'windows-1250', sl: 'windows-1250', bs: 'windows-1250',
  ja: 'shift_jis', ko: 'euc-kr', zh: 'gb18030',
};
function langHints() {
  const out = new Set();
  const langs = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language])) || [];
  for (const l of langs) {
    const L = String(l || '').toLowerCase();
    if (/^zh-(tw|hk|mo)|hant/.test(L)) { out.add('big5'); continue; }
    const enc = LANG_ENC[L.split('-')[0]]; if (enc) out.add(enc);
  }
  return out;
}
// Very common characters, used to tell real Chinese text from bytes decoded the wrong way.
const ZHS = new Set('的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东政海口使教西再平真听世气信北少关并内加化由却代军产入先山五太水万市眼体别处总才场师书比住员九笑性通目华报立马命张活难神数件安表原车白应路期叫死常提感金何更反合放做系计或司利受光王果亲界及今京务制解各任至清物台象记边共风战干接它许八特觉望直服毛林题建南度统色字请交爱让认算论百吃义科怎元社术结六功指思非流每青管夫连远资队跟带花快条院变联言权往展该领传近留红治决周保达办运武半候七必城父强步完革深区即求品士转量空甚众技轻程告江语英基派满式李息写呢识极令黄德收脸钱党倒未持取设始版双历越史商千片容研像找友孩站广改议形委早房音火际则首单跑吗啊哪谁吧');
const ZHT = new Set('的一是不了人我在有他這中大來上國個到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明其種聲全工己話兒者向情部正名定女問力機給等幾很業最間新什打便位因重被走電四第門相次東政海口使教西再平真聽世氣信北少關並內加化由卻代軍產入先山五太水萬市眼體別處總才場師書比住員九笑性通目華報立馬命張活難神數件安表原車白應路期叫死常提感金何更反合放做系計或司利受光王果親界及今京務制解各任至清物台象記邊共風戰干接它許八特覺望直服毛林題建南度統色字請交愛讓認算論百吃義科怎元社術結六功指思非流每青管夫連遠資隊跟帶花快條院變聯言權往展該領傳近留紅治決週保達辦運武半候七必城父強步完革深區即求品士轉量空甚眾技輕程告江語英基派滿式李息寫呢識極令黃德收臉錢黨倒未持取設始版雙歷越史商千片容研像找友孩站廣改議形委早房音火際則首單跑嗎啊哪誰吧');
// Letters that real text in each script always contains, but wrongly decoded bytes rarely produce.
const CYR_MARKERS = new Set('яЯјЈљЉњЊћЋџЏђЂіІїЇєЄ');
const GREEK_MARKERS = new Set('άέήίόύώΆΈΉΊΌΎΏ');
const ARABIC_MARKERS = new Set('ال');
const SCRIPT_RX = {
  latin: /[À-ɏḀ-ỿ]/, cyr: /[Ѐ-ӿ]/, greek: /[Ͱ-Ͽ]/, hebrew: /[֐-׿]/,
  arabic: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/, thai: /[฀-๿]/,
  kana: /[぀-ヿ]/, han: /[㐀-䶿一-鿿]/, ko: /[가-힯ᄀ-ᇿ㄰-㆏]/,
};
const NEUTRAL_RX = /[ -¿×÷‐-⁯€™　-〿！-／：-＠]/;
function scoreText(text, script) {
  let nonAscii = 0, inScript = 0, letters = 0, hiLetters = 0, lower = 0, cased = 0, bad = 0, han = 0, common = 0, kana = 0, markers = 0, markers2 = 0;
  let prev = 0, comb = 0, orphan = 0, lead = 0, leadBad = 0;   // Thai spelling rules
  let prevLower = false, midCaps = 0;                            // e.g. "кЬнейт": a capital inside a word
  const cps = script === 'thai' ? [...text].map(x => x.codePointAt(0)) : null;
  let idx = -1;
  const rx = SCRIPT_RX[script === 'zhs' || script === 'zht' ? 'han' : script === 'ja' ? 'kana' : script];
  for (const ch of text) {
    const c = ch.codePointAt(0); idx++;
    if (script === 'thai') {
      const isComb = c === 0x0E31 || (c >= 0x0E34 && c <= 0x0E3A) || (c >= 0x0E47 && c <= 0x0E4E);
      const prevBase = (prev >= 0x0E01 && prev <= 0x0E2E) || prev === 0x0E31 || (prev >= 0x0E34 && prev <= 0x0E3A) || (prev >= 0x0E47 && prev <= 0x0E4E);
      if (isComb) { comb++; if (!prevBase) orphan++; }
      if (c >= 0x0E40 && c <= 0x0E44) { lead++; const nx = cps[idx + 1] || 0; if (!(nx >= 0x0E01 && nx <= 0x0E2E)) leadBad++; }
      prev = c;
    } else if (script === 'cyr' || script === 'greek') {
      const lo = ch.toLowerCase(), up = ch.toUpperCase();
      if (lo !== up) { if (ch === up && prevLower) midCaps++; prevLower = ch === lo; } else prevLower = false;
    }
    if (c < 128) { const l = c | 32; if (l >= 97 && l <= 122) letters++; continue; }
    if ((c >= 0x80 && c < 0xA0) || c === 0xFFFD || (c >= 0xE000 && c <= 0xF8FF)) { nonAscii++; bad++; continue; }
    if (NEUTRAL_RX.test(ch)) continue;
    nonAscii++;
    const up = ch.toUpperCase(), lo = ch.toLowerCase();
    if (up !== lo) { cased++; if (ch === lo) lower++; letters++; hiLetters++; }
    else if (/\p{L}/u.test(ch)) { letters++; hiLetters++; }
    if (rx && rx.test(ch)) inScript++;
    if (script === 'zhs' || script === 'zht' || script === 'ja') {
      if (SCRIPT_RX.han.test(ch)) { han++; if ((script === 'zht' ? ZHT : ZHS).has(ch)) common++; }
      if (SCRIPT_RX.kana.test(ch)) kana++;
    }
    if (script === 'cyr' && CYR_MARKERS.has(ch)) markers++;
    else if (script === 'greek' && GREEK_MARKERS.has(ch)) markers++;
    else if (script === 'arabic' && ARABIC_MARKERS.has(ch)) markers++;
    else if (script === 'thai') { if (c >= 0x0E01 && c <= 0x0E2E) markers++; else if (c >= 0x0E48 && c <= 0x0E4B) markers2++; }
  }
  if (!nonAscii) return 0.5;
  const frac = inScript / nonAscii, hiRatio = letters ? hiLetters / letters : 0;
  const caseF = 0.5 + 0.5 * (cased ? lower / cased : 1);
  let s;
  const enough = inScript >= 100;
  const implausible = enough && (
    ((script === 'cyr' || script === 'greek') && midCaps / inScript > 0.01) ||
    (script === 'cyr' && markers / inScript < 0.008) ||
    (script === 'greek' && markers / inScript < 0.02) ||
    (script === 'arabic' && markers / inScript < 0.10) ||
    (script === 'thai' && (markers / inScript < 0.25 || markers2 / inScript < 0.01 || (comb >= 20 && orphan / comb > 0.1) || (lead >= 10 && leadBad / lead > 0.15))));
  const plaus = implausible ? 0.35 : 1;
  if (script === 'latin') s = frac * (1 - hiRatio) * caseF;
  else if (script === 'cyr' || script === 'greek') s = frac * Math.min(1, hiRatio * 1.3) * caseF * plaus;
  else if (script === 'zhs' || script === 'zht') s = (han / nonAscii) * Math.min(1, (common / Math.max(1, han)) / 0.3);
  else if (script === 'ja') s = ((kana + han * 0.5) / nonAscii) * (kana ? 1 : 0.4);
  else s = frac * Math.min(1, hiRatio * 1.3) * plaus;
  return s - bad / nonAscii;
}
function detectEncoding(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return 'utf-8';
  if (b[0] === 0xFF && b[1] === 0xFE) return 'utf-16le';
  if (b[0] === 0xFE && b[1] === 0xFF) return 'utf-16be';
  const n = Math.min(b.length, 4000);
  let zEven = 0, zOdd = 0;
  for (let i = 0; i < n; i++) if (!b[i]) (i % 2 ? zOdd++ : zEven++);
  if (n > 20 && zOdd > n * 0.2 && zEven < n * 0.02) return 'utf-16le';
  if (n > 20 && zEven > n * 0.2 && zOdd < n * 0.02) return 'utf-16be';
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); return 'utf-8'; } catch {}
  // Legacy code pages: score each candidate on how much the result looks like real text.
  let end = Math.min(b.length, 96 * 1024);
  if (end < b.length) { const nl = b.lastIndexOf(0x0A, end); if (nl > 0) end = nl; }
  const sample = b.subarray(0, end);
  const hints = langHints();
  let best = 'windows-1252', bestScore = -Infinity;
  for (const [enc, script] of LEGACY_ENC) {
    let text;
    try { text = new TextDecoder(enc, { fatal: true }).decode(sample); } catch { continue; }
    const s = scoreText(text, script) + (hints.has(enc) ? 0.04 : 0);   // phone language only breaks near-ties
    if (s > bestScore + 1e-9) { bestScore = s; best = enc; }
  }
  return best;
}
/* SUBENC-END */
function decodeSubs() {
  if (!P.subBuf) return;
  const enc = P.subEncForced || detectEncoding(P.subBuf);
  P.subEnc = enc;
  let text;
  try { text = new TextDecoder(enc).decode(P.subBuf); } catch { text = new TextDecoder('utf-8').decode(P.subBuf); }
  P.cues = parseSubs(text); P.subOn = true; lastSubText = null; renderSub();
}
function sheetSubEncoding() {
  const cur = P.subEncForced || 'auto';
  const b = openSheet('Character encoding',
    `<p class="sheet-note">If subtitles show strange symbols or question marks, pick the language they’re written in.</p>` +
    SUB_ENCODINGS.map(([k, l]) => opt('e:' + k, k === cur ? 'i-check' : 'i-text',
      l + (k === 'auto' && P.subEnc ? `<small>Detected: ${esc(encLabel(P.subEnc))}</small>` : ''), '', k === cur ? 'sel' : '')).join(''));
  b.onclick = e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    const k = o.slice(2);
    P.subEncForced = k === 'auto' ? null : k;
    decodeSubs();
    closeSheet();
    ptoast(P.cues.length ? `Subtitles: ${encLabel(P.subEnc)}` : 'No subtitle lines found with that encoding');
  };
}

/* ---------- headphones: pause on unplug, resume on reconnect ---------- */
function onHeadphones(ev) {
  const connected = !!ev?.connected;
  if (!connected) {
    if (S.hpPause && P.item && !P.v.paused) {
      P.v.pause(); P.unplugAt = Date.now();
      (P.el.hidden ? snack : ptoast)('Paused — headphones disconnected');
    }
  } else if (S.hpResume && P.unplugAt && Date.now() - P.unplugAt < 15 * 60e3 && P.item && P.v.paused) {
    P.unplugAt = 0;
    P.v.play().catch(() => {});
    (P.el.hidden ? snack : ptoast)('Resumed — headphones connected');
  }
}
if (NATIVE) { try { ML.addListener('headphones', onHeadphones); } catch {} }

/* ---------- seek step shown on the skip buttons ---------- */
function applySeekStepIcons() { $$('#i-rew text, #i-fwd text').forEach(t => (t.textContent = S.seekStep)); }
applySeekStepIcons();
const gestureSens = () => ({ slow: 0.55, normal: 1, fast: 1.7 }[S.gestureSens] || 1);

/* ---------------- boot ---------------- */
render();
setupSW();
importShared();
(async () => {
  if (DESK) {
    await deskRestore(); libLoaded();
    DESK.onOpenFiles(files => { const its = deskAddPaths(files.map(p => ({ path: p })), 'Opened files'); if (its[0]) { if (!P.el.hidden) closePlayer(true); openPlayer(its[0], its.filter(i => i.kind === its[0].kind)); } });
  }
  if (NATIVE) {
    await loadAppInfo();
    await refreshAccess();
    if (hasAccess('video') || hasAccess('audio')) { S.onboarded = true; saveSettings(); scanDevice(true); }
    await restorePicked();
    try { const r = await ML.getLaunchFile(); if (r.file) handleOpenFile(r.file); } catch {}
  }
  if (!S.onboarded && (NATIVE || IS_ANDROID_BROWSER)) showOnboarding();
})();
if (store.get('justRefreshed', false)) { store.del('justRefreshed'); setTimeout(() => snack('App cache refreshed — you’re on the latest files'), 300); }
/* Android: real heights of the status bar and navigation buttons (CSS env() is often 0 in the app) */
async function syncInsets() {
  if (!NATIVE || !ML.getInsets) return;
  try {
    const r = await ML.getInsets();
    if (r.bottom >= 0) document.documentElement.style.setProperty('--nav-b', r.bottom + 'px');
    if (r.top >= 0) document.documentElement.style.setProperty('--nav-t', r.top + 'px');
  } catch {}
}
syncInsets(); setTimeout(syncInsets, 800);
window.addEventListener('resize', () => setTimeout(syncInsets, 150));
window.OpenPlayer = { lib, P, S, version: APP_VERSION, get playlists() { return playlists; }, privateIds, detectEncoding, progress };

/* =================================================================
   v1.6 — engine choice & tracks, night audio, resume after moves,
   storage cleaner, kids mode
   ================================================================= */

/* ---------- which engine plays this file ---------- */
async function chooseEngine(item) {
  if (!P.nv || item.remote || !item.native || (!item.npath && !item.nuri)) return 'web';
  if (P.engineFor[item.id]) return P.engineFor[item.id];
  if (item.kind === 'audio') return 'web';            // music keeps playing in the background on the web engine
  if (S.engine === 'native') return 'native';
  if (S.engine === 'web') return 'web';
  if (item.engineProbe) return item.engineProbe.needsNative ? 'native' : 'web';
  try {
    item.engineProbe = await NP.probe({ path: item.npath || null, uri: item.nuri || null, name: item.name });
    return item.engineProbe.needsNative ? 'native' : 'web';
  } catch { return 'web'; }
}
function setEngine(kind) {
  const native = kind === 'native' && !!P.nv;
  if (native && !P.v.isNative) {
    const w = P.webV; w.pause(); w.removeAttribute('src'); try { w.load(); } catch {}
    P.v = P.nv;
  } else if (!native && P.v.isNative) {
    P.nv.close(); P.v = P.webV;
  }
  if (!P.el.hidden) document.documentElement.classList.toggle('native-engine', native);   // in the mini bar the library stays visible
  P.el.classList.toggle('native-engine', native);
  if (!P.el.hidden) document.documentElement.style.background = native ? 'transparent' : '#000';
}
function switchEngine(kind, why) {
  if (!P.item) return;
  P.engineFor[P.item.id] = kind;
  if (P.item.dpath) P.deskMode[P.item.id] = kind === 'native' ? 'hls' : 'direct';
  const t = P.v.currentTime || 0;
  if (why) ptoast(why);
  load(P.item, t > 1 ? t : undefined);
}
let nativeLayoutQueued = false;
function syncNativeLayout() {
  if (!P.v.isNative || nativeLayoutQueued) return;
  nativeLayoutQueued = true;
  requestAnimationFrame(() => {
    nativeLayoutQueued = false;
    NP.setLayout({ mode: ASPECTS[P.aspect][0], zoom: P.zoom, mirror: !!P.adj?.mirror }).catch(() => {});
  });
}

/* ---------- audio languages & embedded subtitles ---------- */
const CODEC_NAMES = {
  'audio/ac3': 'Dolby Digital (AC3)', 'audio/eac3': 'Dolby Digital Plus', 'audio/eac3-joc': 'Dolby Atmos', 'audio/true-hd': 'Dolby TrueHD',
  'audio/vnd.dts': 'DTS', 'audio/vnd.dts.hd': 'DTS-HD', 'audio/mp4a-latm': 'AAC', 'audio/mpeg': 'MP3', 'audio/opus': 'Opus',
  'audio/vorbis': 'Vorbis', 'audio/flac': 'FLAC', 'audio/raw': 'PCM',
  'text/x-ssa': 'ASS', 'application/x-subrip': 'SRT', 'text/vtt': 'WebVTT', 'application/pgs': 'PGS (image)',
  'application/vobsub': 'VobSub (image)',
  ac3: 'Dolby Digital (AC3)', eac3: 'Dolby Digital Plus', truehd: 'Dolby TrueHD', dts: 'DTS', aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC',
  subrip: 'SRT', ass: 'ASS', ssa: 'SSA', mov_text: 'Timed text', webvtt: 'WebVTT', 'application/dvbsubs': 'DVB (image)', 'application/ttml+xml': 'TTML', 'application/x-quicktime-tx3g': 'Timed text',
};
const langName = code => {
  if (!code || code === 'und') return '';
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) || code; } catch { return code; }
};
function trackLabel(t, i) {
  const ch = t.channels > 0 ? ({ 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' }[t.channels] || t.channels + ' ch') : '';
  const name = t.label || langName(t.language) || `Track ${i + 1}`;
  const bits = [CODEC_NAMES[t.codec] || (t.codec || '').replace(/^\w+\//, '').toUpperCase(), t.type === 'audio' ? ch : '', t.forced ? 'Forced' : ''].filter(Boolean);
  return { name, info: bits.join(' · ') };
}
const nativeTracks = type => (P.v.isNative ? P.v.tracks : (P.item?.dpath && P.deskTracks) || []).filter(t => t.type === type);
function onNativeTracks() {
  const audio = nativeTracks('audio'), text = nativeTracks('text');
  const it = P.item; if (!it || P.tracksHinted === it.id) return;
  if (audio.length > 1 || text.length) {
    P.tracksHinted = it.id;
    const bits = [audio.length > 1 && plural(audio.length, 'audio language'), text.length && plural(text.length, 'subtitle track')].filter(Boolean);
    ptoast(`${bits.join(' and ')} · choose in ⋮ or CC`, null, null, 3500);
  }
}
function sheetAudioTracks() {
  const draw = () => {
    const list = nativeTracks('audio');
    return list.length ? list.map((t, i) => {
      const l = trackLabel(t, i);
      return opt(`at:${t.group}:${t.track}`, t.selected ? 'i-check' : 'i-vol', `${esc(l.name)}<small>${esc(l.info)}${t.supported ? '' : ' · may not play'}</small>`, '', t.selected ? 'sel' : '');
    }).join('') : `<p class="sheet-note">This file has a single audio track.</p>`;
  };
  const b = openSheet('Audio track', draw());
  b.onclick = e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    const [, g, t] = o.split(':');
    closeSheet();
    if (P.item?.dpath) return deskAudio(+g);
    NP.selectTrack({ type: 'audio', group: +g, track: +t }).catch(() => ptoast('Couldn’t switch audio track'));
  };
}
function embeddedSubsHtml() {
  const list = nativeTracks('text');
  if (!list.length) return '';
  const anyOn = list.some(t => t.selected);
  return `<div class="group">Subtitles in this file</div>` +
    opt('st:off', anyOn ? 'i-cc' : 'i-check', 'Off', '', anyOn ? '' : 'sel') +
    list.map((t, i) => {
      const l = trackLabel(t, i);
      return opt(`st:${t.group}:${t.track}`, t.selected ? 'i-check' : 'i-cc', `${esc(l.name)}<small>${esc(l.info)}</small>`, '', t.selected ? 'sel' : '');
    }).join('');
}
function pickEmbeddedSub(o) {
  if (P.item?.dpath) return deskSub(o);
  if (o === 'st:off') return NP.selectTrack({ type: 'text', off: true }).catch(() => {});
  const [, g, t] = o.split(':');
  if (P.cues.length) P.subOn = false;    // one subtitle at a time
  return NP.selectTrack({ type: 'text', group: +g, track: +t }).catch(() => ptoast('Couldn’t show those subtitles'));
}

/* ---------- night audio mode (web engine part; the native engine uses DynamicsProcessing) ---------- */
S.night ??= false;
function toggleNight() {
  S.night = !S.night; saveSettings();
  if (S.night && !P.v.isNative && !ensureBoost()) { S.night = false; saveSettings(); return ptoast('Night mode isn’t available for this stream'); }
  applyAudioFx();
  ptoast(S.night ? 'Night mode on · loud scenes softer, dialogue clearer' : 'Night mode off');
}

/* ---------- watch history follows files that were moved or renamed ---------- */
let fpIndex = store.get('fpIndex', {});        // fingerprint (exact byte size + kind) → last known id
const fpOf = it => (it && it.size > 1e6) ? `${it.kind === 'audio' ? 'a' : 'v'}${it.size}` : null;
function rememberFp(it) {
  const fp = fpOf(it);
  if (fp && fpIndex[fp] !== it.id) { fpIndex[fp] = it.id; store.set('fpIndex', fpIndex); }
}
function adoptMovedHistory(items) {
  let n = 0;
  for (const it of items) {
    if (progress[it.id]) { rememberFp(it); continue; }
    const fp = fpOf(it), old = fp && fpIndex[fp];
    if (!old || old === it.id || !progress[old] || lib.byId.get(old)) continue;   // the old file is still there: not a move
    migrateId(old, it.id);
    fpIndex[fp] = it.id; n++;
  }
  if (n) { store.set('fpIndex', fpIndex); render(); }
  return n;
}

/* ---------- storage cleaner (Android app) ---------- */
function cleanerCandidates() {
  const vids = lib.items.filter(i => i.kind !== 'audio' && !privateIds.has(i.id) && i.size > 0 && canFileOps(i));
  const bySize = new Map();
  for (const v of vids) { if (!bySize.has(v.size)) bySize.set(v.size, []); bySize.get(v.size).push(v); }
  const dupes = [];
  for (const g of bySize.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
    for (const extra of sorted.slice(1)) dupes.push({ it: extra, why: `Same file as “${sorted[0].name}” in ${sorted[0].folder}` });
  }
  const taken = new Set(dupes.map(d => d.it.id));
  const watched = vids.filter(v => { const p = progress[v.id]; return !taken.has(v.id) && p && p.d && p.t / p.d >= 0.9 && v.size >= 50e6; })
    .sort((a, b) => b.size - a.size).map(it => ({ it, why: `Watched · ${it.folder}` }));
  watched.forEach(w => taken.add(w.it.id));
  const big = vids.filter(v => !taken.has(v.id)).sort((a, b) => b.size - a.size).slice(0, 12)
    .map(it => ({ it, why: `${it.folder}${progress[it.id] ? ' · started' : ' · not watched yet'}` }));
  return { dupes, watched, big };
}
function sheetCleaner() {
  if (!NATIVE) return snack('The storage cleaner is part of the Android app', 'Get it', () => window.open(ANDROID_APK_URL, '_blank', 'noopener'), 6000);
  const c = cleanerCandidates();
  const sel = new Set([...c.dupes, ...c.watched].map(x => x.it.id));
  const all = [...c.dupes, ...c.watched, ...c.big];
  const byId = new Map(all.map(x => [x.it.id, x.it]));
  const section = (title, note, rows) => rows.length ? `<div class="group">${title}</div>${note ? `<p class="sheet-note" style="padding-top:0">${note}</p>` : ''}` +
    rows.map(({ it, why }) => `<label class="crow"><input type="checkbox" data-c="${esc(it.id)}" ${sel.has(it.id) ? 'checked' : ''}>
      <span class="cmeta"><b>${esc(it.name)}</b><small>${esc(why)}</small></span><span class="csize">${fmtSize(it.size)}</span></label>`).join('') : '';
  const total = () => [...sel].reduce((a, id) => a + (byId.get(id)?.size || 0), 0);
  const footer = () => `<div class="cfoot"><button class="btn danger" data-a="del" ${sel.size ? '' : 'disabled'}>Delete ${plural(sel.size, 'file')} · free ${fmtSize(total()) || '0 B'}</button></div>`;
  const body = all.length
    ? section('Duplicate copies', 'The same video saved more than once. The oldest copy is kept.', c.dupes) +
      section('Already watched', 'Big videos you’ve watched to the end.', c.watched) +
      section('Largest videos', '', c.big) + footer()
    : `<p class="sheet-note">Nothing to clean up — no duplicates or big watched videos found.</p>`;
  const b = openSheet('Clean up storage', body);
  b.onchange = e => {
    const cb = e.target.closest('[data-c]'); if (!cb) return;
    cb.checked ? sel.add(cb.dataset.c) : sel.delete(cb.dataset.c);
    const f = $('.cfoot', b); if (f) f.outerHTML = footer();
  };
  b.onclick = async e => {
    if (!e.target.closest('[data-a="del"]')) return;
    const items = [...sel].map(id => byId.get(id)).filter(Boolean);
    closeSheet();
    if (!(await confirmSheet('Delete these files?', `${plural(items.length, 'file')} (${fmtSize(items.reduce((a, i) => a + i.size, 0))}) will be permanently deleted from your phone.`, 'Delete', true))) return;
    deleteMany(items);
  };
}
async function deleteMany(items) {
  const freed = items.reduce((a, i) => a + (i.size || 0), 0);
  let done = [];
  try {
    const r = await ML.deleteMany({ items: items.map(i => ({ uri: i.nuri || null, path: i.npath || null })) });
    if (r?.done) done = items;
    else if (r?.cancelled) return;
  } catch {
    for (const it of items) {                       // older Android: one confirmation per file
      try { const r = await ML.deleteMedia({ uri: it.nuri || null, path: it.npath || null }); if (r?.done) done.push(it); else if (r?.cancelled) break; } catch {}
    }
  }
  done.forEach(it => forgetItem(it, true));
  render();
  snack(done.length ? `Deleted ${plural(done.length, 'file')} · freed ${fmtSize(done === items ? freed : done.reduce((a, i) => a + (i.size || 0), 0))}` : 'Nothing was deleted');
}

/* ---------- kids mode ---------- */
S.kids = Object.assign({ on: false, folders: [], limitMin: 0, day: '', used: 0 }, S.kids || {});
const kidsAllowed = it => !S.kids?.on || !S.kids.folders.length || S.kids.folders.includes(it.folder);
function kidsLeftMin() {
  const k = S.kids; if (!k.limitMin) return null;
  if (k.day !== new Date().toDateString()) return k.limitMin;
  return Math.max(0, Math.ceil(k.limitMin - k.used / 60));
}
function applyKidsUi() {
  const on = !!S.kids.on;
  document.body.classList.toggle('kids', on);
  $('#btnKids').hidden = !on;
  $('#kidsBar').hidden = !on;
  if (on) {
    const left = kidsLeftMin();
    $('#kidsLeft').textContent = left == null ? 'No time limit' : left > 0 ? `${left} min left today` : 'Time’s up for today';
    if (!['folders', 'videos'].includes(lib.tab)) lib.tab = 'folders';
    if (lib.folder === PRIV) lib.folder = null;
  }
}
async function sheetKidsSetup() {
  if (!pinRec) {
    const ok = await confirmSheet('Kids mode', 'Kids mode needs a 4-digit PIN so only a grown-up can turn it off. Create one now?', 'Create PIN');
    if (!ok || !(await setNewPin())) return;
  } else if (!(await verifyPin('Enter PIN'))) return;
  const folders = [...new Set(lib.items.filter(i => i.kind !== 'audio' && !privateIds.has(i.id)).map(i => i.folder))].sort();
  const chosen = new Set(S.kids.folders.filter(f => folders.includes(f)));
  const draw = () => `
    <p class="sheet-note">Children see only the folders you pick, can’t delete or change anything, and need your PIN to leave.</p>
    <div class="group">Folders they can watch</div>
    ${folders.length ? folders.map(f => `<label class="crow"><input type="checkbox" data-f="${esc(f)}" ${chosen.has(f) ? 'checked' : ''}><span class="cmeta"><b>${esc(f)}</b><small>${plural(lib.items.filter(i => i.folder === f && i.kind !== 'audio').length, 'video')}</small></span></label>`).join('')
      : '<p class="sheet-note">Add some videos first.</p>'}
    <div class="group">Daily time limit</div>
    <div class="seg kseg" data-k="limit">${[[0, 'None'], [30, '30 min'], [60, '1 hour'], [120, '2 hours']].map(([v, l]) => `<button data-v="${v}" class="${S.kids.limitMin === v ? 'sel' : ''}">${l}</button>`).join('')}</div>
    <div class="sheet-actions"><button class="btn primary" data-a="start" ${chosen.size ? '' : 'disabled'}>Start kids mode</button></div>`;
  const b = openSheet('Kids mode', draw());
  b.onchange = e => { const cb = e.target.closest('[data-f]'); if (!cb) return; cb.checked ? chosen.add(cb.dataset.f) : chosen.delete(cb.dataset.f); $('[data-a="start"]', b).disabled = !chosen.size; };
  b.onclick = e => {
    const v = e.target.closest('[data-k="limit"] [data-v]');
    if (v) { S.kids.limitMin = +v.dataset.v; b.innerHTML = draw(); return; }
    if (!e.target.closest('[data-a="start"]')) return;
    Object.assign(S.kids, { on: true, folders: [...chosen] });
    if (S.kids.day !== new Date().toDateString()) Object.assign(S.kids, { day: new Date().toDateString(), used: 0 });
    saveSettings(); closeSheet();
    privUnlocked = false; lib.folder = null; lib.tab = 'folders';
    applyKidsUi(); render();
    snack('Kids mode is on. Tap the lock at the top to leave.', null, null, 5000);
  };
}
async function exitKids() {
  if (!(await verifyPin('Exit kids mode'))) return;
  S.kids.on = false; saveSettings(); applyKidsUi(); render();
  snack('Kids mode is off');
}
function kidsTick() {
  const k = S.kids;
  if (!k.on || !k.limitMin || P.v.paused) { P.kidsLast = 0; return; }
  const now = performance.now(), today = new Date().toDateString();
  if (k.day !== today) { k.day = today; k.used = 0; }
  if (P.kidsLast) k.used += Math.min(2, (now - P.kidsLast) / 1000);
  P.kidsLast = now;
  if (now - (P.kidsSaved || 0) > 10000) { P.kidsSaved = now; saveSettings(); applyKidsUi(); }
  if (k.used >= k.limitMin * 60) { P.v.pause(); P.kidsLast = 0; saveSettings(); kidsTimeUp(); }
}
function kidsTimeUp() {
  if (!sheet.hidden && $('#sheetTitle').textContent === 'Time’s up') return;
  const b = openSheet('Time’s up', `<p class="sheet-note">That’s all the watching for today. Ask a grown-up if you need more time.</p>` +
    opt('more', 'i-timer', 'Add 15 minutes<small>Needs the PIN</small>') + opt('exit', 'i-lock', 'Exit kids mode<small>Needs the PIN</small>'));
  b.onclick = async e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'exit') return exitKids();
    if (await verifyPin('Add 15 minutes')) { S.kids.used = Math.max(0, S.kids.used - 15 * 60); saveSettings(); applyKidsUi(); P.v.play().catch(() => {}); }
  };
}
$('#btnKids').onclick = exitKids;

/* automatic fallback: the standard engine sometimes plays the picture but no sound (AC3/DTS) */
/* ---------- jumping (seek) watchdog ----------
   If a jump doesn't land (the video errors, or starts again from the beginning), try the other
   engine at the time asked for instead of leaving the viewer at 0:00. */
P.seekLog = [];
function watchSeek(target) {
  const it = P.item, v = P.v; if (!it || target < 12) return;
  const engine = v.isNative ? 'All formats' : 'Standard';
  const token = P.loadToken;
  clearTimeout(P.seekWatch);
  P.seekWatch = setTimeout(() => {
    if (P.item !== it || P.loadToken !== token) return;
    const at = P.v.currentTime || 0, failed = !!P.v.error || at < target - 8;
    P.seekLog.unshift(`${fmtTime(target)} → ${fmtTime(at)} (${engine})${failed ? ' — failed' : ''}`); P.seekLog.length = Math.min(P.seekLog.length, 6);
    if (!failed) return;
    const tried = (P.seekRetry ||= {})[it.id] || 0;
    if (tried >= 1) { ptoast('Jumping doesn’t work for this file. Open ⋮ › Playback details and send a screenshot.', null, null, 5000); return; }
    P.seekRetry[it.id] = tried + 1;
    if (!v.isNative && canGoNative(it)) { P.engineFor[it.id] = 'native'; ptoast('Switching to the all-formats player to jump…'); return load(it, target); }
    // Only when the standard engine can play it too (not Dolby/DTS sound, which it plays silent)
    if (v.isNative && it.src && !it.dpath && it.engineProbe && !it.engineProbe.needsNative) { P.engineFor[it.id] = 'web'; ptoast('Switching to the standard player to jump…'); return load(it, target); }
    ptoast('Jumping doesn’t work for this file. Open ⋮ › Playback details and send a screenshot.', null, null, 5000);
  }, 3500);
}
async function sheetPlaybackDetails() {
  const it = P.item; if (!it) return;
  let d = {};
  try { d = await NP.diag(); } catch {}
  const src = it.nuri ? (it.nuri.startsWith('content://media') ? 'Phone library' : 'Opened from another app (' + (it.nuri.split('/')[2] || '') + ')') : it.npath ? 'File path' : it.remote ? 'Network link' : 'Picked file';
  const rows = [
    ['App version', appInfo?.versionName || APP_VERSION],
    ['Engine', P.v.isNative ? 'All formats (Media3 + FFmpeg)' : 'Standard (built-in)'],
    ['Source', src],
    ['Length', isFinite(P.v.duration) ? fmtTime(P.v.duration) : 'unknown'],
    ['Seekable', P.v.isNative ? String(d.seekable ?? P.v.seekable) : 'n/a'],
    ['Codecs', [d.video, d.audio].filter(Boolean).join(' + ') || '—'],
    ['MKV seek index', d.mkv || '—'],
    ['Last jumps', P.seekLog.join('<br>') || 'none yet'],
  ];
  openSheet('Playback details', `<div class="diag">${rows.map(([k, v]) => `<div><b>${k}</b><span>${k === 'Last jumps' ? v : esc(String(v))}</span></div>`).join('')}</div>
    <p class="sheet-note">Take a screenshot of this if jumping or playback doesn’t work, and send it to the developer.</p>`);
}
function canGoNative(it) {
  if (DESK && it?.dpath) return !P.hls && P.deskMode[it.id] !== 'direct';
  return !!(P.nv && it && it.native && !it.remote && P.engineFor[it.id] !== 'web' && (it.npath || it.nuri));
}
function silentAudioCheck() {
  const v = P.v, it = P.item;
  if (v.isNative || !it || it.kind === 'audio' || P.silentCheck === -1 || !canGoNative(it) || S.engine === 'web') return;
  if (v.currentTime < 2.5 || v.paused) return;
  P.silentCheck = -1;
  if (!('webkitAudioDecodedByteCount' in v)) return;
  const hasAudio = it.engineProbe ? it.engineProbe.audioTracks > 0 : it.deskProbe ? it.deskProbe.audio.length > 0 : true;
  if (hasAudio && v.webkitAudioDecodedByteCount === 0) switchEngine('native', 'No sound with the standard player · switching to all formats…');
}
applyKidsUi();

/* =================================================================
   Desktop app (Linux, Windows, Mac): files the browser engine can't decode are
   converted by FFmpeg into HLS segments as they play (see desktop/main.js).
   ================================================================= */
P.deskMode = {};    // item id → 'direct' | 'hls'
P.deskAudio = {};   // item id → audio stream index
P.hls = null;
const DESK_TEXT_SUBS = ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'];
async function deskProbe(it) {
  if (!it.deskProbe) { try { it.deskProbe = await DESK.probe(it.dpath); } catch {} }
  return it.deskProbe;
}
function deskModeFor(it) {
  if (P.deskMode[it.id]) return P.deskMode[it.id];
  if (S.engine === 'web') return 'direct';
  if (S.engine === 'native') return 'hls';
  return it.deskProbe && !it.deskProbe.direct ? 'hls' : 'direct';
}
function deskDetach() { if (P.hls) { try { P.hls.destroy(); } catch {} P.hls = null; } }
function deskAttach(it) {
  const info = it.deskProbe || { audio: [], subs: [] };
  if (info.incomplete) { $('#spinner').hidden = true; return showPlayError('incomplete'); }
  if (info.missing) { $('#spinner').hidden = true; return showPlayError('missing'); }
  if (it.deskProbe && !info.duration && !info.video && !info.audio.length) { $('#spinner').hidden = true; return showPlayError('damaged'); }
  const aIdx = P.deskAudio[it.id] ?? Math.max(0, info.audio.findIndex(a => a.def));
  P.deskTracks = [
    ...info.audio.map((a, i) => ({ type: 'audio', group: i, track: 0, label: a.title, language: a.language, codec: a.codec, channels: a.channels, selected: i === aIdx, supported: true })),
    ...info.subs.filter(s => DESK_TEXT_SUBS.includes(s.codec)).map(s => ({ type: 'text', group: s.index, track: 0, label: s.title, language: s.language, codec: s.codec, forced: s.forced, selected: false, supported: true })),
  ];
  if (deskModeFor(it) === 'hls' && window.Hls?.isSupported()) {
    const hls = P.hls = new Hls({ maxBufferLength: 40, backBufferLength: 60, enableWorker: true, fragLoadingTimeOut: 60000, manifestLoadingTimeOut: 30000 });
    hls.loadSource(DESK.url('hls/index.m3u8', it.dpath, `&a=${aIdx}`));
    hls.attachMedia(P.v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => P.v.play().catch(() => {}));
    let retries = 0;
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal || P.hls !== hls) return;
      if (retries++ < 2) {                         // one bad segment shouldn't end playback
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); return; }
      }
      $('#spinner').hidden = true;
      P.deskErr = `${d.type} / ${d.details}${d.response?.code ? ' / HTTP ' + d.response.code : ''}${d.reason ? ' / ' + d.reason : ''}`;
      showPlayError('generic', { details: () => sheetDeskDiag(it) });
    });
  } else P.v.src = DESK.url('file', it.dpath);
  onNativeTracks();
}
function deskAudio(idx) {
  const it = P.item; if (!it) return;
  P.deskAudio[it.id] = idx;
  P.deskMode[it.id] = 'hls';      // choosing a language needs the converter
  const t = P.v.currentTime || 0;
  ptoast('Switching audio track…');
  load(it, t > 1 ? t : undefined);
}
async function deskSub(o) {
  const it = P.item; if (!it) return;
  (P.deskTracks || []).forEach(t => { if (t.type === 'text') t.selected = o === `st:${t.group}:0`; });
  if (o === 'st:off') { P.cues = []; P.subBuf = null; renderSub(); return; }
  const idx = +o.split(':')[1];
  ptoast('Loading subtitles…');
  try {
    const txt = await (await fetch(DESK.url('sub', it.dpath, `&s=${idx}`))).text();
    if (P.item !== it) return;
    P.subOn = true;
    await loadSubFile(new File([txt], 'embedded.srt'));
  } catch { ptoast('Couldn’t read those subtitles'); }
}
async function deskThumb(it) {
  const info = await deskProbe(it);
  const out = { dur: info?.duration || it.dur || 0 };
  if (it.kind === 'audio' || !info?.video) return { ...out, thumb: null, noArt: true };
  try {
    const blob = await (await fetch(DESK.url('thumb', it.dpath))).blob();
    if (blob.size) out.thumb = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(blob); });
  } catch {}
  return out;
}
/* library entries for files picked in the desktop app, kept across restarts */
function deskSave() {
  store.set('deskFiles', lib.items.filter(i => i.dpath && !i.remote).map(i => ({ path: i.dpath, name: i.name, size: i.size, mtime: i.mtime, folder: i.folder, kind: i.kind, subPath: i.subPath || null })));
}
function deskAddPaths(list, folderLabel) {
  const subs = new Map(list.filter(f => SUB_EXT.test(f.path)).map(f => [f.path.replace(/\.[^./\\]+$/, '').toLowerCase(), f.path]));
  const out = [];
  for (const f of list) {
    const name = f.name || f.path.split(/[\\/]/).pop();
    const isAud = AUDIO_EXT.test(name) || /\.(ac3|dts|wma)$/i.test(name);
    const isVid = !isAud && (VIDEO_EXT.test(name) || /\.(vob|divx|asf|rm|rmvb)$/i.test(name));
    if (!isAud && !isVid) continue;
    const id = `${name}|${f.size ?? 0}|${Math.round(f.mtime || 0)}`;
    let it = lib.byId.get(id) || lib.items.find(i => i.dpath === f.path);
    if (!it) {
      const dir = f.path.split(/[\\/]/).slice(-2, -1)[0];
      it = { id, kind: isAud ? 'audio' : 'video', file: null, name, size: f.size || 0, mtime: Math.round(f.mtime || 0), folder: f.folder || dir || folderLabel,
        url: null, dur: 0, thumb: null, sub: null, dpath: f.path, subPath: f.subPath || subs.get(f.path.replace(/\.[^./\\]+$/, '').toLowerCase()) || null };
      if (isAud) { it.title = baseName(name); it.artist = ''; it.album = it.folder; }
      lib.items.push(it); lib.byId.set(id, it);
    }
    out.push(it);
  }
  if (out.length) { adoptMovedHistory(out); deskSave(); render(); hydrateThumbs(); }
  return out;
}
async function deskPick() {
  const files = await DESK.pick();
  if (!files.length) return;
  const added = deskAddPaths(files, 'Added files');
  snack(added.length ? `${plural(added.length, 'file')} added` : 'No playable videos or music in that selection');
}
async function deskRestore() {
  const saved = store.get('deskFiles', []);
  if (!saved.length) return;
  const ok = new Set(await DESK.exists(saved.map(f => f.path)));
  const keep = saved.filter(f => ok.has(f.path));
  await DESK.allow([...keep.map(f => f.path), ...keep.map(f => f.subPath).filter(Boolean)]);
  deskAddPaths(keep);
}

/* =================================================================
   "Get app" (web version only): install this web app, or download the
   desktop app (Linux, Windows, Mac) or the Android app.
   ================================================================= */
const DL = 'https://github.com/adhil-bit/open-palyer/releases/download/desktop/';
const SITE = new URL('../', location.href).href;
let installEvt = null;
const userOS = (() => { const ua = navigator.userAgent; return /Android/.test(ua) ? 'android' : /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Windows/.test(ua) ? 'win' : /Mac OS X/.test(ua) ? 'mac' : /Linux|CrOS/.test(ua) ? 'linux' : ''; })();
const installedPWA = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; snack('Open Player is installed'); });
function sheetGetApp() {
  const desk = [
    ['linux', 'appimage', 'Linux · AppImage', 'Any distro. Make it executable, then double-click', 'OpenPlayer-linux-x86_64.AppImage'],
    ['linux', 'deb', 'Ubuntu / Debian · .deb', 'sudo apt install ./OpenPlayer-linux-amd64.deb', 'OpenPlayer-linux-amd64.deb'],
    ['win', 'exe', 'Windows', '64-bit installer', 'OpenPlayer-win-x64.exe'],
    ['mac', 'dmg', 'Mac', 'Apple silicon (M1 and newer)', 'OpenPlayer-mac-arm64.dmg'],
  ];
  const mine = desk.filter(d => d[0] === userOS), others = desk.filter(d => d[0] !== userOS);
  const row = d => opt('d:' + d[4], 'i-laptop', `${d[2]}<small>${esc(d[3])}</small>`, d[0] === userOS ? '<span class="val">For this computer</span>' : '');
  const pwa = installedPWA() ? '' : opt('pwa', 'i-dl', `Install this web app<small>${installEvt ? 'Adds Open Player to your apps, works offline' : userOS === 'ios' ? 'Safari › Share › Add to Home Screen' : 'Browser menu › Install app (or the install icon in the address bar)'}</small>`);
  const b = openSheet('Get Open Player',
    (userOS === 'android' ? opt('android', 'i-android', 'Android app<small>Recommended: finds all your videos, plays MKV, x265, AC3 and DTS</small>') : '') +
    (mine.length ? `<div class="group">Desktop app · plays MKV, x265, AC3 and DTS</div>${mine.map(row).join('')}` : '') +
    (pwa ? `<div class="group">Web app</div>${pwa}` : '') +
    `<div class="group">${mine.length ? 'Other systems' : 'Desktop app · plays MKV, x265, AC3 and DTS'}</div>${others.map(row).join('')}` +
    (userOS !== 'android' ? opt('android', 'i-android', 'Android app<small>For your phone</small>') : '') +
    `<p class="sheet-note">Desktop builds aren’t signed with a paid certificate, so Windows and Mac show a warning the first time. Checksums are on the <a href="${SITE}#desktop" target="_blank" rel="noopener">website</a>.</p>`);
  b.onclick = async e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    if (o.startsWith('d:')) { window.open(DL + o.slice(2), '_blank', 'noopener'); closeSheet(); return; }
    if (o === 'android') { window.open(ANDROID_APK_URL, '_blank', 'noopener'); closeSheet(); return; }
    if (o === 'pwa') {
      if (installEvt) { closeSheet(); installEvt.prompt(); try { await installEvt.userChoice; } catch {} installEvt = null; }
      else snack(userOS === 'ios' ? 'In Safari: Share › Add to Home Screen' : 'Use your browser menu › Install app', null, null, 6000);
    }
  };
}
if (!NATIVE && !DESK) { $('#btnGet').hidden = false; $('#btnGet').onclick = sheetGetApp; }

/* Reads the start of a video file to name its codecs, so playback errors can say exactly why. */
async function sniffCodecs(it) {
  const out = { video: '', audio: '' };
  try {
    const blob = it?.file; if (!blob) return out;
    const head = new Uint8Array(await blob.slice(0, 8 * 1024 * 1024).arrayBuffer());
    if (head.length && head.subarray(0, 65536).every(x => x === 0)) { out.incomplete = true; return out; }
    let txt = ''; for (let i = 0; i < head.length; i++) { const c = head[i]; txt += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; }
    const V = [['V_MPEGH/ISO/HEVC', 'HEVC (x265)'], ['hvc1', 'HEVC (x265)'], ['hev1', 'HEVC (x265)'], ['V_MPEG4/ISO/AVC', ''], ['V_MPEG4/ISO/ASP', 'MPEG-4 (DivX/Xvid)'], ['V_MS/VFW/FOURCC', 'AVI-style'],
      ['V_MPEG2', 'MPEG-2'], ['V_REAL', 'RealVideo'], ['XVID', 'Xvid'], ['DIVX', 'DivX'], ['DX50', 'DivX']];
    const A = [['A_TRUEHD', 'Dolby TrueHD'], ['A_EAC3', 'Dolby Digital Plus (E-AC3)'], ['A_AC3', 'Dolby Digital (AC3)'], ['A_DTS', 'DTS'], ['ac-3', 'Dolby Digital (AC3)'], ['ec-3', 'Dolby Digital Plus (E-AC3)']];
    out.video = (V.find(([k]) => txt.includes(k)) || [, ''])[1];
    out.audio = (A.find(([k]) => txt.includes(k)) || [, ''])[1];
  } catch {}
  return out;
}
async function sheetDeskDiag(it) {
  let d; try { d = await DESK.diag(it?.dpath); } catch (e) { d = { error: String(e) }; }
  const text = [`Open Player desktop ${d.app || ''} (${d.os || ''})`, `Player error: ${P.deskErr || '-'}`,
    `FFmpeg: ${d.ffmpegOk === false ? 'NOT WORKING' : d.ffmpegOk ? 'ok' : 'unknown'} ${d.version || ''}`, `FFmpeg path: ${d.ffmpeg || ''}`,
    `File: ${d.file || ''}`, `Readable: ${d.allowed}`,
    `Probe: ${d.probe ? JSON.stringify({ duration: d.probe.duration, video: d.probe.video?.codec, tenBit: d.probe.video?.tenBit, audio: (d.probe.audio || []).map(a => a.codec), subs: (d.probe.subs || []).map(x => x.codec), error: d.probe.error }) : '-'}`,
    '', ...(d.last || [])].join('\n');
  const b = openSheet('Playback details', `<p class="sheet-note">Copy this and send it to the developer to get the file working.</p>
    <pre style="margin:0 20px 12px;padding:12px;background:var(--surface-2);border-radius:10px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:46vh;overflow:auto">${esc(text)}</pre>
    <div class="sheet-actions"><button class="btn primary" data-a="copy">Copy details</button></div>`);
  b.onclick = async e => { if (!e.target.closest('[data-a="copy"]')) return; try { await navigator.clipboard.writeText(text); snack('Copied'); } catch { snack('Select the text and copy it'); } };
}

/* ---------- friendly playback errors: what happened, and what to do ---------- */
const ERR_ICONS = {
  dl: '<svg viewBox="0 0 24 24"><path d="M12 4v10m0 0l-4-4m4 4l4-4M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  film: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 5v14M16 5v14M3 9.5h5M3 14.5h5M16 9.5h5M16 14.5h5" stroke="currentColor" stroke-width="1.6"/></svg>',
  broken: '<svg viewBox="0 0 24 24"><path d="M6 3h8l5 5v13H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12l2 2-2 2 2 2M13 12l2 2-2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  wifi: '<svg viewBox="0 0 24 24"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.7 16a5 5 0 0 1 6.6 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="19.5" r="1.4" fill="currentColor"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 3l9.5 17h-19z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.2" fill="currentColor"/></svg>',
};
function nativeErrorKind(name = '') {
  if (/FILE_NOT_FOUND|NO_PERMISSION/.test(name)) return 'missing';
  if (/PARSING_CONTAINER_MALFORMED|PARSING_MANIFEST_MALFORMED|READ_POSITION_OUT_OF_RANGE/.test(name)) return 'damaged';
  if (/UNSUPPORTED|DECODER_INIT|DECODING_FORMAT/.test(name)) return 'unsupported';
  if (/IO_NETWORK|BAD_HTTP|TIMEOUT/.test(name)) return 'network';
  return 'generic';
}
function playErrorInfo(kind, o = {}) {
  const tryAgain = ['Try again', () => { hidePlayError(); if (P.item) { P.item.deskProbe = null; P.item.engineProbe = null; } PV.failed = null; load(P.item); }];
  const close = ['Close', () => { hidePlayError(); closePlayer(); }];
  const nextOne = P.idx < P.queue.length - 1 ? ['Play next', () => { hidePlayError(); next(); }] : null;
  switch (kind) {
    case 'incomplete': return { icon: 'dl', tone: 'warn', title: 'Download not finished',
      text: 'This video is still downloading, or its download stopped part-way. The beginning of the file is still empty, so it can’t play yet.',
      tips: ['Let your download or torrent app reach 100%', 'In a torrent app, use “Force recheck” or “Verify” if it says finished', 'If the download failed, download the video again'],
      acts: [tryAgain, nextOne, close] };
    case 'damaged': return { icon: 'broken', tone: 'warn', title: 'This video file is damaged',
      text: 'Part of the file is missing or broken, so it can’t be read. This usually means the download didn’t complete properly.',
      tips: ['Download the video again', 'If it came from a torrent, recheck it in your torrent app'],
      acts: [tryAgain, nextOne, close] };
    case 'missing': return { icon: 'search', tone: 'info', title: 'Video not found',
      text: 'This file was moved, renamed or deleted, or the memory card it was on isn’t connected.',
      tips: [NATIVE ? 'Rescan in Settings › Rescan phone now' : 'Add it again with ＋ › Pick videos'],
      acts: [nextOne, close] };
    case 'network': return { icon: 'wifi', tone: 'info', title: 'Couldn’t load the video',
      text: 'The connection dropped or the link stopped working.', tips: ['Check your internet connection', 'Open the link in a browser to see if it still works'],
      acts: [tryAgain, close] };
    case 'browser': {
      const what = o.parts?.length ? `It uses ${o.parts.join(' and ')}, which ${userOS === 'linux' ? 'Chrome and Firefox on Linux' : 'this browser'} can’t play.` : 'It uses a video or sound format this browser can’t play.';
      return { icon: 'film', tone: 'accent', title: 'Your browser can’t play this video',
        text: what + (installedPWA() ? ' The installed web app uses the browser’s player too.' : ''),
        tips: [IS_ANDROID_BROWSER ? 'The Open Player Android app plays it' : 'The Open Player desktop app plays it: it has its own player built in'],
        acts: [IS_ANDROID_BROWSER ? ['Get the Android app', () => window.open(ANDROID_APK_URL, '_blank', 'noopener')] : ['Get the desktop app', () => sheetGetApp()], close] };
    }
    case 'oldcopy': return { icon: 'film', tone: 'accent', title: 'Add this video again',
      text: 'This copy was added the old way, so the all-formats player can’t open it.', tips: [],
      acts: [['Pick videos', () => { hidePlayError(); closePlayer(); pickNative(); }], close] };
    case 'unsupported': return { icon: 'film', tone: 'accent', title: 'This format isn’t supported',
      text: 'Open Player can’t decode this video’s picture or sound.', tips: ['Try Player engine › All formats in the ⋮ menu'], acts: [nextOne, close] };
    default: return { icon: 'alert', tone: 'warn', title: 'Couldn’t play this video',
      text: 'Something went wrong while opening this file.', tips: [],
      acts: [tryAgain, o.details ? ['Details', o.details, 'link'] : null, close] };
  }
}
function showPlayError(kind, o = {}) {
  const info = playErrorInfo(kind, o);
  P.lastError = kind;
  $('#spinner').hidden = true;
  $('#perrIc').className = 'perr-ic ' + (info.tone || '');
  $('#perrIc').innerHTML = ERR_ICONS[info.icon] || ERR_ICONS.alert;
  $('#perrTitle').textContent = info.title;
  $('#perrText').textContent = info.text;
  $('#perrTips').innerHTML = info.tips?.length ? `<ul>${info.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
  const acts = info.acts.filter(Boolean);
  $('#perrActs').innerHTML = acts.map(([l, , cls], i) => `<button class="btn ${cls || (i === 0 ? 'primary' : '')}" data-i="${i}">${esc(l)}</button>`).join('');
  $('#perrActs').onclick = e => { const b = e.target.closest('[data-i]'); if (b) acts[+b.dataset.i][1](); };
  $('#perr').hidden = false;
  $('#ptoast').hidden = true;
  showControls(true);
}
function hidePlayError() { $('#perr').hidden = true; }
