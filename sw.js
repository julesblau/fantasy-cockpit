// Bump CACHE_NAME (v1 -> v2 ...) whenever any precached file changes.
var CACHE_NAME = 'draft-cockpit-v13';
var PRECACHE = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/data.js', './js/state.js', './js/importer.js', './js/ui.js', './js/edit.js', './js/app.js', './js/compare.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.map(function (name) {
          if (name !== CACHE_NAME) { return caches.delete(name); }
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') { return; }
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) { return cached; }
      return fetch(event.request).catch(function () {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
