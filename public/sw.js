// Minimaler Service Worker. Er ist nur da, damit Android die Seite als App
// installierbar ansieht – erst dann taucht sie im Teilen-Menü auf
// (Web Share Target). Absichtlich **kein** Zwischenspeicher: die App lebt von
// aktuellen Daten, und ein veralteter Cache wäre nur eine Fehlerquelle.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  // Alles direkt aus dem Netz. Der Handler muss existieren, mehr nicht.
  event.respondWith(fetch(event.request));
});
