// Called by the app right after Paystack says "paid" (and by the "I've paid, refresh" button).
// Checks the payment with Paystack, then switches Feed on for that user. No manual approval needed.
const { getAdmin, verifyWithPaystack, activate } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ ok: false, error: 'not signed in' });
    const decoded = await getAdmin().auth().verifyIdToken(m[1]);
    const reference = req.body && req.body.reference;
    if (!reference || typeof reference !== 'string') return res.status(400).json({ ok: false, error: 'missing reference' });

    const v = await verifyWithPaystack(reference);
    if (!v.ok) return res.status(200).json({ ok: false, error: v.reason });
    if (v.uid !== decoded.uid) return res.status(403).json({ ok: false, error: 'this payment belongs to another account' });

    const r = await activate(decoded.uid, reference, v.amount);
    return res.status(200).json({ ok: true, already: r.already });
  } catch (e) {
    console.error('verify-payment failed:', e);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
};
