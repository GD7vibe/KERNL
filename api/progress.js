// api/progress.js — listening progress for signed-in readers (free and Pro). Guests are asked to sign up.
// GET  ?id=<summary id>                    -> { pos, dur, pct, listens, finished }
// POST { id, pos, dur, done }              -> { ok, pct, listens, finished }
//   pos/dur in seconds. done:true is sent once per listen when the reader reaches the end (95%+):
//   it adds one to the listen count and marks the book finished.
const K = require('../lib/kernl');

const COLS = 'id,listen_pos,listen_dur,listen_pct,listens,finished_at';
const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const ctx = await K.authenticate(req);
    if (!ctx || !ctx.user) return res.status(401).json({ code: 'auth_required', error: 'Please sign in.' });
    if (ctx.tier === 'guest') return res.status(403).json({ code: 'signup_required', error: 'Create a free account to keep your place on every device.' });

    const body = req.method === 'POST' ? (req.body || {}) : {};
    const id = String((req.method === 'GET' ? (req.query || {}).id : body.id) ?? '');
    if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ error: 'id required' });

    const where = 'user_id=eq.' + encodeURIComponent(ctx.user.id) + '&summary_id=eq.' + id;
    const got = await K.sb('/rest/v1/user_library?select=' + COLS + '&' + where + '&order=id.asc&limit=1');
    const row = got.ok && Array.isArray(got.data) ? got.data[0] : null;

    if (req.method === 'GET') {
      if (!row) return res.status(200).json({ pos: 0, dur: null, pct: 0, listens: 0, finished: false });
      return res.status(200).json({ pos: row.listen_pos || 0, dur: row.listen_dur || null, pct: row.listen_pct || 0, listens: row.listens || 0, finished: !!row.finished_at });
    }

    if (!row) return res.status(404).json({ code: 'not_in_library', error: 'Open this book first.' });
    if (K.rateLimited('prog:' + ctx.user.id, 120, 60 * 1000)) return res.status(429).json({ error: 'Too many updates' });

    const dur = num(body.dur, 4 * 3600), pos = num(body.pos, 4 * 3600);
    if (dur === null || pos === null || dur < 1) return res.status(400).json({ error: 'pos and dur required' });
    const pct = Math.min(100, Math.round((Math.min(pos, dur) / dur) * 100));
    const done = body.done === true;

    const patch = {
      listen_pos: done ? 0 : Math.min(pos, dur),           // finished: next play starts from the beginning
      listen_dur: dur,
      listen_pct: Math.max(row.listen_pct || 0, done ? 100 : pct),
      last_listened_at: new Date().toISOString()
    };
    if (done) {
      patch.listens = (row.listens || 0) + 1;
      if (!row.finished_at) patch.finished_at = patch.last_listened_at;
    }
    const w = await K.sb('/rest/v1/user_library?' + where, { method: 'PATCH', prefer: 'return=minimal', body: patch });
    if (!w.ok) return res.status(502).json({ error: 'Could not save progress' });
    return res.status(200).json({ ok: true, pct: patch.listen_pct, listens: patch.listens != null ? patch.listens : (row.listens || 0), finished: !!(row.finished_at || patch.finished_at) });
  } catch (e) {
    console.error('[progress] error:', e.message);
    return res.status(500).json({ error: 'Progress failed' });
  }
};
