const CACHE_NAME = 'privatechat-shell-v18';
const RUNTIME_CACHE = 'privatechat-runtime-v1'; // libraries, fonts and chat photos, kept for offline use

// App shell: saved on install so the app opens with no network.
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

// Third-party files the app needs to even start. Saved the first time they load.
// Firestore / Auth / Realtime Database / Cloudinary upload calls are NEVER touched here.
function isLibraryRequest(url) {
  return (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'))
      || url.hostname === 'cdn.tailwindcss.com'
      || url.hostname === 'cdnjs.cloudflare.com';
}
function isChatImage(request, url) {
  return url.hostname === 'res.cloudinary.com' && request.destination === 'image';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== RUNTIME_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Answer from the saved copy at once, and refresh the saved copy in the background.
async function staleWhileRevalidate(request, cacheName, matchOpts) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, matchOpts);
  const network = fetch(request).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  if (cached) return cached;
  const res = await network;
  return res || new Response('', { status: 504, statusText: 'Offline' });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  } catch (_) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    if (isLibraryRequest(url)) {
      event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    } else if (isChatImage(req, url)) {
      event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    }
    return; // everything else (Firebase data, auth, uploads) goes straight to the network
  }

  // Sign-in redirect pages (see vercel.json) must always hit the network.
  if (url.pathname.startsWith('/__/')) return;

  // App shell: ignore ?query so app.html?chat=... opens offline too; update in the background.
  event.respondWith(staleWhileRevalidate(req, CACHE_NAME, { ignoreSearch: true }));
});
