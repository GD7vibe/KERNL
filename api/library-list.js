// api/library-list.js
// Public catalogue of every book in the library (titles and authors only, no summary text).
// Pages through the table, so it is no longer capped at 1,000 rows.
const K = require('../lib/kernl');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const PAGE = 1000, MAX_PAGES = 50;
    const rows = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await K.sb('/rest/v1/summaries?select=title,author,lookup_key&lookup_key=like.*nospoilers*&order=title.asc,id.asc&limit=' + PAGE + '&offset=' + (i * PAGE));
      if (!r.ok || !Array.isArray(r.data)) return res.status(500).json({ error: 'Could not load library' });
      rows.push(...r.data);
      if (r.data.length < PAGE) break;
    }

    const seen = new Set();
    const books = rows.filter(b => {
      const key = (b.title || '').toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(b => ({ title: b.title, author: b.author }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(books);
  } catch (err) {
    return res.status(500).json({ error: 'Could not load library' });
  }
};
