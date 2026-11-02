// Network-first service worker (as in InkVault): makes ProblemVault installable
// and lets the shell open instantly; live data always comes from the server.
const CACHE = 'problemvault-v6';
const SHELL = ['/', '/tablet', '/phone', '/app.js', '/board.js', '/webassign.js', '/mml2tex.js', '/ink.js', '/app.css', '/manifest.webmanifest', '/manifest-tablet.webmanifest', '/manifest-phone.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', e => {
  // one missing file must not stop the worker from installing (that would block app install)
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp')) return;
  // every workspace URL of an app is that app's page: /w/x -> /, /tablet/w/x -> /tablet
  const m = /^(\/tablet|\/phone)?\/w\//.exec(url.pathname);
  const key = m ? (m[1] || '/') : e.request;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
        return res;
      })
      .catch(() => caches.match(key))
  );
});
