// Bump CACHE_NAME (v1 -> v2 ...) whenever any precached file changes.
var CACHE_NAME = 'draft-cockpit-v28';
// Player headshots/logos: a separate, un-versioned runtime cache -- never wiped by an app-shell bump.
var IMG_CACHE_NAME = 'draft-cockpit-img-v1';
var IMG_HOSTS = ['a.espncdn.com', 'sleepercdn.com', 'flockfantasy.com', 'cdn.prod.website-files.com', 'sportsbook.draftkings.com'];
var PRECACHE = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/data.js', './js/adp-data.js', './js/dk-data.js', './js/state.js', './js/adp-refresh.js', './js/importer.js', './js/ui.js', './js/edit.js', './js/app.js', './js/compare.js',
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
          if (name !== CACHE_NAME && name !== IMG_CACHE_NAME) { return caches.delete(name); }
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') { return; }

  if (IMG_HOSTS.indexOf(new URL(event.request.url).hostname) !== -1) {
    // cache-first; opaque cross-origin responses are cacheable and fine to store as-is; a
    // network failure with nothing cached is left to fail -- the img's onerror handles the UI.
    event.respondWith(
      caches.open(IMG_CACHE_NAME).then(function (cache) {
        return cache.match(event.request).then(function (cached) {
          if (cached) { return cached; }
          return fetch(event.request).then(function (response) {
            cache.put(event.request, response.clone());
            return response;
          });
        });
      })
    );
    return;
  }

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
