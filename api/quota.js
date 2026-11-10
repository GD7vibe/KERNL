// api/quota.js — how many library books and new titles this account has left.
// GET → { tier, library: { used, limit, remaining }, creations: { used, limit, remaining } }
// The library numbers are LIMITS (guest 12, free 36, pro 200). Creations are the separate
// Pro cap of TITLE_CREATION_LIMIT new catalogue titles per rolling 12 months. Free is 0.
const K = require('../lib/kernl');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const ctx = await K.authenticate(req);
    if (!ctx || !ctx.user) return res.status(401).json({ code: 'auth_required', error: 'Please sign in.' });
    const limit = K.limitFor(ctx.tier);
    const [profile, owned] = await Promise.all([K.getProfile(ctx.user.id), K.getOwnedIds(ctx.user.id)]);
    const used = Math.max(profile ? (profile.downloads_used || 0) : 0, owned.size);
    const library = { used, limit, remaining: Math.max(0, limit - used) };
    let creations;
    if (ctx.tier === 'pro') {
      creations = await K.creationQuota(ctx.user.id);
      if (!creations) {
        return res.status(503).json({
          code: 'creation_unavailable', tier: ctx.tier, library,
          error: 'New-title allowance could not be loaded.'
        });
      }
    } else {
      creations = { used: 0, limit: 0, remaining: 0 };
    }
    return res.status(200).json({ tier: ctx.tier, library, creations });
  } catch (e) {
    console.error('[quota]', e.message);
    return res.status(500).json({ error: 'Could not load your allowance.' });
  }
};
