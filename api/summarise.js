const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

// ─── Normalisation ────────────────────────────────────────────────────────────

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['''\u2018\u2019]/g, '')      // smart single quotes / apostrophes
    .replace(/["""\u201C\u201D]/g, '')      // smart double quotes
    .replace(/[*!?@#$%^&()_+=\[\]{};:<>,.\/\\|~`]/g, '') // punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function normTitle(s) {
  return norm(s)
    .replace(/^(the|a|an)\s+/i, '')         // strip leading articles
    .replace(/\s*[:\-—]\s*.+$/, '')          // strip subtitles after : or —
    .trim();
}

function makeKey(title, author, spoilers) {
  return norm(title) + '||' + norm(author) + '||' + (spoilers ? 'spoilers' : 'nospoilers');
}

function makeTitleOnlyKey(title, spoilers) {
  return norm(title) + '||' + (spoilers ? 'spoilers' : 'nospoilers');
}

// Simple Levenshtein distance for similarity scoring
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// Get the most distinctive word from a title (longest word, ignoring stop words)
function getDistinctiveWord(title) {
  const stops = new Set(['the','a','an','and','or','of','in','on','at','to','for','with','by','from','is','it','its','as','be','are','was','were','not','no','my','your','his','her','our','their','this','that','these','those','i','me','we','us','you','he','she','they','them','what','how','why','when','who']);
  const words = normTitle(title).split(' ').filter(w => w.length > 3 && !stops.has(w));
  if (!words.length) return normTitle(title).split(' ')[0];
  return words.sort((a, b) => b.length - a.length)[0];
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function supabaseGet(url) {
  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  return data && data.length > 0 ? data : null;
}

async function saveToSupabase(title, author, key, html, plain, words) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/summaries`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ title, author, lookup_key: key, html, plain, words: JSON.stringify(words) })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase insert failed:', err);
  }
}

// ─── Multi-layer cache lookup ─────────────────────────────────────────────────

async function findCached(title, author, spoilers) {
  const spoilerSuffix = spoilers ? 'spoilers' : 'nospoilers';
  const nTitle = norm(title);
  const nAuthor = norm(author);
  const ntTitle = normTitle(title);

  // Layer 1: Exact key match (title + author + spoilers)
  console.log('Cache lookup L1: exact key');
  const exactKey = makeKey(title, author, spoilers);
  let rows = await supabaseGet(
    `${SUPABASE_URL}/rest/v1/summaries?lookup_key=eq.${encodeURIComponent(exactKey)}&select=html,plain,words,lookup_key,title,author&limit=1`
  );
  if (rows) { console.log('Cache hit L1'); return rows[0]; }

  // Layer 1b: Also check nospoilers key in case it's non-fiction (same as before)
  if (spoilers) {
    const nfKey = makeKey(title, author, false);
    rows = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/summaries?lookup_key=eq.${encodeURIComponent(nfKey)}&select=html,plain,words,lookup_key,title,author&limit=1`
    );
    if (rows) { console.log('Cache hit L1b (nonfiction)'); return rows[0]; }
  }

  // Layer 2: Normalised title + nospoilers (ignore author entirely)
  console.log('Cache lookup L2: title-only key');
  const titleKey = norm(title) + '||' + spoilerSuffix;
  const titleKeyNF = norm(title) + '||nospoilers';
  rows = await supabaseGet(
    `${SUPABASE_URL}/rest/v1/summaries?lookup_key=in.(${encodeURIComponent(titleKey)},${encodeURIComponent(titleKeyNF)})&select=html,plain,words,lookup_key,title,author&limit=1`
  );
  if (rows) { console.log('Cache hit L2'); return rows[0]; }

  // Layer 3: ILIKE search on title column — catches partial matches and minor spelling
  console.log('Cache lookup L3: ilike title');
  rows = await supabaseGet(
    `${SUPABASE_URL}/rest/v1/summaries?title=ilike.${encodeURIComponent('%' + nTitle + '%')}&select=html,plain,words,lookup_key,title,author&limit=10`
  );
  if (rows) {
    // Score each result for similarity
    const scored = rows.map(r => ({ row: r, score: similarity(title, r.title) }))
                       .filter(r => r.score >= 0.75)
                       .sort((a, b) => b.score - a.score);
    if (scored.length) { console.log('Cache hit L3, score:', scored[0].score); return scored[0].row; }
  }

  // Layer 3b: ILIKE on normalised title without leading article
  if (ntTitle !== nTitle) {
    console.log('Cache lookup L3b: ilike stripped title');
    rows = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/summaries?title=ilike.${encodeURIComponent('%' + ntTitle + '%')}&select=html,plain,words,lookup_key,title,author&limit=10`
    );
    if (rows) {
      const scored = rows.map(r => ({ row: r, score: similarity(title, r.title) }))
                         .filter(r => r.score >= 0.75)
                         .sort((a, b) => b.score - a.score);
      if (scored.length) { console.log('Cache hit L3b, score:', scored[0].score); return scored[0].row; }
    }
  }

  // Layer 4: Search by most distinctive word in title
  const word = getDistinctiveWord(title);
  if (word && word.length >= 4) {
    console.log('Cache lookup L4: distinctive word =', word);
    rows = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/summaries?title=ilike.${encodeURIComponent('%' + word + '%')}&select=html,plain,words,lookup_key,title,author&limit=20`
    );
    if (rows) {
      const scored = rows.map(r => ({ row: r, score: similarity(title, r.title) }))
                         .filter(r => r.score >= 0.70)
                         .sort((a, b) => b.score - a.score);
      if (scored.length) { console.log('Cache hit L4, score:', scored[0].score); return scored[0].row; }
    }
  }

  // Layer 5: Author-based search — if author provided, find all their books and match title
  if (nAuthor && nAuthor.length > 2) {
    console.log('Cache lookup L5: author match');
    rows = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/summaries?author=ilike.${encodeURIComponent('%' + nAuthor + '%')}&select=html,plain,words,lookup_key,title,author&limit=20`
    );
    if (rows) {
      const scored = rows.map(r => ({ row: r, score: similarity(title, r.title) }))
                         .filter(r => r.score >= 0.65)
                         .sort((a, b) => b.score - a.score);
      if (scored.length) { console.log('Cache hit L5, score:', scored[0].score); return scored[0].row; }
    }
  }

  console.log('Cache miss — all layers exhausted');
  return null;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(title, author, spoilers) {
  const spoilerInstruction = spoilers
    ? `The user has requested spoilers. Include all major plot points, character arcs, twists, and the ending. Hold nothing back.`
    : `First, determine whether this book is fiction (novel, short story collection) or non-fiction (biography, memoir, history, business, self-help, science, etc).

If it is NON-FICTION: ignore the spoiler setting entirely and write a full, comprehensive summary covering all key arguments, insights, data, conclusions and takeaways. Non-fiction has no spoilers.

If it is FICTION: write a spoiler-free summary. Do NOT reveal major plot twists, the ending, or key surprises. Focus on themes, writing style, the world of the book, characters and why it is worth reading.`;

  return `Write a comprehensive 1,500-word summary of the book "${title}"${author ? ` by ${author}` : ''}.

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
- Target exactly 1,500 words. Do not exceed 1,550 words under any circumstances.

After the summary, on a new line write: WORDS_START
Then provide exactly 21 interesting, unusual, or book-specific words from the book or relevant to its themes. These should be words a teenager might not know but would find fascinating to learn.
CRITICAL: Every word must be completely unique — no word may appear more than once in the list. Double-check your list before finalising it.
Format each word as JSON on its own line like this:
{"word":"example","definition":"the meaning of the word in plain English"}
Then on a new line write: WORDS_END`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { title, author, spoilers } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  // Multi-layer cache lookup
  try {
    const cached = await findCached(title, author, spoilers);
    if (cached) {
      const words = cached.words ? JSON.parse(cached.words) : [];
      return res.status(200).json({ html: cached.html, plain: cached.plain, words, source: 'cache' });
    }
  } catch (e) {
    console.error('Cache lookup error:', e.message);
  }

  // Generate fresh summary
  const prompt = buildPrompt(title, author, spoilers);
  const nonfictionKey = makeKey(title, author, false);

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

    // Extract genre
    const firstLine = raw.split('\n')[0].trim();
    const isNonFiction = firstLine.toUpperCase().includes('NONFICTION');
    if (firstLine.toUpperCase().startsWith('GENRE:')) {
      raw = raw.slice(firstLine.length).trim();
    }

    const saveKey = isNonFiction ? nonfictionKey : makeKey(title, author, spoilers);

    // Extract summary and words
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
          const k = w.word.toLowerCase().trim();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 21);
    }

    const html = summaryRaw;
    const plain = html
      .replace(/<h2[^>]*>/gi, '\n\n').replace(/<\/h2>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n').trim();

    await saveToSupabase(title, author, saveKey, html, plain, words);

    res.status(200).json({ html, plain, words, source: 'generated' });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to generate summary' });
  }
};
