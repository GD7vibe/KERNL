// api/delete-account.js
// Deletes the signed-in account. Apple requires an in-app way to do this.
// POST { confirm: "DELETE" } with the user's access token.
// Cancelling an App Store subscription is separate: that is done in iOS Settings.
const K = require('../lib/kernl');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const ctx = await K.authenticate(req);
    if (!ctx || !ctx.user) return res.status(401).json({ code: 'auth_required', error: 'Please sign in.' });
    if (ctx.user.anonymous || ctx.tier === 'guest') {
      return res.status(403).json({ code: 'signup_required', error: 'Create an account before you can delete one.' });
    }
    if (!req.body || req.body.confirm !== 'DELETE') return res.status(400).json({ error: 'Confirmation required.' });
    const id = String(ctx.user.id || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return res.status(400).json({ error: 'Account could not be deleted.' });
    if (K.rateLimited('del:' + id, 5, 60 * 60 * 1000)) return res.status(429).json({ error: 'Please wait and try again.' });

    const enc = encodeURIComponent(id);
    // title_creations may not exist until sql/03 is run. A missing table must not block deletion.
    await K.sb('/rest/v1/title_creations?user_id=eq.' + enc, { method: 'DELETE', prefer: 'return=minimal' });
    const library = await K.sb('/rest/v1/user_library?user_id=eq.' + enc, { method: 'DELETE', prefer: 'return=minimal' });
    if (!library.ok && library.status !== 404) return res.status(502).json({ error: 'Could not delete the library.' });
    const profile = await K.sb('/rest/v1/profiles?id=eq.' + enc, { method: 'DELETE', prefer: 'return=minimal' });
    if (!profile.ok && profile.status !== 404) return res.status(502).json({ error: 'Could not delete the account.' });
    const auth = await K.deleteAuthUser(id);
    if (!auth) return res.status(502).json({ error: 'Could not delete the account. Email duffgaryduff@hotmail.com and we will remove it.' });
    K.clearAuthCache(req);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[delete-account]', e.message);
    return res.status(500).json({ error: 'Could not delete the account.' });
  }
};
