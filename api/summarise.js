const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeKey(title, author) {
  return (title + '||' + (author || '')).toLowerCase().trim().replace(/\s+/g, ' ');
}

async function getFromSupabase(key) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/summaries?lookup_key=eq.${encodeURIComponent(key)}&select=html,plain`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const data = await res.json();
  return data && data.length > 0 ? data[0] : null;
}

async function saveToSupabase(title, author, key, html, plain) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/summaries`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title, author, lookup_key: key, html, plain })
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

  const { title, author } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const key = makeKey(title, author);

  // Check Supabase first
  try {
    const cached = await getFromSupabase(key);
    if (cached) {
      return res.status(200).json({ html: cached.html, plain: cached.plain, source: 'cache' });
    }
  } catch (e) {
    console.error('Supabase read failed:', e.message);
  }

  // Not in database — generate with Anthropic
  const prompt = `Write a comprehensive 1,500-word summary of the book "${title}"${author ? ` by ${author}` : ''}.

Structure it with clear sections using HTML formatting:
- An opening paragraph introducing the book and its significance
- 4-6 sections with <h2> headings covering key themes, arguments, and insights
- Each section should be 2-3 substantial paragraphs
- A closing section on legacy and impact

Format rules:
- Use <h2> for section headings
- Use <p> tags for paragraphs
- No <html>, <body>, or <head> tags — return only the inner content
- Write in an engaging, intelligent tone
- Aim for exactly 1,500 words of actual text content`;

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
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Anthropic API error' });
    }

    const html = data.content[0].text.trim();
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

    // Save to Supabase — now logs errors if it fails
    await saveToSupabase(title, author, key, html, plain);

    res.status(200).json({ html, plain, source: 'generated' });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to generate summary' });
  }
};
