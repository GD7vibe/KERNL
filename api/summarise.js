const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeKey(title, author, spoilers) {
  const base = (title + '||' + (author || '')).toLowerCase().trim().replace(/\s+/g, ' ');
  return base + '||' + (spoilers ? 'spoilers' : 'nospoilers');
}

async function getFromSupabase(key) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/summaries?lookup_key=eq.${encodeURIComponent(key)}&select=html,plain,words`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const data = await res.json();
  return data && data.length > 0 ? data[0] : null;
}

async function saveToSupabase(title, author, key, html, plain, words) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/summaries`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title, author, lookup_key: key, html, plain, words: JSON.stringify(words) })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase insert failed:', err);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { title, author, spoilers } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  // For lookup, try the requested key first
  const requestedKey = makeKey(title, author, spoilers);
  const nonfictionKey = makeKey(title, author, false);

  // Check Supabase — for spoilers=true also check nospoilers key in case it's non-fiction
  try {
    const cached = await getFromSupabase(requestedKey);
    if (cached) {
      const words = cached.words ? JSON.parse(cached.words) : [];
      return res.status(200).json({ html: cached.html, plain: cached.plain, words, source: 'cache' });
    }
    // If spoilers requested but not found, also check nospoilers (covers non-fiction cached without spoilers key)
    if (spoilers) {
      const cachedNonFiction = await getFromSupabase(nonfictionKey);
      if (cachedNonFiction) {
        const words = cachedNonFiction.words ? JSON.parse(cachedNonFiction.words) : [];
        return res.status(200).json({ html: cachedNonFiction.html, plain: cachedNonFiction.plain, words, source: 'cache' });
      }
    }
  } catch (e) {
    console.error('Supabase read failed:', e.message);
  }

  const spoilerInstruction = spoilers
    ? `The user has requested spoilers. Include all major plot points, character arcs, twists, and the ending. Hold nothing back.`
    : `First, determine whether this book is fiction (novel, short story collection) or non-fiction (biography, memoir, history, business, self-help, science, etc).

If it is NON-FICTION: ignore the spoiler setting entirely and write a full, comprehensive summary covering all key arguments, insights, data, conclusions and takeaways. Non-fiction has no spoilers.

If it is FICTION: write a spoiler-free summary. Do NOT reveal major plot twists, the ending, or key surprises. Focus on themes, writing style, the world of the book, characters and why it is worth reading. Give the reader a feel for the book without ruining the experience of reading it themselves.`;

  const prompt = `Write a comprehensive 1,500-word summary of the book "${title}"${author ? ` by ${author}` : ''}.

${spoilerInstruction}

IMPORTANT: On the very first line of your response, write either GENRE:FICTION or GENRE:NONFICTION so the system knows how to categorise this book. Then continue with the summary on the next line.

Structure it with clear sections using HTML formatting:
- An opening paragraph introducing the book and its significance
- 4-6 sections with <h2> headings covering key themes, characters, and insights
- Each section should be 2-3 substantial paragraphs
- A closing section on legacy and impact

Format rules:
- Use <h2> for section headings
- Use <p> tags for paragraphs
- No <html>, <body>, or <head> tags — return only the inner content
- Write in an engaging, intelligent tone
- Target exactly 1,500 words. Do not exceed 1,550 words under any circumstances. Be concise and disciplined — cut padding, not content

After the summary, on a new line write: WORDS_START
Then provide exactly 21 interesting, unusual, or book-specific words from the book or relevant to its themes. These should be words a teenager might not know but would find fascinating to learn. Include rare English words, domain-specific vocabulary, and words unique to the book's setting or era.
CRITICAL: Every word must be completely unique — no word may appear more than once in the list. Double-check your list before finalising it.
Format each word as JSON on its own line like this:
{"word":"example","definition":"the meaning of the word in plain English"}
Then on a new line write: WORDS_END`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Anthropic API error' });
    }

    let raw = data.content[0].text.trim();

    // Extract genre declaration from first line
    const firstLine = raw.split('\n')[0].trim();
    const isNonFiction = firstLine.toUpperCase().includes('NONFICTION');
    // Strip the genre line from the content
    if (firstLine.toUpperCase().startsWith('GENRE:')) {
      raw = raw.slice(firstLine.length).trim();
    }

    // Non-fiction always saves under nospoilers key so it's shared across both toggle states
    const saveKey = isNonFiction ? nonfictionKey : requestedKey;

    const wordsStart = raw.indexOf('WORDS_START');
    const wordsEnd = raw.indexOf('WORDS_END');
    const summaryRaw = wordsStart > -1 ? raw.slice(0, wordsStart).trim() : raw;

    let words = [];
    if (wordsStart > -1 && wordsEnd > -1) {
      const wordsBlock = raw.slice(wordsStart + 11, wordsEnd).trim();
      const seen = new Set();
      words = wordsBlock.split('\n')
        .map(line => { try { return JSON.parse(line.trim()); } catch (e) { return null; } })
        .filter(w => w && w.word && w.definition)
        .filter(w => {
          const key = w.word.toLowerCase().trim();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 21);
    }

    const html = summaryRaw;
    const plain = html
      .replace(/<h2[^>]*>/gi, '\n\n')
      .replace(/<\/h2>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    await saveToSupabase(title, author, saveKey, html, plain, words);

    res.status(200).json({ html, plain, words, source: 'generated' });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to generate summary' });
  }
};
