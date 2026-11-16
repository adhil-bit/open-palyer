// Open Player desktop (Linux, Windows, Mac).
// The window shows the same web player as the PWA. Files the browser engine can't decode
// (HEVC/x265, AC3, DTS, TrueHD, AVI, WMV…) are converted on the fly by a bundled FFmpeg into
// short HLS segments, so seeking, the equalizer, screenshots and recording keep working.
'use strict';
const { app, BrowserWindow, ipcMain, protocol, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const FFMPEG = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const WWW = path.join(__dirname, 'www');
const HOST = 'op://player';
const SEG = 6;   // seconds per converted segment

protocol.registerSchemesAsPrivileged([{
  scheme: 'op',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

/* ---------------- diagnostics (shown by the player's "Details" button) ---------------- */
const diag = { ffmpeg: FFMPEG, ffmpegOk: null, version: '', last: [] };
function note(what, text) {
  diag.last.unshift(`[${new Date().toISOString().slice(11, 19)}] ${what}\n${String(text || '').trim().slice(-1500)}`);
  diag.last.length = Math.min(diag.last.length, 6);
}
function checkFfmpeg() {
  try {
    const p = spawn(FFMPEG, ['-hide_banner', '-version'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', e => { diag.ffmpegOk = false; note('FFmpeg could not start', `${FFMPEG}\n${e.message}`); });
    p.on('close', code => { if (diag.ffmpegOk !== false) { diag.ffmpegOk = code === 0; diag.version = out.split('\n')[0]; } });
  } catch (e) { diag.ffmpegOk = false; note('FFmpeg could not start', e.message); }
}

/* ---------------- probing ---------------- */
const probeCache = new Map();
function runFfmpeg(args, { timeout = 20000 } = {}) {
  return new Promise(resolve => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { if (err.length < 400000) err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('close', () => { clearTimeout(t); resolve(err); });
    p.on('error', () => { clearTimeout(t); resolve(err); });
  });
}
// Parses `ffmpeg -i` output: duration, streams with codec, language, title, channels, 10-bit.
async function probe(file) {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (probeCache.has(key)) return probeCache.get(key);
  const out = await runFfmpeg(['-hide_banner', '-i', file]);
  if (!/Duration:/.test(out)) note('Probe found no media info: ' + path.basename(file), out);
  const r = { duration: 0, video: null, audio: [], subs: [], size: st.size };
  // A torrent or download still in progress leaves unwritten parts as zero bytes.
  try {
    const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    r.incomplete = n > 0 && buf.subarray(0, n).every(x => x === 0);
  } catch {}
  const d = out.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (d) r.duration = +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]);
  const lines = out.split(/\r?\n/);
  let last = null;
  const counts = { Video: 0, Audio: 0, Subtitle: 0 };
  for (const line of lines) {
    const m = line.match(/^\s*Stream #\d+:(\d+)(?:\[[^\]]*\])?(?:\((\w+)\))?: (Video|Audio|Subtitle): (\w+)(.*)$/);
    if (m) {
      const [, , lang, type, codec, rest] = m;
      const s = { index: counts[type]++, codec, language: lang && lang !== 'und' ? lang : '', title: '', def: /\(default\)/.test(rest), forced: /\(forced\)/.test(rest) };
      if (type === 'Video') {
        if (/attached pic/.test(rest)) { last = null; counts.Video--; continue; }
        s.tenBit = /p10|p12|10le|12le/.test(rest);
        const wh = rest.match(/, (\d{2,5})x(\d{2,5})/); if (wh) { s.width = +wh[1]; s.height = +wh[2]; }
        if (!r.video) r.video = s;
      } else if (type === 'Audio') {
        const ch = rest.match(/, (mono|stereo|5\.1(?:\(side\))?|7\.1|(\d+) channels)/);
        s.channels = !ch ? 0 : ch[1] === 'mono' ? 1 : ch[1] === 'stereo' ? 2 : ch[1].startsWith('5.1') ? 6 : ch[1] === '7.1' ? 8 : +ch[2];
        r.audio.push(s);
      } else r.subs.push(s);
      last = s;
      continue;
    }
    const t = line.match(/^\s+title\s*:\s*(.+)$/);
    if (t && last && !last.title) last.title = t[1].trim();
    if (/^\s*Stream #/.test(line)) last = null;
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const okVideo = !r.video || (['h264', 'vp8', 'vp9', 'av1'].includes(r.video.codec) && !r.video.tenBit);
  const firstAudio = r.audio.find(a => a.def) || r.audio[0];
  const okAudio = !firstAudio || ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le'].includes(firstAudio.codec);
  const okBox = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav', 'oga', 'ogv'].includes(ext);
  r.direct = okVideo && okAudio && okBox;
  probeCache.set(key, r);
  return r;
}

/* ---------------- media served to the player ---------------- */
const allowed = new Set();      // only files the user opened can be read
const allow = p => { if (p) allowed.add(path.resolve(p)); return p; };
const okPath = p => p && allowed.has(path.resolve(p)) && fs.existsSync(p);
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', ogv: 'video/ogg', opus: 'audio/ogg', wav: 'audio/wav' };

function serveFile(file, req) {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (!range) return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes' } });
  let start = range[1] ? +range[1] : size - +range[2];
  let end = range[1] && range[2] ? +range[2] : size - 1;
  start = Math.max(0, start); end = Math.min(end, size - 1);
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: { 'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' },
  });
}

function playlist(file, audio, duration) {
  const q = `p=${encodeURIComponent(file)}&a=${audio}`;
  let out = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${SEG}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n`;
  const n = Math.max(1, Math.ceil(duration / SEG));
  for (let i = 0; i < n; i++) {
    const len = Math.min(SEG, duration - i * SEG);
    out += `#EXTINF:${Math.max(0.1, len).toFixed(3)},\n${HOST}/hls/seg.ts?${q}&i=${i}\n`;
  }
  return out + '#EXT-X-ENDLIST\n';
}

function streamProc(args, type) {
  const p = spawn(FFMPEG, args, { windowsHide: true });
  let err = '';
  p.stderr.on('data', d => { if (err.length < 20000) err += d; });
  p.on('error', e => note('FFmpeg could not start', e.message));
  p.on('close', code => { if (code && code !== 255 && !p.killed) note(`FFmpeg exited with ${code}: ${args.filter(a => !String(a).includes(path.sep)).slice(0, 40).join(' ')}`, err); });
  const body = Readable.toWeb(p.stdout);
  return { p, res: new Response(body, { headers: { 'content-type': type, 'cache-control': 'no-store' } }) };
}

function segment(file, audio, i, info) {
  const start = i * SEG;
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', file, '-t', String(SEG)];
  if (info.video) {
    args.push('-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-vf', "scale='min(1920,iw)':-2", '-force_key_frames', 'expr:gte(t,0)', '-sc_threshold', '0');
  } else args.push('-vn');
  if (info.audio.length) args.push('-map', `0:a:${Math.min(audio, info.audio.length - 1)}`, '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-af', 'aresample=async=1');
  args.push('-sn', '-dn', '-output_ts_offset', String(start), '-muxdelay', '0', '-f', 'mpegts', 'pipe:1');
  return streamProc(args, 'video/mp2t').res;
}

async function handle(req) {
  const u = new URL(req.url);
  const file = u.searchParams.get('p');
  if (u.pathname.startsWith('/app/') || u.pathname === '/app') {
    let rel = decodeURIComponent(u.pathname.replace(/^\/app\/?/, '')) || 'index.html';
    const f = path.join(WWW, path.normalize(rel));
    if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return new Response('Not found', { status: 404 });
    const ext = path.extname(f).slice(1);
    const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json', json: 'application/json' };
    return new Response(fs.readFileSync(f), { headers: { 'content-type': types[ext] || 'application/octet-stream' } });
  }
  if (!okPath(file)) { note('Blocked or missing file', `${file}\nallowed: ${allowed.has(path.resolve(file || '.'))}, exists: ${!!file && fs.existsSync(file)}`); return new Response('Not allowed', { status: 403 }); }
  try {
    if (u.pathname === '/file') return serveFile(file, req);
    if (u.pathname === '/hls/index.m3u8') {
      const info = await probe(file);
      return new Response(playlist(file, +u.searchParams.get('a') || 0, info.duration || SEG), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    }
    if (u.pathname === '/hls/seg.ts') return segment(file, +u.searchParams.get('a') || 0, +u.searchParams.get('i') || 0, await probe(file));
    if (u.pathname === '/thumb') {
      const info = await probe(file);
      const at = info.duration > 20 ? Math.min(info.duration * 0.15, 120) : 0;
      return streamProc(['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-f', 'mjpeg', 'pipe:1'], 'image/jpeg').res;
    }
    if (u.pathname === '/sub') {
      return streamProc(['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:s:${+u.searchParams.get('s') || 0}`, '-c:s', 'srt', '-f', 'srt', 'pipe:1'], 'text/plain; charset=utf-8').res;
    }
  } catch (e) {
    note('Request failed: ' + u.pathname, e?.stack || e);
    return new Response(String(e?.message || e), { status: 500 });
  }
  return new Response('Not found', { status: 404 });
}

/* ---------------- window ---------------- */
let win = null, rendererReady = false;
const pendingOpen = [];
const mediaArgs = argv => argv.slice(1).filter(a => !a.startsWith('-') && /\.[a-z0-9]{2,5}$/i.test(a) && fs.existsSync(a)).map(a => path.resolve(a));
function sendOpen(files) {
  files.forEach(allow);
  if (win && rendererReady) win.webContents.send('open-files', files);
  else pendingOpen.push(...files);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 380, minHeight: 500,
    backgroundColor: '#000000', title: 'Open Player', autoHideMenuBar: true,
    icon: path.join(WWW, 'icons', 'icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.loadURL(`${HOST}/app/index.html`);
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  // Links (the Android download, GitHub, VirusTotal) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(HOST)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const files = mediaArgs(argv);
    if (files.length) sendOpen(files);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('open-file', (e, file) => { e.preventDefault(); sendOpen([path.resolve(file)]); });   // macOS
  app.whenReady().then(() => {
    protocol.handle('op', handle);
    // The player asks for files passed on the command line / "Open with" once its library is ready.
    ipcMain.handle('ready', () => { rendererReady = true; return pendingOpen.splice(0); });
    ipcMain.handle('allow', (_e, paths) => { (paths || []).forEach(allow); return true; });
    ipcMain.handle('probe', async (_e, p) => { allow(p); try { return await probe(p); } catch { return null; } });
    ipcMain.handle('exists', (_e, paths) => (paths || []).filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }));
    ipcMain.handle('pick', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [
        { name: 'Videos and music', extensions: ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'flv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'vob', 'wmv', '3gp', 'ogv', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'ac3', 'dts', 'wma', 'srt', 'vtt'] },
        { name: 'All files', extensions: ['*'] }] });
      if (r.canceled) return [];
      r.filePaths.forEach(allow);
      return r.filePaths.map(p => { const s = fs.statSync(p); return { path: p, name: path.basename(p), size: s.size, mtime: s.mtimeMs }; });
    });
    ipcMain.handle('diag', async (_e, p) => {
      let info = null;
      if (p) { allow(p); try { info = await probe(p); } catch (e) { info = { error: e.message }; } }
      return { app: app.getVersion(), os: `${process.platform} ${process.arch}`, ...diag, file: p || null, allowed: p ? allowed.has(path.resolve(p)) : null, probe: info };
    });
    ipcMain.handle('fullscreen', (_e, on) => { if (win) win.setFullScreen(!!on); });
    checkFfmpeg();
    sendOpen(mediaArgs(process.argv));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
