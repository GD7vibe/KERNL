// api/generate-portrait.js
// Generates a personalised "Reading Portrait" for a user based on their library.
// Called from account.html when a user has 5+ books saved.
// Caches result in Supabase `portraits` table — regenerates after every 5 new books.

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PORTRAIT_THRESHOLD = 5;  // minimum books before first portrait
const REGEN_EVERY       = 5;   // regenerate after every N new books

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── Auth ───────────────────────────────────────────────────────────────────
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

    // ── Fetch user library ─────────────────────────────────────────────────────
    const { data: library } = await sb
      .from('user_library')
      .select('added_at, summaries(title, author, categories)')
      .eq('user_id', user.id)
      .order('added_at', { ascending: true });

    if (!library || library.length < PORTRAIT_THRESHOLD) {
      return res.status(200).json({
        portrait: null,
        recommendations: [],
        booksNeeded: PORTRAIT_THRESHOLD - (library ? library.length : 0)
      });
    }

    const bookCount = library.length;

    // ── Check cache ────────────────────────────────────────────────────────────
    const { data: cached } = await sb
      .from('portraits')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (cached) {
      // Only regenerate if user has read REGEN_EVERY more books since last portrait
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

    // ── Build book list for Claude ─────────────────────────────────────────────
    const bookList = library
      .map(item => item.summaries ? `${item.summaries.title} by ${item.summaries.author}` : null)
      .filter(Boolean)
      .join('\n');

    // Also grab all library books for recommendation pool (exclude already read)
    const { data: allBooks } = await sb
      .from('summaries')
      .select('title, author, synopsis, categories')
      .limit(500);

    const readTitles = new Set(
      library.map(item => item.summaries?.title?.toLowerCase().trim()).filter(Boolean)
    );

    const unreadBooks = (allBooks || [])
      .filter(b => !readTitles.has(b.title?.toLowerCase().trim()))
      .map(b => `${b.title} by ${b.author}${b.synopsis ? ' — ' + b.synopsis.slice(0, 80) : ''}`)
      .slice(0, 200)
      .join('\n');

    // ── Generate portrait with Claude ──────────────────────────────────────────
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

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text.trim();
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // ── Cache in Supabase ──────────────────────────────────────────────────────
    await sb.from('portraits').upsert({
      user_id: user.id,
      portrait: result.portrait,
      recommendations: result.recommendations,
      book_count_at_generation: bookCount,
      generated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

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
