// api/generate-portrait.js
// Generates a personalised "Reading Portrait" for a user based on their library.
// Uses raw fetch to Anthropic API — no SDK dependency required.

const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';

const PORTRAIT_THRESHOLD = 5;
const REGEN_EVERY        = 5;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  try {
    // ── Auth ───────────────────────────────────────────────────────────────────
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`
      }
    });
    if (!authRes.ok) return res.status(401).json({ error: 'Invalid session' });
    const user = await authRes.json();
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid session' });

    // ── Fetch user library ─────────────────────────────────────────────────────
    const libRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_library?select=added_at,summaries(title,author)&user_id=eq.${user.id}&order=added_at.asc`,
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

    // Fetch unread books for recommendations
    const allBooksRes = await fetch(
      `${SUPABASE_URL}/rest/v1/summaries?select=title,author,synopsis&limit=500`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const allBooks = await allBooksRes.json();

    const unreadBooks = (allBooks || [])
      .filter(b => !readTitles.has(b.title?.toLowerCase().trim()))
      .map(b => `${b.title} by ${b.author}${b.synopsis ? ' — ' + b.synopsis.slice(0, 80) : ''}`)
      .slice(0, 200)
      .join('\n');

    // ── Call Anthropic ─────────────────────────────────────────────────────────
    const prompt = `You are a perceptive literary companion with deep knowledge of books and human character. A reader has saved the following books to their personal library:

${bookList}

Your task is two parts:

PART 1 — THE READING PORTRAIT:
Write a single paragraph (4-6 sentences, around 100-130 words) that reflects back who this person appears to be intellectually and personally, based purely on their reading choices.

This should feel like a thoughtful, warm observation from a brilliant friend who knows them well — not a personality quiz result, not generic flattery. It should be specific to their actual choices, name particular themes or tensions you notice, and offer a genuine insight that might surprise or delight them. Write in second person ("You seem drawn to..."). British English throughout.

Do not mention that you are analysing their reading list. Simply speak as if you know them.

PART 2 — THREE RECOMMENDATIONS:
From the following unread books available in the KERNL library, choose exactly 3 that would genuinely resonate with this reader. For each, give:
- The exact title and author
- One sentence (max 15 words) explaining specifically why it suits THIS reader based on their portrait

Available books:
${unreadBooks}

Respond in this exact JSON format and nothing else:
{
  "portrait": "Your portrait paragraph here...",
  "recommendations": [
    { "title": "Book Title", "author": "Author Name", "reason": "One sentence reason." },
    { "title": "Book Title", "author": "Author Name", "reason": "One sentence reason." },
    { "title": "Book Title", "author": "Author Name", "reason": "One sentence reason." }
  ]
}`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json();
      throw new Error(err.error?.message || 'Anthropic API error');
    }

    const anthropicData = await anthropicRes.json();
    const raw   = anthropicData.content[0].text.trim();
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // ── Cache in Supabase ──────────────────────────────────────────────────────
    // Use service key for upsert
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
