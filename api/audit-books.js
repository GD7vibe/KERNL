// api/audit-books.js
// Pro/admin only, read-only. For every library book, runs the SAME lookup that clicking the book runs
// (api/summarise.js findCached, fed the title and author exactly as the catalogue shows them) and reports:
//   opens        'ok' | 'not_found' (a click would fail, or for Pro would pay to write a duplicate) | 'wrong_book' (a click opens a different book)
//   problems     summary text checks (too_short, abrupt_end, few_sections)
//   shelf        false if no category maps to a shelf, so the book can only be found by search
//   no_words     the 21 vocabulary words are missing
// GET ?offset=0&limit=25  ->  { offset, count, rows:[...] }   (page on until count < limit)
const K = require('../lib/kernl');
const { findCached } = require('./summarise');

// Same categories the shelves use (public/scenes.js GROUPS).
const SHELF_CATS = new Set([
  'Crime & True Crime', 'Fiction — Thriller', 'Fiction — Literary', 'Fiction — Sci-Fi', 'Fiction — Historical', 'Biography & Memoir', 'Sport',
  'Science & Technology', 'Nature & Environment', 'History', 'Politics & Society', 'Business & Entrepreneurship', 'Economics', 'Leadership',
  'Personal Development', 'Psychology', 'Health & Wellbeing', 'Parenting & Family', 'Philosophy', 'Spirituality'
]);

async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const ctx = await K.authenticate(req);
    if (!ctx || !K.canGenerateAudio(ctx)) return res.status(403).json({ error: 'Not allowed' });

    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(40, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const r = await K.sb('/rest/v1/summaries?select=id,title,author,plain,html,words,categories&order=id.asc&offset=' + offset + '&limit=' + limit);
    if (!r.ok) return res.status(502).json({ error: 'Could not read library' });

    const rows = await inChunks(r.data || [], 6, async (b) => {
      const row = { id: b.id, title: b.title, author: b.author, opens: 'ok', problems: K.summaryProblems(b.plain, b.html), shelf: true, no_words: false, note: '' };
      let cats = []; try { cats = JSON.parse(b.categories || '[]'); } catch (e) { cats = []; }
      row.shelf = Array.isArray(cats) && cats.some(c => SHELF_CATS.has(c));
      try { const w = JSON.parse(b.words || '[]'); row.no_words = !Array.isArray(w) || w.length === 0; } catch (e) { row.no_words = true; }
      if (String(b.title || '').length > 200 || String(b.author || '').length > 200) row.note = 'title/author over 200 characters (clipped by the open request)';
      try {
        const hit = await findCached(K.cleanText(b.title, 200), K.cleanText(b.author, 200));
        if (!hit) row.opens = 'not_found';
        else if (String(hit.id) !== String(b.id)) { row.opens = 'wrong_book'; row.note = (row.note ? row.note + '; ' : '') + 'opens id ' + hit.id + ' "' + hit.title + '" by ' + hit.author; }
      } catch (e) { row.opens = 'error'; row.note = e.message; }
      return row;
    });

    return res.status(200).json({ offset, count: rows.length, rows });
  } catch (e) {
    console.error('[audit-books] error:', e.message);
    return res.status(500).json({ error: 'Audit failed' });
  }
};
