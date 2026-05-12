// api/generate-portrait.js
// Generates a personalised "Reading Portrait" for a user based on their library.
// Uses raw fetch to Anthropic API — no SDK dependency required.

const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';

const PORTRAIT_THRESHOLD = 5;
const REGEN_EVERY        = 20;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  try {
    // ── Auth ───────────────────────────────────────────────────────────────────
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!authRes.ok) return res.status(401).json({ error: 'Invalid session' });
    const user = await authRes.json();
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid session' });

    // ── Fetch user library ─────────────────────────────────────────────────────
    const libRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_library?select=summaries(title,author)&user_id=eq.${user.id}&order=added_at.asc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const library = await libRes.json();

    if (!library || library.length < PORTRAIT_THRESHOLD) {
      return res.status(200).json({
        portrait: null,
        recommendations: [],
        booksNeeded: PORTRAIT_THRESHOLD - (library ? library.length : 0)
      });
    }

    const bookCount = library.length;

    // ── Check cache ────────────────────────────────────────────────────────────
    const cacheRes = await fetch(
      `${SUPABASE_URL}/rest/v1/portraits?user_id=eq.${user.id}&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const cacheRows = await cacheRes.json();
    const cached = cacheRows && cacheRows[0] ? cacheRows[0] : null;

    if (cached) {
      const booksSinceRegen = bookCount - (cached.book_count_at_generation || 0);
      if (booksSinceRegen < REGEN_EVERY) {
        return res.status(200).json({
          portrait: cached.portrait,
          recommendations: cached.recommendations,
          bookCount,
          fromCache: true
        });
      }
    }

    // ── Build book list ────────────────────────────────────────────────────────
    const bookList = library
      .map(item => item.summaries ? `${item.summaries.title} by ${item.summaries.author}` : null)
      .filter(Boolean)
      .join('\n');

    const readTitles = new Set(
      library.map(item => item.summaries?.title?.toLowerCase().trim()).filter(Boolean)
    );

    // Fetch a small sample of unread books for recommendations — 40 max to keep prompt short
    const allBooksRes = await fetch(
      `${SUPABASE_URL}/rest/v1/summaries?select=title,author,synopsis&limit=100&order=title.asc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const allBooks = await allBooksRes.json();

    const unreadBooks = (allBooks || [])
      .filter(b => b.title && !readTitles.has(b.title.toLowerCase().trim()))
      .slice(0, 40)
      .map(b => `- ${b.title} by ${b.author}`)
      .join('\n');

    // ── Call Anthropic ─────────────────────────────────────────────────────────
    const prompt = `You are a perceptive literary companion. A reader has saved these books:

${bookList}

PART 1 — READING PORTRAIT:
Write one paragraph (4-6 sentences, ~100 words) reflecting who this person appears to be intellectually, based on their choices. Be specific, warm, surprising. Second person ("You seem drawn to..."). British English. Do not mention you are analysing a reading list.

PART 2 — THREE RECOMMENDATIONS:
From this list of available books, pick exactly 3 that suit this reader:
${unreadBooks}

Give the exact title, author, and one sentence (max 12 words) explaining why.

Reply ONLY in this JSON format:
{"portrait":"...","recommendations":[{"title":"...","author":"...","reason":"..."},{"title":"...","author":"...","reason":"..."},{"title":"...","author":"...","reason":"..."}]}`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json();
      throw new Error(err.error?.message || 'Anthropic API error ' + anthropicRes.status);
    }

    const anthropicData = await anthropicRes.json();
    const raw    = anthropicData.content[0].text.trim();
    const clean  = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // ── Cache in Supabase ──────────────────────────────────────────────────────
    await fetch(`${SUPABASE_URL}/rest/v1/portraits`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        user_id: user.id,
        portrait: result.portrait,
        recommendations: result.recommendations,
        book_count_at_generation: bookCount,
        generated_at: new Date().toISOString()
      })
    });

    return res.status(200).json({
      portrait: result.portrait,
      recommendations: result.recommendations,
      bookCount,
      fromCache: false
    });

  } catch(e) {
    console.error('generate-portrait error:', e.message);
    return res.status(500).json({ error: 'Could not generate portrait: ' + e.message });
  }
};
