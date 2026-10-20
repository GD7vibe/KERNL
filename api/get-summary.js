// api/get-summary.js
// Returns a stored summary. GET ?title=&author=
//   anonymous      -> guest-library books only
//   signed in      -> any book; opening one that isn't in the user's library uses one slot of their allowance
//   service key    -> anything, no quota (admin scripts)
const K = require('../lib/kernl');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (K.rateLimited('gs:' + K.clientIp(req), 30, 60 * 1000)) return res.status(429).json({ error: 'Too many requests' });

  const title = K.cleanText(req.query.title, 300);
  const author = K.cleanText(req.query.author, 300);
  if (!title) return res.status(400).json({ error: 'title required' });

  try {
    const ctx = await K.authenticate(req);
    const book = await K.findBookFuzzy(title, author);
    if (!book) return res.status(404).json({ error: 'Summary not found' });

    const access = await K.authoriseRead(ctx, book);
    if (!access.ok) return K.fail(res, access);

    return res.status(200).json({
      title: book.title, author: book.author, html: book.html, plain: book.plain,
      words: book.words || [], quota: access.quota || null
    });
  } catch (err) {
    console.error('get-summary error:', err.message);
    return res.status(err.status || 500).json({ error: 'Could not load summary' });
  }
};
