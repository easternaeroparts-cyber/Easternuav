// Udaan Nepal — service worker
// Bump this version string whenever you upload a new index.html so old caches get replaced.
const CACHE_VERSION = 'udaan-v1';
const CORE_ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'assets/enr61-chart.jpg',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// Install: pre-cache the core app shell so it works offline right after first visit.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

// Activate: delete any caches from older versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for our own assets (fast + offline-capable), network-first
// for everything else (map tiles, fonts) so they stay fresh but still work if cached.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return (
          cached ||
          fetch(event.request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
            return response;
          })
        );
      })
    );
  } else {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
