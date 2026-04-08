self.addEventListener('push', (event) => {
  console.log('[sw] push event received, hasData:', !!event.data);

  let data = {};
  try {
    data = event.data ? event.data.json() : {};
    console.log('[sw] push data (json):', JSON.stringify(data));
  } catch (e) {
    const raw = event.data ? event.data.text() : '';
    console.log('[sw] push data not JSON, raw:', raw, 'error:', e.message);
    data = { title: 'New message', body: raw };
  }

  const title = data.title || 'VargaFlow';
  const options = {
    body: data.body || 'You have a new message.',
    icon: '/favicon.png',
    badge: '/favicon.png',
    tag: data.tag || 'vargaflow-push',
    renotify: true,
    data: { url: data.url || '/messages' },
  };

  console.log('[sw] calling showNotification, title:', title, 'body:', options.body);
  event.waitUntil(
    self.registration.showNotification(title, options)
      .then(() => console.log('[sw] showNotification resolved'))
      .catch((err) => console.error('[sw] showNotification failed:', err))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/messages';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
