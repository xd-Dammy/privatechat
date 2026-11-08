# Firebase Console steps (phone friendly, no terminal)

You only need a browser. Open https://console.firebase.google.com, sign in as
damizzy2025@gmail.com and open the project **privatechat-83c05**.
If the menu is cramped, switch Safari to "Desktop Website" (aA button).

Do the steps in this order.

## Step 0 - Save the current rules (safety copy)
1. Left menu: **Build -> Firestore Database -> Rules** tab.
2. Press and hold in the rules box, Select All, Copy.
3. Paste into the Notes app and save it. If anything ever breaks you can paste it back.

## Step 1 - Find the UID of each admin
Each admin must already have signed up in the app.
1. Left menu: **Build -> Authentication -> Users**.
2. Find the person by email. Copy the long **User UID** next to it.
   - damizzy2025@gmail.com
   - omokoredeariyo@gmail.com

## Step 2 - Make them admin (one document each)
1. Left menu: **Build -> Firestore Database -> Data** tab.
2. Tap **Start collection** (or **+ Start collection**).
3. Collection ID: `admins` -> Next.
4. Document ID: paste the person's **User UID** (not their email).
5. Add one field (Firestore needs at least one): Field `note`, Type `string`, Value `admin`.
6. Save.
7. For the second person: open the `admins` collection and tap **Add document**, then repeat 4-6 with that person's UID.

To remove an admin later, delete their document from `admins`. That is all.

## Step 3 - Publish the new rules
1. Back to the **Rules** tab.
2. Delete everything in the box.
3. Open `firestore.rules` from this zip (Files app -> tap the file) and copy ALL of it.
4. Paste it into the Rules box.
5. Tap **Publish**. Wait for the "published" message.

## Step 3b - Add the contacts index (needed once)
1. **Firestore Database -> Indexes** tab -> **Single field** -> **Add exemption**.
2. Collection ID: `contacts`. Field path: `uid`.
3. Tick **Ascending** under both *Collection* and *Collection group*. Save, wait until it says Enabled.
(Without it, changing your name/avatar will not update it in other people's contact lists.)

## Step 4 - Upload the site to Vercel
Upload all the files in this zip (except the folder `later-push-notifications`,
which is only for later) to your GitHub repository, replacing the old ones.
Vercel redeploys on its own.

## Step 5 - Test
1. Open the app, sign out and sign in again.
2. As an admin you should see the Admin tab (user list and broadcast).
3. Sign in as a normal user: there must be no Admin tab.
4. Send a normal chat message to check chatting still works.

If you see "Missing or insufficient permissions", tell me exactly where it
appears and what you were doing, or paste back the rules you saved in Step 0.

## Google search (do after the site is live)
1. Go to https://search.google.com/search-console and add the property
   https://private-chatbox-kohl.vercel.app
2. Verify it (the HTML tag method is easiest: it gives you a `<meta>` tag to put in the
   `<head>` of `index.html`; send it to me and I will add it).
3. Open **Sitemaps** and submit `sitemap.xml`.
4. Open **URL inspection**, paste the homepage address, tap **Request indexing**.
