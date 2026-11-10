'use strict';
// App Store Server API + StoreKit 2 signed transactions.
//
// Pro is sold only in the iOS app, as an auto-renewable subscription:
//   product id:  com.kernl.pro.annual     (£20 a year, set in App Store Connect)
//   bundle id:   APPLE_BUNDLE_ID          (suggested value: com.kernl.books)
//
// The website never takes payment. A profile becomes Pro only after Apple’s own
// signed record says the subscription is active. The client’s word is not enough.
//
// Environment (Vercel, never commit the key):
//   APPLE_BUNDLE_ID       e.g. com.kernl.books
//   APPLE_ISSUER_ID       App Store Connect issuer id
//   APPLE_KEY_ID          the subscription key id
//   APPLE_PRIVATE_KEY     the .p8 private key, PEM text (real newlines or \n)
//   APPLE_ENVIRONMENT     Sandbox or Production. Tried first; the other is used if Apple says the transaction is not there.
//   APPLE_APP_APPLE_ID    optional numeric app id. When set, notifications must carry the same id.
//
// KERNL_APPLE_TEST and KERNL_APPLE_TEST_ROOT are for the local test suite only.
// They are ignored when VERCEL is set, so a preview deploy cannot trust a stand-in root.

const crypto = require('crypto');
const K = require('./kernl');
const ROOT_PEMS = require('./apple-roots');

const APPLE_PRODUCT_ID = 'com.kernl.pro.annual';
const LEAF_OID = '1.2.840.113635.100.6.11.1';
const INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';
// These end the subscription even if a slightly later status call still looks active.
const INACTIVE_NOTIFICATIONS = new Set(['EXPIRED', 'GRACE_PERIOD_EXPIRED', 'REFUND', 'REVOKE']);

const PINNED_ROOTS = ROOT_PEMS.map(pem => new crypto.X509Certificate(pem));
const SANDBOX_HOST = 'https://api.storekit-sandbox.itunes.apple.com';
const PRODUCTION_HOST = 'https://api.storekit.itunes.apple.com';

let _jwt = null;

function appleTransactionId(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d{4,30}$/.test(s) ? s : '';
}

function appleApiConfigured() {
  const env = process.env.APPLE_ENVIRONMENT;
  return !!(process.env.APPLE_BUNDLE_ID && process.env.APPLE_ISSUER_ID && process.env.APPLE_KEY_ID
    && process.env.APPLE_PRIVATE_KEY && (env === 'Sandbox' || env === 'Production'));
}

function privateKeyPem() {
  let key = String(process.env.APPLE_PRIVATE_KEY || '').trim();
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  if (key && !key.includes('BEGIN')) {
    try {
      const decoded = Buffer.from(key, 'base64').toString('utf8');
      if (decoded.includes('BEGIN')) key = decoded;
    } catch (e) { /* use the original text */ }
  }
  return key;
}

function signJws(header, payload, pem) {
  const data = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(data), { key: pem, dsaEncoding: 'ieee-p1363' });
  return data + '.' + sig.toString('base64url');
}

function appStoreJwt() {
  const now = Math.floor(Date.now() / 1000);
  const kid = process.env.APPLE_KEY_ID;
  if (_jwt && _jwt.kid === kid && _jwt.exp > now + 60) return _jwt.token;
  const token = signJws(
    { alg: 'ES256', kid, typ: 'JWT' },
    { iss: process.env.APPLE_ISSUER_ID, iat: now, exp: now + 300, aud: 'appstoreconnect-v1', bid: process.env.APPLE_BUNDLE_ID },
    privateKeyPem()
  );
  _jwt = { token, exp: now + 300, kid };
  return token;
}

function hostsFor(environment) {
  const preferProduction = (environment || process.env.APPLE_ENVIRONMENT) === 'Production';
  return preferProduction ? [PRODUCTION_HOST, SANDBOX_HOST] : [SANDBOX_HOST, PRODUCTION_HOST];
}

function oidDer(oid) {
  const parts = String(oid).split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    const chunk = [n & 0x7f];
    n >>= 7;
    while (n > 0) { chunk.unshift((n & 0x7f) | 0x80); n >>= 7; }
    out.push.apply(out, chunk);
  }
  return Buffer.from(out);
}

function certHasOid(cert, oid) {
  return cert.raw.indexOf(oidDer(oid)) !== -1;
}

function datesOk(cert) {
  const now = Date.now();
  const skew = 60 * 1000;
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && from <= now + skew && to >= now - skew;
}

function trustedRoots() {
  const roots = PINNED_ROOTS.slice();
  // The stand-in root exists only so the test suite can sign fixtures. Never honoured on Vercel.
  if (process.env.KERNL_APPLE_TEST === '1' && !process.env.VERCEL && process.env.KERNL_APPLE_TEST_ROOT) {
    roots.push(new crypto.X509Certificate(process.env.KERNL_APPLE_TEST_ROOT));
  }
  return roots;
}

// Verifies an Apple JWS (transaction, notification, or renewal info) against the pinned roots.
// The payload is returned only after the certificate chain and the signature both check out.
async function verifySignedPayload(jws) {
  const parts = String(jws || '').split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  if (!header || header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length !== 3) throw new Error('header');
  const leaf = new crypto.X509Certificate(Buffer.from(header.x5c[0], 'base64'));
  const intermediate = new crypto.X509Certificate(Buffer.from(header.x5c[1], 'base64'));
  const root = trustedRoots().find(candidate => {
    try { return intermediate.checkIssued(candidate) && datesOk(candidate); } catch (e) { return false; }
  });
  if (!root || !intermediate.ca || !datesOk(intermediate) || !datesOk(leaf) || !leaf.checkIssued(intermediate)) throw new Error('chain');
  if (!certHasOid(leaf, LEAF_OID) || !certHasOid(intermediate, INTERMEDIATE_OID)) throw new Error('oid');
  const signingInput = Buffer.from(parts[0] + '.' + parts[1]);
  const sig = Buffer.from(parts[2], 'base64url');
  if (!crypto.verify('sha256', signingInput, { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, sig)) throw new Error('signature');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload');
  return payload;
}

async function verifySignedTransaction(jws) {
  const tx = await verifySignedPayload(jws);
  const bundle = process.env.APPLE_BUNDLE_ID || '';
  if (!bundle || tx.bundleId !== bundle) throw new Error('bundle');
  if (tx.environment !== 'Sandbox' && tx.environment !== 'Production') throw new Error('environment');
  if (!appleTransactionId(tx.transactionId) || !appleTransactionId(tx.originalTransactionId)) throw new Error('id');
  return tx;
}

function isEntitled(tx, notificationType, status) {
  if (!tx) return false;
  if (notificationType && INACTIVE_NOTIFICATIONS.has(notificationType)) return false;
  if (status === 2 || status === 5) return false;
  if (tx.revocationDate) return false;
  if (tx.productId !== APPLE_PRODUCT_ID) return false;
  if (tx.type && tx.type !== 'Auto-Renewable Subscription') return false;
  if (tx.bundleId && process.env.APPLE_BUNDLE_ID && tx.bundleId !== process.env.APPLE_BUNDLE_ID) return false;
  if (status === 4) return true;
  const exp = Number(tx.expiresDate || 0);
  return Number.isFinite(exp) && exp > Date.now();
}

function entitlementStatus(tx, notificationType, status) {
  const entitled = isEntitled(tx, notificationType, status);
  let label = 'expired';
  if (entitled) label = 'active';
  else if (tx && (tx.revocationDate || notificationType === 'REFUND' || notificationType === 'REVOKE' || status === 5)) label = 'revoked';
  return { entitled, label };
}

async function appleGet(pathname, environment) {
  let token;
  try { token = appStoreJwt(); } catch (e) { return { ok: false, error: true }; }
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  let sawNotFound = false;
  for (const host of hostsFor(environment)) {
    let res, text;
    try {
      res = await fetch(host + pathname, { headers });
      text = await res.text();
    } catch (e) {
      return { ok: false, error: true };
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (res.ok && data) return { ok: true, data };
    const code = data && data.errorCode;
    if (res.status === 404 || code === 4040010 || code === 4040001 || code === 4040002) { sawNotFound = true; continue; }
    return { ok: false, error: true };
  }
  return sawNotFound ? { ok: false, notFound: true } : { ok: false, error: true };
}

async function fetchAppleTransaction(transactionId, environment) {
  const id = appleTransactionId(transactionId);
  if (!id) return { ok: false, error: true };
  const got = await appleGet('/inApps/v1/transactions/' + id, environment);
  if (!got.ok) return got;
  if (!got.data || typeof got.data.signedTransactionInfo !== 'string') return { ok: false, error: true };
  try {
    const tx = await verifySignedTransaction(got.data.signedTransactionInfo);
    if (tx.transactionId !== id) return { ok: false, error: true };
    return { ok: true, tx };
  } catch (e) {
    return { ok: false, error: true };
  }
}

// Current state of a subscription, from Apple, using the original transaction id.
async function fetchSubscriptionState(originalTransactionId, environment) {
  const id = appleTransactionId(originalTransactionId);
  if (!id) return { ok: false, error: true };
  const got = await appleGet('/inApps/v1/subscriptions/' + id, environment);
  if (!got.ok) return got;
  const groups = got.data && Array.isArray(got.data.data) ? got.data.data : [];
  let best = null;
  for (const group of groups) {
    const items = group && Array.isArray(group.lastTransactions) ? group.lastTransactions : [];
    for (const item of items) {
      if (!item || typeof item.signedTransactionInfo !== 'string') continue;
      let tx;
      try { tx = await verifySignedTransaction(item.signedTransactionInfo); } catch (e) { continue; }
      if (tx.originalTransactionId !== id) continue;
      if (!best || Number(tx.expiresDate || 0) > Number(best.tx.expiresDate || 0)) best = { tx, status: Number(item.status) };
    }
  }
  return best ? { ok: true, tx: best.tx, status: best.status } : { ok: false, notFound: true };
}

async function profilesForOriginal(originalTransactionId) {
  const id = appleTransactionId(originalTransactionId);
  if (!id) return { ok: false, rows: [] };
  const r = await K.sb('/rest/v1/profiles?select=id,tier&apple_original_transaction_id=eq.' + encodeURIComponent(id) + '&limit=5');
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, rows: [] };
  return { ok: true, rows: r.data };
}

async function saveEntitlement(userId, tx, notificationType, status) {
  const decided = entitlementStatus(tx, notificationType, status);
  const body = {
    tier: decided.entitled ? 'pro' : 'free',
    apple_original_transaction_id: tx.originalTransactionId,
    apple_product_id: tx.productId || null,
    apple_expires_at: tx.expiresDate ? new Date(Number(tx.expiresDate)).toISOString() : null,
    apple_environment: tx.environment || null,
    apple_status: decided.label,
    apple_transaction_id: tx.transactionId || null
  };
  const r = await K.sb('/rest/v1/profiles?id=eq.' + encodeURIComponent(userId), {
    method: 'PATCH', prefer: 'return=representation', body
  });
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return null;
  return { tier: body.tier, status: decided.label, expiresAt: body.apple_expires_at, active: decided.entitled };
}

async function logNotification(uuid, type, originalTransactionId) {
  if (!uuid) return;
  try {
    await K.sb('/rest/v1/apple_notifications', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        notification_uuid: String(uuid).slice(0, 80),
        notification_type: type || null,
        original_transaction_id: originalTransactionId || null,
        received_at: new Date().toISOString()
      }
    });
  } catch (e) { /* the profile update is the part that must succeed */ }
}

module.exports = {
  APPLE_PRODUCT_ID, INACTIVE_NOTIFICATIONS,
  appleTransactionId, appleApiConfigured, signJws,
  verifySignedPayload, verifySignedTransaction, isEntitled, entitlementStatus,
  fetchAppleTransaction, fetchSubscriptionState, profilesForOriginal, saveEntitlement, logNotification
};
