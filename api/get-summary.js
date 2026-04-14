const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

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
  return (str || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/ +/g, ' ').trim();
}

async function sbFetch(path) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  return res.json();
}

function sanitise(row) {
  return { title: row.title, author: row.author, html: row.html, plain: row.plain, words: row.words || [], genre: row.genre || 'NONFICTION' };
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

  const normTitle = normalise(title);
  const normAuthor = normalise(author || '');

  try {
    // Step 1: exact lookup_key match
    if (author) {
      const key1 = encodeURIComponent(title + '||' + author + '||nospoilers');
      const key2 = encodeURIComponent(title + '||' + author + '||spoilers');
      const rows = await sbFetch('summaries?select=title,author,html,plain,words,genre&lookup_key=in.(' + key1 + ',' + key2 + ')&limit=1');
      if (Array.isArray(rows) && rows.length) return res.status(200).json(sanitise(rows[0]));
    }

    // Step 2: ILIKE title search
    const rows2 = await sbFetch('summaries?select=title,author,html,plain,words,genre&title=ilike.' + encodeURIComponent('%' + title + '%') + '&limit=20');
    if (Array.isArray(rows2) && rows2.length) {
      let best = rows2[0];
      if (normAuthor) {
        best = rows2.sort((a, b) => levenshtein(normalise(a.author), normAuthor) - levenshtein(normalise(b.author), normAuthor))[0];
      }
      const dist = levenshtein(normalise(best.title), normTitle);
      if (dist <= Math.max(5, normTitle.length * 0.3)) return res.status(200).json(sanitise(best));
    }

    // Step 3: distinctive word search
    const words = normTitle.split(' ').filter(w => w.length > 4);
    for (const word of words) {
      const rows3 = await sbFetch('summaries?select=title,author,html,plain,words,genre&title=ilike.' + encodeURIComponent('%' + word + '%') + '&limit=10');
      if (Array.isArray(rows3) && rows3.length) {
        const best = rows3.sort((a, b) => levenshtein(normalise(a.title), normTitle) - levenshtein(normalise(b.title), normTitle))[0];
        const dist = levenshtein(normalise(best.title), normTitle);
        if (dist <= Math.max(5, normTitle.length * 0.4)) return res.status(200).json(sanitise(best));
      }
    }

    return res.status(404).json({ error: 'Summary not found' });
  } catch (err) {
    console.error('get-summary error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};