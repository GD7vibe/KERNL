const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (!SUPABASE_URL) return res.status(500).json({ error: 'Missing SUPABASE_URL' });
    if (!SUPABASE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY' });

    const r = await fetch(
      SUPABASE_URL + '/rest/v1/summaries?select=title,author,lookup_key&lookup_key=like.*nospoilers*&order=title.asc&limit=1000',
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
    );
    if (!r.ok) {
      const txt = await r.text();
      return res.status(500).json({ error: 'Supabase error ' + r.status, detail: txt.substring(0,200) });
    }
    const data = await r.json();

    const seen = new Set();
    const books = data.filter(b => {
      const key = (b.title || '').toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(b => ({ title: b.title, author: b.author }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(books);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};