const CACHE_NAME = 'hamesh-cache-v4';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './pdf-lib.min.js',
  './favicon.svg',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs'
];

// حدث التثبيت - تخزين الملفات الأساسية مسبقاً
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching core assets');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// حدث التفعيل - مسح التخزين المؤقت القديم عند ترقية الإصدار
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// حدث جلب الطلبات - أولوية الشبكة لملفات الواجهة والتنقل، وأولوية الكاش للأصول الثابتة
const NETWORK_FIRST = ['./index.html', './styles.css', './app.js'];

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isNavigation = event.request.mode === 'navigate';
  const isAppShell = NETWORK_FIRST.some((file) => url.pathname.endsWith(file.slice(1)));

  if (isNavigation || isAppShell) {
    event.respondWith(
      fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
        }
        return networkResponse;
      }).catch(() =>
        caches.match(event.request).then((cached) => cached || (isNavigation ? caches.match('./index.html') : Response.error()))
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).then((networkResponse) => {
        // تخزين خطوط جوجل بشكل ديناميكي عند جلبها أول مرة
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          (url.origin.includes('fonts.googleapis.com') || url.origin.includes('fonts.gstatic.com'))
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    })
  );
});
