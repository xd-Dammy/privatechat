/* Firebase Cloud Messaging background service worker. */
importScripts('https://www.gstatic.com/firebasejs/12.16.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.16.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAN2iDg0QJaUweMmgKHkN53j5qCvE6lfMM",
  authDomain: "privatechat-83c05.firebaseapp.com",
  projectId: "privatechat-83c05",
  storageBucket: "privatechat-83c05.firebasestorage.app",
  messagingSenderId: "738424965551",
  appId: "1:738424965551:web:65453174b7b2179ba7c75a"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || payload.data?.title || 'PrivateChat';
  const body = payload.notification?.body || payload.data?.body || 'You have a new message';
  const url = payload.data?.url || './app.html';

  self.registration.showNotification(title, {
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url },
    tag: payload.data?.messageId || 'privatechat-message',
    renotify: true
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './app.html', self.location.origin).href;
  event.waitUntil((async () => {
    const clientsList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(url);
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(url);
  })());
});
