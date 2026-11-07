// Offline support: the app shell and seed cards are cached so TAPE opens with
// no signal. Live quotes (/yf/...) always go to the network and are never cached here.
const CACHE = 'tape-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/yf/')) return;
  // Network first (so updates show up), cache as the fallback when offline.
  // Page loads revalidate with the server (GitHub Pages sends a 10-minute max-age), so a new
  // deploy shows on the next open; hashed assets can come from the HTTP cache.
  const fresh = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html') || url.pathname.endsWith('version.json');
  e.respondWith(
    fetch(e.request, fresh ? { cache: 'no-cache' } : undefined)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html'))),
  );
});
