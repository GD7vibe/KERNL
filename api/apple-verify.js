// api/apple-verify.js
// The iOS app calls this after a StoreKit 2 purchase or restore.
//   POST { signedTransaction?, transactionId }
//   Authorization: Bearer <Supabase access token>
//
// signedTransaction is the JWS from Transaction.jwsRepresentation. transactionId is the
// StoreKit transaction id. At least one is required. This route asks Apple’s App Store
// Server API for that transaction and only then changes profiles.tier. A body that merely
// says tier:"pro" does nothing.
//
// Product id: com.kernl.pro.annual (£20 a year). Bundle id comes from APPLE_BUNDLE_ID.
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
    if (!A.appleApiConfigured()) {
      return res.status(503).json({ code: 'apple_not_configured', error: 'App Store verification is not configured.' });
    }
    const ctx = await K.authenticate(req);
    if (!ctx || !ctx.user) return res.status(401).json({ code: 'auth_required', error: 'Please sign in.' });
    if (ctx.user.anonymous || ctx.tier === 'guest') {
      return res.status(403).json({ code: 'signup_required', error: 'Create an account before restoring a subscription.' });
    }
    if (K.rateLimited('apple:' + ctx.user.id, 30, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }

    const body = bodyOf(req);
    let hinted = null;
    if (body.signedTransaction != null && body.signedTransaction !== '') {
      if (typeof body.signedTransaction !== 'string' || body.signedTransaction.length < 20 || body.signedTransaction.length > 20000) {
        return res.status(400).json({ code: 'invalid_transaction', error: 'The App Store receipt could not be read.' });
      }
      try { hinted = await A.verifySignedTransaction(body.signedTransaction); }
      catch (e) { return res.status(400).json({ code: 'invalid_transaction', error: 'The App Store receipt could not be verified.' }); }
    }
    const fromBody = A.appleTransactionId(body.transactionId);
    const transactionId = fromBody || (hinted && hinted.transactionId);
    if (!transactionId) return res.status(400).json({ error: 'A transaction id or a signed App Store receipt is required.' });
    if (hinted && fromBody && fromBody !== hinted.transactionId) {
      return res.status(400).json({ code: 'invalid_transaction', error: 'The receipt does not match that transaction.' });
    }

    // Apple’s copy is the one that counts. The signed receipt from the phone is only a hint.
    const fetched = await A.fetchAppleTransaction(transactionId, (hinted && hinted.environment) || process.env.APPLE_ENVIRONMENT);
    if (fetched.notFound) return res.status(400).json({ code: 'transaction_not_found', error: 'Apple has no record of that transaction.' });
    if (!fetched.ok) return res.status(503).json({ code: 'apple_unavailable', error: 'Apple could not be reached. Please try again.' });
    const tx = fetched.tx;
    if (hinted && hinted.originalTransactionId !== tx.originalTransactionId) {
      return res.status(400).json({ code: 'invalid_transaction', error: 'The receipt does not match Apple’s record.' });
    }
    if (tx.productId !== A.APPLE_PRODUCT_ID) {
      return res.status(403).json({ code: 'wrong_product', error: 'That purchase is not KERNL Pro.' });
    }

    const found = await A.profilesForOriginal(tx.originalTransactionId);
    if (!found.ok) return res.status(503).json({ error: 'Could not check the subscription. Please try again.' });
    if (found.rows.some(p => p.id !== ctx.user.id)) {
      return res.status(409).json({ code: 'subscription_in_use', error: 'That App Store subscription is already on another KERNL account.' });
    }

    const decided = A.entitlementStatus(tx, tx.revocationDate ? 'REVOKE' : null, null);
    const alreadyLinked = found.rows.some(p => p.id === ctx.user.id);
    // An expired receipt must not knock a hand-granted Pro account back to Free.
    if (!decided.entitled && !alreadyLinked) {
      return res.status(403).json({ code: 'subscription_inactive', error: 'That subscription is not active.' });
    }
    const saved = await A.saveEntitlement(ctx.user.id, tx, decided.entitled ? null : (tx.revocationDate ? 'REVOKE' : 'EXPIRED'), null);
    if (!saved) return res.status(503).json({ error: 'Could not update your account.' });
    K.clearAuthCache(req);
    return res.status(200).json({
      ok: true,
      tier: saved.tier,
      active: saved.active,
      productId: A.APPLE_PRODUCT_ID,
      expiresAt: saved.expiresAt,
      originalTransactionId: tx.originalTransactionId
    });
  } catch (e) {
    console.error('[apple-verify]', e.message);
    return res.status(500).json({ error: 'Could not verify the subscription.' });
  }
};
