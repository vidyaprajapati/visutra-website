/* VISUTRA service worker — needed for the app (TWA) and "Install app".
   Deliberately simple and SAFE for live business data:
   - Pages, scripts and Firebase data always come from the network (never a
     stale cached copy), so stock, orders and invoices are always current.
   - Only if there's no internet at all does a page request show
     offline.html instead of Chrome's error page.
   - Nothing from Firebase/Google/other sites is touched. */
const CACHE = 'visutra-shell-v1';
const SHELL = ['/offline.html', '/assets/app-icons/icon-192.png', '/assets/app-icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;                              // uploads, Firebase writes: untouched
  if(new URL(req.url).origin !== self.location.origin) return;   // Firebase, Google, CDNs: untouched
  if(req.mode === 'navigate'){
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
  }
  // Everything else: normal network behaviour (no caching of live data).
});
