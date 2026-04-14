const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 20;
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return timestamps.length > maxRequests;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });

  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/summaries?select=title,author,lookup_key&lookup_key=like.*nospoilers*&order=title.asc',
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
    );
    if (!r.ok) throw new Error('Supabase error ' + r.status);
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
    console.error('library-list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};