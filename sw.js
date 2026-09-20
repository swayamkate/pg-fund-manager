// Service worker disabled — was causing cache issues on Cloudflare Pages.
// Nothing registers this file anymore; it exists only so browsers still
// holding an old registration can purge and remove it. No fetch handler =
// always network. On activate: delete every cache, hand control back, and
// unregister itself so it can never serve stale content again.
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister())
  );
});