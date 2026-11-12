# Later: push notifications (needs a computer)

This folder is NOT needed for the app to work. Use it when you have a computer with Node.js and the Firebase CLI. Copy `index.js` and `package.json` into a folder named `functions`, add `"functions": {"source": "functions"}` to `firebase.json`, and the project must be on the Blaze plan.

# PrivateChat Push Notifications

The project now contains the web FCM client, background service worker, Firestore token rules, and Firebase Functions that send message notifications.

## One required Firebase setting

1. Open Firebase Console → Project settings → Cloud Messaging.
2. Under Web Push certificates, generate a key pair if one does not already exist.
3. Copy the **public** key.
4. Open `app.js` and replace:

   `PASTE_YOUR_FIREBASE_WEB_PUSH_PUBLIC_KEY_HERE`

   with the public VAPID key.

Do not put the VAPID **private** key in the app.

## Deploy

From the project root:

```bash
firebase login
firebase use privatechat-83c05
firebase deploy --only firestore:rules,functions
```

If the Firebase CLI asks to enable the required APIs, allow it.

The Functions folder uses the Firebase Admin SDK. It sends a notification when a new private or group message is created and removes stale FCM tokens when Firebase reports that a device token is no longer registered.

## Hosting requirement

Web FCM requires HTTPS (localhost is also suitable for local development). Users must grant browser notification permission. On supported iPhone/iPad browsers, web push also requires the web app to be installed as a Home Screen web app.
