# Feed payment (₦500 / 30 days) - phone friendly setup

1. Create/sign in to a Paystack account (dashboard.paystack.com) and finish business verification so you can go live.
2. Paystack dashboard -> Settings -> API Keys & Webhooks. Copy the **Public key** (`pk_live_...`;
   use `pk_test_...` first to try it). Do NOT copy or share the Secret key.
3. In `app.js` find `PAYSTACK_PUBLIC_KEY = ""` and paste the public key between the quotes. Upload, bump `sw.js`.
4. Publish the new `firestore.rules` (they add `paymentClaims`).

## How it works today (no server)
- User taps **Pay ₦500 with Paystack**, pays in the Paystack pop-up.
- The app saves a "payment claim" with the Paystack reference.
- You (admin) see it under **Admin -> Feed payments to confirm**. Open Paystack -> Transactions, check the same
  reference is *Success* and ₦500, then tap **Approve**. The user gets 30 days (extra time adds on).
- Safe by design: a claim alone gives no access, only your approval does.

## Automatic later
`later-payment-webhook/` activates Feed the instant Paystack confirms payment, with no approval step.
It needs a computer, the Firebase CLI and the paid Blaze plan.
