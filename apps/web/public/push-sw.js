/* Web Push handlers, pulled into the generated Workbox service worker via workbox.importScripts. */
self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { title: 'Jorcord', body: event.data ? event.data.text() : '' }; }
  const title = p.title || 'Jorcord';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // The app shows its own in-app notification while a tab is visible and focused.
    if (wins.some((c) => c.visibilityState === 'visible' && c.focused)) return;
    await self.registration.showNotification(title, {
      body: p.body || '', tag: p.tag || 'jorcord', renotify: true, icon: self.registration.scope + 'icon-192.png', badge: self.registration.scope + 'icon-192.png',
      data: { guildId: p.guildId || null, channelId: p.channelId || null, messageId: p.messageId || null, kind: p.kind || 'message' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const path = d.channelId ? `/channels/${d.guildId || '@me'}/${d.channelId}` : '/channels/@me';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if ('focus' in c) { await c.focus(); c.postMessage({ type: 'jorcord:goto', guildId: d.guildId || null, channelId: d.channelId || null }); return; }
    }
    await self.clients.openWindow(self.registration.scope.replace(/\/$/, '') + path);
  })());
});
