// Backup: Paystack calls this itself when a payment succeeds, even if the user closed the app.
// Set the URL in Paystack -> Settings -> API Keys & Webhooks -> Live Webhook URL:
//   https://YOUR-SITE/api/paystack-webhook
// We never trust the request body: we only take the reference and ask Paystack to confirm it.
const { verifyWithPaystack, activate } = require('./_lib');

module.exports = async (req, res) => {
  try {
    const ev = req.body || {};
    if (ev.event === 'charge.success' && ev.data && typeof ev.data.reference === 'string') {
      const v = await verifyWithPaystack(ev.data.reference);
      if (v.ok) await activate(v.uid, ev.data.reference, v.amount);
    }
  } catch (e) { console.error('webhook failed:', e); }
  res.status(200).end(); // always 200 so Paystack doesn't keep retrying
};
