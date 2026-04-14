const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function normalise(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function sbFetch(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('Supabase ' + r.status + ': ' + txt.substring(0, 150));
  }
  return r.json();
}

const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 30;
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return timestamps.length > maxRequests;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });

  const { title, author } = req.query;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!SUPABASE_URL) return res.status(500).json({ error: 'Missing SUPABASE_URL' });
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY' });

  const normTitle = normalise(title);
  const normAuthor = normalise(author || '');
  const SELECT = 'select=title,author,html,plain,words';

  try {
    // Step 1: exact lookup_key match
    if (author) {
      const keyNS = title + '||' + author + '||nospoilers';
      const keyS  = title + '||' + author + '||spoilers';
      const rows = await sbFetch('/rest/v1/summaries?' + SELECT + '&lookup_key=in.(' + encodeURIComponent(keyNS) + ',' + encodeURIComponent(keyS) + ')&limit=1');
      if (rows && rows.length) return res.status(200).json(sanitise(rows[0]));
    }

    // Step 2: title ILIKE
    const titleRows = await sbFetch('/rest/v1/summaries?' + SELECT + '&title=ilike.' + encodeURIComponent('%' + title + '%') + '&limit=20');
    if (titleRows && titleRows.length) {
      let best = titleRows[0];
      if (normAuthor) {
        best = titleRows.sort((a, b) =>
          levenshtein(normalise(a.author), normAuthor) - levenshtein(normalise(b.author), normAuthor)
        )[0];
      }
      if (levenshtein(normalise(best.title), normTitle) <= Math.max(5, normTitle.length * 0.3))
        return res.status(200).json(sanitise(best));
    }

    // Step 3: distinctive word search
    const words = normTitle.split(' ').filter(w => w.length > 4);
    for (const word of words) {
      const wordRows = await sbFetch('/rest/v1/summaries?' + SELECT + '&title=ilike.' + encodeURIComponent('%' + word + '%') + '&limit=10');
      if (wordRows && wordRows.length) {
        const best = wordRows.sort((a, b) =>
          levenshtein(normalise(a.title), normTitle) - levenshtein(normalise(b.title), normTitle)
        )[0];
        if (levenshtein(normalise(best.title), normTitle) <= Math.max(5, normTitle.length * 0.4))
          return res.status(200).json(sanitise(best));
      }
    }

    return res.status(404).json({ error: 'Summary not found' });
  } catch (err) {
    console.error('get-summary error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

function sanitise(row) {
  return { title: row.title, author: row.author, html: row.html, plain: row.plain, words: row.words || [] };
}