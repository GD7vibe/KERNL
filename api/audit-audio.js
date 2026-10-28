// api/audit-audio.js
// Pro/admin only, read-only. Checks a page of library books for:
//   - summary text that looks incomplete (too short / ends mid-sentence / few sections)
//   - missing female audio
//   - audio made from different text (audio_meta hash mismatch)
//   - audio with no verification record (legacy file)
//   - audio file size out of line with the text length (a cut-short narration)
// GET ?offset=0&limit=40  ->  { total, offset, rows:[{title,author,words,problems,audio,state,bytes,ratio}] }
const K = require('../lib/kernl');

const enc = encodeURIComponent;

async function headSize(filename) {
  try {
    const r = await fetch(K.publicAudioUrl(filename), { method: 'HEAD' });
    if (!r.ok) return null;
    return parseInt(r.headers.get('content-length') || '0', 10) || 0;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const ctx = await K.authenticate(req);
    if (!ctx || !K.canGenerateAudio(ctx)) return res.status(403).json({ error: 'Not allowed' });

    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 40));

    const r = await K.sb('/rest/v1/' + K.SUMMARIES_TABLE + '?select=id,title,author,plain,html&order=id.asc&offset=' + offset + '&limit=' + limit);
    if (!r.ok) return res.status(502).json({ error: 'Could not read library' });
    const books = r.data || [];

    const rows = await Promise.all(books.map(async (b) => {
      const plain = b.plain || '';
      const words = plain.trim() ? plain.trim().split(/\s+/).length : 0;
      const row = { title: b.title, author: b.author, words, problems: K.summaryProblems(plain, b.html), audio: false, state: 'none', bytes: 0, ratio: 0 };
      const key = K.audioKey(b.title, b.author, 'female');
      const bytes = await headSize(key);
      if (bytes) {
        row.audio = true; row.bytes = bytes;
        row.ratio = +(bytes / Math.min(plain.length, 120000 || 1)).toFixed(2);
        const meta = await K.getAudioMeta(key);
        row.state = !meta ? 'unverified' : (meta.plain_hash === K.plainHash(plain) ? 'fresh' : 'stale');
      }
      return row;
    }));

    return res.status(200).json({ offset, count: rows.length, rows });
  } catch (e) {
    console.error('[audit-audio] error:', e.message);
    return res.status(500).json({ error: 'Audit failed' });
  }
};
