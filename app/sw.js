/* Open Player service worker.
   Bump VERSION on every release so phones pick up the new files. */
const VERSION = '1.3.0';
const SHELL_CACHE = `op-shell-${VERSION}`;
const SHARE_CACHE = 'op-share-inbox';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('op-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Android "Share → Open Player"
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const cache = await caches.open(SHARE_CACHE);
        let i = 0;
        for (const f of form.getAll('media')) {
          if (!(f instanceof File)) continue;
          await cache.put(new Request(`./__shared/${Date.now()}-${i++}`), new Response(f, {
            headers: {
              'content-type': f.type || 'video/mp4',
              'x-name': encodeURIComponent(f.name),
              'x-mtime': String(f.lastModified || Date.now()),
            },
          }));
        }
      } catch {}
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Pages: network first so updates arrive quickly; fall back to cache offline.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(SHELL_CACHE);
        c.put('./index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // App files: serve from cache, refresh in the background.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
