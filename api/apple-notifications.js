// api/apple-notifications.js
// App Store Server Notifications V2. Apple POSTs { signedPayload }.
// The payload is verified against Apple’s certificate chain. Renewal keeps Pro.
// Refund, revoke, expiry and the end of a grace period set the linked account back to Free.
// A notification for a subscription we have not linked (for example a hand-granted Pro
// member, who has no Apple id stored) does not change anyone’s tier.
//
// Point App Store Connect at https://<host>/api/apple-notifications
const K = require('../lib/kernl');
const A = require('../lib/apple');

function bodyOf(req) {
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  return body && typeof body === 'object' ? body : {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!process.env.APPLE_BUNDLE_ID) return res.status(503).json({ error: 'App Store notifications are not configured.' });
    const body = bodyOf(req);
    if (!body.signedPayload || typeof body.signedPayload !== 'string') {
      return res.status(400).json({ error: 'signedPayload is required.' });
    }
    let note;
    try { note = await A.verifySignedPayload(body.signedPayload); }
    catch (e) { return res.status(401).json({ error: 'Notification could not be verified.' }); }

    const data = note.data || {};
    if (data.bundleId && data.bundleId !== process.env.APPLE_BUNDLE_ID) {
      return res.status(401).json({ error: 'Notification is for a different app.' });
    }
    const appId = process.env.APPLE_APP_APPLE_ID;
    if (appId && data.appAppleId != null && String(data.appAppleId) !== String(appId)) {
      return res.status(401).json({ error: 'Notification is for a different app.' });
    }
    const type = note.notificationType || '';
    if (type === 'TEST' || !data.signedTransactionInfo) {
      await A.logNotification(note.notificationUUID, type, null);
      return res.status(200).json({ ok: true });
    }

    let tx;
    try { tx = await A.verifySignedTransaction(data.signedTransactionInfo); }
    catch (e) { return res.status(401).json({ error: 'Transaction in the notification could not be verified.' }); }
    let status = data.status == null ? null : Number(data.status);

    // Ask Apple for the current subscription when we can. A refund, revoke or expiry
    // still wins if that call is briefly behind, so a refund is not left as Pro.
    if (A.appleApiConfigured()) {
      const fresh = await A.fetchSubscriptionState(tx.originalTransactionId, tx.environment);
      if (fresh.ok && !A.INACTIVE_NOTIFICATIONS.has(type)) {
        tx = fresh.tx;
        status = fresh.status;
      }
    }

    const found = await A.profilesForOriginal(tx.originalTransactionId);
    if (!found.ok) return res.status(503).json({ error: 'Could not look up the subscription.' });
    if (!found.rows.length) {
      await A.logNotification(note.notificationUUID, type, tx.originalTransactionId);
      return res.status(200).json({ ok: true, linked: false });
    }
    let tier = null;
    for (const row of found.rows) {
      const saved = await A.saveEntitlement(row.id, tx, type, status);
      if (!saved) return res.status(503).json({ error: 'Could not update the subscription.' });
      tier = saved.tier;
    }
    K.clearAuthCache();
    await A.logNotification(note.notificationUUID, type, tx.originalTransactionId);
    return res.status(200).json({ ok: true, linked: true, tier });
  } catch (e) {
    console.error('[apple-notifications]', e.message);
    return res.status(500).json({ error: 'Notification failed.' });
  }
};
