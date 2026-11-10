// Minimal app-shell service worker for Slope Battles.
// Scope is intentionally narrow: this app's data (rankings, games, chat) is
// live Firestore state, not something a service worker should cache — the
// only job here is making sure the page shell itself (HTML/icon/manifest)
// still renders if the network drops before those requests land, instead of
// a blank white screen.
const CACHE_NAME = 'slope-battles-shell-v1';
const SHELL_FILES = ['./', './index.html', './icon.svg', './manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Network-first for navigations/shell files so users always get the latest
// build when online; falls back to the last cached shell only when the
// network request itself fails (offline / dropped mid-load).
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave Firebase/CDN/API calls alone

  const isShellFile = req.mode === 'navigate' || SHELL_FILES.some(f => url.pathname.endsWith(f.replace('./', '')));
  if (!isShellFile) return;

  // cache:'no-cache' revalidates with the server every time (a cheap 304 when
  // unchanged). Without it, GitHub Pages' max-age=600 let the browser serve a
  // stale index.html for up to 10 minutes after a deploy. A navigate-mode
  // Request can't be re-fetched with options, so navigations go by URL.
  event.respondWith(
    fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' })
      .then(res => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
  );
});
