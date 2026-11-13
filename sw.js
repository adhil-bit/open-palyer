/* The player moved to /app/. This replaces the old root service worker:
   it clears the old app caches, unregisters itself and reloads open pages. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of ['op-shell-1.0.0', 'op-shell-1.1.0', 'op-shell-1.2.0']) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
  })());
});
