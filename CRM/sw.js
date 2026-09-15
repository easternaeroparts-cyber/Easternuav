/* Eastern UAV CRM — service worker.
   The shell is cached so the app opens instantly and survives a dead
   signal in the field. Supabase calls are never cached: stale
   operational data is worse than no data. */
const CACHE = 'euav-crm-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache the API, auth, or the weather lookup.
  if (url.hostname.endsWith('supabase.co') ||
      url.hostname.endsWith('aviationweather.gov') ||
      e.request.method !== 'GET') {
    return;
  }

  // Shell: network first so updates land, cache as the fallback.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
  }
});
