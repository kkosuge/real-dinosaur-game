/* Service worker: offline play after the first visit (registered by src/main.js on http/https only).
 * - images under assets/: cache-first, keyed by the `?v=<content hash>` that tools/build_manifest.py appends to every
 *   manifest path. A changed image is a new URL (a cache miss), so it is never served stale.
 * - assets/manifest.js, code and pages: network-first (revalidated with cache: 'no-cache', so a server update is never
 *   mixed with heuristically cached old files), the cache when offline.
 * - whenever a fresh manifest.js arrives, cached images it no longer lists are pruned.
 * - an update is applied only after every file downloads; otherwise the previous worker and its complete cache stay.
 * VERSION only needs a bump when this file's logic or CORE changes (not for new images). */
'use strict';

var VERSION = 'rdg-v1.4.2';
var CORE = [
  './',
  'index.html',
  'style.css',
  'src/i18n.js',
  'src/config.js',
  'src/rng.js',
  'src/sim.js',
  'src/assets.js',
  'src/audio.js',
  'src/input.js',
  'src/render.js',
  'src/share.js',
  'src/main.js',
  'assets/manifest.js'
];

/** Every image path listed in assets/manifest.js (`window.ASSET_MANIFEST = {...};`), including its `?v=` hash: all
 * groups, the fx dust sprites included (the renderer draws them). */
function manifestPaths(text) {
  var out = [];
  try {
    var json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    (function walk(n) {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        Object.keys(n).forEach(function (k) {
          if ((k === 'src' || k === 'srcBlur') && typeof n[k] === 'string') out.push(n[k]);
          else walk(n[k]);
        });
      }
    })(json);
  } catch (e) { /* no manifest yet */ }
  return out;
}

/** Delete cached assets/ entries (except manifest.js) that the manifest `text` no longer lists. */
function prune(text) {
  var keep = new Set(manifestPaths(text).map(function (u) { return new URL(u, self.registration.scope).href; }));
  if (!keep.size) return Promise.resolve(); // unreadable / empty manifest: keep everything
  return caches.open(VERSION).then(function (cache) {
    return cache.keys().then(function (reqs) {
      return Promise.all(reqs.filter(function (r) {
        var p = new URL(r.url).pathname;
        return p.indexOf('/assets/') !== -1 && !/manifest\.js$/.test(p) && !keep.has(r.url);
      }).map(function (r) { return cache.delete(r); }));
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      // an update (a previous rdg- cache exists) must download everything or fail, keeping the old worker + cache;
      // a first install is best-effort (whatever is cached helps)
      var isUpdate = keys.some(function (k) { return k.indexOf('rdg-') === 0 && k !== VERSION; });
      return caches.open(VERSION).then(function (cache) {
        // no-cache: revalidate against the server, never precache a heuristically cached old copy
        function add(u) { return cache.add(new Request(u, { cache: 'no-cache' })).catch(function (err) { if (isUpdate) throw err; }); }
        var manifestText = '';
        return Promise.all(CORE.map(add))
          .then(function () { return fetch('assets/manifest.js', { cache: 'no-cache' }); })
          .then(function (res) {
            if (!res.ok) throw new Error('assets/manifest.js: HTTP ' + res.status);
            return res.text();
          })
          .then(function (text) { manifestText = text; return Promise.all(manifestPaths(text).map(add)); })
          .then(function () { return prune(manifestText); })
          .catch(function (err) {
            if (isUpdate) return caches.delete(VERSION).then(function () { throw err; });
          });
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('rdg-') === 0 && k !== VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var isManifest = /\/assets\/manifest\.js$/.test(url.pathname);
  var isAsset = url.pathname.indexOf('/assets/') !== -1 && !isManifest;
  if (isAsset) {
    // exact match (no ignoreSearch): the ?v= content hash is part of the key
    event.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          if (res && res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
          return res;
        });
      })
    );
    return;
  }
  event.respondWith(
    // revalidate (a 304 is cheap): the browser's heuristic HTTP cache could otherwise hand out an old main.js next to
    // a new render.js. A navigation keeps its own request (some engines reject init on navigate-mode requests).
    (req.mode === 'navigate' ? fetch(req) : fetch(req, { cache: 'no-cache' })).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
        if (isManifest) event.waitUntil(res.clone().text().then(prune));
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('index.html'); });
    })
  );
});
