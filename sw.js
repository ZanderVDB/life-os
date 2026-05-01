const CACHE = 'lifeos-v127';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', e => {
  // Auto-activate on install. The previous policy (manual "Relaunch"
  // button via postMessage) caused a serious problem: if the user
  // never tapped Relaunch on a device (especially mobile, where the
  // update toast is easy to miss), they kept running stale code with
  // the v115 data-loss bug for weeks. With auto-skipWaiting any new
  // version goes live on the next page load, no manual step needed.
  // Active editing state is preserved by the page (modals stay open,
  // textareas keep their content) — the only side effect is the
  // refreshed CSS/JS reloads.
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Kept for backwards compat with the old "Relaunch" button — harmless
// no-op now since we already skipWaiting on install.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('firebasejs') || e.request.url.includes('googleapis') || e.request.url.includes('anthropic')) {
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
