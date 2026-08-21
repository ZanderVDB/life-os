/**
 * Life OS v2 service worker.
 *
 * WHAT THIS CACHES: the static application shell — the HTML, the modules, the
 * manifest, the icons. Nothing else.
 *
 * WHAT THIS NEVER CACHES:
 *   - anything from the API. Task titles, notes and diary text are the user's
 *     private life; a cache is plaintext on disk and survives sign-out. There
 *     is no offline data story in v2, and pretending otherwise by caching
 *     authenticated responses would be worse than having none.
 *   - Firebase ID tokens or any request carrying an Authorization header.
 *   - cross-origin requests of any kind.
 *
 * CACHE NAMING: the name carries a build id, so a new deployment lands in a
 * fresh cache and old ones are deleted on activate. The `life-os-v2-` prefix
 * also guarantees no collision with the legacy app's caches, which live on a
 * different origin but could otherwise share a name if the domains ever merge.
 *
 * UPDATE POLICY: this worker never calls skipWaiting by itself. It waits until
 * the page tells it to, which only happens after the user chooses to update.
 */
const BUILD = '__BUILD_ID__';
const CACHE = `life-os-v2-shell-${BUILD}`;
const CACHE_PREFIX = 'life-os-v2-';

/** The shell. Small, static, and enough to render an offline message. */
const SHELL = [
  './',
  './index.html',
  './app.js',
  './routes.js',
  './pwa.js',
  './config.js',
  './settings.js',
  './motion.js',
  './utility-menu.js',
  './projects.js',
  './project-modal.js',
  './stars.js',
  './task-modal.js',
  './steps.js',
  './arrange.js',
  './habit-modal.js',
  './manifest.webmanifest',
  './icons/app-icon.svg',
  './offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll fails the whole install if any single file 404s. Add them
    // individually so one missing icon cannot break installation entirely.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    // Deliberately NOT skipWaiting(). The new worker waits for the user.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // The only instruction this worker accepts, and only the page sends it.
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

/* No hostname appears here on purpose.
 *
 * The fetch handler returns for anything cross-origin before this is reached,
 * so the old `railway.app` clause could never match — it only pinned the
 * worker's idea of the API to one host it never saw. A path prefix and an
 * Authorization header are what actually identify API traffic, on any domain. */
const isApiRequest = (url, request) =>
  url.pathname.startsWith('/api/')
  || request.headers.has('Authorization');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Same-origin only. Fonts, Firebase and the API are all somebody else's
  // problem — let the network handle them untouched.
  if (url.origin !== self.location.origin) return;

  // Never touch API traffic, even same-origin. Private data does not go to disk.
  if (isApiRequest(url, request)) return;

  // Navigations: network first, so a deploy is picked up immediately. The
  // cached shell is a fallback for being offline, not a performance trick.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html'))
          ?? (await cache.match('./offline.html'))
          ?? new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
      }
    })());
    return;
  }

  // Shell assets: network first with a cache fallback, and refresh the cache on
  // every success. Stale-while-revalidate would serve yesterday's app.js after
  // a deploy — the exact bug the legacy worker kept producing.
  event.respondWith((async () => {
    try {
      const fresh = await fetch(request, { cache: 'no-store' });
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw new Error('offline and not cached');
    }
  })());
});
