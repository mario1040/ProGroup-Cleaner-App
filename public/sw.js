const CACHE_NAME = 'naris-cache-v3';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/site.webmanifest',
  '/icon.png',
  '/icon.svg',
  '/apple-touch-icon.png',
  '/og-image.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching offline assets');
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[Service Worker] Failed to pre-cache some assets:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames.map((cacheName) => {
        if (cacheName !== CACHE_NAME) {
          console.log('[Service Worker] Deleting old cache:', cacheName);
          return caches.delete(cacheName);
        }
        return undefined;
      })
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Always request the latest app shell and service-worker script from the network.
  if (event.request.mode === 'navigate' || url.pathname === '/index.html' || url.pathname === '/sw.js') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).then((networkResponse) => {
        if (networkResponse.ok && url.pathname !== '/sw.js') {
          const responseToCache = networkResponse.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', responseToCache)));
        }
        return networkResponse;
      }).catch(async () => {
        const cached = await caches.match('/index.html');
        return cached || Response.error();
      })
    );
    return;
  }

  // Cache fingerprinted same-origin assets; a new build gets new filenames.
  event.respondWith(
    caches.match(event.request).then(async (cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      const networkResponse = await fetch(event.request);
      if (networkResponse.ok) {
        const responseToCache = networkResponse.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache)));
      }
      return networkResponse;
    })
  );
});
