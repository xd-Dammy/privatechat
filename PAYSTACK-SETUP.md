# Feed payment (N500 / 30 days)

## A. Automatic activation (recommended) - runs on your Vercel project, no terminal
After this, a paying user gets Feed within seconds. No approval needed.

1. **Paystack public key** -> `app.js`, `PAYSTACK_PUBLIC_KEY = "pk_live_..."` (Paystack -> Settings -> API Keys & Webhooks).
2. **Firebase service account:** Firebase Console -> Project settings (gear) -> **Service accounts** ->
   **Generate new private key**. A `.json` file downloads. Open it and copy ALL of the text.
3. **Vercel** -> your project -> Settings -> **Environment Variables**. Add two (tick Production):
   - `PAYSTACK_SECRET_KEY` = your Paystack **secret** key (`sk_live_...`)
   - `FIREBASE_SERVICE_ACCOUNT` = the whole JSON text from step 2
4. Upload the new files to GitHub, including the `api/` folder and `package.json`. Vercel redeploys.
   (Environment variables only apply to a NEW deployment, so redeploy after adding them.)
5. **Paystack webhook (backup):** Settings -> API Keys & Webhooks -> Live Webhook URL:
   `https://private-chatbox-kohl.vercel.app/api/paystack-webhook`  -> Save.
6. Publish the latest `firestore.rules`.

Keep the secret key and the service-account JSON ONLY in Vercel. Never put them in app.js or GitHub.

How it works: user pays -> the app calls `/api/verify-payment` -> your server asks Paystack "was this reference paid,
N500+, for this user?" -> if yes it switches Feed on for 30 days (extra time adds on). The webhook does the same if the
user closes the app mid-payment. "I've paid, refresh" re-checks the user's earlier payments too.

## B. Manual fallback (always on)
If the server can't confirm (e.g. step 3 not done yet), the payment is saved as a claim. Admin tab -> "Feed payments to
confirm": check the reference in Paystack -> Transactions, then tap **Approve**.
