// ── AudioForge Service Worker v3.0.0 ─ 100% Offline-First ────────────
const CACHE_NAME      = 'audioforge-v3.0.0';
const PRECACHE_URLS   = [
  './',
  './index.html',
  './css/style.css',
  './css/fonts.css',
  './js/main.js',
  './js/audio-engine.js',
  './js/waveform.js',
  './js/undo-manager.js',
  './js/libs/lame.js',
  './manifest.json',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ── Install: pre-cache ALL assets before going live ───────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing AudioForge v3.0.0');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Pre-caching', PRECACHE_URLS.length, 'assets');
        return cache.addAll(PRECACHE_URLS);
      })
      .then(() => {
        console.log('[SW] All assets cached. Offline ready!');
        return self.skipWaiting();
      })
      .catch(err => {
        console.error('[SW] Pre-cache failed:', err);
        return self.skipWaiting();
      })
  );
});

// ── Activate: wipe OLD caches, claim all clients ──────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating AudioForge v3.0.0');
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Deleting stale cache:', k);
          return caches.delete(k);
        })
      ))
      .then(() => {
        console.log('[SW] Claiming clients.');
        return self.clients.claim();
      })
  );
});

// ── Fetch: offline-first strategy ────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.protocol.startsWith('http')) return;

  const isCoreAsset = PRECACHE_URLS.some(p => {
    const clean = p.replace(/^\.\//, '');
    return url.pathname.endsWith(clean) || url.pathname === '/' + clean;
  }) || url.pathname === '/' || url.pathname.endsWith('/index.html');

  if (isCoreAsset) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) {
          revalidateInBackground(req);
          return cached;
        }
        return fetchAndCache(req);
      }).catch(() => offlineFallback(req))
    );
  } else {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.status === 200 && res.type !== 'opaque') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then(c => c || offlineFallback(req)))
    );
  }
});

function fetchAndCache(req) {
  return fetch(req).then(res => {
    if (!res || res.status !== 200 || res.type === 'opaque') return res;
    const clone = res.clone();
    caches.open(CACHE_NAME).then(c => c.put(req, clone));
    return res;
  });
}

function revalidateInBackground(req) {
  fetch(req)
    .then(res => {
      if (!res || res.status !== 200 || res.type === 'opaque') return;
      caches.open(CACHE_NAME).then(c => c.put(req, res));
    })
    .catch(() => {});
}

function offlineFallback(req) {
  if (req.destination === 'document') {
    return caches.match('./index.html');
  }
  return new Response('', { status: 503, statusText: 'Offline' });
}

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.source.postMessage({ type: 'VERSION', version: CACHE_NAME });
  }
  if (event.data && event.data.type === 'CACHE_STATUS') {
    caches.open(CACHE_NAME).then(cache =>
      cache.keys().then(keys => {
        event.source.postMessage({
          type: 'CACHE_REPORT',
          count: keys.length,
          total: PRECACHE_URLS.length,
          ready: keys.length >= PRECACHE_URLS.length,
        });
      })
    );
  }
});
