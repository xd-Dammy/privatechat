const CACHE_NAME = 'privatechat-shell-v11';

// Only cache the static app shell — never cache Firebase/API calls,
// so chat data, auth state, and presence always stay live.
const SHELL_FILES = [
  './',
  './index.html',
  './app.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './firebase-messaging-sw.js',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept Firebase/Google/external API calls — those must always hit the network.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Firebase auth pages are proxied through this origin (see vercel.json).
  // Sign-in redirects must always go to the network, never the cache.
  if (url.pathname.startsWith('/__/')) {
    return;
  }

  // App shell files: cache-first, falling back to network.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).catch(() => cached);
    })
  );
});
