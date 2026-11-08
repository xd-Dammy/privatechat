# How PrivateChat works (read this when I am not around)

You do not need a server of your own. The app is two things:

1. **The site files** (this zip), hosted on Vercel. They run inside the user's phone browser.
2. **Firebase** (project `privatechat-83c05`), run by Google, which stores accounts and data.

The code in the browser talks directly to Firebase. The **rules** in `firestore.rules`
are the only thing that decides who may read or write what. The browser is never trusted.

## 1. The files

| File | What it is |
|---|---|
| `index.html` | Public landing page (this is what Google shows in search) |
| `app.html` | The chat app itself: all the screens (login, chats, status, calls, admin) |
| `app.js` | All the app logic, about 3,600 lines, in one file |
| `styles.css` | Extra styling (most styling is Tailwind classes inside `app.html`) |
| `firestore.rules` | The security rules you paste into Firebase Console -> Rules |
| `sw.js` | Service worker: caches the app files so it opens fast. **Bump the version number in its first line every time you change files**, or phones keep the old copy |
| `manifest.json` | Lets people "Add to Home Screen" |
| `privacy.html`, `robots.txt`, `sitemap.xml` | Privacy page and Google search helpers |
| `later-push-notifications/` | Server code for background alerts (needs a computer and a paid Firebase plan) |

## 2. The data (Firestore) - think of folders and papers

- `users/{uid}` - one paper per person: name, email, appNumber, avatar.
  - `users/{uid}/contacts/{otherUid}` - their contact list entries.
- `chats/{uidA_uidB}/messages/{id}` - private messages. The folder name is both user IDs
  sorted and joined with `_` (see `chatIdFor` in `app.js`). The rules use that name to
  allow only those two people.
- `groups/{id}` and `groups/{id}/messages/{id}` - group chats.
- `statuses/{id}` - 24-hour statuses.
- `calls/{id}` - call set-up information.
- `admins/{uid}` - **an admin is just a paper here.** You add it by hand in the Console.

## 3. How login works

1. The user taps a button on the login page (`app.html`).
2. `handleAuthSubmit` (email) or `handleGoogleSignIn` (Google) in `app.js` asks Firebase Authentication to sign in.
3. Firebase tells the app a user is signed in by calling the function inside `onAuthStateChanged`.
   **This is the heart of the app.** Search for it in `app.js`.
4. That function loads the user's `users/{uid}` paper, then calls `showMainApp()` and
   starts every `listenTo...` function.
5. If nobody is signed in, it calls `showLoginPage()`.

## 4. How a message travels

1. You type and tap send: `sendMessage` in `app.js` builds a message and saves it with `addDoc`
   into `chats/{chatId}/messages`.
2. The other person's phone has a **live listener** (`listenToMessages` uses `onSnapshot`)
   on that same folder, so Firebase pushes the new message to it instantly.
3. `renderMessages` draws the messages on the screen.

Key idea: the app does not "fetch messages again". It **subscribes**, and Firebase calls
your function whenever the data changes.

## 5. Where to change what

| I want to... | Look here |
|---|---|
| Change a screen's layout or text | `app.html` (search for the text) |
| Change colours | Tailwind classes in `app.html`, or `styles.css` |
| Change what happens on a button | find its `onclick="name()"` in `app.html`, then `window.name = ` in `app.js` |
| Add an admin | Firebase Console -> Firestore -> `admins` -> add document with their UID |
| Change who can read/write data | `firestore.rules`, then paste into Console -> Rules -> Publish |
| Make users get the new version | edit files, bump the number in `sw.js`, upload to GitHub |

## 6. How to debug on a phone

1. Open `https://private-chatbox-kohl.vercel.app/app.html?debug=1` once. A red strip at the
   bottom of the screen now shows errors.
2. "Missing or insufficient permissions" means **the rules refused it** - fix `firestore.rules`.
3. "auth/..." errors come from sign-in - check Firebase Console -> Authentication.
4. If nothing changed after you uploaded, you forgot to bump `sw.js` (old files cached).

## 7. Words you will meet

- **Authentication**: proving who you are (login). Firebase does it.
- **UID**: the long unique ID Firebase gives each account.
- **Firestore**: the database (collections = folders, documents = papers).
- **Listener (`onSnapshot`)**: "tell me every time this data changes".
- **Rules**: the server-side gatekeeper. Anything in the browser can be edited by a hacker;
  rules cannot.
- **Service worker**: a helper script that caches files so the app opens fast.
- **Deploy**: uploading new files so Vercel serves them.

## 8. Honest limits to remember

- Messages are **not end-to-end encrypted** yet. Do not claim "100% private" until they are.
- Contact entries and call data still have loose rules (see `CHANGES.md`).
