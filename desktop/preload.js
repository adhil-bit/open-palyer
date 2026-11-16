// Bridge between the web player and the desktop app (see main.js).
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('OPDesktop', {
  platform: process.platform,
  // Real path of a file chosen in a file input or dropped on the window.
  pathFor(file) {
    try { const p = webUtils.getPathForFile(file); if (p) ipcRenderer.invoke('allow', [p]); return p || null; } catch { return null; }
  },
  allow: paths => ipcRenderer.invoke('allow', paths),
  probe: p => ipcRenderer.invoke('probe', p),
  exists: paths => ipcRenderer.invoke('exists', paths),
  pick: () => ipcRenderer.invoke('pick'),
  diag: p => ipcRenderer.invoke('diag', p),
  fullscreen: on => ipcRenderer.invoke('fullscreen', on),
  // Calls fn with files opened from the file manager: first the ones waiting since launch, then later ones.
  onOpenFiles(fn) {
    ipcRenderer.on('open-files', (_e, files) => fn(files));
    ipcRenderer.invoke('ready').then(files => { if (files && files.length) fn(files); });
  },
  url: (kind, p, extra = '') => `op://player/${kind}?p=${encodeURIComponent(p)}${extra}`,
});
