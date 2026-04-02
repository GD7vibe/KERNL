module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { title, author } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

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

    res.status(200).json({ html, plain });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to generate summary' });
  }
};
