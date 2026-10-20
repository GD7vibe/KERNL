// api/tts.js
// Cache check for audio. Never generates anything.
// POST { title, author, voice }  ->  { url, source:'cache' }  or  { cached:false, reason? }
//
// The text hash is always compared against the library's own copy of the summary
// (looked up by exact key, not "title contains"), so a different book with a similar title can no
// longer cause a false match or mismatch.
const K = require('../lib/kernl');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (K.rateLimited('tts:' + K.clientIp(req), 60, 60 * 1000)) return res.status(429).json({ error: 'Too many requests' });

  const body = req.body || {};
  const voice = K.normVoice(body.voice);
  const title = K.cleanText(body.title, 300);
  const author = K.cleanText(body.author, 300);
  if (!title) return res.status(400).json({ error: 'title required' });

  try {
    const ctx = await K.authenticate(req);
    const book = await K.findBook(title, author);
    if (!book) return res.status(200).json({ cached: false, reason: 'no_summary' });

    const access = await K.authoriseAudioRead(ctx, book);
    if (!access.ok) return K.fail(res, access);

    const hit = await K.findCachedAudio(K.audioKeyCandidates(book, title, author, voice));
    if (!hit) return res.status(200).json({ cached: false });

    const status = await K.audioStatus(hit.filename, book.plain);
    if (status.state === 'stale') {
      console.warn('[tts] stale audio:', hit.filename, 'stored', status.meta.plain_hash, 'current', K.plainHash(book.plain));
      await K.logSyncError(book, voice, 'hash_mismatch',
        'Audio hash ' + status.meta.plain_hash + ' does not match current summary hash ' + K.plainHash(book.plain) + '. Key: ' + hit.filename);
      return res.status(200).json({ cached: false, reason: 'hash_mismatch' });
    }
    if (status.state === 'unknown') {
      // Legacy file with no audio_meta row. Serve it and record the hash now so it is verified from here on.
      await K.saveAudioMeta(book, voice, hit.filename, book.plain);
    }
    return res.status(200).json({ url: hit.url, source: 'cache' });
  } catch (e) {
    console.warn('[tts] failed:', e.message);
    return res.status(200).json({ cached: false });
  }
};
