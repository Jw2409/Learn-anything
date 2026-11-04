/* Learn Anything service worker.
 * This tiny program lives on your phone and wakes up when the reminder server
 * sends a push. A push carries no text, so the worker asks the server what to
 * say, then shows it. If the server cannot be reached it still shows a plain
 * reminder, because iPhone requires every push to show something.
 *
 * The server address and your private id come from the way this file is
 * registered (sw.js?w=<server>&id=<id>), so nothing secret is stored here.
 */
const params = new URL(self.location.href).searchParams;
const SERVER = params.get('w') || '';
const ID = params.get('id') || '';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let n = { title: 'Learn Anything', body: 'Your lesson is waiting.' };
    try {
      if (SERVER && ID) {
        const res = await fetch(SERVER + '/n/' + ID, { cache: 'no-store' });
        if (res.ok) {
          const d = await res.json();
          if (d && d.title && d.body) n = { title: String(d.title), body: String(d.body) };
        }
      }
    } catch (e) { /* keep the plain reminder */ }
    await self.registration.showNotification(n.title, {
      body: n.body,
      icon: 'icon.png',
      badge: 'icon.png',
      tag: 'learn-reminder',
      renotify: true,
      data: { url: './' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) return c.focus();
    }
    return self.clients.openWindow('./');
  })());
});
