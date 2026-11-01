// Aux service worker: caches the app shell so the app opens offline-ish and installs as a PWA.
// API calls, the socket and anything from YouTube or Google always go to the network.
const CACHE = 'aux-shell-v5'; // bump when index.html and app.js change together
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first, so a deploy shows up straight away; the cache is only a fallback.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/')))
  );
});

// Push: the server only rings us (no payload), so ask it what happened, then show that.
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let msg = { title: 'Aux', body: 'Something new happened on Aux.', url: '#inbox' };
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        const r = await fetch('/api/push/latest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        if (r.ok) msg = await r.json();
      }
    } catch {}
    await self.registration.showNotification(msg.title, { body: msg.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: msg.url } });
  })());
});

// Tapping a notification opens Aux at the right screen, reusing an open window if there is one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(`/${e.notification.data?.url || '#inbox'}`, self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) { await win.focus(); try { await win.navigate(url); } catch {} return; }
    await self.clients.openWindow(url);
  })());
});
