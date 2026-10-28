// Service worker: app shell offline, AI models cached on first use, API always live.
const VERSION = 'sammilani-v1';
const SHELL = [
  './', 'index.html', 'admin.html', 'manifest.webmanifest', 'config.js',
  'assets/css/app.css',
  'assets/js/app.js', 'assets/js/admin.js', 'assets/js/i18n.js', 'assets/js/api.js',
  'assets/js/voice.js', 'assets/js/photo.js', 'assets/js/outbox.js', 'assets/js/combo.js',
  'vendor/qrcode/qrcode.js', 'icons/logo.png',
  'icons/icon-192.png?v=2', 'icons/icon-512.png?v=2', 'icons/apple-touch-icon.png?v=2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache the API (Apps Script) or photos
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com') || url.pathname.includes('/photos/')) return;

  // Vendor AI models + fonts: cache-first (large, immutable)
  if (url.pathname.includes('/vendor/') || url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com')) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // App shell: network-first so updates show immediately, cache when offline
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
    );
  }
});
