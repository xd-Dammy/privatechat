// OPTIONAL, for later: makes Feed activate automatically the moment Paystack confirms a payment.
// Needs: a computer with the Firebase CLI, the Blaze (pay-as-you-go) plan, and your Paystack SECRET key.
//   firebase functions:secrets:set PAYSTACK_SECRET_KEY
//   firebase deploy --only functions
// Then in Paystack dashboard -> Settings -> API Keys & Webhooks, set the Webhook URL to the function URL.
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');

initializeApp();
const PAYSTACK_SECRET_KEY = defineSecret('PAYSTACK_SECRET_KEY');
const DAYS = 30, PRICE_KOBO = 50000;

exports.paystackWebhook = onRequest({ secrets: [PAYSTACK_SECRET_KEY] }, async (req, res) => {
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY.value()).update(req.rawBody).digest('hex');
  if (hash !== req.headers['x-paystack-signature']) return res.status(401).send('bad signature');
  const ev = req.body;
  if (ev.event !== 'charge.success' || ev.data?.status !== 'success') return res.sendStatus(200);
  if (ev.data.amount < PRICE_KOBO || ev.data.currency !== 'NGN') return res.sendStatus(200);
  const uid = ev.data.metadata?.uid;
  if (!uid) return res.sendStatus(200);

  const db = getFirestore();
  const ref = ev.data.reference;
  const claimRef = db.collection('paymentClaims').doc(ref);
  const subRef = db.collection('subscriptions').doc(uid);
  await db.runTransaction(async (tx) => {
    const claim = await tx.get(claimRef);
    if (claim.exists && claim.data().status === 'approved') return; // already applied
    const sub = await tx.get(subRef);
    const curMs = sub.exists && sub.data().until ? sub.data().until.toMillis() : 0;
    const start = Math.max(Date.now(), curMs);
    tx.set(subRef, { until: Timestamp.fromMillis(start + DAYS * 86400000), paymentRef: ref, grantedAt: FieldValue.serverTimestamp(), grantedBy: 'paystack-webhook' });
    tx.set(claimRef, { uid, reference: ref, amount: ev.data.amount / 100, status: 'approved', createdAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  res.sendStatus(200);
});
