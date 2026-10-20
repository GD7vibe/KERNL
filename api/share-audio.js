// api/share-audio.js
// Pro-only: get a download link for a book's audio, or email that link to your own account address.
// POST { title, author, action: 'link' | 'email' }
//   -> { ok:true, url, downloadUrl, name }            (link)
//   -> { ok:true, sent:true, to }                     (email)
// Never generates audio: if it doesn't exist yet the user must press play first (Pro) to create it.
const K = require('../lib/kernl');

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function safeName(s) { return String(s || 'kernl').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'kernl'; }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const action = body.action === 'email' ? 'email' : 'link';
  const title = K.cleanText(body.title, 300);
  const author = K.cleanText(body.author, 300);
  if (!title) return res.status(400).json({ error: 'title required' });

  try {
    const ctx = await K.authenticate(req);
    if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
    if (!K.canGenerateAudio(ctx)) return res.status(403).json({ code: 'pro_required', error: 'Saving and sharing audio is a Pro feature.' });

    const who = ctx.user ? ctx.user.id : K.clientIp(req);
    if (!ctx.admin && K.rateLimited('share:' + who, 20, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests. Try again later.' });

    const book = await K.findBook(title, author);
    if (!book) return res.status(404).json({ error: 'Summary not found' });
    const access = await K.authoriseAudioRead(ctx, book);
    if (!access.ok) return K.fail(res, access);

    // Female voice only.
    const hit = await K.findCachedAudio(K.audioKeyCandidates(book, title, author, 'female'));
    if (!hit) return res.status(404).json({ code: 'no_audio', error: 'No audio yet for this book. Press play once to create it, then try again.' });

    const name = safeName(book.title) + '_KERNL.' + (hit.filename.endsWith('.wav') ? 'wav' : 'mp3');
    const downloadUrl = '/api/audio?file=' + encodeURIComponent(hit.filename) + '&dl=1&name=' + encodeURIComponent(name);

    if (action === 'link') return res.status(200).json({ ok: true, url: hit.url, downloadUrl, name });

    // Email: only to the signed-in account's own address, so this can't be used as an email relay.
    const to = ctx.user && ctx.user.email;
    if (!to) return res.status(400).json({ error: 'Your account has no email address.' });
    if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured' });

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'KERNL <kindle@kernlbooks.com>',
        to: [to],
        subject: book.title + ' — KERNL audio',
        text: 'Your KERNL audio summary of "' + book.title + '"' + (book.author ? ' by ' + book.author : '') + ' is ready.\n\nListen or download: ' + hit.url + '\n\nKERNL — for the curious\nkernlbooks.com',
        html: '<p>Your KERNL audio summary of <strong>' + esc(book.title) + '</strong>' + (book.author ? ' by ' + esc(book.author) : '') + ' is ready.</p><p><a href="' + esc(hit.url) + '">Listen or download the audio</a></p><p style="color:#888;font-size:12px">KERNL — for the curious<br>kernlbooks.com</p>'
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('[share-audio] Resend error:', d); return res.status(502).json({ error: d.message || 'Email failed to send' }); }
    return res.status(200).json({ ok: true, sent: true, to });
  } catch (e) {
    console.error('[share-audio] error:', e.message);
    return res.status(e.status || 500).json({ error: 'Could not share audio' });
  }
};
