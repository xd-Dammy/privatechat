# v3.7 - works like a real chat app offline

- **Chats and messages are saved on the phone** (Firestore offline storage). Open the app with no data and your chat list and
  history appear straight away; you no longer wait on a loading screen. Your profile also loads from the saved copy first.
- **App opens offline**: the service worker now also saves the libraries the app needs to start (Firebase, Tailwind, icons)
  and your chat photos. Needs one normal online visit first after installing/updating.
- **Offline sending**: messages you send with no network are queued (shown with a small clock) and go out automatically
  when you're back online. An orange "You're offline" bar shows while disconnected.
- **Background download** of your 20 latest chats and 10 latest groups while online, so even chats you didn't open today are ready offline.
- **Fix**: long chats showed the *oldest* 200 messages. They now show the *newest* 200.
- Photos/videos/voice notes still need a connection to send (they upload first).
- Service worker cache `v13`.

---

# v3.6

- **Feed payment, ₦500 / 30 days, via Paystack.** Pay button opens Paystack; the app records the payment reference;
  an admin confirms it in the Paystack dashboard and taps Approve (Admin tab -> "Feed payments to confirm").
  Paying again adds 30 days on to the time left. Setup: `PAYSTACK-SETUP.md`. Automatic version: `later-payment-webhook/`.
- **Push-notification box hidden** in Settings until a Web Push key is set (it was showing a developer message to everyone).
- **Light theme fix**: setting titles were nearly invisible; fixed text colours.
- Publish the new `firestore.rules` (adds `paymentClaims`). Service worker cache `v12`.

---

# v3.4

- **Settings is now a full page** (a tab in the same place as Status / Calls / Discover) instead of a pop-up.
- **Feed (paid)**: new Feed tab. Post text/photo/video, like, delete your own post, and tap **Message** on a post
  to chat with the author (opens the chat if you are contacts, otherwise sends a contact request with a first message).
  Access = a `subscriptions/{uid}` document with an `until` date in the future; **the rules enforce it** (posts can't be
  read or written without it). Admins can grant 30 days / remove access from the Admin tab (calendar / ban icons), or add the
  document by hand in the Console. Payments are NOT wired yet: put a Paystack/Flutterwave payment-page link in
  `FEED_PAYMENT_URL` in `app.js` for the Subscribe button. Automatic activation after payment needs a small server
  function (webhook) later.
- Not in Feed yet: comments, following, video-only scrolling, reporting posts.
- Google sign-in: see `GOOGLE-SIGNIN-DOMAIN.md`. `vercel.json` is back and switched off by `USE_AUTH_PROXY = false`.
- Service worker cache `v10`. Publish the new `firestore.rules`.

---

# v3.3 (merge of v3.2 no-backend + the Push/Google-sign-in build)

Base is v3.2 (no Cloud Functions, no terminal). Added from the other build:
- **Background media sending**: photos, videos and voice notes upload in the background with a progress
  bubble, Cancel and Retry; you can keep chatting meanwhile.
- **Tighter Firestore rules**: private chats limited to the two people (and `recipientId` must be the
  other person), contact entries can only be written in limited ways, groups (members only; admins manage;
  members can only change counters/their own info or leave), calls (only caller creates; candidates limited
  to the two people), statuses (delete now works), message edits limited to `text`/`edited`/`readAt`.
- Rules fix: the "update my name/avatar in everyone's contact list" query (collection group `contacts`)
  was being refused by the old rules, so name/avatar changes never reached other people's lists.
  Needs the one-time index below.
- Admin still = a document at `admins/{uid}`. The rules let admins write contact entries so the in-app
  Broadcast keeps working under the tighter contact rules.
- Service worker cache `v9`; the service worker still ignores `/__/` paths (harmless).

Left out on purpose: `functions/` (Cloud Functions), `vercel.json` auth proxy and the custom-claim admin,
because they need a terminal / Google Cloud Console work. Push code stays in `later-push-notifications/`.

**One-time index (Firebase Console):** Firestore Database -> Indexes -> Single field -> Add exemption:
Collection ID `contacts`, Field `uid`, enable Ascending for both *Collection* and *Collection group*. Save.

---

# What changed in this version

## Google / SEO
- `index.html` is now a public landing page (title, meta description, canonical, social tags, structured data).
- The chat app moved to `app.html` (marked `noindex`, because it is a login screen with nothing for Google to read). `app.js`, `manifest.json`, `sw.js`, `firebase-messaging-sw.js` and `functions/index.js` all point to it.
- `privacy.html` is its own page, `robots.txt` and `sitemap.xml` are included.
- Installed home-screen apps skip the landing page and open `app.html`.
- Service worker cache bumped to `v5` so existing installs pick up the new files.
- Not changed: `app.html` still has `user-scalable=no`. Removing it can make iPhones zoom in when a text field is tapped. The landing and privacy pages allow zoom.

## Admin
- Admin is no longer decided by an email address in `app.js`. It uses a Firebase Auth custom claim (`admin: true`).
- Broadcast now runs in a Cloud Function (`broadcastSupportMessage`) that rejects anyone without the claim.
- Removing a user was already checked by `firestore.rules` through the same claim.

## Deploy
1. Upload everything to Vercel as before.
2. `cd functions && npm install`
3. `firebase deploy --only functions,firestore:rules,firestore:indexes`
4. Grant yourself admin (see top of `functions/set-admin-claim.js`), then sign out and back in:
   `node set-admin-claim.js your-admin-email@example.com`
5. Paste your VAPID key into `app.js` (see `README-PUSH.md`).
6. In Google Search Console: add the site, submit `sitemap.xml`, request indexing for the homepage.
7. If you add a custom domain, replace `private-chatbox-kohl.vercel.app` in `index.html`, `privacy.html`, `robots.txt` and `sitemap.xml`.

## Update: Google sign-in on phones, background media sending, tighter rules

### Google sign-in sent people back to the login page
On phones the app signs in with a redirect. The sign-in pages were on `privatechat-83c05.firebaseapp.com` while the app is on Vercel, and iPhone Safari / recent Chrome block the storage the result comes back through, so the person returned still signed out. Fix: the auth pages are now served from the app's own domain.
- `vercel.json` (new) proxies `/__/auth/*` to Firebase.
- `app.js` uses the Vercel host as `authDomain` (`AUTH_PROXY_HOST` near the top; change it if you add a custom domain).
- `sw.js` never caches `/__/` paths; cache bumped to `v6`.

**One-time setup (cannot be done from the code):**
1. Google Cloud Console -> APIs & Services -> Credentials -> the "Web client (auto created by Google Service)" OAuth client:
   - Authorized redirect URIs: add `https://private-chatbox-kohl.vercel.app/__/auth/handler`
   - Authorized JavaScript origins: add `https://private-chatbox-kohl.vercel.app`
2. Firebase Console -> Authentication -> Settings -> Authorized domains: make sure `private-chatbox-kohl.vercel.app` is listed.
3. Apple sign-in (if used): add the same `/__/auth/handler` URL as a Return URL on the Apple Services ID.
4. Deploy with `vercel.json` in the project root.

### Photos, videos and voice notes now send in the background
Choosing media clears the composer immediately and adds a bubble to the chat with a progress ring and a cancel button. People can keep typing, open other chats or send more messages while it uploads. When it finishes, the bubble becomes the real message. If it fails, the bubble shows Retry and Delete. Closing the tab mid-upload shows a warning. Chat-list previews now say "Photo", "Video" or "Voice note" for captionless media.

### Firestore rules
`firestore.rules` is tightened (private chats limited to the two people, contacts, groups, calls). Also fixed: deleting statuses was always denied, and calls placed in the opposite direction between the same two people were rejected. Added `firestore.indexes.json` for the contact name/avatar update. Deploy with `firebase deploy --only firestore:rules,firestore:indexes`.

Still open: the user document (including email) is readable by every signed-in user, because search and Discover need it; statuses are readable by every signed-in user; Storage rules are not part of this project (media goes to Cloudinary).
