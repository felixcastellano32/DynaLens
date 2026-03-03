const CACHE_NAME = 'dynalens-v6';
const ASSETS = [
  '/DynaLens/',
  '/DynaLens/index.html',
  '/DynaLens/app.css',
  '/DynaLens/app.js',
  '/DynaLens/manifest.json',
  '/DynaLens/icons/icon-192.png',
  '/DynaLens/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first for Gemini API calls, cache first for static assets
  if (e.request.url.includes('api.groq.com')) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
