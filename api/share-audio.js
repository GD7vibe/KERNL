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
    if (!ctx) return res.status(401).json({ error: 'Inicia sesión primero.' });
    if (!K.canGenerateAudio(ctx)) return res.status(403).json({ code: 'pro_required', error: 'Guardar y compartir audio es una función Pro.' });

    const who = ctx.user ? ctx.user.id : K.clientIp(req);
    if (!ctx.admin && K.rateLimited('share:' + who, 20, 60 * 60 * 1000)) return res.status(429).json({ error: 'Demasiadas solicitudes. Inténtalo más tarde.' });

    const book = await K.findBook(title, author);
    if (!book) return res.status(404).json({ error: 'Resumen no encontrado' });
    const access = await K.authoriseAudioRead(ctx, book);
    if (!access.ok) return K.fail(res, access);

    // Female voice only.
    const hit = await K.findCachedAudio(K.audioKeyCandidates(book, title, author, 'female'));
    if (!hit) return res.status(404).json({ code: 'no_audio', error: 'Aún no hay audio de este libro. Pulsa reproducir una vez para crearlo y vuelve a intentarlo.' });

    const name = safeName(book.title) + '_KERNL.' + (hit.filename.endsWith('.wav') ? 'wav' : 'mp3');
    const downloadUrl = '/api/audio?file=' + encodeURIComponent(hit.filename) + '&dl=1&name=' + encodeURIComponent(name);

    if (action === 'link') return res.status(200).json({ ok: true, url: hit.url, downloadUrl, name });

    // Email: only to the signed-in account's own address, so this can't be used as an email relay.
    const to = ctx.user && ctx.user.email;
    if (!to) return res.status(400).json({ error: 'Tu cuenta no tiene correo electrónico.' });
    if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured' });

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'KERNL Audio <audio@kernlbooks.com>',
        reply_to: 'duffgaryduff@hotmail.com',
        to: [to],
        subject: book.title + ' — audio de KERNL',
        text: 'Hola,\n\nPediste a KERNL que te enviara el resumen en audio de "' + book.title + '"' + (book.author ? ' de ' + book.author : '') + '.\n\nEscúchalo o descárgalo aquí: ' + hit.url + '\n\nKERNL — Lee menos. Sabe más.\nkernlbooks.com',
        html: '<p>Hola,</p><p>Pediste a KERNL que te enviara el resumen en audio de <strong>' + esc(book.title) + '</strong>' + (book.author ? ' de ' + esc(book.author) : '') + '.</p><p><a href="' + esc(hit.url) + '">Escucha o descarga el audio</a></p><p style="color:#888;font-size:12px">KERNL — Lee menos. Sabe más.<br>kernlbooks.com</p>'
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('[share-audio] Resend error:', d); return res.status(502).json({ error: d.message || 'No se pudo enviar el correo' }); }
    return res.status(200).json({ ok: true, sent: true, to });
  } catch (e) {
    console.error('[share-audio] error:', e.message);
    return res.status(e.status || 500).json({ error: 'No se pudo compartir el audio' });
  }
};
