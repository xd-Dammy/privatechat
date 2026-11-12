// Shared helpers for the payment functions (Vercel serverless, runs on your Vercel project).
// Vercel environment variables needed:
//   PAYSTACK_SECRET_KEY        Paystack secret key (sk_live_... / sk_test_...). NEVER put it in app.js.
//   FIREBASE_SERVICE_ACCOUNT   the whole service-account JSON (Firebase -> Project settings -> Service accounts)
const admin = require('firebase-admin');

const DAYS = 30;
const PRICE_KOBO = 50000; // N500

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin;
}

// Ask Paystack (with the secret key) whether this reference really was paid.
async function verifyWithPaystack(reference) {
  const res = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
    headers: { Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status || !body.data) return { ok: false, reason: body.message || 'verify failed' };
  const d = body.data;
  if (d.status !== 'success') return { ok: false, reason: 'payment status: ' + d.status };
  if (d.currency !== 'NGN' || d.amount < PRICE_KOBO) return { ok: false, reason: 'amount too low' };
  const uid = d.metadata && d.metadata.uid;
  if (!uid) return { ok: false, reason: 'no uid on payment' };
  return { ok: true, uid, amount: d.amount / 100 };
}

// Give DAYS days (added on to any time left). Safe to call twice for the same reference.
async function activate(uid, reference, amount) {
  const a = getAdmin();
  const db = a.firestore();
  const claimRef = db.collection('paymentClaims').doc(reference);
  const subRef = db.collection('subscriptions').doc(uid);
  let already = false;
  await db.runTransaction(async (tx) => {
    const claim = await tx.get(claimRef);
    if (claim.exists && claim.data().status === 'approved') { already = true; return; }
    const sub = await tx.get(subRef);
    const curMs = sub.exists && sub.data().until ? sub.data().until.toMillis() : 0;
    const start = Math.max(Date.now(), curMs);
    const FV = a.firestore.FieldValue;
    tx.set(subRef, {
      until: a.firestore.Timestamp.fromMillis(start + DAYS * 86400000),
      paymentRef: reference, grantedAt: FV.serverTimestamp(), grantedBy: 'paystack-auto'
    });
    tx.set(claimRef, { uid, reference, amount, status: 'approved', approvedBy: 'paystack-auto', createdAt: FV.serverTimestamp() }, { merge: true });
  });
  return { already };
}

module.exports = { getAdmin, verifyWithPaystack, activate };
