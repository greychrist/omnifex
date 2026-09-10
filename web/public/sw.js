// Minimal service worker: enough for Safari's "Add to Home Screen" to install
// a real standalone app, and nothing more.
//
// Deliberately NOT an offline cache. The app is a live session console; a
// stale cached shell that could not reach the daemon would be worse than a
// plain failed load. Every fetch goes to the network; the worker's only job is
// to exist and to claim the page so the install criteria are met.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through. Keep the handler present: some browsers require a fetch
  // listener before they treat the page as installable.
  event.respondWith(fetch(event.request));
});

// Phase 6 hook: Web Push lands here. A pushed `permission.request` opens the
// session it belongs to.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON */ }
  const title = data.title || 'OmniFex';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
