// api/summarise.js
// Serverless function — runs on Vercel, keeps API key secret

export default async function handler(req, res) {
  // CORS headers — allow requests from any origin (your own site)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { title, author } = req.body || {};

  if (!title) {
    return res.status(400).json({ error: 'Book title is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  const prompt = `You are KERNL, a premium book summarisation service. Your task is to write a comprehensive, authoritative 1500-word summary of the book "${title}"${author ? ` by ${author}` : ''}.

Write with confidence, depth, and genuine literary insight. No padding, no waffle.

Format your response using ONLY these HTML tags — <h2> for section headings, <p> for paragraphs. Start immediately with the first <h2> tag, no preamble.

Structure:
<h2>The Author & Context</h2>
[Who wrote this, when, why it matters — 2-3 paragraphs]

<h2>The Core Story or Argument</h2>
[What the book is fundamentally about — 3-4 paragraphs]

<h2>Key Themes & Ideas</h2>
[The most important intellectual or narrative threads — 3-4 paragraphs]

<h2>Pivotal Moments or Arguments</h2>
[The most powerful, memorable sections — 2-3 paragraphs]

<h2>Legacy & Why It Matters</h2>
[Why this book is significant today — 2 paragraphs]

Aim for exactly 1500 words. Use only <h2> and <p> tags. Write as an expert who has read the book carefully.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: err?.error?.message || `Anthropic API error ${response.status}`
      });
    }

    const data = await response.json();
    const html = data.content.map(c => c.text || '').join('').trim();
    const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = plain.split(/\s+/).filter(Boolean).length;

    return res.status(200).json({ html, plain, wordCount });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
