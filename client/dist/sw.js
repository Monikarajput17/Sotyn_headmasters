// Service Worker — receives push messages even when the ERP tab is
// closed and shows a desktop / phone notification. On click it tries
// to focus an already-open ERP tab, otherwise opens a new one to the
// notification's deep link.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'SEPL ERP', body: event.data ? event.data.text() : 'New notification' };
  }
  const title = data.title || 'SEPL ERP';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || 'sepl-erp',
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || '/', ...data },
    vibrate: [120, 60, 120],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus an already-open ERP tab if one exists
      for (const client of clientList) {
        try {
          const u = new URL(client.url);
          if (u.origin === self.location.origin) {
            client.focus();
            client.postMessage({ type: 'navigate', url: targetUrl });
            return;
          }
        } catch {}
      }
      // Otherwise open a fresh tab
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
