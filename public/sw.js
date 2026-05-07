// Syruvia service worker — handles Web Push + click-to-open.
// Kept deliberately tiny: no precaching, no offline fallback, no fancy
// fetch interception. Just the two events the app needs.

self.addEventListener('install', () => {
  // Activate immediately on first install / version bump so we don't have
  // to ask the user to reload twice.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Server pushes a JSON payload like:
//   { title, body, tag, url, icon, badge }
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: (event.data && event.data.text()) || '' }; }
  const title = data.title || 'Syruvia';
  const opts = {
    body: data.body || '',
    tag: data.tag || 'syruvia',
    icon: data.icon || '/app-icon.svg',
    badge: data.badge || '/app-icon.svg',
    data: { url: data.url || '/dashboard' },
    renotify: true,
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// Tap on a notification → focus an existing tab on the same origin if
// possible, otherwise open a new one. Navigates to the URL the server
// embedded in the payload (e.g. /tickets/TKT-1234).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/dashboard';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      try {
        const u = new URL(client.url);
        if (u.origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) await client.navigate(targetUrl);
          return;
        }
      } catch {}
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
