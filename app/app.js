/* Open Player — ad-free video & music player (web app + Android app).
   No ads, no tracking, nothing leaves the device. */

const APP_VERSION = '1.3.0';
const ANDROID_APK_URL = 'https://github.com/adhil-bit/open-palyer/releases/latest';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|3gp|3g2|ts|m2ts|mts|flv|wmv|ogv|mpg|mpeg)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|wma|amr|aiff?|alac)$/i;
const SUB_EXT = /\.(srt|vtt)$/i;

/* Running inside the Android app? (Capacitor) */
const Cap = window.Capacitor;
const NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const ML = NATIVE ? (Cap.registerPlugin ? Cap.registerPlugin('MediaLibrary') : Cap.Plugins?.MediaLibrary) : null;
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
  sort: 'name',          // name | date | size | duration
  sortDir: 1,
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
    lib.items.push(it); lib.byId.set(id, it); added++;
  }
  if (added) {
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
    lib.items = lib.items.filter(i => !i.native);
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
    render();
    hydrateThumbs();
    if (!quiet) snack(`Found ${plural(v.items.length, 'video')} and ${plural(a.items.length, 'song')}`);
    if (S.deepScan && allFiles) deepScan(true);
  } catch (e) {
    if (!quiet) snack('Couldn’t read your media library');
  } finally { scanning = false; }
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
    if (!it.file && !it.native) continue;
    if (it.kind === 'audio' && !it.native) continue;     // no artwork reader for manual songs
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
    } else data = await makeThumb(it.file);
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
const videoItems = () => lib.items.filter(i => !isAudio(i));
const audioItems = () => lib.items.filter(isAudio);
lib.musicView = 'songs';   // songs | albums | artists
lib.group = null;          // selected album/artist

function sortItems(arr) {
  const key = { name: i => (i.title || i.name).toLowerCase(), date: i => i.mtime, size: i => i.size, duration: i => i.dur || 0 }[S.sort];
  return [...arr].sort((a, b) => {
    const x = key(a), y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * S.sortDir || a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}
function matchQuery(i) {
  if (!lib.query) return true;
  const q = lib.query.toLowerCase();
  return [i.name, i.title, i.artist, i.album].some(s => s && s.toLowerCase().includes(q));
}
function visibleItems() {
  if (lib.tab === 'music') {
    let arr = audioItems().filter(matchQuery);
    if (lib.group) arr = arr.filter(i => (lib.musicView === 'albums' ? i.album : i.artist) === lib.group);
    return lib.group && lib.musicView === 'albums' ? arr : sortItems(arr);
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
function render() {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === lib.tab));
  const showCrumb = (lib.tab === 'folders' && lib.folder) || (lib.tab === 'music' && lib.group);
  $('#crumb').hidden = !showCrumb;
  if (showCrumb) $('#crumbTitle').textContent = lib.tab === 'music' ? lib.group : lib.folder;
  $('#musicChips').hidden = lib.tab !== 'music' || !!lib.group;
  $$('#musicChips button').forEach(b => b.classList.toggle('sel', b.dataset.mv === lib.musicView));

  let html = '';
  $('#empty').hidden = true;
  if (lib.tab === 'recent') {
    const list = recents.filter(r => !lib.query || r.name.toLowerCase().includes(lib.query.toLowerCase()));
    if (!list.length) html = emptyMsg('Videos and songs you play show up here.');
    for (const r of list) {
      const it = lib.byId.get(r.id);
      if (it) { html += rowHTML(it); continue; }
      const p = progress[r.id]; const pct = p && p.d ? clamp(p.t / p.d * 100, 0, 100) : 0;
      html += `<button class="row missing" data-recent="${esc(r.id)}">
        <div class="thumb ph"><svg><use href="#i-film"/></svg>${pct > 1 ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ''}</div>
        <div class="meta"><div class="name">${esc(r.name)}</div><div class="sub"><span>${p ? fmtTime(p.t) + ' / ' + fmtTime(p.d) : ''}</span><span>Tap to re-open</span></div></div>
      </button>`;
    }
    listEl.innerHTML = html;
    return;
  }

  if (lib.tab === 'music') {
    const songs = audioItems();
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
        const g = groups.get(s[key]) || { n: 0, art: null, artist: s.artist };
        g.n++; if (!g.art && s.thumb) g.art = s.thumb;
        groups.set(s[key], g);
      }
      for (const [name, g] of [...groups].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
        html += `<button class="row" data-group="${esc(name)}">
          <div class="art${key === 'artist' ? ' round' : ''}${g.art ? '' : ' ph'}">${g.art ? `<img src="${g.art}" alt="" loading="lazy">` : `<svg><use href="#${key === 'album' ? 'i-disc' : 'i-user'}"/></svg>`}</div>
          <div class="meta"><div class="name">${esc(name)}</div><div class="sub"><span>${key === 'album' ? esc(g.artist || '') + ' · ' : ''}${g.n} song${g.n > 1 ? 's' : ''}</span></div></div>
          <svg class="chev"><use href="#i-chev"/></svg></button>`;
      }
    } else {
      const items = visibleItems();
      html = items.length ? `<button class="playall" data-act="playall"><svg><use href="#i-play"/></svg>Play all · ${items.length}</button>` + items.map(songRowHTML).join('') : emptyMsg('No matches.');
    }
    listEl.innerHTML = html;
    return;
  }

  const vids = videoItems();
  if (!vids.length) { $('#empty').hidden = false; listEl.innerHTML = ''; return; }
  if (lib.tab === 'folders' && !lib.folder && !lib.query) {
    const groups = new Map();
    for (const it of vids) {
      const g = groups.get(it.folder) || { n: 0, size: 0, fresh: 0, hidden: 0 };
      g.n++; g.size += it.size || 0; if (!progress[it.id]) g.fresh++; if (it.hidden) g.hidden++;
      groups.set(it.folder, g);
    }
    for (const [name, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      html += `<button class="row" data-folder="${esc(name)}">
        <div class="folder-ico"><svg><use href="#i-folder"/></svg></div>
        <div class="meta"><div class="name">${esc(name)}</div>
          <div class="sub"><span>${g.n} video${g.n > 1 ? 's' : ''}</span><span>${fmtSize(g.size)}</span>${g.fresh ? `<span class="badge">${g.fresh} NEW</span>` : ''}${g.hidden ? '<span class="badge hid">HIDDEN</span>' : ''}</div></div>
        <svg class="chev"><use href="#i-chev"/></svg>
      </button>`;
    }
  } else {
    html = visibleItems().map(rowHTML).join('') || emptyMsg('No matches.');
  }
  listEl.innerHTML = html;
}

/* long-press on a row → info sheet */
let rowPress = null;
listEl.addEventListener('pointerdown', e => {
  const row = e.target.closest('.row[data-id]'); if (!row) return;
  rowPress = setTimeout(() => { rowPress = 'fired'; navigator.vibrate?.(15); showInfo(lib.byId.get(row.dataset.id)); }, 520);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => listEl.addEventListener(t, () => { if (rowPress !== 'fired') clearTimeout(rowPress); }));
listEl.addEventListener('scroll', () => { if (rowPress !== 'fired') clearTimeout(rowPress); }, { passive: true });
listEl.addEventListener('contextmenu', e => e.preventDefault());
listEl.addEventListener('click', e => {
  if (rowPress === 'fired') { rowPress = null; return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'grant') return requestMediaAccess();
  if (act === 'addMusic') return $('#pickMusic').click();
  if (act === 'playall') { const q = visibleItems(); if (q.length) openPlayer(q[0], q); return; }
  const row = e.target.closest('.row'); if (!row) return;
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
  if (lib.tab === 'folders') return lib.folder ? visibleItems() : videoItems().filter(i => i.folder === it.folder);
  return visibleItems();
}
$$('#musicChips button').forEach(b => b.onclick = () => { lib.musicView = b.dataset.mv; lib.group = null; render(); listEl.scrollTop = 0; });

/* tabs, search, sort, pickers */
$$('.tab').forEach(t => t.onclick = () => { lib.tab = t.dataset.tab; lib.folder = null; lib.group = null; render(); listEl.scrollTop = 0; hydrateThumbs(); });
$('#btnCrumbBack').onclick = () => { lib.folder = null; lib.group = null; render(); };
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

function sheetAdd() {
  const b = openSheet('Add videos',
    opt('files', 'i-film', 'Pick videos<small>Choose one or more files</small>') +
    opt('folder', 'i-folder', 'Pick a folder<small>Adds every video inside, with matching subtitles</small>') +
    opt('url', 'i-loop', 'Open network stream<small>Play a direct video link (http/https)</small>'));
  b.onclick = e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'files') $('#pickFiles').click();
    if (o === 'folder') $('#pickFolder').click();
    if (o === 'url') sheetUrl();
  };
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
  const items = [['name', 'Name'], ['date', 'Date modified'], ['size', 'Size'], ['duration', 'Length']];
  const draw = () => items.map(([k, l]) => opt(k, S.sort === k ? 'i-check' : 'i-sort', l,
    S.sort === k ? `<span class="val">${S.sortDir > 0 ? 'Ascending' : 'Descending'}</span>` : '', S.sort === k ? 'sel' : '')).join('');
  const b = openSheet('Sort by', draw());
  b.onclick = e => {
    const k = e.target.closest('[data-o]')?.dataset.o; if (!k) return;
    if (S.sort === k) S.sortDir *= -1; else { S.sort = k; S.sortDir = k === 'name' ? 1 : -1; }
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
    ${opt('deep', 'i-search', 'Find videos in hidden folders<small>Folders apps hide from players (.nomedia). Needs “All files access”.</small>', sw(S.deepScan && allFiles))}
    ${opt('rescan', 'i-refresh', 'Rescan phone now')}
    ${opt('tghelp', 'i-info', 'Telegram / Plus downloads not showing?')}`
    : `
    <div class="group">Your media</div>
    ${opt('getapp', 'i-android', 'Get the Android app<small>Shows every video and song on your phone automatically</small>', '<span class="val">Recommended</span>')}
    ${opt('tghelp', 'i-info', 'Telegram / Plus downloads not showing?')}`;
  const draw = (info) => `${mediaSection}
    <div class="group">Playback</div>
    ${opt('resume', 'i-loop', 'Resume where you left off', `<span class="val">${resumeLbl[S.resume]}</span>`)}
    ${opt('autoNext', 'i-next', 'Auto-play next video', sw(S.autoNext))}
    ${opt('seekStep', 'i-fwd', 'Double-tap seek', `<span class="val">${S.seekStep}s</span>`)}
    ${opt('keepAwake', 'i-sun', 'Keep screen on while playing', sw(S.keepAwake))}
    ${opt('rememberBright', 'i-sun', 'Remember brightness', sw(S.rememberBright))}
    <div class="group">Storage &amp; cache</div>
    <div class="storage">App storage used: <b>${fmtSize(info.usage) || '0 B'}</b>${info.quota ? ` of ${fmtSize(info.quota)}` : ''} · ${info.cacheCount} cache${info.cacheCount === 1 ? '' : 's'}
      <div class="bar"><i style="width:${info.quota ? clamp(info.usage / info.quota * 100, 1, 100) : 1}%"></i></div></div>
    ${opt('refreshCache', 'i-refresh', 'Refresh app cache<small>Clears stored app files and reloads the latest version</small>')}
    ${opt('clearThumbs', 'i-trash', 'Clear thumbnail cache<small>Thumbnails are rebuilt next time</small>')}
    ${opt('clearHistory', 'i-trash', 'Clear watch history<small>Resume points and Recent list</small>', '', 'danger')}
    <div class="group">About</div>
    ${opt('update', 'i-info', `Open Player ${APP_VERSION}<small>No ads. No tracking. Your videos never leave this device.</small>`, '<span class="val">Check for update</span>')}`;
  const b = openSheet('Settings', draw(await storageInfo()));
  const redraw = async () => { b.innerHTML = draw(await storageInfo()); };
  b.onclick = async e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    if (o === 'resume') S.resume = { always: 'ask', ask: 'never', never: 'always' }[S.resume];
    if (o === 'autoNext') S.autoNext = !S.autoNext;
    if (o === 'keepAwake') S.keepAwake = !S.keepAwake;
    if (o === 'rememberBright') S.rememberBright = !S.rememberBright;
    if (o === 'seekStep') S.seekStep = { 5: 10, 10: 15, 15: 30, 30: 5 }[S.seekStep] || 10;
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
    if (o === 'access') {
      if (hasAccess('video') || hasAccess('audio')) { closeSheet(); return snack('Access is on. To turn it off, use Android settings.', 'Open', () => ML.openAppSettings(), 5000); }
      closeSheet(); return requestMediaAccess();
    }
    if (o === 'deep') { closeSheet(); return toggleDeepScan(); }
    if (o === 'rescan') { closeSheet(); await scanDevice(); return; }
    if (o === 'tghelp') { closeSheet(); return sheetTelegramHelp(); }
    if (o === 'getapp') { window.open(ANDROID_APK_URL, '_blank', 'noopener'); return; }
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
    ['Type', it.file?.type || '—'], ['Subtitles', it.sub ? it.sub.name : 'None'],
    ['Watched', p ? `${fmtTime(p.t)} of ${fmtTime(p.d)}` : 'Not yet'],
  ];
  const b = openSheet('Details',
    `<div style="padding:0 20px 8px">${rows.map(([k, v]) =>
      `<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)"><span style="color:var(--muted);width:90px;flex:none">${k}</span><span style="word-break:break-word">${esc(v)}</span></div>`).join('')}</div>` +
    opt('play', 'i-play', 'Play') + opt('remove', 'i-trash', 'Remove from list', '', 'danger'));
  b.onclick = e => {
    const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return;
    closeSheet();
    if (o === 'play') openPlayer(it, visibleQueueFor(it));
    if (o === 'remove') {
      lib.items = lib.items.filter(i => i !== it); lib.byId.delete(it.id);
      if (it.url) URL.revokeObjectURL(it.url);
      if (lib.folder && !lib.items.some(i => i.folder === lib.folder)) lib.folder = null;
      render();
    }
  };
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
  const n = P.v.cloneNode(false);
  n.removeAttribute('src');
  P.v.replaceWith(n); P.v = n; P.boost = null;
  bindVideo(n);
}
const fmtRate = r => (Math.round(r * 100) / 100).toFixed(r % 0.25 ? 2 : (r % 1 ? 2 : 1)).replace(/0$/, '') + '×';

function openPlayer(item, queue) {
  P.queue = queue && queue.length ? queue : [item];
  P.idx = Math.max(0, P.queue.indexOf(item));
  P.el.hidden = false;
  document.documentElement.style.background = '#000';
  hideMini();
  if (item.kind !== 'audio') enterFullscreen();
  if (!history.state?.player) history.pushState({ player: 1 }, '');
  load(item);
  showControls();
}
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
  saveProgress(true);
  P.item = item;
  P.cues = []; P.subDelay = 0; renderSub();
  P.zoom = 1;
  if (item.remote && P.boost) freshVideo();
  if (item.remote) P.v.src = item.url;
  else if (item.src) P.v.src = item.src;
  else { item.url ||= URL.createObjectURL(item.file); P.v.src = item.url; }
  setAudioView(item);
  P.v.playbackRate = S.defaultSpeed;
  $('#vTitle').textContent = item.kind === 'audio' ? (item.title || item.name) : item.name;
  $('#vSub').textContent = P.queue.length > 1 ? `${P.idx + 1} of ${P.queue.length} · ${item.folder}` : (item.folder || '');
  $('#btnPrev').disabled = P.idx <= 0; $('#btnPrev').style.opacity = P.idx <= 0 ? .35 : 1;
  $('#btnNext').disabled = P.idx >= P.queue.length - 1; $('#btnNext').style.opacity = P.idx >= P.queue.length - 1 ? .35 : 1;
  $('#spinner').hidden = false;
  P.pendingStart = startAt;
  P.ab = { a: null, b: null };
  P.audioDelay = item.remote ? 0 : (allDelays[item.id] || 0);
  if (!item.remote && (S.eqOn || P.audioDelay)) ensureBoost();
  applyAudioFx();
  if (P.rec) stopRecording();
  if (item.sub) loadSubFile(item.sub, true);
  applyBright();
  setupMediaSession();
  if (!item.remote) touchRecent(item);
  P.v.play().catch(() => {});
}
function onMeta() {
  const v = P.v, it = P.item;
  if (!isFinite(v.duration) && !it.remote) {
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
  if (it.kind !== 'audio' && v.videoWidth === 0 && v.videoHeight === 0) ptoast('Video codec not supported here — playing audio only');
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
function onPlayState() {
  const playing = !P.v.paused;
  $('#btnPlay use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#btnPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (navigator.mediaSession) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  updateMini();
  if (P.item?.kind === 'audio' && P.el.hidden) render();
  if (playing) { keepAwake(true); scheduleHide(); } else { keepAwake(false); showControls(true); saveProgress(true); }
}
function onEnded() {
  saveProgress(true, true);
  if (P.sleepEnd) { P.sleepEnd = false; ptoast('Sleep timer: stopped'); return; }
  if (P.repeat === 'one') { P.v.currentTime = 0; P.v.play(); return; }
  if (P.idx < P.queue.length - 1 && (S.autoNext || P.repeat === 'all')) return next();
  if (P.repeat === 'all' && P.queue.length) { P.idx = -1; return next(); }
  showControls(true);
}
function onError() {
  $('#spinner').hidden = true;
  const code = P.v.error?.code;
  const msg = code === 4 ? 'This file’s format isn’t supported by your browser. MP4 (H.264) and WebM play best.'
    : code === 2 ? 'Network error while loading the video.' : 'Couldn’t play this video.';
  ptoast(msg, null, null, 6000);
}

function saveProgress(force, finished) {
  const it = P.item, v = P.v;
  if (!it || it.remote || !isFinite(v.duration) || !v.duration) return;
  const t = finished ? v.duration : v.currentTime;
  progress[it.id] = { t, d: v.duration, ts: Date.now() };
  if (force || Math.random() < 1) store.set('progress', progress);
}
function touchRecent(it) {
  recents = [{ id: it.id, name: it.name, folder: it.folder, size: it.size, ts: Date.now() }, ...recents.filter(r => r.id !== it.id)].slice(0, 60);
  store.set('recents', recents);
}

function closePlayer(fromPop) {
  saveProgress(true);
  const keepMusic = P.item?.kind === 'audio' && !P.v.paused;
  if (!keepMusic) { P.v.pause(); clearSleep(); }
  P.el.hidden = true; closeSheet();
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
function showMini() { $('#mini').hidden = false; document.body.classList.add('has-mini'); updateMini(); }
function hideMini() { $('#mini').hidden = true; document.body.classList.remove('has-mini'); }
function updateMini() {
  if ($('#mini').hidden || !P.item) return;
  const it = P.item;
  $('#miniTitle').textContent = it.title || it.name;
  $('#miniSub').textContent = it.artist || it.folder || '';
  const art = $('#miniArt'); art.classList.toggle('ph', !it.thumb);
  art.innerHTML = it.thumb ? `<img src="${it.thumb}" alt="">` : '<svg><use href="#i-note"/></svg>';
  $('#miniPlay use').setAttribute('href', P.v.paused ? '#i-play' : '#i-pause');
  $('#miniProg').style.width = P.v.duration ? (P.v.currentTime / P.v.duration * 100) + '%' : '0';
}
$('#miniOpen').onclick = () => {
  hideMini();
  P.el.hidden = false; document.documentElement.style.background = '#000';
  if (!history.state?.player) history.pushState({ player: 1 }, '');
  showControls();
};
$('#miniPlay').onclick = () => { togglePlay(); setTimeout(updateMini, 50); };
$('#miniNext').onclick = () => { next(); setTimeout(updateMini, 300); };
$('#miniClose').onclick = () => { P.v.pause(); clearSleep(); hideMini(); render(); };
window.addEventListener('popstate', () => {
  if (!sheet.hidden) { closeSheet(); if (!P.el.hidden) history.pushState({ player: 1 }, ''); return; }
  if (!P.el.hidden) closePlayer(true);
});

const togglePlay = () => (P.v.paused ? P.v.play().catch(() => {}) : P.v.pause());
function seekBy(s) {
  const v = P.v; if (!isFinite(v.duration)) return;
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
function scheduleHide() { clearTimeout(P.ctlTimer); if (!P.v.paused) P.ctlTimer = setTimeout(hideControls, 3500); }
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
  const move = e => {
    const d = P.v.duration; if (!d) return;
    const t = frac(e) * d;
    updateSeek(t);
    const tip = $('#seekTip'); tip.hidden = false; tip.textContent = fmtTime(t); tip.style.left = frac(e) * 100 + '%';
    const now = performance.now();
    if (now - lastSet > 120) { lastSet = now; P.v.currentTime = t; }
  };
  seekEl.addEventListener('pointerdown', e => { dragging = true; seekEl.setPointerCapture(e.pointerId); seekEl.classList.add('drag'); holdControls(true); move(e); });
  seekEl.addEventListener('pointermove', e => dragging && move(e));
  const end = e => {
    if (!dragging) return; dragging = false;
    seekEl.classList.remove('drag'); $('#seekTip').hidden = true;
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
  const o = screen.orientation; if (!o?.lock) return;
  if (want === 'auto') {
    if (!force && !P.v.videoWidth) return;
    want = P.v.videoWidth >= P.v.videoHeight ? 'landscape' : 'portrait';
  }
  const go = () => o.lock(want).catch(() => {});
  if (document.fullscreenElement) go();
  else document.documentElement.requestFullscreen?.().then(go).catch(() => {});
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
    comp.threshold.value = -6; comp.ratio.value = 4;
    let node = src.connect(delay);
    for (const b of bands) node = node.connect(b);
    node.connect(gain).connect(comp).connect(ctx.destination);
    P.boost = { ctx, gain, delay, bands };
    applyAudioFx();
    return true;
  } catch { P.boost = null; return false; }
}
function applyAudioFx() {
  if (!P.boost) return;
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
      P.v.style.transform = videoTransform();
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
      const span = Math.min(P.v.duration, 180);
      target = clamp(base + dx / W * span, 0, P.v.duration);
      const delta = target - base;
      const h = $('#seekhud'); h.hidden = false;
      h.innerHTML = `${fmtTime(target)}<small>${delta >= 0 ? '+' : '−'}${fmtTime(Math.abs(delta))}</small>`;
      updateSeek(target);
    } else if (mode === 'bright') {
      P.bright = clamp(base - dy / (H * 0.6), 0, 1.5);
      applyBright();
      hud('i-sun', P.bright / 1.5, Math.round(P.bright * 100) + '%');
    } else if (mode === 'vol') {
      setVolume(base - dy / (H * 0.6) * (P.item?.remote ? 1 : 1.4));
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
    if (mode === 'seek') { P.v.currentTime = target; $('#seekhud').hidden = true; mode = null; return; }
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
    ${opt('load', 'i-plus', 'Load subtitle file<small>.srt or .vtt</small>')}
    ${P.cues.length ? opt('toggle', 'i-cc', 'Show subtitles', sw(P.subOn)) : ''}
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
  const local = !P.item.remote;
  const b = openSheet('More',
    `<div class="group">Tools</div>` +
    opt('record', 'i-rec', P.rec ? 'Stop recording' : 'Record clip<small>Saves what plays as a video file</small>', P.rec ? '<span class="val" style="color:#ff5d5d">● REC</span>' : '', P.rec ? 'danger' : '') +
    opt('shot', 'i-camera', 'Save screenshot') +
    opt('ab', 'i-loop', 'A-B repeat', `<span class="val">${abLbl}</span>`) +
    opt('jump', 'i-fwd', 'Jump to time') +
    opt('bookmarks', 'i-bookmark', 'Bookmarks', `<span class="val">${getMarks().length || ''}</span>`) +
    `<div class="group">Picture &amp; sound</div>` +
    opt('aspect', 'i-aspect', 'Aspect ratio', `<span class="val">${ASPECTS[P.aspect][1]}</span>`) +
    opt('adjust', 'i-sun', 'Video adjustments<small>Contrast, color, mirror</small>') +
    (local ? opt('eq', 'i-eq', 'Equalizer', `<span class="val">${S.eqOn ? esc(S.eqPreset) : 'Off'}</span>`) : '') +
    (local ? opt('adelay', 'i-vol', 'Audio delay', `<span class="val">${P.audioDelay ? '+' + Math.round(P.audioDelay * 1000) + ' ms' : 'Off'}</span>`) : '') +
    `<div class="group">Playback</div>` +
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
    if (o === 'sleep') return sheetSleep();
    if (o === 'info') return sheetMediaInfo();
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
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
    P.cues = parseSubs(text); P.subOn = true;
    if (!silent) ptoast(P.cues.length ? `Subtitles loaded (${P.cues.length} lines)` : 'Couldn’t read that subtitle file');
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

/* files opened from other apps ("Open with" / Share → Open Player) */
function handleOpenFile(f) {
  if (!f?.uri) return;
  const kind = (f.mime || '').startsWith('audio/') || AUDIO_EXT.test(f.name || '') ? 'audio' : 'video';
  const id = 'in:' + f.uri;
  let it = lib.byId.get(id);
  if (!it) {
    it = { id, kind, native: true, nuri: f.uri, npath: null, src: Cap.convertFileSrc(f.uri), name: f.name || 'Shared file',
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

/* ---------------- boot ---------------- */
render();
setupSW();
importShared();
(async () => {
  if (NATIVE) {
    await refreshAccess();
    if (hasAccess('video') || hasAccess('audio')) { S.onboarded = true; saveSettings(); scanDevice(true); }
    try { const r = await ML.getLaunchFile(); if (r.file) handleOpenFile(r.file); } catch {}
  }
  if (!S.onboarded && (NATIVE || IS_ANDROID_BROWSER)) showOnboarding();
})();
if (store.get('justRefreshed', false)) { store.del('justRefreshed'); setTimeout(() => snack('App cache refreshed — you’re on the latest files'), 300); }
window.OpenPlayer = { lib, P, S, version: APP_VERSION };
