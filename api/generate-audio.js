// api/generate-audio.js
// Generates xAI TTS audio for a library book and stores it in Supabase Storage.
// POST { title, author, voice }  ->  { ok:true, filename, cached? }
//
// The text always comes from the library row, never from the browser, and an existing
// fresh file is never regenerated, so repeat or concurrent calls cost nothing.
const K = require('../lib/kernl');

const MAX_CHARS = 120000;

async function generate(book, voice, filename) {
  const r = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.XAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: book.plain.slice(0, MAX_CHARS), voice_id: voice === 'male' ? 'leo' : 'eve', language: K.TTS_LANGUAGE })
  });
  if (!r.ok) {
    console.error('[generate-audio] xAI failed:', r.status, (await r.text()).slice(0, 200));
    const e = new Error('xAI TTS failed'); e.status = 502; throw e;
  }
  const buffer = Buffer.from(await r.arrayBuffer());
  if (!buffer.length) { const e = new Error('xAI returned empty audio'); e.status = 502; throw e; }
  if (!(await K.uploadAudio(filename, buffer))) { const e = new Error('Upload failed'); e.status = 502; throw e; }
  await K.saveAudioMeta(book, voice, filename, book.plain);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.XAI_API_KEY) return res.status(500).json({ ok: false, error: 'Server is not configured' });

  const body = req.body || {};
  const voice = K.normVoice(body.voice);
  const title = K.cleanText(body.title, 300);
  const author = K.cleanText(body.author, 300);
  if (!title) return res.status(400).json({ ok: false, error: 'title required' });

  try {
    const ctx = await K.authenticate(req);
    const book = await K.findBook(title, author);
    if (!book || !book.plain) return res.status(404).json({ ok: false, error: 'Resumen no encontrado' });

    const access = await K.authoriseAudioRead(ctx, book);
    if (!access.ok) return K.fail(res, access);

    const keys = K.audioKeyCandidates(book, title, author, voice);
    const filename = keys[0];

    // Already generated and still matching the current text? Nothing to do.
    const hit = body.regenerate && K.canGenerateAudio(ctx) ? null : await K.findCachedAudio(keys);
    if (hit) {
      const st = await K.audioStatus(hit.filename, book.plain);
      if (st.state !== 'stale') {
        return res.status(200).json({ ok: true, filename: hit.filename, cached: true });
      }
    }

    if (K.isIncomplete(book.plain, book.html)) {
      return res.status(422).json({ ok: false, code: 'incomplete_text', error: 'Este resumen parece incompleto, así que no se creó el audio.' });
    }

    if (!K.canGenerateAudio(ctx)) {
      return res.status(403).json({ ok: false, code: 'pro_required', error: 'Crear audio nuevo es una función Pro.' });
    }

    // Someone on this instance is already generating it: wait for that instead of paying twice.
    const pending = K.inflight.get(filename);
    if (pending) {
      await pending;
      return res.status(200).json({ ok: true, filename, cached: true });
    }

    const who = ctx && ctx.user ? ctx.user.id : K.clientIp(req);
    if (!(ctx && ctx.admin) && K.rateLimited('gen:' + who, 12, 60 * 60 * 1000)) {
      return res.status(429).json({ ok: false, error: 'Demasiadas solicitudes de audio. Inténtalo más tarde.' });
    }

    const job = generate(book, voice, filename);
    K.inflight.set(filename, job);
    await job;
    return res.status(200).json({ ok: true, filename });
  } catch (e) {
    console.error('[generate-audio] error:', e.message);
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
};
