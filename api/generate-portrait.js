// api/generate-portrait.js
// Generates a Reading Portrait for a user based on their library.
// - Portrait: Claude Haiku, generated at 10 books then every 10 after. Each saved permanently.
// - Recommendations: category-matched, no Claude, fresh on every call.

const K = require('../lib/kernl');

const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const ANON_KEY     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

const PORTRAIT_THRESHOLD = 10; // first portrait after 10 books
const REGEN_EVERY        = 10; // new portrait every 10 books after that

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

    // ── Fetch user library (with categories) ──────────────────────────────────
    // Spanish edition: this reader's rows for this language only; titles and categories come from summaries_es (same ids as English).
    const libRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_library?select=summary_id&user_id=eq.${user.id}&language=eq.${K.LANG}&order=added_at.asc`,
      { headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` } }
    );
    const libRows = libRes.ok ? await libRes.json() : [];
    const library = await hydrate(Array.isArray(libRows) ? libRows : [], SUPABASE_KEY);
    const bookCount = library.length;

    if (bookCount < PORTRAIT_THRESHOLD) {
      // Still generate recommendations even if no portrait yet
      const recs = await getRecommendations(library || [], SUPABASE_KEY);
      return res.status(200).json({
        portrait: null,
        portraits: [],
        recommendations: recs,
        booksNeeded: PORTRAIT_THRESHOLD - bookCount,
        bookCount
      });
    }

    // ── Fetch all saved portraits for this user ────────────────────────────────
    const portraitsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/portraits?user_id=eq.${user.id}&language=eq.${K.LANG}&order=generated_at.asc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const allPortraits = await portraitsRes.json() || [];

    // ── Decide if we need a new portrait ──────────────────────────────────────
    const lastPortrait = allPortraits.length > 0 ? allPortraits[allPortraits.length - 1] : null;
    const lastCount    = lastPortrait ? (lastPortrait.book_count_at_generation || 0) : 0;
    const needsNew     = !lastPortrait || (bookCount - lastCount) >= REGEN_EVERY;

    let currentPortrait = lastPortrait ? lastPortrait.portrait : null;

    if (needsNew) {
      // ── Generate new portrait with Claude Haiku ──────────────────────────────
      const bookList = library
        .map(item => item.summaries ? `${item.summaries.title}, de ${item.summaries.author}` : null)
        .filter(Boolean)
        .join('\n');

      const prompt = `Eres un compañero literario perceptivo. Un lector ha guardado estos libros en su biblioteca personal:

${bookList}

Escribe un párrafo (de 4 a 6 oraciones, unas 100 palabras) que refleje quién parece ser esta persona intelectualmente, basándote solo en sus elecciones. Sé específico, cálido y sorprendente: nombra temas o tensiones concretas que notes. Escribe en segunda persona, con tuteo ("Parece que te atrae..."). Español latinoamericano neutro. No menciones que estás analizando una lista de lecturas.

Responde SOLO con el párrafo, sin JSON y sin preámbulo.`;

      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!anthropicRes.ok) {
        const err = await anthropicRes.json();
        throw new Error(err.error?.message || 'Anthropic error ' + anthropicRes.status);
      }

      const anthropicData = await anthropicRes.json();
      currentPortrait = anthropicData.content[0].text.trim();

      // ── Save this portrait permanently ────────────────────────────────────────
      await fetch(`${SUPABASE_URL}/rest/v1/portraits`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          user_id: user.id,
          portrait: currentPortrait,
          language: K.LANG,
          book_count_at_generation: bookCount,
          generated_at: new Date().toISOString()
        })
      });

      // Refresh portraits list
      const refreshRes = await fetch(
        `${SUPABASE_URL}/rest/v1/portraits?user_id=eq.${user.id}&language=eq.${K.LANG}&order=generated_at.asc`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const refreshed = await refreshRes.json();
      allPortraits.push(...(refreshed.slice(allPortraits.length)));
    }

    // ── Get fresh category-matched recommendations ─────────────────────────────
    const recommendations = await getRecommendations(library, SUPABASE_KEY);

    return res.status(200).json({
      portrait: currentPortrait,
      portraits: allPortraits,
      recommendations,
      bookCount,
      nextPortraitAt: lastCount + REGEN_EVERY
    });

  } catch(e) {
    console.error('generate-portrait error:', e.message);
    return res.status(500).json({ error: 'No se pudo generar el retrato: ' + e.message });
  }
};

// ── Category-matched recommendations (no Claude) ──────────────────────────────
async function getRecommendations(library, serviceKey) {
  try {
    // Build set of categories the user reads and titles they own
    const readTitles = new Set();
    const userCategories = {};

    library.forEach(item => {
      if (!item.summaries) return;
      if (item.summaries.id !== undefined) readTitles.add(String(item.summaries.id));
      let cats = [];
      try { cats = typeof item.summaries.categories === 'string'
        ? JSON.parse(item.summaries.categories)
        : (item.summaries.categories || []); } catch(e) {}
      cats.forEach(c => { userCategories[c] = (userCategories[c] || 0) + 1; });
    });

    // Sort categories by frequency
    const topCats = Object.entries(userCategories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat]) => cat);

    if (!topCats.length) return [];

    // Fetch unread books from top categories
    const allRes = await fetch(
      `${SUPABASE_URL}/rest/v1/${K.SUMMARIES_TABLE}?select=id,title,author,synopsis,categories&limit=500`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
    );
    const allBooks = await allRes.json() || [];

    // Filter to unread books in user's categories
    const candidates = allBooks.filter(b => {
      if (!b.title || readTitles.has(String(b.id))) return false;
      let cats = [];
      try { cats = typeof b.categories === 'string'
        ? JSON.parse(b.categories)
        : (b.categories || []); } catch(e) {}
      return cats.some(c => topCats.includes(c));
    });

    // Shuffle and pick 3
    const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, 3);
    return shuffled.map(b => ({
      title: b.title,
      author: b.author,
      synopsis: b.synopsis || ''
    }));
  } catch(e) {
    console.warn('getRecommendations error:', e.message);
    return [];
  }
}

// Attach each library row's book (id, title, author, categories) from the edition's table, keeping the order the reader added them.
async function hydrate(rows, serviceKey) {
  const ids = rows.map(r => r.summary_id).filter(v => v !== null && v !== undefined);
  if (!ids.length) return [];
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/${K.SUMMARIES_TABLE}?select=id,title,author,categories&id=in.(${ids.map(encodeURIComponent).join(',')})`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  );
  const books = r.ok ? await r.json() : [];
  const byId = {}; (Array.isArray(books) ? books : []).forEach(b => { byId[String(b.id)] = b; });
  return rows.map(x => ({ summaries: byId[String(x.summary_id)] || null })).filter(x => x.summaries);
}
