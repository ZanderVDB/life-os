const CACHE = 'lifeos-v100';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', e => {
  // No longer auto-skipWaiting — the page shows a "Relaunch" prompt in
  // Settings / as a toast so the user decides when to apply an update
  // instead of having state reset out from under them.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Let the page trigger skipWaiting explicitly via postMessage — that's what
// the "Relaunch" button in the update toast and Settings calls into.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('firebasejs') || e.request.url.includes('googleapis') || e.request.url.includes('anthropic')) {
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
