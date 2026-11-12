# Google sign-in and your domain

Why people sometimes come back to the login page: your app is on `private-chatbox-kohl.vercel.app`
but Firebase's sign-in pages are on `privatechat-83c05.firebaseapp.com`. A *popup* sign-in works across
domains. A *redirect* sign-in does not on iPhone Safari / recent Chrome (they block the storage the
result comes back through). The app tries the popup first and only uses the redirect when it must
(home-screen installed app, popup blocked).

## Always required (any domain, including a new custom one)
Firebase Console -> Authentication -> Settings -> **Authorized domains** -> add your site's domain
(e.g. `private-chatbox-kohl.vercel.app` and your custom domain). If it is missing, sign-in fails.

## To make the redirect fallback work too (one time, use "Desktop site" on a phone)
1. Google Cloud Console -> APIs & Services -> Credentials -> "Web client (auto created by Google Service)":
   - Authorized JavaScript origins: add `https://YOUR-SITE`
   - Authorized redirect URIs: add `https://YOUR-SITE/__/auth/handler`
2. Keep `vercel.json` in the project root (it is in this zip) and upload it with the site.
3. In `app.js` set `USE_AUTH_PROXY = true` (and `AUTH_PROXY_HOST` to your domain if it is not the Vercel one).
4. Bump the number in `sw.js`, upload, sign out and test on an iPhone.
5. Apple sign-in: add the same `/__/auth/handler` URL as a Return URL on the Apple Services ID.

If you move to a custom domain later, repeat steps 1-3 with the new domain and also replace the old
domain in `index.html`, `privacy.html`, `robots.txt`, `sitemap.xml`.
