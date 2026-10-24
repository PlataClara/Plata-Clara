// Plata Clara - service worker
// Estrategia: red primero (siempre intenta bajar lo último), caché solo si no hay internet.
const CACHE = 'plata-clara-v7';
const BASE = ['./', 'index.html', 'config.js', 'cloud.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'badge.png', 'apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(BASE); }).catch(function () {}));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    // 'no-cache' obliga a validar con el servidor y salta la caché HTTP de GitHub Pages
    fetch(req, { cache: 'no-cache' })
      .then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('index.html'); });
      })
  );
});

// ---- Avisos de cuotas (notificaciones push) ----
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) { list.forEach(function (c) { c.postMessage({ type: 'pc-push' }); }); }));
  e.waitUntil(self.registration.showNotification(d.title || 'Plata Clara', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'badge.png',
    vibrate: [250, 120, 250, 120, 500],
    lang: 'es',
    silent: false,
    tag: d.tag || 'plata-clara',
    renotify: true,
    data: { url: d.url || './#deudas' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './#deudas', self.location).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.split('#')[0] === url.split('#')[0] && 'focus' in c) {
        return c.focus().then(function (w) { try { return w.navigate(url); } catch (err) {} });
      }
    }
    return self.clients.openWindow(url);
  }));
});
